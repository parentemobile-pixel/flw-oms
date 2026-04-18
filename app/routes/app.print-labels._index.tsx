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
        variants.push({
          variantId: vEdge.node.id,
          productTitle: product.title,
          variantTitle: vEdge.node.title,
          sku: vEdge.node.sku ?? null,
          barcode: vEdge.node.barcode ?? null,
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

  const handlePrint = useCallback(() => {
    if (!selected) return;
    const qty = Math.max(1, Math.min(500, parseInt(quantity, 10) || 1));
    const fd = new FormData();
    fd.set("quantity", String(qty));
    fd.set("productTitle", selected.productTitle);
    fd.set("variantTitle", selected.variantTitle);
    fd.set("sku", selected.sku ?? "");
    fd.set("barcode", selected.barcode ?? "");
    // Use a native form submit so the browser handles the PDF download.
    const form = document.createElement("form");
    form.method = "post";
    form.action = "/api/labels/adhoc";
    form.target = "_blank";
    for (const [k, v] of fd.entries()) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = k;
      input.value = String(v);
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    document.body.removeChild(form);
  }, [selected, quantity]);

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
                  <Button variant="primary" onClick={handlePrint}>
                    Generate label PDF
                  </Button>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  PDF opens in a new tab. Use your browser's print dialog to
                  send to the Zebra printer. Label size: 2.25" × 1.25".
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
