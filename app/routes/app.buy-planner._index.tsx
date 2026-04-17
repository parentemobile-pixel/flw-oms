import { useState, useCallback } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Banner,
  Badge,
  Button,
  InlineStack,
  TextField,
  Select,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { getProducts } from "../services/shopify-api/products.server";
import { getBuyRecommendations, updateInventoryConfig } from "../services/buy-planner/buy-recommendations.server";
import { syncSalesData } from "../services/buy-planner/sales-sync.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Get products from Shopify
  const productsData = await getProducts(admin, { first: 50 });
  const products = productsData.edges.map((edge: { node: Record<string, unknown> }) => ({
    productId: edge.node.id as string,
    title: edge.node.title as string,
    vendor: edge.node.vendor as string,
    variants: (
      (edge.node.variants as Record<string, unknown>)?.edges as Array<{ node: Record<string, unknown> }>
    )?.map(({ node }) => ({
      variantId: node.id as string,
      title: node.title as string,
      sku: node.sku as string,
      inventoryQuantity: (node.inventoryQuantity as number) || 0,
    })) || [],
  }));

  // Get buy recommendations
  const recommendations = await getBuyRecommendations(session.shop, products);

  // Get sync status
  const syncStatus = await db.syncStatus.findUnique({ where: { shop: session.shop } });

  return json({ recommendations, syncStatus, shop: session.shop });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "sync") {
    try {
      const result = await syncSalesData(admin, session.shop);
      return json({ syncSuccess: true, ordersProcessed: result.ordersProcessed });
    } catch (error) {
      return json({ syncError: `Sync failed: ${error}` });
    }
  }

  if (intent === "updateConfig") {
    const productId = formData.get("productId") as string;
    const variantId = formData.get("variantId") as string | null;
    const minLevel = parseInt(formData.get("minLevel") as string) || 0;
    const coverageDays = parseInt(formData.get("coverageDays") as string) || 90;

    await updateInventoryConfig(session.shop, productId, variantId, minLevel, coverageDays);
    return json({ configUpdated: true });
  }

  return json({});
};

