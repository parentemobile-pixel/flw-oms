import { useState, useCallback, useEffect, useMemo } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  TextField,
  Button,
  Banner,
  InlineStack,
  Icon,
  Spinner,
  ButtonGroup,
  Badge,
  Collapsible,
} from "@shopify/polaris";
import {
  SearchIcon,
  ChevronUpIcon,
  ChevronDownIcon,
} from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import { searchProducts } from "../services/shopify-api/products.server";
import { getVariantsInventory } from "../services/shopify-api/inventory.server";
import {
  getDefaultLocation,
  getLocations,
  type Location,
} from "../services/shopify-api/locations.server";
import {
  ProductPicker,
  type PickerProduct,
  type PickerVariant,
} from "../components/ProductPicker";
import { LocationPicker } from "../components/LocationPicker";
import { ProductGrid, type GridCell } from "../components/ProductGrid";

interface SearchProduct {
  id: string;
  title: string;
  variants: Array<{
    id: string;
    title: string;
    sku: string | null;
    barcode: string | null;
    price: string | null;
    selectedOptions: Array<{ name: string; value: string }>;
  }>;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [locations, defaultLocation] = await Promise.all([
    getLocations(admin, session.shop).catch(() => [] as Location[]),
    getDefaultLocation(admin, session.shop).catch(() => null),
  ]);
  return json({
    locations,
    defaultLocationId: defaultLocation?.id ?? locations[0]?.id ?? null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "search");

  if (intent === "loadStock") {
    // Fetch per-variant available at a given location. Used by the
    // "Match stock" row action + "Match all" bulk action. Mirrors
    // the Transfer new page's loadStock pattern.
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

  // intent === "search"
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
          barcode: v.node.barcode ?? null,
          price: v.node.price ?? null,
          selectedOptions: v.node.selectedOptions ?? [],
        })),
      };
    });
    return json({ products });
  } catch (error) {
    console.error("Label search failed:", error);
    return json({
      products: [] as SearchProduct[],
      error: String(error),
    });
  }
};

interface SelectedVariant {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  selectedOptions: Array<{ name: string; value: string }>;
}

