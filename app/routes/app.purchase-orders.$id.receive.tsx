import { useState, useCallback, useMemo } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useActionData,
  useSubmit,
  useNavigation,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  TextField,
  Button,
  Banner,
  BlockStack,
  Text,
  InlineStack,
  Badge,
  ButtonGroup,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import {
  getPurchaseOrder,
  receiveLineItems,
} from "../services/purchase-orders/po-service.server";
import {
  adjustInventoryBatch,
  getVariantsInventory,
} from "../services/shopify-api/inventory.server";
import {
  getLocations,
  type Location,
} from "../services/shopify-api/locations.server";
import { LocationPicker } from "../components/LocationPicker";
import { BarcodeScanInput } from "../components/BarcodeScanInput";
import db from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const po = await getPurchaseOrder(session.shop, params.id!);
  if (!po) throw new Response("Not found", { status: 404 });

  const locations = await getLocations(admin, session.shop).catch(
    () => [] as Location[],
  );

  return json({
    po,
    locations,
    defaultLocationId:
      po.shopifyLocationId ?? (locations[0]?.id ?? null),
  });
};

interface ReceiveItem {
  lineItemId: string;
  quantityReceived: number;
  shopifyVariantId: string;
  previouslyReceived: number;
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const receivedItemsJson = formData.get("receivedItems") as string;
  const locationId = formData.get("locationId") as string;
  const receivedItems = JSON.parse(receivedItemsJson) as ReceiveItem[];

  if (!locationId) {
    return json({ error: "Please select a receive location." });
  }

  // Compute deltas (positive = more being received). Skip lines with no change.
  const withDeltas = receivedItems
    .map((item) => ({
      ...item,
      delta: item.quantityReceived - item.previouslyReceived,
    }))
    .filter((item) => item.delta !== 0);

  if (withDeltas.length === 0) {
    return json({ error: "No changes to apply." });
  }

  // 1. Resolve inventoryItem IDs in ONE batched call (not per-line).
  const variantIds = [...new Set(withDeltas.map((i) => i.shopifyVariantId))];
  let inventoryMap: Awaited<ReturnType<typeof getVariantsInventory>>;
  try {
    inventoryMap = await getVariantsInventory(admin, variantIds);
  } catch (error) {
    return json({
      error: `Couldn't fetch Shopify inventory info: ${String(error)}`,
    });
  }

