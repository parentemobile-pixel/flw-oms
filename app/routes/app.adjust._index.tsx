import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Select,
  Button,
  Banner,
  Icon,
  Spinner,
  Divider,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import {
  getDefaultLocation,
  getLocations,
  type Location,
} from "../services/shopify-api/locations.server";
import {
  getVariantsInventory,
  type InventoryAdjustReason,
} from "../services/shopify-api/inventory.server";
import { searchProducts } from "../services/shopify-api/products.server";
import {
  applyAdjustments,
  getRecentAdjustmentSessions,
} from "../services/inventory/adjust-service.server";
import { LocationPicker } from "../components/LocationPicker";
import { ProductGrid, type GridCell } from "../components/ProductGrid";

interface SearchHit {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  selectedOptions: Array<{ name: string; value: string }>;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [locations, defaultLocation, recentSessions] = await Promise.all([
    getLocations(admin, session.shop).catch(() => [] as Location[]),
    getDefaultLocation(admin, session.shop).catch(() => null),
    getRecentAdjustmentSessions(session.shop, 5).catch(() => []),
  ]);
  return json({
    locations,
    defaultLocationId: defaultLocation?.id ?? null,
    recentSessions,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "search") {
    const query = String(formData.get("query") ?? "").trim();
    if (!query) return json({ hits: [] as SearchHit[] });
    try {
      const result = await searchProducts(admin, query);
      const hits: SearchHit[] = [];
      for (const edge of result.edges as Array<{ node: any }>) {
        const product = edge.node;
        for (const vEdge of product.variants.edges as Array<{ node: any }>) {
          hits.push({
            variantId: vEdge.node.id,
            productId: product.id,
            productTitle: product.title,
            variantTitle: vEdge.node.title,
            sku: vEdge.node.sku ?? null,
            selectedOptions: vEdge.node.selectedOptions ?? [],
          });
        }
      }
      return json({ hits });
    } catch (error) {
      return json({ hits: [] as SearchHit[], error: String(error) });
    }
  }

  if (intent === "loadInventory") {
    const variantIdsJson = String(formData.get("variantIds") ?? "[]");
    const locationId = String(formData.get("locationId") ?? "");
    const variantIds = JSON.parse(variantIdsJson) as string[];
    if (variantIds.length === 0 || !locationId) {
      return json({ inventory: {} });
    }
    const map = await getVariantsInventory(admin, variantIds);
    const inventory: Record<string, number> = {};
    for (const [vid, inv] of map.entries()) {
      const level = inv.levels.find((l) => l.locationId === locationId);
      inventory[vid] = level?.quantities.available ?? 0;
    }
    return json({ inventory });
  }

  if (intent === "apply") {
    const locationId = String(formData.get("locationId") ?? "");
    const reason = String(formData.get("reason") ?? "correction") as InventoryAdjustReason;
    const notes = String(formData.get("notes") ?? "") || null;
    const requestsJson = String(formData.get("requests") ?? "[]");
    const requests = JSON.parse(requestsJson) as Array<{
      shopifyVariantId: string;
      newQuantity: number;
    }>;

    try {
      const result = await applyAdjustments(
        admin,
        session.shop,
        locationId,
        reason,
        notes,
        requests,
      );
      return json({ ok: true as const, ...result });
    } catch (error) {
      return json({ error: String(error) });
    }
  }

  return json({});
};

const REASON_OPTIONS: Array<{ label: string; value: InventoryAdjustReason }> = [
  { label: "Correction", value: "correction" },
  { label: "Cycle count accuracy", value: "cycle_count_accuracy" },
  { label: "Damaged", value: "damaged" },
  { label: "Shrinkage", value: "shrinkage" },
  { label: "Restock", value: "restock" },
  { label: "Other", value: "other" },
];

interface AdjustRow extends SearchHit {
  currentQty: number;
  newQty: number;
}

export default function InventoryAdjust() {
  const { locations, defaultLocationId, recentSessions } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isBusy = navigation.state === "submitting";

  const [locationId, setLocationId] = useState<string | null>(
    defaultLocationId,
  );
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [rows, setRows] = useState<AdjustRow[]>([]);
  const [reason, setReason] = useState<InventoryAdjustReason>("correction");
  const [notes, setNotes] = useState("");

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    setIsSearching(true);
    const t = setTimeout(() => {
      const fd = new FormData();
      fd.set("intent", "search");
      fd.set("query", query);
      submit(fd, { method: "post" });
    }, 300);
    return () => clearTimeout(t);
  }, [query, submit]);

  useEffect(() => {
    if (!actionData) return;
    if ("hits" in actionData) {
      setHits(actionData.hits);
      setIsSearching(false);
    }
    if ("inventory" in actionData) {
      // Seed current qty onto rows as they arrive
      const inv = actionData.inventory as Record<string, number>;
      setRows((prev) =>
        prev.map((r) => ({
          ...r,
          currentQty: inv[r.variantId] ?? r.currentQty,
          newQty: r.newQty === r.currentQty ? inv[r.variantId] ?? r.newQty : r.newQty,
        })),
      );
    }
  }, [actionData]);

  const handleAddVariant = useCallback(
    (hit: SearchHit) => {
      if (rows.some((r) => r.variantId === hit.variantId)) return;
      setRows((prev) => [
        ...prev,
        { ...hit, currentQty: 0, newQty: 0 },
      ]);
      // Kick off an inventory fetch for this new variant
      if (locationId) {
        const fd = new FormData();
        fd.set("intent", "loadInventory");
        fd.set("locationId", locationId);
        fd.set("variantIds", JSON.stringify([hit.variantId]));
        submit(fd, { method: "post" });
      }
    },
    [rows, locationId, submit],
  );

  // Reload inventory when location changes
  useEffect(() => {
    if (!locationId || rows.length === 0) return;
    const fd = new FormData();
    fd.set("intent", "loadInventory");
    fd.set("locationId", locationId);
    fd.set("variantIds", JSON.stringify(rows.map((r) => r.variantId)));
    submit(fd, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);

  const cells: GridCell[] = useMemo(
    () =>
      rows.map((r) => ({
        variantId: r.variantId,
        productId: r.productId,
        productTitle: r.productTitle,
        variantTitle: r.variantTitle,
        selectedOptions: r.selectedOptions,
        sku: r.sku,
        stock: r.currentQty,
        value: r.newQty,
      })),
    [rows],
  );

  const handleCellChange = useCallback((variantId: string, next: number) => {
    setRows((prev) =>
      prev.map((r) =>
        r.variantId === variantId ? { ...r, newQty: next } : r,
      ),
    );
  }, []);

  const pendingChanges = rows.filter(
    (r) => r.newQty !== r.currentQty,
  ).length;

  const handleApply = useCallback(() => {
    if (!locationId) return;
    if (pendingChanges === 0) return;
    const fd = new FormData();
    fd.set("intent", "apply");
    fd.set("locationId", locationId);
    fd.set("reason", reason);
    fd.set("notes", notes);
    fd.set(
      "requests",
      JSON.stringify(
        rows
          .filter((r) => r.newQty !== r.currentQty)
          .map((r) => ({
            shopifyVariantId: r.variantId,
            newQuantity: r.newQty,
          })),
      ),
    );
    submit(fd, { method: "post" });
  }, [locationId, reason, notes, rows, pendingChanges, submit]);

  const applyResult =
    actionData && "ok" in actionData && actionData.ok === true
      ? (actionData as { ok: true; sessionId: string; appliedChanges: number; skipped: number })
      : null;

  return (
    <Page
      title="Inventory Adjust"
      subtitle="Grid-based adjustments at a selected location with full audit log"
    >
      <Layout>
        {applyResult && (
          <Layout.Section>
            <Banner
              tone="success"
              title={`Applied ${applyResult.appliedChanges} change(s)`}
            >
              Inventory at Shopify has been updated. Session ID:{" "}
              {applyResult.sessionId}
            </Banner>
          </Layout.Section>
        )}
        {actionData && "error" in actionData && (
          <Layout.Section>
            <Banner tone="critical">{actionData.error as string}</Banner>
          </Layout.Section>
        )}

        {/* Location + Search */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="400" wrap>
                <div style={{ minWidth: "240px" }}>
                  <LocationPicker
                    label="Location"
                    locations={locations}
                    value={locationId}
                    onChange={setLocationId}
                    persistKey="adjust-location"
                  />
                </div>
                <div style={{ flex: 1, minWidth: "300px" }}>
                  <TextField
                    label="Search products"
                    labelHidden
                    value={query}
                    onChange={setQuery}
                    placeholder="Search by product, SKU, or vendor…"
                    autoComplete="off"
                    prefix={<Icon source={SearchIcon} />}
                    clearButton
                    onClearButtonClick={() => {
                      setQuery("");
                      setHits([]);
                    }}
                  />
                </div>
              </InlineStack>

              {isSearching && (
                <InlineStack gap="200" blockAlign="center">
                  <Spinner size="small" />
                  <Text as="span" variant="bodySm" tone="subdued">
                    Searching…
                  </Text>
                </InlineStack>
              )}

              {hits.length > 0 && (
                <BlockStack gap="100">
                  <Text as="h3" variant="headingSm">
                    Search results
                  </Text>
                  {hits.map((h) => {
                    const added = rows.some((r) => r.variantId === h.variantId);
                    return (
                      <div
                        key={h.variantId}
                        style={{
                          padding: "8px 12px",
                          borderRadius: "4px",
                          border: "1px solid #e1e3e5",
                        }}
                      >
                        <InlineStack
                          align="space-between"
                          blockAlign="center"
                          wrap={false}
                        >
                          <div>
                            <Text as="p" variant="bodyMd">
                              {h.productTitle}{" "}
                              <Text as="span" tone="subdued">
                                — {h.variantTitle}
                              </Text>
                            </Text>
                            {h.sku && (
                              <Text as="p" variant="bodySm" tone="subdued">
                                {h.sku}
                              </Text>
                            )}
                          </div>
                          <Button
                            size="slim"
                            disabled={added}
                            onClick={() => handleAddVariant(h)}
                          >
                            {added ? "Added" : "Add"}
                          </Button>
                        </InlineStack>
                      </div>
                    );
                  })}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Grid */}
        {rows.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Enter new quantities
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {pendingChanges} pending change
                    {pendingChanges !== 1 ? "s" : ""}
                  </Text>
                </InlineStack>
                <ProductGrid
                  cells={cells}
                  qtyLabel="New qty"
                  onCellChange={handleCellChange}
                  showColumns={{ stock: true, cost: false, retail: false, onOrder: false }}
                />
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Reason + apply */}
        {rows.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack gap="400" wrap>
                  <div style={{ minWidth: "220px" }}>
                    <Select
                      label="Reason"
                      options={REASON_OPTIONS}
                      value={reason}
                      onChange={(v) => setReason(v as InventoryAdjustReason)}
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: "320px" }}>
                    <TextField
                      label="Notes (optional)"
                      value={notes}
                      onChange={setNotes}
                      autoComplete="off"
                      placeholder="Context for this adjustment…"
                    />
                  </div>
                </InlineStack>
                <InlineStack align="end">
                  <Button
                    variant="primary"
                    onClick={handleApply}
                    loading={isBusy}
                    disabled={pendingChanges === 0 || !locationId}
                  >
                    Apply {pendingChanges} change
                    {pendingChanges !== 1 ? "s" : ""}
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Recent sessions sidebar */}
        {recentSessions.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  Recent adjustments
                </Text>
                <Divider />
                {recentSessions.map((s) => (
                  <InlineStack
                    key={s.id}
                    align="space-between"
                    blockAlign="center"
                  >
                    <BlockStack gap="050">
                      <Text as="p" variant="bodyMd">
                        {s.reason.replace(/_/g, " ")}
                        {s.notes && (
                          <Text as="span" variant="bodySm" tone="subdued">
                            {" "}
                            — {s.notes}
                          </Text>
                        )}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {new Date(s.createdAt).toLocaleString()} ·{" "}
                        {(s as any)._count?.changes ?? 0} change
                        {(s as any)._count?.changes === 1 ? "" : "s"}
                        {s.source !== "manual" && (
                          <Text as="span" tone="subdued">
                            {" "}
                            · {s.source.replace(/_/g, " ")}
                          </Text>
                        )}
                      </Text>
                    </BlockStack>
                  </InlineStack>
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
