import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import db from "../../db.server";
import { getVariantsInventory } from "../shopify-api/inventory.server";

/**
 * Nightly per-variant snapshot. One row per (shop, date, variantId).
 *
 * `on_hand`: sum across every location (can be negative — Shopify
 *   allows overselling; preserve the sign so downstream can subtract
 *   oversold units as "owed" in reorder math).
 * `units_sold`: net line-item quantity for the represented day across
 *   the whole shop (all channels, all locations). Sales minus refunds.
 * `unit_cost` + `price`: captured AT SNAPSHOT TIME. They drift, and
 *   that's what makes historical valuation impossible to reconstruct
 *   after the fact.
 *
 * Idempotent — safe to re-run for the same date. Callers should log
 * loudly on failure because gaps in this table are unrecoverable.
 */

// Lean catalog walk — id, productType, cost, price only. Levels come
// through the shared getVariantsInventory helper (which chunks at 50
// ids to stay under Shopify's per-query cost cap).
const SNAPSHOT_CATALOG_QUERY = `#graphql
  query VariantDayCatalog($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: TITLE) {
      edges {
        cursor
        node {
          id
          title
          productType
          variants(first: 100) {
            edges {
              node {
                id
                price
                inventoryItem {
                  unitCost { amount }
                }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface RawCatalogProduct {
  id: string;
  title: string;
  productType: string | null;
  variants: {
    edges: Array<{
      node: {
        id: string;
        price: string | null;
        inventoryItem: { unitCost: { amount: string } | null } | null;
      };
    }>;
  };
}

interface VariantMeta {
  variantId: string;
  productId: string;
  productTitle: string;
  productType: string;
  cost: number;
  price: number;
}

// Pull the whole catalog's per-variant metadata in one paginated pass.
async function collectVariantMetadata(
  admin: AdminApiContext,
): Promise<VariantMeta[]> {
  const out: VariantMeta[] = [];
  let after: string | null = null;
  let hasNext = true;
  while (hasNext) {
    const response = await admin.graphql(SNAPSHOT_CATALOG_QUERY, {
      variables: { first: 50, after },
    });
    const body = (await response.json()) as {
      data?: {
        products?: {
          edges: Array<{ node: RawCatalogProduct }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };
    const page = body.data?.products;
    if (!page) break;
    for (const edge of page.edges) {
      const p = edge.node;
      for (const vEdge of p.variants.edges) {
        const v = vEdge.node;
        out.push({
          variantId: v.id,
          productId: p.id,
          productTitle: p.title,
          productType: p.productType ?? "",
          cost:
            parseFloat(v.inventoryItem?.unitCost?.amount ?? "0") || 0,
          price: parseFloat(v.price ?? "0") || 0,
        });
      }
    }
    hasNext = page.pageInfo.hasNextPage;
    after = page.pageInfo.endCursor;
  }
  return out;
}

// Shop-wide net-units-sold per variant across a date window. Nets
// refunds at the line-item level using the same refundLineItems.id →
// original lineItem.id mapping the Replenishment service uses. No
// location or channel filter — we want the total.
const WINDOW_ORDERS_QUERY = `#graphql
  query VariantDayOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      edges {
        node {
          id
          lineItems(first: 100) {
            edges {
              node {
                id
                quantity
                variant { id }
              }
            }
          }
          refunds {
            refundLineItems(first: 100) {
              edges {
                node {
                  quantity
                  lineItem { id }
                }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function collectNetSoldByVariant(
  admin: AdminApiContext,
  dayStartIso: string,
  dayEndIso: string,
): Promise<Map<string, number>> {
  const byVariant = new Map<string, number>();
  const query =
    `processed_at:>='${dayStartIso}' AND processed_at:<='${dayEndIso}' ` +
    `AND financial_status:paid`;

  let after: string | null = null;
  let hasNext = true;
  while (hasNext) {
    const response = await admin.graphql(WINDOW_ORDERS_QUERY, {
      variables: { first: 50, after, query },
    });
    const body = (await response.json()) as {
      data?: {
        orders?: {
          edges: Array<{
            node: {
              id: string;
              lineItems: {
                edges: Array<{
                  node: {
                    id: string;
                    quantity: number;
                    variant: { id: string } | null;
                  };
                }>;
              };
              refunds: Array<{
                refundLineItems: {
                  edges: Array<{
                    node: {
                      quantity: number;
                      lineItem: { id: string } | null;
                    };
                  }>;
                };
              }>;
            };
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };
    const page = body.data?.orders;
    if (!page) break;
    for (const edge of page.edges) {
      const order = edge.node;
      // Per-line net (quantity - refunded quantity).
      const perLine = new Map<
        string,
        { variantId: string; net: number }
      >();
      for (const liEdge of order.lineItems.edges) {
        const li = liEdge.node;
        if (!li.variant?.id) continue;
        perLine.set(li.id, { variantId: li.variant.id, net: li.quantity });
      }
      for (const refund of order.refunds ?? []) {
        for (const rEdge of refund.refundLineItems?.edges ?? []) {
          const refunded = rEdge.node;
          if (!refunded.lineItem?.id) continue;
          const entry = perLine.get(refunded.lineItem.id);
          if (!entry) continue;
          entry.net -= refunded.quantity;
        }
      }
      for (const entry of perLine.values()) {
        if (entry.net === 0) continue;
        byVariant.set(
          entry.variantId,
          (byVariant.get(entry.variantId) ?? 0) + entry.net,
        );
      }
    }
    hasNext = page.pageInfo.hasNextPage;
    after = page.pageInfo.endCursor;
  }
  return byVariant;
}

function startOfDayUtc(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}
function endOfDayUtc(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(23, 59, 59, 999);
  return out;
}

export interface SnapshotResult {
  date: string;
  variantsWritten: number;
  productsSeen: number;
  totalOnHand: number;
  totalUnitsSold: number;
}

/**
 * Snapshot a specific date. Pass the day you want to represent —
 * on_hand and cost/price are captured LIVE (they reflect the moment
 * the job runs, not the historical value), while units_sold is the
 * net line-item quantity across the calendar day (00:00–23:59 UTC).
 *
 * Idempotent: existing rows for the (shop, date) tuple are wiped and
 * rewritten so re-runs converge on the current state.
 */
export async function buildVariantDaySnapshot(
  admin: AdminApiContext,
  shop: string,
  targetDate: Date = new Date(),
): Promise<SnapshotResult> {
  const dayStart = startOfDayUtc(targetDate);
  const dayEnd = endOfDayUtc(targetDate);
  const dayStartIso = dayStart.toISOString();
  const dayEndIso = dayEnd.toISOString();

  // Pass 1: variant metadata (cost, price, product_type).
  const meta = await collectVariantMetadata(admin);
  const productIds = new Set<string>();
  for (const m of meta) productIds.add(m.productId);

  // Pass 2: shop-wide net-sold in the window.
  const soldByVariant = await collectNetSoldByVariant(
    admin,
    dayStartIso,
    dayEndIso,
  );

  // Pass 3: inventory levels per variant (batched at 50 ids by helper).
  const variantIds = meta.map((m) => m.variantId);
  const invMap = await getVariantsInventory(admin, variantIds);

  let totalOnHand = 0;
  let totalUnitsSold = 0;
  const rows = meta.map((m) => {
    const inv = invMap.get(m.variantId);
    const onHand = inv
      ? inv.levels.reduce((s, l) => s + (l.quantities.available ?? 0), 0)
      : 0;
    const unitsSold = soldByVariant.get(m.variantId) ?? 0;
    totalOnHand += onHand;
    totalUnitsSold += unitsSold;
    return {
      shop,
      date: dayEnd,
      shopifyVariantId: m.variantId,
      shopifyProductId: m.productId,
      productTitle: m.productTitle,
      productType: m.productType,
      onHand,
      unitsSold,
      unitCost: m.cost,
      price: m.price,
    };
  });

  // Idempotent write. deleteMany + createMany in a transaction so the
  // date is never partially populated.
  await db.$transaction([
    db.variantDaySnapshot.deleteMany({ where: { shop, date: dayEnd } }),
    db.variantDaySnapshot.createMany({ data: rows }),
  ]);

  return {
    date: dayEnd.toISOString(),
    variantsWritten: rows.length,
    productsSeen: productIds.size,
    totalOnHand,
    totalUnitsSold,
  };
}
