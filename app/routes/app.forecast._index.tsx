import { useState, useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useSubmit, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  TextField,
  Button,
  InlineStack,
  Icon,
  Spinner,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import { searchProducts } from "../services/shopify-api/products.server";

interface ProductHit {
  productId: string;
  productTitle: string;
  productType: string | null;
  vendor: string | null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const query = String(formData.get("query") ?? "").trim();
  if (!query) return json({ products: [] as ProductHit[] });
  try {
    const result = await searchProducts(admin, query);
    const products: ProductHit[] = [];
    const seen = new Set<string>();
    for (const edge of result.edges as Array<{ node: any }>) {
      const p = edge.node;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      products.push({
        productId: p.id,
        productTitle: p.title,
        productType: p.productType ?? null,
        vendor: p.vendor ?? null,
      });
    }
    return json({ products });
  } catch (error) {
    return json({
      products: [] as ProductHit[],
      error: String(error),
    });
  }
};

export default function ForecastIndex() {
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [isSearching, setSearching] = useState(false);

  useEffect(() => {
    if (!query.trim()) return;
    const t = setTimeout(() => {
      const fd = new FormData();
      fd.set("query", query);
      setSearching(true);
      submit(fd, { method: "post" });
    }, 300);
    return () => clearTimeout(t);
  }, [query, submit]);

  useEffect(() => {
    if (actionData) setSearching(false);
  }, [actionData]);

  const results = actionData?.products ?? [];

  return (
    <Page
      title="Order Projection"
      subtitle="Pick a product to forecast demand and get a suggested reorder."
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <TextField
                label="Search products"
                labelHidden
                value={query}
                onChange={setQuery}
                placeholder="Search by product title, SKU, or vendor…"
                autoComplete="off"
                prefix={<Icon source={SearchIcon} />}
                clearButton
                onClearButtonClick={() => setQuery("")}
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
                  {results.map((p) => {
                    const numericId = p.productId.split("/").pop() ?? p.productId;
                    return (
                      <div
                        key={p.productId}
                        onClick={() => navigate(`/app/forecast/${numericId}`)}
                        style={{
                          padding: "10px 12px",
                          borderRadius: "6px",
                          cursor: "pointer",
                          border: "1px solid #e1e3e5",
                        }}
                      >
                        <InlineStack align="space-between" blockAlign="center">
                          <BlockStack gap="050">
                            <Text as="p" variant="bodyMd" fontWeight="medium">
                              {p.productTitle}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {[p.vendor, p.productType]
                                .filter(Boolean)
                                .join(" · ") || "—"}
                            </Text>
                          </BlockStack>
                          <Button size="slim">Forecast</Button>
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
        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
