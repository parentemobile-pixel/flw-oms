import { useCallback, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "@remix-run/node";
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
  Badge,
  Divider,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { runProductForecast } from "../services/forecast/forecast-service.server";

const PRODUCT_META_QUERY = `#graphql
  query ForecastProductMeta($id: ID!) {
    product(id: $id) {
      id
      title
      productType
      vendor
      variants(first: 100) {
        edges {
          node {
            id
            title
            sku
          }
        }
      }
    }
  }
`;

function normalizeProductGid(idParam: string): string {
  return idParam.startsWith("gid://")
    ? idParam
    : `gid://shopify/Product/${idParam}`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (!params.productId) return redirect("/app/forecast");
  const productGid = normalizeProductGid(params.productId);

  const response = await admin.graphql(PRODUCT_META_QUERY, {
    variables: { id: productGid },
  });
  const body = (await response.json()) as {
    data?: {
      product?: {
        id: string;
        title: string;
        productType: string | null;
        vendor: string | null;
        variants: {
          edges: Array<{
            node: { id: string; title: string; sku: string | null };
          }>;
        };
      } | null;
    };
  };
  const product = body.data?.product;
  if (!product) return redirect("/app/forecast");

  const variants = product.variants.edges.map((e) => e.node);

  // Look up per-product config for the initial defaults.
  const { default: db } = await import("../db.server");
  const config = await db.productForecastConfig.findUnique({
    where: {
      shop_shopifyProductId: {
        shop: session.shop,
        shopifyProductId: productGid,
      },
    },
  });

  return json({
    product: {
      id: product.id,
      title: product.title,
      productType: product.productType,
      vendor: product.vendor,
      variants,
    },
    config,
  });
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  if (!params.productId) return json({ error: "Missing product id." });
  const productGid = normalizeProductGid(params.productId);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "forecast");

  if (intent === "saveConfig") {
    const { default: db } = await import("../db.server");
    const category = String(formData.get("category") ?? "").trim() || null;
    const safetyBuffer = parseOptionalFloat(formData.get("safetyBuffer"));
    const growth = parseOptionalFloat(formData.get("growth"));
    const leadTimeDays = parseOptionalInt(formData.get("leadTimeDays"));
    const moq = parseOptionalInt(formData.get("moq"));
    const casePack = parseOptionalInt(formData.get("casePack"));
    await db.productForecastConfig.upsert({
      where: {
        shop_shopifyProductId: {
          shop: session.shop,
          shopifyProductId: productGid,
        },
      },
      create: {
        shop: session.shop,
        shopifyProductId: productGid,
        category,
        safetyBuffer,
        growth,
        leadTimeDays,
        moq,
        casePack,
      },
      update: {
        category,
        safetyBuffer,
        growth,
        leadTimeDays,
        moq,
        casePack,
      },
    });
    return json({ configSaved: true });
  }

  // intent === "forecast"
  const coverageStart = new Date(
    String(formData.get("coverageStart") ?? new Date().toISOString().slice(0, 10)),
  );
  const coverageMonths = Math.max(
    1,
    parseInt(String(formData.get("coverageMonths") ?? "3"), 10),
  );
  const safetyBuffer = parseOptionalFloat(formData.get("safetyBuffer"));
  const growth = parseOptionalFloat(formData.get("growth"));

  try {
    const result = await runProductForecast({
      shop: session.shop,
      productId: productGid,
      coverageStart,
      coverageMonths,
      safetyBuffer: safetyBuffer ?? undefined,
      growth: growth ?? undefined,
    });
    if (!result) {
      return json({
        error:
          "No snapshot history for this product yet. Wait for the nightly snapshot to fire, or run the backfill.",
      });
    }
    return json({ forecast: result });
  } catch (error) {
    return json({
      error: `Forecast failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
};

function parseOptionalFloat(raw: FormDataEntryValue | null): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function parseOptionalInt(raw: FormDataEntryValue | null): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

interface ForecastVariantOutput {
  variantId: string;
  onHand: number;
  onOrder: number;
  variantShare: number;
  forecastUnits: number;
  suggestedOrder: number;
  confidence: string;
}

interface ForecastPayload {
  forecast?: {
    productId: string;
    styleRate: number;
    monthsOfHistory: number;
    confidence: "LOW" | "MEDIUM" | "GOOD";
    totalForecast: number;
    totalSuggestedOrder: number;
    belowMoq: boolean;
    variants: ForecastVariantOutput[];
    categoryUsed: string;
  };
  configSaved?: boolean;
  error?: string;
}

export default function ProductForecast() {
  const { product, config } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ForecastPayload | undefined;
  const submit = useSubmit();
  const navigation = useNavigation();
  const isBusy = navigation.state === "submitting";

  const [coverageStart, setCoverageStart] = useState(isoDate(new Date()));
  const [coverageMonths, setCoverageMonths] = useState("3");
  const [safetyBuffer, setSafetyBuffer] = useState(
    config?.safetyBuffer != null ? String(config.safetyBuffer) : "0.25",
  );
  const [growth, setGrowth] = useState(
    config?.growth != null ? String(config.growth) : "0.20",
  );
  const [category, setCategory] = useState(config?.category ?? "");
  const [leadTimeDays, setLeadTimeDays] = useState(
    config?.leadTimeDays != null ? String(config.leadTimeDays) : "",
  );
  const [moq, setMoq] = useState(config?.moq != null ? String(config.moq) : "");
  const [casePack, setCasePack] = useState(
    config?.casePack != null ? String(config.casePack) : "",
  );

  const handleRunForecast = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "forecast");
    fd.set("coverageStart", coverageStart);
    fd.set("coverageMonths", coverageMonths);
    fd.set("safetyBuffer", safetyBuffer);
    fd.set("growth", growth);
    submit(fd, { method: "post" });
  }, [coverageStart, coverageMonths, safetyBuffer, growth, submit]);

  const handleSaveConfig = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "saveConfig");
    fd.set("category", category);
    fd.set("safetyBuffer", safetyBuffer);
    fd.set("growth", growth);
    fd.set("leadTimeDays", leadTimeDays);
    fd.set("moq", moq);
    fd.set("casePack", casePack);
    submit(fd, { method: "post" });
  }, [category, safetyBuffer, growth, leadTimeDays, moq, casePack, submit]);

  const variantMeta = useMemo(() => {
    const map = new Map<string, { title: string; sku: string | null }>();
    for (const v of product.variants) {
      map.set(v.id, { title: v.title, sku: v.sku });
    }
    return map;
  }, [product.variants]);

  const forecast = actionData?.forecast;
  const confidenceTone = (c: string): "success" | "warning" | "critical" => {
    if (c === "GOOD") return "success";
    if (c === "MEDIUM") return "warning";
    return "critical";
  };

  return (
    <Page
      title={product.title}
      subtitle={[product.vendor, product.productType].filter(Boolean).join(" · ")}
      backAction={{ url: "/app/forecast" }}
    >
      <Layout>
        {actionData?.error && (
          <Layout.Section>
            <Banner tone="critical">{actionData.error}</Banner>
          </Layout.Section>
        )}
        {actionData?.configSaved && (
          <Layout.Section>
            <Banner tone="success">Config saved.</Banner>
          </Layout.Section>
        )}

        {/* Coverage window controls */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Coverage window
              </Text>
              <InlineStack gap="400" wrap blockAlign="end">
                <div style={{ minWidth: "160px" }}>
                  <TextField
                    label="Coverage start"
                    type="date"
                    value={coverageStart}
                    onChange={setCoverageStart}
                    autoComplete="off"
                  />
                </div>
                <div style={{ maxWidth: "120px" }}>
                  <TextField
                    label="Months"
                    type="number"
                    value={coverageMonths}
                    onChange={setCoverageMonths}
                    min={1}
                    max={24}
                    autoComplete="off"
                  />
                </div>
                <div style={{ maxWidth: "140px" }}>
                  <TextField
                    label="Safety buffer"
                    type="number"
                    step={0.05}
                    value={safetyBuffer}
                    onChange={setSafetyBuffer}
                    autoComplete="off"
                    helpText="0.25 = +25%"
                  />
                </div>
                <div style={{ maxWidth: "140px" }}>
                  <TextField
                    label="Growth"
                    type="number"
                    step={0.05}
                    value={growth}
                    onChange={setGrowth}
                    autoComplete="off"
                    helpText="0.20 = +20% YoY"
                  />
                </div>
                <Button
                  variant="primary"
                  onClick={handleRunForecast}
                  loading={isBusy}
                >
                  Run forecast
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Per-variant table */}
        {forecast && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="050">
                    <Text as="h2" variant="headingMd">
                      Reorder projection
                    </Text>
                    <InlineStack gap="200">
                      <Badge tone={confidenceTone(forecast.confidence)}>
                        {`${forecast.confidence} — ${forecast.monthsOfHistory} mo history`}
                      </Badge>
                      <Text as="span" tone="subdued" variant="bodySm">
                        Style rate: {forecast.styleRate.toFixed(2)} units per in-stock month
                        {" · "}
                        Seasonality category: {forecast.categoryUsed || "default"}
                      </Text>
                    </InlineStack>
                  </BlockStack>
                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                    Total suggested: {forecast.totalSuggestedOrder} units
                  </Text>
                </InlineStack>
                {forecast.belowMoq && (
                  <Banner tone="warning">
                    Total suggested order is below MOQ ({config?.moq}). Bump
                    quantities manually or drop the order.
                  </Banner>
                )}
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
                          Variant
                        </th>
                        <th style={{ padding: "8px", textAlign: "right" }}>
                          Share
                        </th>
                        <th style={{ padding: "8px", textAlign: "right" }}>
                          On hand
                        </th>
                        <th style={{ padding: "8px", textAlign: "right" }}>
                          On order
                        </th>
                        <th style={{ padding: "8px", textAlign: "right" }}>
                          Forecast
                        </th>
                        <th style={{ padding: "8px", textAlign: "right" }}>
                          Suggested
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {forecast.variants.map((v) => {
                        const meta = variantMeta.get(v.variantId);
                        return (
                          <tr
                            key={v.variantId}
                            style={{ borderBottom: "1px solid #f1f1f1" }}
                          >
                            <td style={{ padding: "8px" }}>
                              {meta?.title ?? v.variantId}
                              {meta?.sku && (
                                <Text as="span" tone="subdued" variant="bodySm">
                                  {" "}
                                  · {meta.sku}
                                </Text>
                              )}
                            </td>
                            <td
                              style={{ padding: "8px", textAlign: "right" }}
                            >
                              {(v.variantShare * 100).toFixed(1)}%
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                textAlign: "right",
                                color: v.onHand < 0 ? "#c9184a" : undefined,
                              }}
                            >
                              {v.onHand}
                            </td>
                            <td style={{ padding: "8px", textAlign: "right" }}>
                              {v.onOrder}
                            </td>
                            <td style={{ padding: "8px", textAlign: "right" }}>
                              {v.forecastUnits.toFixed(1)}
                            </td>
                            <td
                              style={{
                                padding: "8px",
                                textAlign: "right",
                                fontWeight: 600,
                              }}
                            >
                              {v.suggestedOrder}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <Text as="p" tone="subdued" variant="bodySm">
                  Confidence flag:{" "}
                  {forecast.confidence === "LOW" &&
                    "under 4 months of history — treat these numbers as directional."}
                  {forecast.confidence === "MEDIUM" &&
                    "4–8 months of history — reasonable, still noisy on new colorways."}
                  {forecast.confidence === "GOOD" &&
                    "9+ months of history — solid signal."}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Config override */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Product overrides
              </Text>
              <Text as="p" tone="subdued" variant="bodySm">
                Override the forecast defaults for this specific product.
                Unset fields fall back to the global defaults.
              </Text>
              <InlineStack gap="400" wrap>
                <div style={{ maxWidth: "180px" }}>
                  <TextField
                    label="Category"
                    value={category}
                    onChange={setCategory}
                    placeholder={product.productType ?? "default"}
                    autoComplete="off"
                    helpText="Seasonality lookup key. Blank = productType."
                  />
                </div>
                <div style={{ maxWidth: "140px" }}>
                  <TextField
                    label="Lead time (days)"
                    type="number"
                    value={leadTimeDays}
                    onChange={setLeadTimeDays}
                    autoComplete="off"
                  />
                </div>
                <div style={{ maxWidth: "120px" }}>
                  <TextField
                    label="MOQ"
                    type="number"
                    value={moq}
                    onChange={setMoq}
                    autoComplete="off"
                  />
                </div>
                <div style={{ maxWidth: "120px" }}>
                  <TextField
                    label="Case pack"
                    type="number"
                    value={casePack}
                    onChange={setCasePack}
                    autoComplete="off"
                  />
                </div>
              </InlineStack>
              <Divider />
              <InlineStack align="end">
                <Button onClick={handleSaveConfig} loading={isBusy}>
                  Save overrides
                </Button>
              </InlineStack>
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
