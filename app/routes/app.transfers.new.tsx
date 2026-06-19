import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
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
  Button,
  Banner,
  Icon,
  Spinner,
  Collapsible,
  Badge,
} from "@shopify/polaris";
import {
  SearchIcon,
  ChevronUpIcon,
  ChevronDownIcon,
} from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import {
  getDefaultLocation,
  getLocations,
  type Location,
} from "../services/shopify-api/locations.server";
import { getVariantsInventory } from "../services/shopify-api/inventory.server";
import { searchProducts } from "../services/shopify-api/products.server";
import { createTransfer } from "../services/transfers/transfer-service.server";
import { LocationPicker } from "../components/LocationPicker";
import { ProductGrid, type GridCell } from "../components/ProductGrid";
import {
  ProductPicker,
  type PickerProduct,
  type PickerVariant,
} from "../components/ProductPicker";

interface SearchVariant {
  id: string;
  title: string;
  sku: string | null;
  inStock: number;
  selectedOptions: Array<{ name: string; value: string }>;
}

interface SearchProduct {
  id: string;
  title: string;
  variants: SearchVariant[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [locations, defaultLocation] = await Promise.all([
    getLocations(admin, session.shop).catch(() => [] as Location[]),
    getDefaultLocation(admin, session.shop).catch(() => null),
  ]);
  return json({
    locations,
    defaultLocationId: defaultLocation?.id ?? null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "search") {
    const query = String(formData.get("query") ?? "").trim();
    if (!query) return json({ products: [] as SearchProduct[] });
    try {
      const result = await searchProducts(admin, query);
      const products: SearchProduct[] = (
        result.edges as Array<{ node: any }>
      ).map((edge) => {
        const p = edge.node;
        return {
          id: p.id,
          title: p.title,
          variants: (p.variants.edges as Array<{ node: any }>).map((v) => ({
            id: v.node.id,
            title: v.node.title,
            sku: v.node.sku ?? null,
            inStock: v.node.inventoryQuantity ?? 0,
            selectedOptions: v.node.selectedOptions ?? [],
          })),
        };
      });
      return json({ products });
    } catch (error) {
      return json({ products: [] as SearchProduct[], error: String(error) });
    }
  }

  if (intent === "loadStock") {
    const variantIds = JSON.parse(
      String(formData.get("variantIds") ?? "[]"),
    ) as string[];
    const locationId = String(formData.get("locationId") ?? "");
    if (variantIds.length === 0 || !locationId) return json({ stock: {} });
    const map = await getVariantsInventory(admin, variantIds);
    const stock: Record<string, number> = {};
    for (const [vid, inv] of map.entries()) {
      const level = inv.levels.find((l) => l.locationId === locationId);
      stock[vid] = level?.quantities.available ?? 0;
    }
    return json({ stock });
  }

  if (intent === "create") {
    const fromLocationId = String(formData.get("fromLocationId") ?? "");
    const toLocationId = String(formData.get("toLocationId") ?? "");
    const name = (String(formData.get("name") ?? "")).trim() || null;
    const notes = String(formData.get("notes") ?? "") || null;
    const lineItems = JSON.parse(
      String(formData.get("lineItems") ?? "[]"),
    ) as Array<{
      shopifyProductId: string;
      shopifyVariantId: string;
      productTitle: string;
      variantTitle: string;
      sku: string | null;
      quantitySent: number;
    }>;

    try {
      const t = await createTransfer(session.shop, {
        name,
        fromLocationId,
        toLocationId,
        notes,
        lineItems,
      });
      throw redirect(`/app/transfers/${t.id}`);
    } catch (error) {
      if (error instanceof Response) throw error;
      return json({ error: String(error) });
    }
  }

  return json({});
};

interface TransferRow {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  selectedOptions: Array<{ name: string; value: string }>;
  fromStock: number;
  quantitySent: number;
}

export default function NewTransfer() {
  const { locations, defaultLocationId } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isBusy = navigation.state === "submitting";

  const [fromLocationId, setFromLocationId] = useState<string | null>(
    defaultLocationId,
  );
  const [toLocationId, setToLocationId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<SearchProduct[]>([]);
  const [rows, setRows] = useState<TransferRow[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [pickerCollapsed, setPickerCollapsed] = useState(false);

  // Read a prefill payload written by another page (currently the
  // Replenishment report) and apply it once on mount. Payload shape
  // matches the writer side at app.replenishment._index.tsx:
  //   { ts, fromLocationId, toLocationId, rows: [{ ..., quantitySent }] }
  // We clear the key immediately so a refresh doesn't re-apply, and
  // we drop payloads older than 60s so a stale handoff doesn't surface
  // after the user navigated elsewhere first.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const PREFILL_KEY = "flw-oms.transfer-prefill";
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(PREFILL_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      window.localStorage.removeItem(PREFILL_KEY);
    } catch {
      /* ignore */
    }
    let payload:
      | {
          ts?: number;
          fromLocationId?: string;
          toLocationId?: string;
          rows?: Array<{
            variantId: string;
            productId: string;
            productTitle: string;
            variantTitle: string;
            sku: string | null;
            selectedOptions: Array<{ name: string; value: string }>;
            quantitySent: number;
          }>;
        }
      | null = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (!payload) return;
    if (
      typeof payload.ts === "number" &&
      Date.now() - payload.ts > 60_000
    ) {
      return; // stale
    }
    if (payload.fromLocationId) setFromLocationId(payload.fromLocationId);
    if (payload.toLocationId) setToLocationId(payload.toLocationId);
    if (payload.rows && payload.rows.length > 0) {
      setRows((prev) => {
        const next = [...prev];
        const seen = new Set(next.map((r) => r.variantId));
        for (const r of payload!.rows!) {
          if (seen.has(r.variantId)) continue;
          next.push({
            variantId: r.variantId,
            productId: r.productId,
            productTitle: r.productTitle,
            variantTitle: r.variantTitle,
            sku: r.sku,
            selectedOptions: r.selectedOptions,
            fromStock: 0,
            quantitySent: r.quantitySent,
          });
        }
        return next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep "To" valid relative to "From". If the user picks a From that
  // happens to be the location currently selected as To (common when
  // reversing a transfer — From defaults to the main store, you switch
  // From to the new store, but To is still the new store from its
  // initial default), From === To and the Create button silently stays
  // disabled. LocationPicker won't self-correct because its value is
  // already set. Reset To to the first remaining location whenever it's
  // missing, equal to From, or no longer in the filtered option list.
  // Set a concrete value (not null) so LocationPicker's localStorage
  // restore can't immediately re-pick the colliding location.
  useEffect(() => {
    if (!fromLocationId) return;
    const available = locations.filter((l) => l.id !== fromLocationId);
    const toIsValid =
      toLocationId != null &&
      toLocationId !== fromLocationId &&
      available.some((l) => l.id === toLocationId);
    if (!toIsValid) {
      setToLocationId(available[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromLocationId, locations]);

  useEffect(() => {
    if (!query.trim()) {
      setProducts([]);
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
    if ("products" in actionData) {
      setProducts(actionData.products as SearchProduct[]);
      setIsSearching(false);
    }
    if ("stock" in actionData) {
      const stock = actionData.stock as Record<string, number>;
      setRows((prev) =>
        prev.map((r) => ({
          ...r,
          fromStock: stock[r.variantId] ?? r.fromStock,
        })),
      );
    }
  }, [actionData]);

  const selectedVariantIds = useMemo(
    () => new Set(rows.map((r) => r.variantId)),
    [rows],
  );

  // Pull from-location stock for a freshly added set of variant ids.
  const loadStockFor = useCallback(
    (variantIds: string[]) => {
      if (!fromLocationId || variantIds.length === 0) return;
      const fd = new FormData();
      fd.set("intent", "loadStock");
      fd.set("locationId", fromLocationId);
      fd.set("variantIds", JSON.stringify(variantIds));
      submit(fd, { method: "post" });
    },
    [fromLocationId, submit],
  );

  const handleToggleVariant = useCallback(
    (
      product: PickerProduct,
      variant: PickerVariant,
      checked: boolean,
    ) => {
      if (checked) {
        setRows((prev) =>
          prev.some((r) => r.variantId === variant.id)
            ? prev
            : [
                ...prev,
                {
                  variantId: variant.id,
                  productId: product.id,
                  productTitle: product.title,
                  variantTitle: variant.title,
                  sku: variant.sku,
                  selectedOptions: variant.selectedOptions,
                  fromStock: variant.inStock ?? 0,
                  quantitySent: 0,
                },
              ],
        );
        loadStockFor([variant.id]);
      } else {
        setRows((prev) => prev.filter((r) => r.variantId !== variant.id));
      }
    },
    [loadStockFor],
  );

  const handleToggleGroup = useCallback(
    (
      product: PickerProduct,
      groupVariants: PickerVariant[],
      checked: boolean,
    ) => {
      if (checked) {
        const toAdd = groupVariants.filter(
          (v) => !rows.some((r) => r.variantId === v.id),
        );
        if (toAdd.length === 0) return;
        setRows((prev) => [
          ...prev,
          ...toAdd.map((variant) => ({
            variantId: variant.id,
            productId: product.id,
            productTitle: product.title,
            variantTitle: variant.title,
            sku: variant.sku,
            selectedOptions: variant.selectedOptions,
            fromStock: variant.inStock ?? 0,
            quantitySent: 0,
          })),
        ]);
        loadStockFor(toAdd.map((v) => v.id));
      } else {
        const ids = new Set(groupVariants.map((v) => v.id));
        setRows((prev) => prev.filter((r) => !ids.has(r.variantId)));
      }
    },
    [rows, loadStockFor],
  );

  // Reload stock when from-location changes — also fires the first
  // time rows arrive (covers the Replenishment prefill case where rows
  // get seeded by the mount effect without the user touching anything).
  useEffect(() => {
    if (!fromLocationId || rows.length === 0) return;
    const fd = new FormData();
    fd.set("intent", "loadStock");
    fd.set("locationId", fromLocationId);
    fd.set("variantIds", JSON.stringify(rows.map((r) => r.variantId)));
    submit(fd, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromLocationId, rows.length]);

  const cells: GridCell[] = useMemo(
    () =>
      rows.map((r) => ({
        variantId: r.variantId,
        productId: r.productId,
        productTitle: r.productTitle,
        variantTitle: r.variantTitle,
        selectedOptions: r.selectedOptions,
        sku: r.sku,
        stock: r.fromStock,
        value: r.quantitySent,
      })),
    [rows],
  );

  const handleCellChange = useCallback((variantId: string, next: number) => {
    setRows((prev) =>
      prev.map((r) =>
        r.variantId === variantId ? { ...r, quantitySent: next } : r,
      ),
    );
  }, []);

  const canCreate =
    fromLocationId &&
    toLocationId &&
    fromLocationId !== toLocationId &&
    rows.some((r) => r.quantitySent > 0);

  const handleCreate = useCallback(() => {
    if (!canCreate || !fromLocationId || !toLocationId) return;
    const fd = new FormData();
    fd.set("intent", "create");
    fd.set("fromLocationId", fromLocationId);
    fd.set("toLocationId", toLocationId);
    fd.set("name", name);
    fd.set("notes", notes);
    fd.set(
      "lineItems",
      JSON.stringify(
        rows
          .filter((r) => r.quantitySent > 0)
          .map((r) => ({
            shopifyProductId: r.productId,
            shopifyVariantId: r.variantId,
            productTitle: r.productTitle,
            variantTitle: r.variantTitle,
            sku: r.sku,
            quantitySent: r.quantitySent,
          })),
      ),
    );
    submit(fd, { method: "post" });
  }, [canCreate, fromLocationId, toLocationId, name, notes, rows, submit]);

  const totalUnits = rows.reduce((s, r) => s + r.quantitySent, 0);

  return (
    <Page
      title="New Transfer"
      backAction={{ url: "/app/transfers" }}
    >
      <Layout>
        {actionData && "error" in actionData && (
          <Layout.Section>
            <Banner tone="critical">{actionData.error as string}</Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Transfer details
              </Text>
              <TextField
                label="Transfer name"
                value={name}
                onChange={setName}
                autoComplete="off"
                placeholder="e.g. FW25 Marblehead initial stock"
                helpText="A short label to recognize this transfer at a glance — shown as the primary title in the list view."
              />
              <InlineStack gap="400" wrap>
                <div style={{ flex: 1, minWidth: "240px" }}>
                  <LocationPicker
                    label="From"
                    locations={locations}
                    value={fromLocationId}
                    onChange={setFromLocationId}
                    persistKey="transfer-from"
                  />
                </div>
                <div style={{ flex: 1, minWidth: "240px" }}>
                  <LocationPicker
                    label="To"
                    locations={locations.filter(
                      (l) => l.id !== fromLocationId,
                    )}
                    value={toLocationId}
                    onChange={setToLocationId}
                    persistKey="transfer-to"
                  />
                </div>
              </InlineStack>
              <TextField
                label="Notes"
                value={notes}
                onChange={setNotes}
                autoComplete="off"
                multiline={2}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <button
                    type="button"
                    onClick={() => setPickerCollapsed((v) => !v)}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <Text as="h2" variant="headingMd">
                      Add products
                    </Text>
                  </button>
                  {rows.length > 0 && (
                    <Badge tone="info">{`${rows.length} selected`}</Badge>
                  )}
                  {isSearching && <Spinner size="small" />}
                </InlineStack>
                <Button
                  icon={
                    pickerCollapsed ? ChevronDownIcon : ChevronUpIcon
                  }
                  onClick={() => setPickerCollapsed((v) => !v)}
                >
                  {pickerCollapsed ? "Expand section" : "Collapse section"}
                </Button>
              </InlineStack>

              <Collapsible
                id="transfer-product-picker"
                open={!pickerCollapsed}
                transition={{
                  duration: "150ms",
                  timingFunction: "ease-in-out",
                }}
                expandOnPrint
              >
                <BlockStack gap="400">
                  <TextField
                    label="Search"
                    labelHidden
                    value={query}
                    onChange={setQuery}
                    placeholder="Search by product, SKU, or vendor…"
                    autoComplete="off"
                    prefix={<Icon source={SearchIcon} />}
                    clearButton
                    onClearButtonClick={() => {
                      setQuery("");
                      setProducts([]);
                    }}
                  />
                  {!isSearching &&
                    query.trim() !== "" &&
                    products.length === 0 && (
                      <Text as="p" variant="bodySm" tone="subdued">
                        No products match “{query}”.
                      </Text>
                    )}
                  <ProductPicker
                    products={products as PickerProduct[]}
                    selectedVariantIds={selectedVariantIds}
                    onToggleVariant={handleToggleVariant}
                    onToggleGroup={handleToggleGroup}
                  />
                </BlockStack>
              </Collapsible>
            </BlockStack>
          </Card>
        </Layout.Section>

        {rows.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Enter quantities to send
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {totalUnits} unit{totalUnits !== 1 ? "s" : ""} across{" "}
                    {rows.length} line{rows.length !== 1 ? "s" : ""}
                  </Text>
                </InlineStack>
                <ProductGrid
                  cells={cells}
                  qtyLabel="Send"
                  onCellChange={handleCellChange}
                  showColumns={{
                    stock: true,
                    cost: false,
                    retail: false,
                    onOrder: false,
                  }}
                />
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <InlineStack align="end" gap="200">
            <Button url="/app/transfers">Cancel</Button>
            <Button
              variant="primary"
              onClick={handleCreate}
              loading={isBusy}
              disabled={!canCreate}
            >
              Save as draft
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