  // 2. Build adjustment changes list for Shopify.
  const changes = withDeltas
    .map((item) => {
      const inv = inventoryMap.get(item.shopifyVariantId);
      if (!inv) return null;
      return {
        inventoryItemId: inv.inventoryItemId,
        locationId,
        delta: item.delta,
        shopifyVariantId: item.shopifyVariantId,
        lineItemId: item.lineItemId,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const missing = withDeltas.length - changes.length;
  if (missing > 0) {
    return json({
      error: `${missing} line item(s) have no matching Shopify inventory — their variants may have been deleted. No changes applied.`,
    });
  }

  // 3. Apply all adjustments in one Shopify mutation + record audit session.
  try {
    const result = await adjustInventoryBatch(
      admin,
      changes.map((c) => ({
        inventoryItemId: c.inventoryItemId,
        locationId: c.locationId,
        delta: c.delta,
      })),
      "received",
    );

    if (result.userErrors?.length > 0) {
      return json({
        error:
          "Shopify rejected the adjustment: " +
          result.userErrors
            .map((e: { message: string }) => e.message)
            .join("; "),
      });
    }

    // Audit log.
    await db.inventoryAdjustmentSession.create({
      data: {
        shop: session.shop,
        locationId,
        reason: "received",
        source: "po_receive",
        sourceId: params.id!,
        notes: `PO receive: ${receivedItems.length} lines`,
        changes: {
          create: changes.map((c, idx) => ({
            shopifyVariantId: c.shopifyVariantId,
            shopifyInventoryItemId: c.inventoryItemId,
            previousQuantity: withDeltas[idx].previouslyReceived,
            newQuantity: withDeltas[idx].quantityReceived,
            delta: c.delta,
          })),
        },
      },
    });
  } catch (error) {
    return json({
      error: `Shopify adjustment failed, no PO state changed: ${String(error)}`,
    });
  }

  // 4. Now that Shopify succeeded, update PO DB state.
  try {
    await receiveLineItems(
      params.id!,
      receivedItems.map((item) => ({
        lineItemId: item.lineItemId,
        quantityReceived: item.quantityReceived,
      })),
    );
  } catch (error) {
    return json({
      error: `Shopify updated successfully but PO state save failed (please review manually): ${String(error)}`,
    });
  }

  throw redirect(`/app/purchase-orders/${params.id}`);
};

export default function ReceivePurchaseOrder() {
  const { po, locations, defaultLocationId } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [locationId, setLocationId] = useState<string | null>(
    defaultLocationId,
  );
  const [quantities, setQuantities] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    for (const li of po.lineItems) initial[li.id] = li.quantityReceived;
    return initial;
  });
  const [scanFeedback, setScanFeedback] = useState<string | null>(null);

  // Lookup table for scan-to-line mode: sku/barcode → lineItemId
  const scanLookup = useMemo(() => {
    const map: Record<string, string> = {};
    for (const li of po.lineItems) {
      if (li.sku) map[li.sku.toUpperCase()] = li.id;
      if (li.barcode) map[li.barcode.toUpperCase()] = li.id;
    }
    return map;
  }, [po.lineItems]);

  const handleScan = useCallback(
    (code: string) => {
      const normalized = code.toUpperCase().trim();
      const lineId = scanLookup[normalized];
      if (!lineId) {
        setScanFeedback(`No line item matches "${code}".`);
        return;
      }
      const line = po.lineItems.find((li) => li.id === lineId);
      if (!line) return;
      setQuantities((prev) => {
        const next = (prev[lineId] ?? 0) + 1;
        const capped = Math.min(next, line.quantityOrdered);
        if (capped === prev[lineId]) {
          setScanFeedback(
            `${line.productTitle} — ${line.variantTitle}: already fully received (${line.quantityOrdered}).`,
          );
          return prev;
        }
        setScanFeedback(
          `✓ ${line.productTitle} — ${line.variantTitle}: ${capped} / ${line.quantityOrdered}`,
        );
        return { ...prev, [lineId]: capped };
      });
    },
    [scanLookup, po.lineItems],
  );

  const handleQuantityChange = useCallback(
    (lineItemId: string, value: string) => {
      setQuantities((prev) => ({
        ...prev,
        [lineItemId]: Math.max(0, parseInt(value, 10) || 0),
      }));
    },
    [],
  );

  const handleReceiveAll = useCallback(() => {
    const allReceived: Record<string, number> = {};
    for (const li of po.lineItems) allReceived[li.id] = li.quantityOrdered;
    setQuantities(allReceived);
  }, [po.lineItems]);

  const handleReceiveNone = useCallback(() => {
    const reset: Record<string, number> = {};
    for (const li of po.lineItems) reset[li.id] = li.quantityReceived;
    setQuantities(reset);
  }, [po.lineItems]);

  const handleSubmit = useCallback(() => {
    const receivedItems: ReceiveItem[] = po.lineItems.map((li) => ({
      lineItemId: li.id,
      quantityReceived: quantities[li.id] ?? li.quantityReceived,
      shopifyVariantId: li.shopifyVariantId,
      previouslyReceived: li.quantityReceived,
    }));

    const formData = new FormData();
    formData.set("receivedItems", JSON.stringify(receivedItems));
    if (locationId) formData.set("locationId", locationId);
    submit(formData, { method: "post" });
  }, [po.lineItems, quantities, locationId, submit]);

  // Summary counts
  const totalOrdered = po.lineItems.reduce(
    (sum, li) => sum + li.quantityOrdered,
    0,
  );
  const totalWillReceive = po.lineItems.reduce(
    (sum, li) => sum + (quantities[li.id] ?? li.quantityReceived),
    0,
  );
  const changeDelta = totalWillReceive - po.lineItems.reduce(
    (sum, li) => sum + li.quantityReceived,
    0,
  );

  return (
    <Page
      title={`Receive: ${po.poNumber}`}
      subtitle={po.vendor ?? undefined}
      backAction={{ url: `/app/purchase-orders/${po.id}` }}
    >
      <Layout>
        {actionData && "error" in actionData && (
          <Layout.Section>
            <Banner tone="critical">{actionData.error as string}</Banner>
          </Layout.Section>
        )}

        {/* Receive location + summary */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" wrap>
                <div style={{ minWidth: "260px" }}>
                  <LocationPicker
                    label="Receive to location"
                    locations={locations}
                    value={locationId}
                    onChange={setLocationId}
                    persistKey="po-receive-destination"
                  />
                </div>
                <InlineStack gap="400" blockAlign="center">
                  <Text as="p" variant="bodyMd">
                    Will receive{" "}
                    <Text as="span" variant="bodyMd" fontWeight="semibold">
                      {totalWillReceive} / {totalOrdered}
                    </Text>{" "}
                    units
                    {changeDelta !== 0 && (
                      <Text as="span" tone="subdued">
                        {" "}
                        ({changeDelta > 0 ? "+" : ""}
                        {changeDelta} vs current)
                      </Text>
                    )}
                  </Text>
                  <ButtonGroup>
                    <Button onClick={handleReceiveAll} size="slim">
                      Receive All
                    </Button>
                    <Button onClick={handleReceiveNone} size="slim">
                      Reset
                    </Button>
                  </ButtonGroup>
                </InlineStack>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Scan-to-line */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                Fast scan mode
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Focus this field and scan items — each scan increments the
                matching line by 1. USB scanners work like keyboards.
              </Text>
              <BarcodeScanInput
                onScan={handleScan}
                label="Scan barcode"
                labelHidden
                placeholder="Scan SKU or barcode…"
              />
              {scanFeedback && (
                <Text
                  as="p"
                  variant="bodySm"
                  tone={
                    scanFeedback.startsWith("✓") ? "success" : "subdued"
                  }
                >
                  {scanFeedback}
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Line items */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Line Items
              </Text>
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "13px",
                  }}
                >
                  <thead>
                    <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                      <th style={{ padding: "8px", textAlign: "left" }}>
                        Product
                      </th>
                      <th style={{ padding: "8px", textAlign: "left" }}>
                        Variant
                      </th>
                      <th style={{ padding: "8px", textAlign: "left" }}>
                        SKU
                      </th>
                      <th style={{ padding: "8px", textAlign: "right" }}>
                        Ordered
                      </th>
                      <th style={{ padding: "8px", textAlign: "right" }}>
                        Previously
                      </th>
                      <th
                        style={{
                          padding: "8px",
                          textAlign: "right",
                          width: "110px",
                        }}
                      >
                        Received
                      </th>
                      <th style={{ padding: "8px", textAlign: "center" }}>
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {po.lineItems.map((li) => {
                      const currentQty = quantities[li.id] ?? 0;
                      const isComplete = currentQty >= li.quantityOrdered;
                      const isPartial =
                        currentQty > 0 && currentQty < li.quantityOrdered;

                      return (
                        <tr
                          key={li.id}
                          style={{ borderBottom: "1px solid #f1f1f1" }}
                        >
                          <td style={{ padding: "8px" }}>{li.productTitle}</td>
                          <td style={{ padding: "8px" }}>{li.variantTitle}</td>
                          <td style={{ padding: "8px" }}>{li.sku || "—"}</td>
                          <td
                            style={{ padding: "8px", textAlign: "right" }}
                          >
                            {li.quantityOrdered}
                          </td>
                          <td
                            style={{ padding: "8px", textAlign: "right" }}
                          >
                            {li.quantityReceived}
                          </td>
                          <td style={{ padding: "4px 8px" }}>
                            <TextField
                              label="Received"
                              labelHidden
                              value={String(currentQty)}
                              onChange={(val) =>
                                handleQuantityChange(li.id, val)
                              }
                              type="number"
                              min={0}
                              max={li.quantityOrdered}
                              autoComplete="off"
                            />
                          </td>
                          <td style={{ padding: "8px", textAlign: "center" }}>
                            {isComplete ? (
                              <Badge tone="success">Complete</Badge>
                            ) : isPartial ? (
                              <Badge tone="warning">Partial</Badge>
                            ) : (
                              <Badge>Pending</Badge>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineStack align="end" gap="200">
            <Button url={`/app/purchase-orders/${po.id}`}>Cancel</Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              loading={isSubmitting}
              disabled={!locationId || changeDelta === 0}
            >
              Confirm Received
            </Button>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
