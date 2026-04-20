import { useState, useCallback, useMemo } from "react";
import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
} from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useActionData,
  useSubmit,
  useNavigation,
} from "@remix-run/react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import {
  AppProvider,
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Badge,
  TextField,
  Button,
  Banner,
  InlineStack,
  ButtonGroup,
} from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";

import { getPurchaseOrderByToken } from "../services/purchase-orders/po-service.server";
import { unauthenticated } from "../shopify.server";
import {
  adjustInventoryBatch,
  getVariantsInventory,
  updateInventoryItemCostsBatch,
} from "../services/shopify-api/inventory.server";
import db from "../db.server";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: polarisStyles },
];

/**
 * Public scan-to-receive page — accessed via the QR code printed on the PO PDF.
 *
 * Auth model: the URL contains a per-PO random token (stored as receiveToken
 * on PurchaseOrder). No Shopify admin session is required on the browser
 * side — any holder of the QR can scan and receive items. Token can be
 * rotated via rotateReceiveToken() if compromised.
 *
 * Shopify API access: we use the app's OFFLINE session (stored when the
 * merchant installed the app) via shopify.unauthenticated.admin(shop).
 * That gives us a fully authenticated admin client even though the visitor
 * to this route has no session cookie. Result: scan-to-receive actually
 * adjusts Shopify inventory + pushes COGS, same as the in-admin receive flow.
 */
