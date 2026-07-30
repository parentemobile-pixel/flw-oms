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
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  // Just the counts the primary tiles show — nothing else. AIChat +
  // What Needs Attention + Recent Adjustments are gone; loader is
  // scoped tight so the page paints instantly with no hydration jump.
  const [poCounts, transferCounts] = await Promise.all([
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
  ]);

  const counts = (rows: typeof poCounts) =>
    rows.reduce(
      (acc, r) => ({ ...acc, [(r as any).status]: (r as any)._count }),
      {} as Record<string, number>,
    );

  return json({
    pos: counts(poCounts),
    transfers: counts(transferCounts),
  });
};

// Secondary tools — the tiles are the daily-driver modules; these live
// as a compact list so Home doesn't get busy. Order intentional: the
// most-used inventory tools first, admin / reference tools last.
const SECONDARY_LINKS: Array<{ label: string; url: string; hint: string }> = [
  { label: "On Hand", url: "/app/on-hand", hint: "Grid of what's in stock at a location" },
  { label: "Inventory Adjust", url: "/app/adjust", hint: "Correct stock levels with a reason code" },
  { label: "Stock Counts", url: "/app/stock-counts", hint: "Cycle counts + reconciliation" },
  { label: "Forecast", url: "/app/forecast", hint: "Demand forecast + suggested reorder quantities" },
  { label: "Planning", url: "/app/planning", hint: "Trailing sales + suggested order table" },
  { label: "Reports", url: "/app/reports", hint: "Inventory value trend + snapshots" },
  { label: "Barcode Check", url: "/app/barcodes", hint: "Audit + generate missing barcodes" },
  { label: "Products", url: "/app/products", hint: "Bulk vendor, cost, tag, archive" },
];

export default function Index() {
  const { pos, transfers } = useLoaderData<typeof loader>();

  return (
    <Page
      title="FL Woods – OMS"
      subtitle="Order management for the FL Woods team"
    >
      <Layout>
        {/* Five primary tiles */}
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

        {/* Print Labels — simple tile button (matches PO / Transfers
            style). Full search-and-print flow lives on the dedicated
            /app/print-labels page. Placed in Replenishment's former
            slot so it sits higher in the daily-driver order.
            Buttons wrapped in InlineStack so they auto-size instead of
            stretching to the card width (BlockStack's default
            inlineAlign="stretch" is what does the stretching). */}
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Print Labels
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Search a product, pick a variant, print barcode labels
                to the Zebra.
              </Text>
              <InlineStack gap="200">
                <Button url="/app/print-labels" variant="primary">
                  Print labels
                </Button>
              </InlineStack>
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
                New product with size/color variants, barcodes, tagging
                taxonomy — one flow.
              </Text>
              <InlineStack gap="200">
                <Button url="/app/product-builder" variant="primary">
                  Create product
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Replenishment
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                What sold at one store, what's available at the other, and
                what to transfer.
              </Text>
              <InlineStack gap="200">
                <Button url="/app/replenishment" variant="primary">
                  Run replenishment
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Secondary tools — everything else, compact list */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingSm">
                More tools
              </Text>
              <BlockStack gap="150">
                {SECONDARY_LINKS.map((item) => (
                  <InlineStack
                    key={item.url}
                    align="space-between"
                    blockAlign="center"
                  >
                    <BlockStack gap="050">
                      <Link
                        to={item.url}
                        style={{
                          color: "#1e88e5",
                          textDecoration: "none",
                          fontSize: "14px",
                          fontWeight: 500,
                        }}
                      >
                        {item.label}
                      </Link>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {item.hint}
                      </Text>
                    </BlockStack>
                    <Link
                      to={item.url}
                      style={{
                        color: "#637381",
                        textDecoration: "none",
                        fontSize: "13px",
                      }}
                    >
                      Open →
                    </Link>
                  </InlineStack>
                ))}
              </BlockStack>
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
