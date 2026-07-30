import { useState, useCallback, useEffect, useMemo } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher } from "@remix-run/react";
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
} from "@shopify/polaris";
import { SearchIcon, DeleteIcon } from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import { searchProducts } from "../services/shopify-api/products.server";
import {
  ProductPicker,
  type PickerProduct,
  type PickerVariant,
} from "../components/ProductPicker";

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
  await authenticate.admin(request);
  return json({});
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
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

// Metadata cached client-side so the "Selected variants" list can
// render product/variant titles + SKU/barcode/price without needing
// the picker's product still in scope after selection.
interface SelectedVariant {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  barcode: string | null;
  price: string | null;
}

export default function PrintLabels() {
  // useFetcher (not useSubmit) — dedicated to background XHR so
  // debounced-typeahead requests don't collide with page navigation
  // state, and empty responses don't get lost between renders.
  const searchFetcher = useFetcher<typeof action>();
  const isSearching = searchFetcher.state !== "idle";

  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<SearchProduct[]>([]);
  const [selected, setSelected] = useState<SelectedVariant[]>([]);
  const [quantity, setQuantity] = useState("1");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced search — 300ms after the user stops typing.
  useEffect(() => {
    if (!query.trim()) {
      setProducts([]);
      return;
    }
    const t = setTimeout(() => {
      const fd = new FormData();
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

  const selectedVariantIds = useMemo(
    () => new Set(selected.map((s) => s.variantId)),
    [selected],
  );

  const handleToggleVariant = useCallback(
    (product: PickerProduct, variant: PickerVariant, checked: boolean) => {
      if (checked) {
        // Look up full variant metadata (price / barcode) from search
        // results — PickerVariant doesn't carry them.
        const srcProduct = products.find((p) => p.id === product.id);
        const srcVariant = srcProduct?.variants.find(
          (v) => v.id === variant.id,
        );
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
                  barcode: srcVariant?.barcode ?? null,
                  price: srcVariant?.price ?? null,
                },
              ],
        );
      } else {
        setSelected((prev) =>
          prev.filter((s) => s.variantId !== variant.id),
        );
      }
    },
    [products],
  );

  const handleToggleGroup = useCallback(
    (
      product: PickerProduct,
      groupVariants: PickerVariant[],
      checked: boolean,
    ) => {
      if (checked) {
        const srcProduct = products.find((p) => p.id === product.id);
        const additions: SelectedVariant[] = [];
        for (const v of groupVariants) {
          if (selectedVariantIds.has(v.id)) continue;
          const srcVariant = srcProduct?.variants.find((x) => x.id === v.id);
          additions.push({
            variantId: v.id,
            productId: product.id,
            productTitle: product.title,
            variantTitle: v.title,
            sku: v.sku,
            barcode: srcVariant?.barcode ?? null,
            price: srcVariant?.price ?? null,
          });
        }
        if (additions.length === 0) return;
        setSelected((prev) => [...prev, ...additions]);
      } else {
        const removeIds = new Set(groupVariants.map((v) => v.id));
        setSelected((prev) =>
          prev.filter((s) => !removeIds.has(s.variantId)),
        );
      }
    },
    [products, selectedVariantIds],
  );

  const handlePrint = useCallback(async () => {
    if (selected.length === 0 || isGenerating) return;
    setError(null);
    const qty = Math.max(1, Math.min(500, parseInt(quantity, 10) || 1));
    const fd = new FormData();
    fd.set("quantity", String(qty));
    fd.set(
      "variantIds",
      JSON.stringify(selected.map((s) => s.variantId)),
    );

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
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const label =
        selected.length === 1
          ? (selected[0].sku ?? "labels").replace(/[^a-zA-Z0-9-_]/g, "_")
          : `${selected.length}-variants`;
      a.download = `labels-${label}-${qty}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Couldn't generate labels: ${msg}`);
    } finally {
      setIsGenerating(false);
    }
  }, [selected, quantity, isGenerating]);

  const totalLabels =
    selected.length *
    Math.max(1, Math.min(500, parseInt(quantity, 10) || 1));

  return (
    <Page
      title="Print Labels"
      subtitle="Search a product, pick variants, print barcode labels."
    >
      <Layout>
        {error && (
          <Layout.Section>
            <Banner tone="critical">{error}</Banner>
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

        {/* Product picker */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Find variants
                </Text>
                {isSearching && <Spinner size="small" />}
              </InlineStack>
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
              {!isSearching && query.trim() !== "" && products.length === 0 && (
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
          </Card>
        </Layout.Section>

        {/* Selected variants + quantity + print */}
        {selected.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Selected variants ({selected.length})
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    Will print {totalLabels} label
                    {totalLabels !== 1 ? "s" : ""} total
                  </Text>
                </InlineStack>

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
                        <th style={{ padding: "8px", textAlign: "left" }}>
                          Barcode
                        </th>
                        <th style={{ padding: "8px", width: "40px" }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.map((s) => (
                        <tr
                          key={s.variantId}
                          style={{ borderBottom: "1px solid #f1f1f1" }}
                        >
                          <td style={{ padding: "8px" }}>{s.productTitle}</td>
                          <td style={{ padding: "8px" }}>{s.variantTitle}</td>
                          <td style={{ padding: "8px" }}>{s.sku || "—"}</td>
                          <td style={{ padding: "8px" }}>
                            {s.barcode || (
                              <Text as="span" tone="subdued">
                                (will use SKU)
                              </Text>
                            )}
                          </td>
                          <td style={{ padding: "8px" }}>
                            <Button
                              icon={DeleteIcon}
                              variant="plain"
                              tone="critical"
                              accessibilityLabel="Remove"
                              onClick={() =>
                                setSelected((prev) =>
                                  prev.filter(
                                    (x) => x.variantId !== s.variantId,
                                  ),
                                )
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <InlineStack gap="300" blockAlign="end" align="end">
                  <div style={{ maxWidth: "180px" }}>
                    <TextField
                      label="Labels per variant"
                      type="number"
                      value={quantity}
                      onChange={setQuantity}
                      min={1}
                      max={500}
                      autoComplete="off"
                    />
                  </div>
                  <Button
                    variant="primary"
                    onClick={handlePrint}
                    loading={isGenerating}
                    disabled={isGenerating}
                  >
                    {isGenerating
                      ? "Generating…"
                      : `Print ${totalLabels} label${totalLabels !== 1 ? "s" : ""}`}
                  </Button>
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