export default function BuyPlanner() {
  const { recommendations, syncStatus } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSyncing = navigation.state === "submitting";

  const [sortBy, setSortBy] = useState("daysOfCoverage");
  const [filterVelocity, setFilterVelocity] = useState("all");

  const handleSync = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "sync");
    submit(formData, { method: "post" });
  }, [submit]);

  // Sort recommendations
  const sorted = [...recommendations].sort((a, b) => {
    switch (sortBy) {
      case "daysOfCoverage":
        return a.daysOfCoverage - b.daysOfCoverage;
      case "recommendedBuyQty":
        return b.recommendedBuyQty - a.recommendedBuyQty;
      case "avgDailySales":
        return b.avgDailySales - a.avgDailySales;
      case "currentStock":
        return a.currentStock - b.currentStock;
      default:
        return 0;
    }
  });

  // Filter
  const filtered = sorted.filter((r) => {
    if (filterVelocity === "active") return r.avgDailySales > 0;
    if (filterVelocity === "needsOrder") return r.recommendedBuyQty > 0;
    return true;
  });

  const coverageBadge = (days: number) => {
    if (days === 999) return <Badge>No sales data</Badge>;
    if (days <= 14) return <Badge tone="critical">{days}d</Badge>;
    if (days <= 30) return <Badge tone="warning">{days}d</Badge>;
    if (days <= 60) return <Badge tone="attention">{days}d</Badge>;
    return <Badge tone="success">{days}d</Badge>;
  };

  return (
    <Page
      title="Inventory Buy Planner"
      subtitle="Plan purchases based on sales velocity and coverage targets"
      primaryAction={{ content: "Sync Sales Data", onAction: handleSync, loading: isSyncing }}
      secondaryActions={[{ content: "Settings", url: "/app/buy-planner/settings" }]}
    >
      <Layout>
        {actionData && "syncSuccess" in actionData && (
          <Layout.Section>
            <Banner tone="success">
              Sales data synced successfully. Processed {(actionData as { ordersProcessed: number }).ordersProcessed} orders.
            </Banner>
          </Layout.Section>
        )}
        {actionData && "syncError" in actionData && (
          <Layout.Section>
            <Banner tone="critical">{actionData.syncError as string}</Banner>
          </Layout.Section>
        )}

        {syncStatus && (
          <Layout.Section>
            <Card>
              <InlineStack gap="400" align="space-between">
                <Text as="p" variant="bodySm" tone="subdued">
                  Last synced: {syncStatus.lastSyncAt ? new Date(syncStatus.lastSyncAt).toLocaleString() : "Never"}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Status: {syncStatus.status}
                </Text>
              </InlineStack>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <InlineStack gap="400">
              <Select
                label="Sort by"
                labelInline
                options={[
                  { label: "Days of Coverage (Low first)", value: "daysOfCoverage" },
                  { label: "Recommended Buy Qty (High first)", value: "recommendedBuyQty" },
                  { label: "Sales Velocity (High first)", value: "avgDailySales" },
                  { label: "Current Stock (Low first)", value: "currentStock" },
                ]}
                value={sortBy}
                onChange={setSortBy}
              />
              <Select
                label="Filter"
                labelInline
                options={[
                  { label: "All products", value: "all" },
                  { label: "Active sellers only", value: "active" },
                  { label: "Needs reorder", value: "needsOrder" },
                ]}
                value={filterVelocity}
                onChange={setFilterVelocity}
              />
            </InlineStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e1e3e5", background: "#fafbfb" }}>
                    <th style={{ padding: "10px 8px", textAlign: "left" }}>Product</th>
                    <th style={{ padding: "10px 8px", textAlign: "left" }}>Variant</th>
                    <th style={{ padding: "10px 8px", textAlign: "right" }}>Stock</th>
                    <th style={{ padding: "10px 8px", textAlign: "right" }}>Avg/Day</th>
                    <th style={{ padding: "10px 8px", textAlign: "center" }}>Coverage</th>
                    <th style={{ padding: "10px 8px", textAlign: "right" }}>Min Level</th>
                    <th style={{ padding: "10px 8px", textAlign: "right" }}>Target Days</th>
                    <th style={{ padding: "10px 8px", textAlign: "right", fontWeight: "bold" }}>Buy Qty</th>
                    <th style={{ padding: "10px 8px", textAlign: "right" }}>Last Year</th>
                    <th style={{ padding: "10px 8px", textAlign: "right" }}>This Year</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r, i) => (
                    <tr
                      key={`${r.shopifyVariantId}-${i}`}
                      style={{
                        borderBottom: "1px solid #f1f1f1",
                        background: r.recommendedBuyQty > 0 ? "#fff8f0" : undefined,
                      }}
                    >
                      <td style={{ padding: "8px" }}>{r.productTitle}</td>
                      <td style={{ padding: "8px" }}>{r.variantTitle}</td>
                      <td style={{ padding: "8px", textAlign: "right" }}>{r.currentStock}</td>
                      <td style={{ padding: "8px", textAlign: "right" }}>{r.avgDailySales}</td>
                      <td style={{ padding: "8px", textAlign: "center" }}>{coverageBadge(r.daysOfCoverage)}</td>
                      <td style={{ padding: "8px", textAlign: "right" }}>{r.minLevel}</td>
                      <td style={{ padding: "8px", textAlign: "right" }}>{r.coverageDays}</td>
                      <td style={{ padding: "8px", textAlign: "right", fontWeight: "bold", color: r.recommendedBuyQty > 0 ? "#b98900" : undefined }}>
                        {r.recommendedBuyQty > 0 ? r.recommendedBuyQty : "—"}
                      </td>
                      <td style={{ padding: "8px", textAlign: "right" }}>{r.lastYearSameMonth || "—"}</td>
                      <td style={{ padding: "8px", textAlign: "right" }}>{r.thisYearSameMonth || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filtered.length === 0 && (
              <div style={{ padding: "40px", textAlign: "center" }}>
                <Text as="p" tone="subdued">
                  No products found. Try syncing sales data or adjusting filters.
                </Text>
              </div>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
