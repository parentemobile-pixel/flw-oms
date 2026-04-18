import { Suspense, lazy } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Button,
  InlineStack,
  Badge,
  Divider,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import db from "../db.server";

// Lazy-load the AIChat so the dashboard paints first. This materially
// improves perceived load time — Home shows the "what needs attention" card,
// stats, and quick actions before the chat widget hydrates.
const AIChat = lazy(() =>
  import("../components/AIChat").then((m) => ({ default: m.AIChat })),
);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const now = new Date();

  const [
    poCounts,
    transferCounts,
    inProgressCountCount,
    latePOs,
    syncStatus,
    recentSessions,
  ] = await Promise.all([
    // PO aggregate counts
    db.purchaseOrder.groupBy({
      by: ["status"],
      where: { shop: session.shop },
      _count: true,
    }),
    db.inventoryTransfer.groupBy({
      by: ["status"],
      where: { shop: session.shop },
      _count: true,
    }),
    db.stockCount.count({
      where: { shop: session.shop, status: "in_progress" },
    }),
    // POs with expected date in the past and not fully received
    db.purchaseOrder.findMany({
      where: {
        shop: session.shop,
        expectedDate: { lt: now },
        status: { in: ["ordered", "partially_received"] },
      },
      select: {
        id: true,
        poNumber: true,
        vendor: true,
        expectedDate: true,
      },
      orderBy: { expectedDate: "asc" },
      take: 5,
    }),
    db.syncStatus.findUnique({ where: { shop: session.shop } }),
    db.inventoryAdjustmentSession.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { _count: { select: { changes: true } } },
    }),
  ]);

  const counts = (key: "status", rows: typeof poCounts) =>
    rows.reduce(
      (acc, r) => ({ ...acc, [(r as any)[key]]: (r as any)._count }),
      {} as Record<string, number>,
    );

  return json({
    pos: counts("status", poCounts),
    transfers: counts("status", transferCounts),
    inProgressStockCounts: inProgressCountCount,
    latePOs,
    syncStatus,
    recentSessions,
  });
};