export const loader = async ({ params }: LoaderFunctionArgs) => {
  const po = await getPurchaseOrderByToken(params.token!);
  if (!po) {
    throw new Response("PO not found or token expired", { status: 404 });
  }
  return json({ po });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const po = await getPurchaseOrderByToken(params.token!);
  if (!po) {
    throw new Response("PO not found", { status: 404 });
  }

  const formData = await request.formData();
  const changesJson = formData.get("changes") as string;
  const changes = JSON.parse(changesJson) as Array<{
    lineItemId: string;
    quantityReceived: number;
  }>;

  const { receiveLineItems } = await import(
    "../services/purchase-orders/po-service.server"
  );

  // Determine the destination location. Prefer the PO's explicit
  // shopifyLocationId; otherwise fall back to the first location for the shop.
  const locationId = po.shopifyLocationId;
  if (!locationId) {
    return json({
      error:
        "This PO has no destination location set. Open it in the admin and set 'Receive at location' first.",
    });
  }

  // Compute per-line deltas vs. what's already been received in the DB. Skip
  // lines with no change so the Shopify mutation only carries real work.
  const withDeltas: Array<{
    lineItemId: string;
    shopifyVariantId: string;
    unitCost: number;
    delta: number;
    previous: number;
    next: number;
  }> = [];
  for (const c of changes) {
    const line = po.lineItems.find((li) => li.id === c.lineItemId);
    if (!line) continue;
    const delta = c.quantityReceived - line.quantityReceived;
    if (delta === 0) continue;
    withDeltas.push({
      lineItemId: c.lineItemId,
      shopifyVariantId: line.shopifyVariantId,
      unitCost: line.unitCost,
      delta,
      previous: line.quantityReceived,
      next: c.quantityReceived,
    });
  }

  if (withDeltas.length === 0) {
    return json({
      ok: true as const,
      message: "No changes to save.",
    });
  }

  // Open an admin client using the app's offline session for this shop.
  let admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];
  try {
    const ctx = await unauthenticated.admin(po.shop);
    admin = ctx.admin;
  } catch (error) {
    console.error("Scan-to-receive: couldn't get offline admin", error);
    return json({
      error:
        "App session for this shop isn't available. A manager needs to re-open the app in the Shopify admin, then try again.",
    });
  }

  // Resolve inventoryItem IDs via one batched call.
  let inventoryMap: Awaited<ReturnType<typeof getVariantsInventory>>;
  try {
    inventoryMap = await getVariantsInventory(
      admin,
      [...new Set(withDeltas.map((d) => d.shopifyVariantId))],
    );
  } catch (error) {
    console.error("Scan-to-receive: variant inventory fetch failed", error);
    return json({
      error: `Couldn't fetch Shopify inventory info: ${String(error)}`,
    });
  }

  const inventoryChanges = withDeltas
    .map((d) => {
      const inv = inventoryMap.get(d.shopifyVariantId);
      if (!inv) return null;
      return {
        inventoryItemId: inv.inventoryItemId,
        locationId,
        delta: d.delta,
        shopifyVariantId: d.shopifyVariantId,
        lineItemId: d.lineItemId,
        unitCost: d.unitCost,
        previous: d.previous,
        next: d.next,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  if (inventoryChanges.length !== withDeltas.length) {
    const missing = withDeltas.length - inventoryChanges.length;
    return json({
      error: `${missing} line item(s) have no matching Shopify inventory — their variants may have been deleted. No changes applied.`,
    });
  }

  // Apply inventory adjustments as a single batched mutation.
  try {
    const result = await adjustInventoryBatch(
      admin,
      inventoryChanges.map((c) => ({
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

    // Audit log (same shape the in-admin receive writes).
    await db.inventoryAdjustmentSession.create({
      data: {
        shop: po.shop,
        locationId,
        reason: "received",
        source: "po_receive",
        sourceId: po.id,
        notes: `Scan-to-receive: ${withDeltas.length} line(s)`,
        changes: {
          create: inventoryChanges.map((c) => ({
            shopifyVariantId: c.shopifyVariantId,
            shopifyInventoryItemId: c.inventoryItemId,
            previousQuantity: c.previous,
            newQuantity: c.next,
            delta: c.delta,
          })),
        },
      },
    });
  } catch (error) {
    console.error("Scan-to-receive: Shopify adjustment failed", error);
    return json({
      error: `Shopify adjustment failed, no PO state changed: ${String(error)}`,
    });
  }

  // COGS push (best effort — doesn't fail the whole receive).
  const costUpdates = inventoryChanges
    .filter((c) => c.unitCost > 0)
    .map((c) => ({ inventoryItemId: c.inventoryItemId, cost: c.unitCost }));
  if (costUpdates.length > 0) {
    try {
      const r = await updateInventoryItemCostsBatch(admin, costUpdates);
      if (r.failures.length > 0) {
        console.warn(
          `Scan-to-receive COGS: ${r.updated} updated, ${r.skipped} skipped, ${r.failures.length} failed:`,
          r.failures,
        );
      }
    } catch (error) {
      console.error("Scan-to-receive: COGS push failed (non-fatal)", error);
    }
  }

  // DB state last, after Shopify has already accepted the changes.
  try {
    await receiveLineItems(po.id, changes);
    return json({
      ok: true as const,
      message: `Received ${withDeltas.length} line(s). Shopify inventory updated.`,
    });
  } catch (error) {
    console.error("Scan-to-receive: PO DB update failed", error);
    return json({
      error: `Shopify updated but PO state save failed (please review in the admin): ${String(error)}`,
    });
  }
};

export default function ScanReceivePage() {
  const { po } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [quantities, setQuantities] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const li of po.lineItems) init[li.id] = li.quantityReceived;
    return init;
  });

  const [scanFeedback, setScanFeedback] = useState<string | null>(null);

  const scanLookup = useMemo(() => {
    const map: Record<string, string> = {};
    for (const li of po.lineItems) {
      if (li.sku) map[li.sku.toUpperCase()] = li.id;
      if (li.barcode) map[li.barcode.toUpperCase()] = li.id;
    }
    return map;
  }, [po.lineItems]);

  const handleScanInput = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      const el = e.currentTarget;
      const code = el.value.trim().toUpperCase();
      if (!code) return;
      const lineId = scanLookup[code];
      if (!lineId) {
        setScanFeedback(`No match for "${code}".`);
        el.value = "";
        return;
      }
      const line = po.lineItems.find((li) => li.id === lineId);
      if (!line) return;
      setQuantities((prev) => {
        const next = Math.min((prev[lineId] ?? 0) + 1, line.quantityOrdered);
        if (next === prev[lineId]) {
          setScanFeedback(
            `${line.productTitle} already fully received (${line.quantityOrdered}).`,
          );
        } else {
          setScanFeedback(
            `✓ ${line.productTitle} — ${line.variantTitle}: ${next} / ${line.quantityOrdered}`,
          );
        }
        return { ...prev, [lineId]: next };
      });
      el.value = "";
    },
    [scanLookup, po.lineItems],
  );

  const handleQuantityChange = useCallback(
    (lineItemId: string, val: string) => {
      setQuantities((prev) => ({
        ...prev,
        [lineItemId]: Math.max(0, parseInt(val, 10) || 0),
      }));
    },
    [],
  );

  const handleSubmit = useCallback(() => {
    const changes = po.lineItems.map((li) => ({
      lineItemId: li.id,
      quantityReceived: quantities[li.id] ?? li.quantityReceived,
    }));
    const fd = new FormData();
    fd.set("changes", JSON.stringify(changes));
    submit(fd, { method: "post" });
  }, [po.lineItems, quantities, submit]);

  const receivedNow = po.lineItems.reduce(
    (s, li) => s + (quantities[li.id] ?? li.quantityReceived),
    0,
  );
  const totalOrdered = po.lineItems.reduce(
    (s, li) => s + li.quantityOrdered,
    0,
  );

  return (
    <AppProvider i18n={enTranslations}>
      <Page
        title={`Receive: ${po.poNumber}`}
        subtitle={po.vendor ?? undefined}
      >
        <Layout>
          {actionData && "ok" in actionData && actionData.ok && (
            <Layout.Section>
              <Banner tone="success">{actionData.message}</Banner>
            </Layout.Section>
          )}
          {actionData && "error" in actionData && (
            <Layout.Section>
              <Banner tone="critical">{actionData.error as string}</Banner>
            </Layout.Section>
          )}

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200">
                  <Badge>{po.status}</Badge>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {receivedNow} / {totalOrdered} units
                  </Text>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  Scan items or enter quantities below. Save when done — a
                  manager will sync counts to Shopify inventory from the admin
                  app.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Scan
                </Text>
                <input
                  type="text"
                  autoFocus
                  placeholder="Scan SKU or barcode…"
                  onKeyDown={handleScanInput}
                  style={{
                    width: "100%",
                    padding: "12px",
                    fontSize: "16px",
                    border: "1px solid #ccc",
                    borderRadius: "6px",
                  }}
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

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Line items
                </Text>
                {po.lineItems.map((li) => {
                  const currentQty =
                    quantities[li.id] ?? li.quantityReceived;
                  return (
                    <div
                      key={li.id}
                      style={{
                        padding: "12px",
                        borderRadius: "6px",
                        border: "1px solid #e1e3e5",
                      }}
                    >
                      <BlockStack gap="200">
                        <Text as="p" variant="bodyMd" fontWeight="medium">
                          {li.productTitle}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {li.variantTitle}
                          {li.sku ? ` · ${li.sku}` : ""}
                        </Text>
                        <InlineStack
                          align="space-between"
                          blockAlign="center"
                        >
                          <Text as="span" variant="bodySm">
                            Received / ordered
                          </Text>
                          <InlineStack gap="200" blockAlign="center">
                            <div style={{ width: "80px" }}>
                              <TextField
                                label=""
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
                            </div>
                            <Text as="span" variant="bodySm">
                              / {li.quantityOrdered}
                            </Text>
                          </InlineStack>
                        </InlineStack>
                      </BlockStack>
                    </div>
                  );
                })}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <ButtonGroup fullWidth>
              <Button
                variant="primary"
                onClick={handleSubmit}
                loading={isSubmitting}
                size="large"
              >
                Save received quantities
              </Button>
            </ButtonGroup>
          </Layout.Section>

          <Layout.Section>
            <div style={{ height: "3rem" }} />
          </Layout.Section>
        </Layout>
      </Page>
    </AppProvider>
  );
}
