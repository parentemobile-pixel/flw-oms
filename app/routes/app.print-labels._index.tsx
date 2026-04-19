import { useState, useCallback, useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useSubmit,
  useNavigation,
} from "@remix-run/react";
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
  Badge,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import { searchProducts } from "../services/shopify-api/products.server";

interface VariantHit {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  barcode: string | null;
  price: number | null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const query = String(formData.get("query") ?? "").trim();

  if (!query) return json({ variants: [] as VariantHit[] });

  try {
    const result = await searchProducts(admin, query);
    const variants: VariantHit[] = [];
    for (const edge of result.edges as Array<{ node: any }>) {
      const product = edge.node;
      for (const vEdge of product.variants.edges as Array<{ node: any }>) {
        const priceStr = vEdge.node.price;
        variants.push({
          variantId: vEdge.node.id,
          productTitle: product.title,
          variantTitle: vEdge.node.title,
          sku: vEdge.node.sku ?? null,
          barcode: vEdge.node.barcode ?? null,
          price: priceStr ? parseFloat(priceStr) || null : null,
        });
      }
    }
    return json({ variants });
  } catch (error) {
    console.error("Label search failed:", error);
    return json({ variants: [] as VariantHit[], error: String(error) });
  }
};

export default function PrintLabels() {
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSearching = navigation.state === "submitting";

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VariantHit[]>([]);
  const [selected, setSelected] = useState<VariantHit | null>(null);
  const [quantity, setQuantity] = useState("1");

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      const fd = new FormData();
      fd.set("query", query);
      submit(fd, { method: "post" });
    }, 300);
    return () => clearTimeout(t);
  }, [query, submit]);

  useEffect(() => {
    if (actionData && "variants" in actionData) {
      setResults(actionData.variants as VariantHit[]);
    }
  }, [actionData]);

  const [isGenerating, setIsGenerating] = useState(false);
  const handlePrint = useCallback(async () => {
    if (!selected || isGenerating) return;
    const qty = Math.max(
      1,
      Math.min(500, parseInt(quantity, 10) || 1),
    );
    const fd = new FormData();
    fd.set("quantity", String(qty));
    fd.set("productTitle", selected.productTitle);
    fd.set("variantTitle", selected.variantTitle);
    fd.set("sku", selected.sku ?? "");
    fd.set("barcode", selected.barcode ?? "");
    if (selected.price != null) fd.set("price", String(selected.price));

    // Fetch inside the authenticated iframe (target=_blank would lose the
    // Shopify admin session token), then trigger a blob download.
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
      if (blob.size === 0) {
        throw new Error("Generated PDF was empty.");
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeSku =
        (selected.sku ?? "labels").replace(/[^a-zA-Z0-9-_]/g, "_") || "labels";
      a.download = `labels-${safeSku}-${qty}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error("Print labels failed:", error);
      window.alert(
        `Couldn't generate labels: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      setIsGenerating(false);
    }
  }, [selected, quantity, isGenerating]);

  return (
    <Page
      title="Print Labels"
      subtitle="Print extra barcode labels for any product variant"
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                1. Find the variant
              </Text>
              <TextField
                label="Search products"
                labelHidden
                value={query}
                onChange={setQuery}
                placeholder="Search by product title, SKU, or vendor…"
                autoComplete="off"
                prefix={<Icon source={SearchIcon} />}
                clearButton
                onClearButtonClick={() => {
                  setQuery("");
                  setResults([]);
                }}
              />
              {isSearching && (
                <InlineStack gap="200" blockAlign="center">
                  <Spinner size="small" />
                  <Text as="span" tone="subdued" variant="bodySm">
                    Searching…
                  </Text>
                </InlineStack>
              )}

              {results.length > 0 && (
                <BlockStack gap="100">
                  {results.map((v) => {
                    const isSelected = selected?.variantId === v.variantId;
                    return (
                      <div
                        key={v.variantId}
                        onClick={() => setSelected(v)}
                        style={{
                          padding: "10px 12px",
                          borderRadius: "6px",
                          cursor: "pointer",
                          background: isSelected ? "#f0f7ff" : "transparent",
                          border: isSelected
                            ? "1px solid #1e88e5"
                            : "1px solid #e1e3e5",
                        }}
                      >
                        <InlineStack
                          align="space-between"
                          blockAlign="center"
                          wrap={false}
                        >
                          <BlockStack gap="050">
                            <Text as="p" variant="bodyMd" fontWeight="medium">
                              {v.productTitle} —{" "}
                              <Text as="span" tone="subdued">
                                {v.variantTitle}
                              </Text>
                            </Text>
                            <InlineStack gap="200">
                              {v.sku && (
                                <Text as="span" variant="bodySm" tone="subdued">
                                  SKU: {v.sku}
                                </Text>
                              )}
                              {v.barcode && (
                                <Text as="span" variant="bodySm" tone="subdued">
                                  Barcode: {v.barcode}
                                </Text>
                              )}
                            </InlineStack>
                          </BlockStack>
                          {isSelected && <Badge tone="info">Selected</Badge>}
                        </InlineStack>
                      </div>
                    );
                  })}
                </BlockStack>
              )}

              {query.trim() && !isSearching && results.length === 0 && (
                <Text as="p" tone="subdued">
                  No matches.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {selected && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  2. Print
                </Text>
                <Banner tone="info">
                  <Text as="p" variant="bodyMd">
                    <strong>{selected.productTitle}</strong> —{" "}
                    {selected.variantTitle}
                    <br />
                    SKU: {selected.sku ?? "—"} · Barcode:{" "}
                    {selected.barcode ?? "(will use SKU)"}
                    {selected.price != null && (
                      <>
                        {" "}
                        · Price: ${selected.price.toFixed(2)}
                      </>
                    )}
                  </Text>
                </Banner>
                <InlineStack gap="300" blockAlign="end">
                  <div style={{ maxWidth: "180px" }}>
                    <TextField
                      label="How many labels?"
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
                    {isGenerating ? "Generating…" : "Generate label PDF"}
                  </Button>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  PDF downloads to your browser. Open and print to your
                  Zebra printer. Label size: 2" × 1" (landscape).
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