function formatDateShort(d: Date | string | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export default function Index() {
  const {
    pos,
    transfers,
    inProgressStockCounts,
    latePOs,
    syncStatus,
    recentSessions,
  } = useLoaderData<typeof loader>();

  // Count "needs attention" items
  const attentionItems: Array<{
    label: string;
    tone: "critical" | "warning" | "info";
    url: string;
  }> = [];
  if (latePOs.length > 0) {
    attentionItems.push({
      label: `${latePOs.length} PO${latePOs.length !== 1 ? "s" : ""} past expected date`,
      tone: "critical",
      url: "/app/purchase-orders",
    });
  }
  if ((pos.draft ?? 0) > 0) {
    attentionItems.push({
      label: `${pos.draft} draft PO${pos.draft !== 1 ? "s" : ""} to finalize`,
      tone: "warning",
      url: "/app/purchase-orders",
    });
  }
  if ((transfers.in_transit ?? 0) > 0) {
    attentionItems.push({
      label: `${transfers.in_transit} transfer${transfers.in_transit !== 1 ? "s" : ""} awaiting receipt`,
      tone: "warning",
      url: "/app/transfers",
    });
  }
  if (inProgressStockCounts > 0) {
    attentionItems.push({
      label: `${inProgressStockCounts} stock count${inProgressStockCounts !== 1 ? "s" : ""} in progress`,
      tone: "info",
      url: "/app/stock-counts",
    });
  }

  return (
    <Page
      title="FL Woods – OMS"
      subtitle="Order management for the FL Woods team"
    >
      <Layout>
        {/* Needs attention */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                What needs attention
              </Text>
              {attentionItems.length === 0 ? (
                <Text as="p" tone="subdued">
                  🎉 All clear. No POs late, no drafts, no unreceived
                  transfers, no open counts.
                </Text>
              ) : (
                <BlockStack gap="200">
                  {attentionItems.map((item, i) => (
                    <InlineStack
                      key={i}
                      align="space-between"
                      blockAlign="center"
                    >
                      <InlineStack gap="200" blockAlign="center">
                        <Badge
                          tone={
                            item.tone === "critical"
                              ? "critical"
                              : item.tone === "warning"
                                ? "warning"
                                : "info"
                          }
                        >
                          {item.tone === "critical" ? "!" : "•"}
                        </Badge>
                        <Text as="span" variant="bodyMd">
                          {item.label}
                        </Text>
                      </InlineStack>
                      <Link
                        to={item.url}
                        style={{
                          color: "#1e88e5",
                          textDecoration: "none",
                          fontSize: "13px",
                        }}
                      >
                        Review →
                      </Link>
                    </InlineStack>
                  ))}
                  {latePOs.length > 0 && (
                    <>
                      <Divider />
                      <Text as="p" variant="bodySm" tone="subdued">
                        Late POs:
                      </Text>
                      {latePOs.slice(0, 5).map((po) => (
                        <InlineStack
                          key={po.id}
                          align="space-between"
                          blockAlign="center"
                        >
                          <Link
                            to={`/app/purchase-orders/${po.id}`}
                            style={{
                              textDecoration: "none",
                              color: "inherit",
                            }}
                          >
                            <Text as="span" variant="bodySm">
                              {po.poNumber}
                              {po.vendor ? ` — ${po.vendor}` : ""}
                            </Text>
                          </Link>
                          <Text
                            as="span"
                            variant="bodySm"
                            tone="critical"
                          >
                            expected {formatDateShort(po.expectedDate)}
                          </Text>
                        </InlineStack>
                      ))}
                    </>
                  )}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Quick action cards */}
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Purchase Orders
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {pos.draft ?? 0} draft · {pos.ordered ?? 0} ordered ·{" "}
                {pos.partially_received ?? 0} partial ·{" "}
                {pos.received ?? 0} received
              </Text>
              <InlineStack gap="200">
                <Button url="/app/purchase-orders">View all</Button>
                <Button url="/app/purchase-orders/new" variant="primary">
                  New PO
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Transfers
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {transfers.draft ?? 0} draft ·{" "}
                {transfers.in_transit ?? 0} in transit ·{" "}
                {transfers.received ?? 0} received
              </Text>
              <InlineStack gap="200">
                <Button url="/app/transfers">View all</Button>
                <Button url="/app/transfers/new" variant="primary">
                  New transfer
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Stock Counts
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {inProgressStockCounts} in progress
              </Text>
              <Button url="/app/stock-counts">Open</Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Planning
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Sales data last synced:{" "}
                {syncStatus?.lastSyncAt
                  ? new Date(syncStatus.lastSyncAt).toLocaleDateString()
                  : "never"}
              </Text>
              <Button url="/app/planning">Open planning</Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Product Builder
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Create a new product with size/color variants, barcodes,
                and tagging taxonomy.
              </Text>
              <Button url="/app/product-builder">Create product</Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Inventory
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Adjust on-hand at a location, print extra labels, audit
                recent changes.
              </Text>
              <InlineStack gap="200">
                <Button url="/app/adjust">Adjust</Button>
                <Button url="/app/print-labels">Print labels</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Recent adjustments (audit log) */}
        {recentSessions.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Recent inventory changes
                </Text>
                {recentSessions.map((s) => (
                  <InlineStack
                    key={s.id}
                    align="space-between"
                    blockAlign="center"
                  >
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm">
                        {s.reason.replace(/_/g, " ")} · {s.source.replace(
                          /_/g,
                          " ",
                        )}
                        {s.notes ? ` — ${s.notes}` : ""}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {new Date(s.createdAt).toLocaleString()} ·{" "}
                        {(s as any)._count?.changes ?? 0} change
                        {(s as any)._count?.changes === 1 ? "" : "s"}
                      </Text>
                    </BlockStack>
                  </InlineStack>
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* AIChat — lazy-loaded so dashboard paints first */}
        <Layout.Section>
          <Suspense
            fallback={
              <Card>
                <Text as="p" tone="subdued">
                  Loading AI assistant…
                </Text>
              </Card>
            }
          >
            <AIChat />
          </Suspense>
        </Layout.Section>

        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
