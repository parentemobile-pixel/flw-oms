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
  updateInventoryItemCostsBatch,
} from "../services/shopify-api/inventory.server";
import {
  getLocations,
  type Location,
} from "../services/shopify-api/locations.server";
import { LocationPicker } from "../components/LocationPicker";
import { BarcodeScanInput } from "../components/BarcodeScanInput";
import db from "../db.server";

// Hidden for now per user request. Set to true to re-enable the Fast Scan
// Mode card. All handlers and the scanLookup memo are still wired up so
// flipping this flag is all that's needed to bring it back.
const SHOW_SCAN_MODE = false;

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

  // Fetch the PO line items up front so we know each line's unitCost —
  // we'll push those into Shopify's inventoryItem.cost after a successful
  // receive so COGS stays in sync with what we actually paid.
  const po = await getPurchaseOrder(session.shop, params.id!);
  if (!po) return json({ error: "PO not found" });
  const costByLineItemId = new Map<string, number>(
    po.lineItems.map((li) => [li.id, li.unitCost]),
  );

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

  // 3b. Push unit costs (COGS) to Shopify so margin reports and accounting
  // stay in sync with what we actually paid. Only updates lines whose PO
  // cost is > 0 and differs from what we already have. Failures here don't
  // fail the whole receive — inventory is already adjusted, DB still updates.
  const costUpdates: Array<{ inventoryItemId: string; cost: number }> = [];
  for (const c of changes) {
    const cost = costByLineItemId.get(c.lineItemId) ?? 0;
    if (cost > 0) {
      costUpdates.push({ inventoryItemId: c.inventoryItemId, cost });
    }
  }
  let costResult: Awaited<
    ReturnType<typeof updateInventoryItemCostsBatch>
  > | null = null;
  if (costUpdates.length > 0) {
    try {
      costResult = await updateInventoryItemCostsBatch(admin, costUpdates);
      if (costResult.failures.length > 0) {
        console.warn(
          `COGS push partial: ${costResult.updated} updated, ${costResult.skipped} skipped, ${costResult.failures.length} failed:`,
          costResult.failures,
        );
      }
    } catch (error) {
      console.error("COGS push failed (non-fatal):", error);
    }
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
  // Autofill with the ordered amount — the common case is "receiving
  // everything that was ordered". Users can -/+ down to reflect actual
  // counts. For lines that were already partially received, initial value
  // is still ordered; the action computes the delta so no double-adjust.
  const [quantities, setQuantities] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    for (const li of po.lineItems) initial[li.id] = li.quantityOrdered;
    return initial;
  });
  const [viewMode, setViewMode] = useState<"line" | "grid">("grid");
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
    (lineItemId: string, value: number) => {
      setQuantities((prev) => ({
        ...prev,
        [lineItemId]: Math.max(0, value),
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
    for (const li of po.lineItems) reset[li.id] = 0;
    setQuantities(reset);
  }, [po.lineItems]);

  // "Mark row received" — sets every line item in a given (product +
  // non-size) grouping to its ordered quantity.
  const handleMarkLinesReceived = useCallback(
    (lineItemIds: string[]) => {
      setQuantities((prev) => {
        const next = { ...prev };
        for (const id of lineItemIds) {
          const li = po.lineItems.find((l) => l.id === id);
          if (li) next[id] = li.quantityOrdered;
        }
        return next;
      });
    },
    [po.lineItems],
  );

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

        {/* Fast scan mode — hidden for now. Flip SHOW_SCAN_MODE to true to
            re-enable. handleScan / scanLookup / BarcodeScanInput are all
            still wired up, just not rendered. */}
        {SHOW_SCAN_MODE && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  Fast scan mode
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Focus this field and scan items — each scan increments
                  the matching line by 1. USB scanners work like keyboards.
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
        )}

        {/* Line items — grid or line view */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Line Items
                </Text>
                <ButtonGroup variant="segmented">
                  <Button
                    pressed={viewMode === "line"}
                    onClick={() => setViewMode("line")}
                    size="slim"
                  >
                    Line Items
                  </Button>
                  <Button
                    pressed={viewMode === "grid"}
                    onClick={() => setViewMode("grid")}
                    size="slim"
                  >
                    Size Grid
                  </Button>
                </ButtonGroup>
              </InlineStack>
              {viewMode === "grid" ? (
                <POReceiveGrid
                  lineItems={po.lineItems}
                  quantities={quantities}
                  onQuantityChange={handleQuantityChange}
                  onMarkRowReceived={handleMarkLinesReceived}
                />
              ) : (
                <POReceiveLine
                  lineItems={po.lineItems}
                  quantities={quantities}
                  onQuantityChange={handleQuantityChange}
                  onMarkRowReceived={handleMarkLinesReceived}
                />
              )}
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

// ─── Helpers & sub-components ──────────────────────────────────────────────

const SIZE_TOKENS = new Set([
  "XXS", "XS", "S", "M", "L", "XL", "2XL", "XXL", "3XL", "XXXL", "4XL",
  "OS", "ONE SIZE",
]);
const SIZE_SORT_ORDER = [
  "XXS", "XS", "S", "M", "L", "XL", "2XL", "XXL", "3XL", "XXXL", "4XL",
  "OS", "ONE SIZE",
];

interface ReceiveLine {
  id: string;
  shopifyProductId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  quantityOrdered: number;
  quantityReceived: number;
}

function classifyVariant(variantTitle: string): {
  size: string | null;
  nonSize: string;
} {
  if (/^default title$/i.test(variantTitle.trim())) {
    return { size: null, nonSize: "" };
  }
  const parts = variantTitle.split(" / ").map((p) => p.trim()).filter(Boolean);
  let size: string | null = null;
  const nonSize: string[] = [];
  for (const p of parts) {
    if (!size && SIZE_TOKENS.has(p.toUpperCase())) size = p;
    else nonSize.push(p);
  }
  return { size, nonSize: nonSize.join(" / ") };
}

function compareSizes(a: string, b: string): number {
  const ai = SIZE_SORT_ORDER.indexOf(a.toUpperCase());
  const bi = SIZE_SORT_ORDER.indexOf(b.toUpperCase());
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return a.localeCompare(b);
}

/**
 * Simple quantity input with an "/ N" readout for context. Admin users
 * (warehouse with keyboard) prefer typing, so no +/- buttons here.
 */
function QtyInput({
  value,
  max,
  onChange,
}: {
  value: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <InlineStack gap="050" blockAlign="center" wrap={false}>
      <div style={{ width: "56px" }}>
        <TextField
          label="Qty"
          labelHidden
          // type="text" + inputMode="numeric" → no spinner arrows eating
          // the 56px width, but phone keyboards still default to numeric.
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={String(value)}
          onChange={(val) => {
            const digitsOnly = val.replace(/[^0-9]/g, "");
            onChange(parseInt(digitsOnly, 10) || 0);
          }}
          autoComplete="off"
          align="center"
        />
      </div>
      <Text as="span" variant="bodySm" tone="subdued">
        /{max}
      </Text>
    </InlineStack>
  );
}

// ─── Line view (flat table) ────────────────────────────────────────────────

function POReceiveLine({
  lineItems,
  quantities,
  onQuantityChange,
  onMarkRowReceived,
}: {
  lineItems: ReceiveLine[];
  quantities: Record<string, number>;
  onQuantityChange: (id: string, v: number) => void;
  onMarkRowReceived: (ids: string[]) => void;
}) {
  return (
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
            <th style={{ padding: "8px", textAlign: "left" }}>Product</th>
            <th style={{ padding: "8px", textAlign: "left" }}>Variant</th>
            <th style={{ padding: "8px", textAlign: "left" }}>SKU</th>
            <th style={{ padding: "8px", textAlign: "right" }}>Ordered</th>
            <th style={{ padding: "8px", textAlign: "right" }}>Previously</th>
            <th style={{ padding: "8px" }}>Receive now</th>
            <th style={{ padding: "8px" }}></th>
          </tr>
        </thead>
        <tbody>
          {lineItems.map((li) => {
            const currentQty = quantities[li.id] ?? 0;
            const isComplete = currentQty >= li.quantityOrdered;
            return (
              <tr key={li.id} style={{ borderBottom: "1px solid #f1f1f1" }}>
                <td style={{ padding: "8px" }}>{li.productTitle}</td>
                <td style={{ padding: "8px" }}>{li.variantTitle}</td>
                <td style={{ padding: "8px" }}>{li.sku || "—"}</td>
                <td style={{ padding: "8px", textAlign: "right" }}>
                  {li.quantityOrdered}
                </td>
                <td style={{ padding: "8px", textAlign: "right" }}>
                  {li.quantityReceived}
                </td>
                <td style={{ padding: "4px 8px" }}>
                  <QtyInput
                    value={currentQty}
                    max={li.quantityOrdered}
                    onChange={(v) => onQuantityChange(li.id, v)}
                  />
                </td>
                <td style={{ padding: "8px" }}>
                  {isComplete ? (
                    <Badge tone="success">Received</Badge>
                  ) : (
                    <Button
                      size="slim"
                      onClick={() => onMarkRowReceived([li.id])}
                    >
                      Mark received
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Grid view (sizes as columns, "Mark row received" per color group) ────

function POReceiveGrid({
  lineItems,
  quantities,
  onQuantityChange,
  onMarkRowReceived,
}: {
  lineItems: ReceiveLine[];
  quantities: Record<string, number>;
  onQuantityChange: (id: string, v: number) => void;
  onMarkRowReceived: (ids: string[]) => void;
}) {
  const sizeSet = new Set<string>();
  const groups = new Map<
    string,
    {
      productTitle: string;
      nonSize: string;
      noSize: boolean;
      lineItemIds: string[];
      bySize: Record<string, ReceiveLine>;
    }
  >();

  for (const li of lineItems) {
    const { size, nonSize } = classifyVariant(li.variantTitle);
    const key = `${li.shopifyProductId}::${nonSize}`;
    if (!groups.has(key)) {
      groups.set(key, {
        productTitle: li.productTitle,
        nonSize,
        noSize: !size,
        lineItemIds: [],
        bySize: {},
      });
    }
    const g = groups.get(key)!;
    g.lineItemIds.push(li.id);
    if (size) {
      sizeSet.add(size);
      g.bySize[size] = li;
    } else {
      g.bySize["_single"] = li;
    }
  }

  const sortedSizes = [...sizeSet].sort(compareSizes);
  const sizeColCount = Math.max(sortedSizes.length, 1);

  return (
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
            <th
              style={{
                padding: "6px 8px",
                textAlign: "left",
                width: "200px",
              }}
            >
              Product / Variant
            </th>
            {sortedSizes.length > 0 ? (
              sortedSizes.map((s) => (
                <th
                  key={s}
                  style={{
                    padding: "6px 4px",
                    textAlign: "center",
                  }}
                >
                  {s}
                </th>
              ))
            ) : (
              <th style={{ padding: "6px 4px", textAlign: "center" }}>
                Qty
              </th>
            )}
            <th
              style={{
                padding: "6px 8px",
                textAlign: "right",
                width: "130px",
              }}
            ></th>
          </tr>
        </thead>
        <tbody>
          {[...groups.entries()].map(([key, g]) => {
            const allReceived = g.lineItemIds.every((id) => {
              const li = lineItems.find((l) => l.id === id);
              if (!li) return true;
              return (quantities[id] ?? 0) >= li.quantityOrdered;
            });
            return (
              <tr key={key} style={{ borderBottom: "1px solid #f1f1f1" }}>
                <td style={{ padding: "6px 8px", verticalAlign: "top" }}>
                  <div style={{ fontWeight: 500 }}>{g.productTitle}</div>
                  {g.nonSize && (
                    <Text as="span" variant="bodySm" tone="subdued">
                      {g.nonSize}
                    </Text>
                  )}
                </td>
                {g.noSize ? (
                  <td
                    colSpan={sizeColCount}
                    style={{ padding: "6px 8px", verticalAlign: "top" }}
                  >
                    {(() => {
                      const li = g.bySize["_single"];
                      if (!li) return "—";
                      return (
                        <QtyInput
                          value={quantities[li.id] ?? 0}
                          max={li.quantityOrdered}
                          onChange={(v) => onQuantityChange(li.id, v)}
                        />
                      );
                    })()}
                  </td>
                ) : (
                  sortedSizes.map((s) => {
                    const li = g.bySize[s];
                    if (!li) {
                      return (
                        <td
                          key={s}
                          style={{
                            padding: "6px 4px",
                            textAlign: "center",
                            background: "#f9f9f9",
                            color: "#9ca3af",
                          }}
                        >
                          —
                        </td>
                      );
                    }
                    return (
                      <td
                        key={s}
                        style={{ padding: "4px 4px", verticalAlign: "top" }}
                      >
                        <QtyInput
                          value={quantities[li.id] ?? 0}
                          max={li.quantityOrdered}
                          onChange={(v) => onQuantityChange(li.id, v)}
                        />
                        {li.quantityReceived > 0 && (
                          <div
                            style={{
                              fontSize: "11px",
                              color: "#6b7280",
                              textAlign: "center",
                              marginTop: "2px",
                            }}
                          >
                            {li.quantityReceived} prev
                          </div>
                        )}
                      </td>
                    );
                  })
                )}
                <td
                  style={{
                    padding: "6px 8px",
                    verticalAlign: "top",
                    textAlign: "right",
                  }}
                >
                  {allReceived ? (
                    <Badge tone="success">All received</Badge>
                  ) : (
                    <Button
                      size="slim"
                      onClick={() => onMarkRowReceived(g.lineItemIds)}
                    >
                      Mark row received
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
