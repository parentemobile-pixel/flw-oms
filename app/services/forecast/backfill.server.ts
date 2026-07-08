import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import db from "../../db.server";

/**
 * One-shot historical backfill of VariantMonthSnapshot rows from the
 * Shopify Orders API. Runs the same net-line-item aggregation the
 * VariantDaySnapshot job uses, but grouped by (variant, month) so
 * pre-cutover months have SOMETHING to feed the forecast engine.
 *
 * inStockFraction defaults to 1.0 with a documented TODO for the
 * ShopifyQL-based availability approximation the spec calls for
 * (starting_units + ending_units per (variant, month) → 0/0.25/0.5/1.0
 * mapping). ShopifyQL access is Plus-gated in some tiers, so this
 * v1 falls back to the conservative "assume stocked" value. Under-
 * estimating in-stock fraction UNDER-estimates demand rate, so with
 * fraction=1.0 the engine's LOW-confidence gate catches sparse
 * data before it drives a bad order.
 *
 * Once daily VariantDaySnapshot rows accumulate for a month, the
 * forecast engine prefers those (they carry an exact fraction) and
 * falls back to this table only for pre-cutover history.
 */

const MONTH_ORDERS_QUERY = `#graphql
  query BackfillMonthOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      edges {
        node {
          id
          lineItems(first: 100) {
            edges {
              node {
                id
                quantity
                variant { id product { id title productType } }
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

interface MonthAggregate {
  variantId: string;
  productId: string;
  productTitle: string;
  productType: string;
  unitsSold: number;
}

/**
 * Pull net-sold units per variant across one calendar month. Same
 * refund-netting the daily snapshot does — refund quantities subtract
 * from the original line item's net. Line items whose parent order
 * was fully refunded end up at net=0 and are excluded.
 */
async function pullMonth(
  admin: AdminApiContext,
  monthIso: string,
): Promise<Map<string, MonthAggregate>> {
  const [yyyy, mm] = monthIso.split("-").map((s) => parseInt(s, 10));
  // Last day of the month = day 0 of the next month.
  const lastDay = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
  const startIso = `${monthIso}-01T00:00:00Z`;
  const endIso = `${monthIso}-${String(lastDay).padStart(2, "0")}T23:59:59Z`;
  const query =
    `processed_at:>='${startIso}' AND processed_at:<='${endIso}' ` +
    `AND financial_status:paid`;

  const byVariant = new Map<string, MonthAggregate>();
  let after: string | null = null;
  let hasNext = true;
  while (hasNext) {
    const response = await admin.graphql(MONTH_ORDERS_QUERY, {
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
                    variant: {
                      id: string;
                      product: {
                        id: string;
                        title: string;
                        productType: string | null;
                      } | null;
                    } | null;
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
      const perLine = new Map<
        string,
        {
          variantId: string;
          productId: string;
          productTitle: string;
          productType: string;
          net: number;
        }
      >();
      for (const liEdge of order.lineItems.edges) {
        const li = liEdge.node;
        if (!li.variant?.id || !li.variant.product?.id) continue;
        perLine.set(li.id, {
          variantId: li.variant.id,
          productId: li.variant.product.id,
          productTitle: li.variant.product.title,
          productType: li.variant.product.productType ?? "",
          net: li.quantity,
        });
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
        if (entry.net <= 0) continue;
        const existing = byVariant.get(entry.variantId);
        if (existing) {
          existing.unitsSold += entry.net;
        } else {
          byVariant.set(entry.variantId, {
            variantId: entry.variantId,
            productId: entry.productId,
            productTitle: entry.productTitle,
            productType: entry.productType,
            unitsSold: entry.net,
          });
        }
      }
    }
    hasNext = page.pageInfo.hasNextPage;
    after = page.pageInfo.endCursor;
  }
  return byVariant;
}

export interface BackfillResult {
  months: string[];
  variantsWritten: number;
}

/**
 * Backfill VariantMonthSnapshot for a range of past months. Iterates
 * month-by-month so a network hiccup drops one month, not the whole
 * range. Idempotent — existing (shop, month, variantId) rows get
 * overwritten.
 *
 * @param months  Number of past whole months to backfill (14+
 *                recommended per spec). The current month is excluded
 *                — the daily job owns it.
 */
export async function backfillMonthlySales(
  admin: AdminApiContext,
  shop: string,
  months: number = 14,
): Promise<BackfillResult> {
  const now = new Date();
  const monthList: string[] = [];
  // Start with the month BEFORE the current month, walk back N.
  for (let i = 1; i <= months; i++) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
    );
    monthList.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
    );
  }
  monthList.reverse(); // oldest → newest

  let variantsWritten = 0;
  for (const month of monthList) {
    try {
      const aggregate = await pullMonth(admin, month);
      if (aggregate.size === 0) {
        console.log(`[Backfill] ${shop} ${month}: no orders`);
        continue;
      }
      const rows = Array.from(aggregate.values()).map((a) => ({
        shop,
        month,
        shopifyVariantId: a.variantId,
        shopifyProductId: a.productId,
        productTitle: a.productTitle,
        productType: a.productType,
        unitsSold: a.unitsSold,
        // TODO: replace with ShopifyQL-derived per-variant-month
        // starting/ending units. See engine spec §4.
        inStockFraction: 1.0,
        source: "approx",
      }));
      await db.$transaction([
        db.variantMonthSnapshot.deleteMany({
          where: { shop, month },
        }),
        db.variantMonthSnapshot.createMany({ data: rows }),
      ]);
      variantsWritten += rows.length;
      console.log(
        `[Backfill] ${shop} ${month}: wrote ${rows.length} variant rows`,
      );
    } catch (error) {
      console.error(`[Backfill] ${shop} ${month} FAILED:`, error);
    }
  }

  return { months: monthList, variantsWritten };
}
