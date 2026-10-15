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
  InlineGrid,
} from "@shopify/polaris";
import type { ReactNode } from "react";

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
  { label: "Stock Counts", url: "/app/stock-counts", hint: "Rolling cycle counts + not-counted report" },
  { label: "Forecast", url: "/app/forecast", hint: "Demand forecast + suggested reorder quantities" },
  { label: "Planning", url: "/app/planning", hint: "Trailing sales + suggested order table" },
  { label: "Reports", url: "/app/reports", hint: "Inventory value trend + snapshots" },
  { label: "Product Issues", url: "/app/product-issues", hint: "Duplicate/missing barcodes, negative stock, missing cost" },
  { label: "Products", url: "/app/products", hint: "Bulk vendor, cost, tag, archive" },
];

// Equal-height home tile. Polaris Card has no height prop, so the
// wrapper forces Card's own elements to fill the grid cell, and the
// buttons are pushed to the bottom so they line up across a row.
function Tile({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flw-home-tile">
      <Card>
        <div className="flw-home-tile__body">
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              {title}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {description}
            </Text>
          </BlockStack>
          {/* InlineStack keeps buttons auto-sized instead of stretching */}
          <InlineStack gap="200">{children}</InlineStack>
        </div>
      </Card>
    </div>
  );
}

const TILE_CSS = `
.flw-home-tile, .flw-home-tile > div, .flw-home-tile > div > div { height: 100%; }
.flw-home-tile__body { display: flex; flex-direction: column; justify-content: space-between; gap: var(--p-space-300); height: 100%; }
`;

export default function Index() {
  const { pos, transfers } = useLoaderData<typeof loader>();

  return (
    <Page
      title="FLW OMS"
      subtitle="Order management for the FL Woods team"
    >
      <style>{TILE_CSS}</style>
      <Layout>
        {/* Five primary tiles — one grid so every tile shares the same
            width and each row's tiles stretch to the same height (the
            old oneHalf sections sized to content and let the odd fifth
            tile stretch full-width). */}
        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Tile
              title="Purchase Orders"
              description={`${pos.draft ?? 0} draft · ${pos.ordered ?? 0} ordered · ${pos.partially_received ?? 0} partial · ${pos.received ?? 0} received`}
            >
              <Button url="/app/purchase-orders">View all</Button>
              <Button url="/app/purchase-orders/new" variant="primary">
                New PO
              </Button>
            </Tile>

            <Tile
              title="Transfers"
              description={`${transfers.draft ?? 0} draft · ${transfers.in_transit ?? 0} in transit · ${transfers.received ?? 0} received`}
            >
              <Button url="/app/transfers">View all</Button>
              <Button url="/app/transfers/new" variant="primary">
                New transfer
              </Button>
            </Tile>

            <Tile
              title="Print Labels"
              description="Search a product, pick a variant, print barcode labels to the Zebra."
            >
              <Button url="/app/print-labels" variant="primary">
                Print labels
              </Button>
            </Tile>

            <Tile
              title="Product Builder"
              description="New product with size/color variants, barcodes, tagging taxonomy — one flow."
            >
              <Button url="/app/product-builder" variant="primary">
                Create product
              </Button>
            </Tile>

            <Tile
              title="Replenishment"
              description="What sold at one store, what's available at the other, and what to transfer."
            >
              <Button url="/app/replenishment" variant="primary">
                Run replenishment
              </Button>
            </Tile>
          </InlineGrid>
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