export default function PrintLabels() {
  const { locations, defaultLocationId } = useLoaderData<typeof loader>();

  const searchFetcher = useFetcher<typeof action>();
  const stockFetcher = useFetcher<typeof action>();
  const isSearching = searchFetcher.state !== "idle";

  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<SearchProduct[]>([]);
  const [selected, setSelected] = useState<SelectedVariant[]>([]);
  // Per-variant label quantities. `null` = user hasn't set anything;
  // renders as empty in the grid input.
  const [labelQty, setLabelQty] = useState<Record<string, number | null>>({});
  const [matchLocationId, setMatchLocationId] = useState<string | null>(
    defaultLocationId,
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerCollapsed, setPickerCollapsed] = useState(false);

  // Debounced search.
  useEffect(() => {
    if (!query.trim()) {
      setProducts([]);
      return;
    }
    const t = setTimeout(() => {
      const fd = new FormData();
      fd.set("intent", "search");
      fd.set("query", query);
      searchFetcher.submit(fd, { method: "post" });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    if (searchFetcher.data && "products" in searchFetcher.data) {
      setProducts(searchFetcher.data.products as SearchProduct[]);
    }
  }, [searchFetcher.data]);

  // Whenever loadStock returns, fold the values into labelQty for every
  // variant the response covered. Stateless / idempotent — the response
  // maps variantId → available at the requested location.
  useEffect(() => {
    if (stockFetcher.data && "stock" in stockFetcher.data) {
      const stock = stockFetcher.data.stock as Record<string, number>;
      if (Object.keys(stock).length === 0) return;
      setLabelQty((prev) => {
        const next = { ...prev };
        for (const [variantId, available] of Object.entries(stock)) {
          next[variantId] = Math.max(0, available);
        }
        return next;
      });
    }
  }, [stockFetcher.data]);

  const selectedVariantIds = useMemo(
    () => new Set(selected.map((s) => s.variantId)),
    [selected],
  );

  const handleToggleVariant = useCallback(
    (product: PickerProduct, variant: PickerVariant, checked: boolean) => {
      if (checked) {
        setSelected((prev) =>
          prev.some((s) => s.variantId === variant.id)
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
                },
              ],
        );
      } else {
        setSelected((prev) =>
          prev.filter((s) => s.variantId !== variant.id),
        );
        setLabelQty((prev) => {
          const next = { ...prev };
          delete next[variant.id];
          return next;
        });
      }
    },
    [],
  );

  const handleToggleGroup = useCallback(
    (
      product: PickerProduct,
      groupVariants: PickerVariant[],
      checked: boolean,
    ) => {
      if (checked) {
        setSelected((prev) => {
          const existing = new Set(prev.map((r) => r.variantId));
          const additions = groupVariants
            .filter((v) => !existing.has(v.id))
            .map((v) => ({
              variantId: v.id,
              productId: product.id,
              productTitle: product.title,
              variantTitle: v.title,
              sku: v.sku,
              selectedOptions: v.selectedOptions,
            }));
          return additions.length === 0 ? prev : [...prev, ...additions];
        });
      } else {
        const removeIds = new Set(groupVariants.map((v) => v.id));
        setSelected((prev) =>
          prev.filter((s) => !removeIds.has(s.variantId)),
        );
        setLabelQty((prev) => {
          const next = { ...prev };
          for (const id of removeIds) delete next[id];
          return next;
        });
      }
    },
    [],
  );

  // Fire loadStock for a subset of variant ids. The stockFetcher effect
  // above will fold the response into labelQty. Batch-safe: two rapid
  // clicks on different rows will each land their variants correctly
  // because the fetcher response overwrites just its own variants.
  const loadStockForVariants = useCallback(
    (variantIds: string[]) => {
      if (variantIds.length === 0 || !matchLocationId) return;
      const fd = new FormData();
      fd.set("intent", "loadStock");
      fd.set("locationId", matchLocationId);
      fd.set("variantIds", JSON.stringify(variantIds));
      stockFetcher.submit(fd, { method: "post" });
    },
    [matchLocationId, stockFetcher],
  );

  const handleCellChange = useCallback(
    (variantId: string, next: number) => {
      setLabelQty((prev) => ({
        ...prev,
        [variantId]: Math.max(0, next),
      }));
    },
    [],
  );

  // Grid cells derived from selected + labelQty. value is the label
  // count; renders as empty when null (untouched).
  const cells: GridCell[] = useMemo(
    () =>
      selected.map((s) => ({
        variantId: s.variantId,
        productId: s.productId,
        productTitle: s.productTitle,
        variantTitle: s.variantTitle,
        selectedOptions: s.selectedOptions,
        sku: s.sku,
        value: labelQty[s.variantId] ?? null,
      })),
    [selected, labelQty],
  );

  // "Match stock" per row. `cells` here is what ProductGrid hands back
  // — every cell in the current row (including size-column + any
  // overflow non-standard sizes).
  const handleMatchRow = useCallback(
    (rowCells: GridCell[]) => {
      loadStockForVariants(rowCells.map((c) => c.variantId));
    },
    [loadStockForVariants],
  );

  const handleMatchAll = useCallback(() => {
    loadStockForVariants(selected.map((s) => s.variantId));
  }, [loadStockForVariants, selected]);

  const totalLabels = useMemo(
    () =>
      Object.values(labelQty).reduce<number>(
        (s, v) => s + (v ?? 0),
        0,
      ),
    [labelQty],
  );

  const handlePrint = useCallback(async () => {
    if (isGenerating) return;
    const items = selected
      .map((s) => ({ variantId: s.variantId, quantity: labelQty[s.variantId] ?? 0 }))
      .filter((i) => i.quantity > 0);
    if (items.length === 0) {
      setError("Enter a label quantity for at least one variant first.");
      return;
    }
    setError(null);

    // Popup-blocker workaround: open the tab NOW (still in the click's
    // user-gesture context) so the browser allows it, then point it at
    // the blob URL once the PDF is ready. If we called window.open
    // after the await, the browser would treat it as a programmatic
    // popup and block it.
    const pdfWindow = window.open("", "_blank");

    const fd = new FormData();
    fd.set("items", JSON.stringify(items));

    setIsGenerating(true);
    try {
      const response = await fetch("/api/labels/adhoc", {
        method: "POST",
        body: fd,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Label endpoint returned ${response.status}. ${body.slice(0, 200)}`,
        );
      }
      const blob = await response.blob();
      if (blob.size === 0) throw new Error("Generated PDF was empty.");
      // The server returns Content-Disposition: attachment on the raw
      // response, but blob URLs ignore that — the tab renders inline
      // via Chrome's built-in PDF viewer.
      const url = URL.createObjectURL(blob);

      if (pdfWindow && !pdfWindow.closed) {
        pdfWindow.location.href = url;
        // Trigger the print dialog once Chrome's PDF viewer has had a
        // moment to render the blob. There's no reliable load event
        // to hook for the built-in PDF viewer, so we heuristic-delay.
        // If the timing misses (very slow load), the user's Cmd/Ctrl+P
        // in the new tab still works.
        setTimeout(() => {
          try {
            pdfWindow.focus();
            pdfWindow.print();
          } catch {
            // Cross-origin / popup edge cases — silently skip; user
            // can still print manually from the new tab.
          }
        }, 1200);
        // Give the tab time to load the blob before revoking. Chrome
        // usually copies the blob into the viewer within a second or
        // two; 60s is generous cover for a slow network / big PDF.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        // Popup blocked. Fall back to a plain download so the user
        // still gets the PDF, with a message they can adjust settings.
        const a = document.createElement("a");
        a.href = url;
        const label =
          items.length === 1
            ? (selected.find((s) => s.variantId === items[0].variantId)?.sku ??
                "labels").replace(/[^a-zA-Z0-9-_]/g, "_")
            : `${items.length}-variants`;
        a.download = `labels-${label}-${totalLabels}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setError(
          "Your browser blocked the new tab. Allow pop-ups for this site to open the PDF inline; the file was downloaded instead.",
        );
      }
    } catch (err) {
      pdfWindow?.close();
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Couldn't generate labels: ${msg}`);
    } finally {
      setIsGenerating(false);
    }
  }, [isGenerating, selected, labelQty, totalLabels]);

  const matchLocationName =
    locations.find((l) => l.id === matchLocationId)?.name ?? "location";
  const isLoadingStock = stockFetcher.state !== "idle";

  return (
    <Page
      title="Print Labels"
      subtitle="Search a product, pick variants, print barcode labels."
    >
      <Layout>
        {error && (
          <Layout.Section>
            <Banner tone="critical" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          </Layout.Section>
        )}
        {searchFetcher.data &&
          "error" in searchFetcher.data &&
          searchFetcher.data.error && (
            <Layout.Section>
              <Banner tone="critical">
                Search failed: {String(searchFetcher.data.error)}
              </Banner>
            </Layout.Section>
          )}

        {/* Product picker — collapsible so the grid below has more
            room once the user has picked their variants. Same pattern
            as the Transfer new and PO new pages. */}
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
                      Find variants
                    </Text>
                  </button>
                  {selected.length > 0 && (
                    <Badge tone="info">{`${selected.length} selected`}</Badge>
                  )}
                  {isSearching && <Spinner size="small" />}
                </InlineStack>
                <Button
                  icon={pickerCollapsed ? ChevronDownIcon : ChevronUpIcon}
                  onClick={() => setPickerCollapsed((v) => !v)}
                >
                  {pickerCollapsed ? "Expand section" : "Collapse section"}
                </Button>
              </InlineStack>
              <Collapsible
                id="print-labels-product-picker"
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
                    placeholder="Search by product title, SKU, or barcode…"
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
                        No products match &ldquo;{query}&rdquo;.
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

        {/* Grid — sizes as columns, colorway as rows. Cells are the
            label quantities. Row-trailing = "Match stock" button. */}
        {selected.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="end" wrap>
                  <BlockStack gap="100">
                    <Text as="h2" variant="headingMd">
                      Label quantities ({selected.length} variant
                      {selected.length !== 1 ? "s" : ""})
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      Will print {totalLabels} label
                      {totalLabels !== 1 ? "s" : ""} total. Set the count per
                      cell, or use &ldquo;Match stock&rdquo; to fill from
                      inventory.
                    </Text>
                  </BlockStack>
                  <InlineStack gap="300" blockAlign="end">
                    <div style={{ minWidth: "200px" }}>
                      <LocationPicker
                        label="Match stock at"
                        locations={locations}
                        value={matchLocationId}
                        onChange={setMatchLocationId}
                        persistKey="print-labels-match-location"
                      />
                    </div>
                    <Button
                      onClick={handleMatchAll}
                      disabled={!matchLocationId}
                      loading={isLoadingStock}
                    >
                      Match all to stock
                    </Button>
                  </InlineStack>
                </InlineStack>

                <ProductGrid
                  cells={cells}
                  qtyLabel="Labels"
                  onCellChange={handleCellChange}
                  showColumns={{
                    cost: false,
                    retail: false,
                    stock: false,
                    onOrder: false,
                  }}
                  sizeColumns={["XS", "S", "M", "L", "XL", "2XL", "3XL"]}
                  trailingLabel="Match stock"
                  renderRowTrailing={({ cells: rowCells }) => (
                    <Button
                      size="slim"
                      onClick={() => handleMatchRow(rowCells)}
                      disabled={!matchLocationId}
                      loading={isLoadingStock}
                    >
                      Match {matchLocationName}
                    </Button>
                  )}
                  onRemoveRow={(variantIds) => {
                    const drop = new Set(variantIds);
                    setSelected((prev) =>
                      prev.filter((s) => !drop.has(s.variantId)),
                    );
                    setLabelQty((prev) => {
                      const next = { ...prev };
                      for (const id of drop) delete next[id];
                      return next;
                    });
                  }}
                  stickyLeadColumn
                />

                <InlineStack align="end" gap="200">
                  <ButtonGroup>
                    <Button
                      onClick={() => {
                        setSelected([]);
                        setLabelQty({});
                      }}
                    >
                      Clear all
                    </Button>
                    <Button
                      variant="primary"
                      onClick={handlePrint}
                      loading={isGenerating}
                      disabled={isGenerating || totalLabels === 0}
                    >
                      {isGenerating
                        ? "Generating…"
                        : `Print ${totalLabels} label${totalLabels !== 1 ? "s" : ""}`}
                    </Button>
                  </ButtonGroup>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  PDF downloads to your browser. Open and print to your
                  Zebra printer. Label size: 2&Prime; &times; 1&Prime;
                  (landscape).
                </Text>
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
