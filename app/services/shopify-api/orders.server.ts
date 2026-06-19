import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

const ORDERS_QUERY = `#graphql
  query GetOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      edges {
        node {
          id
          createdAt
          lineItems(first: 50) {
            edges {
              node {
                variant {
                  id
                }
                product {
                  id
                }
                quantity
                originalTotalSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export interface OrderLineItem {
  variantId: string;
  productId: string;
  quantity: number;
  revenue: number;
}

export interface FetchedOrder {
  id: string;
  createdAt: string;
  lineItems: OrderLineItem[];
}

export async function fetchOrders(
  admin: AdminApiContext,
  { first = 50, after, query }: { first?: number; after?: string; query?: string } = {},
): Promise<{ orders: FetchedOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }> {
  const response = await admin.graphql(ORDERS_QUERY, {
    variables: { first, after: after || null, query: query || null },
  });
  const data = await response.json();

  const orders: FetchedOrder[] = data.data.orders.edges.map(
    (edge: {
      node: {
        id: string;
        createdAt: string;
        lineItems: {
          edges: Array<{
            node: {
              variant?: { id: string };
              product?: { id: string };
              quantity: number;
              originalTotalSet?: { shopMoney?: { amount: string } };
            };
          }>;
        };
      };
    }) => ({
      id: edge.node.id,
      createdAt: edge.node.createdAt,
      lineItems: edge.node.lineItems.edges
        .filter((li: { node: { variant?: { id: string } } }) => li.node.variant)
        .map(
          (li: {
            node: {
              variant?: { id: string };
              product?: { id: string };
              quantity: number;
              originalTotalSet?: { shopMoney?: { amount: string } };
            };
          }) => ({
            variantId: li.node.variant!.id,
            productId: li.node.product?.id || "",
            quantity: li.node.quantity,
            revenue: parseFloat(li.node.originalTotalSet?.shopMoney?.amount || "0"),
          }),
        ),
    }),
  );

  return {
    orders,
    pageInfo: data.data.orders.pageInfo,
  };
}

export async function fetchAllOrdersInRange(
  admin: AdminApiContext,
  startDate: string,
  endDate: string,
): Promise<FetchedOrder[]> {
  const allOrders: FetchedOrder[] = [];
  let hasNextPage = true;
  let after: string | undefined;
  const query = `created_at:>='${startDate}' AND created_at:<='${endDate}' AND financial_status:paid`;

  while (hasNextPage) {
    const result = await fetchOrders(admin, { first: 50, after, query });
    allOrders.push(...result.orders);
    hasNextPage = result.pageInfo.hasNextPage;
    after = result.pageInfo.endCursor || undefined;
  }

  return allOrders;
}

// ─── Location- + refund-aware sales (Replenishment module) ──────────────────

/**
 * Net-sales line item: `quantity` minus any refunded units for the same
 * order line item. Aggregates do not happen here — the caller groups by
 * variantId.
 */
export interface NetSalesLineItem {
  variantId: string;
  productId: string;
  netQuantity: number;
}

const LOCATION_ORDERS_QUERY = `#graphql
  query GetLocationOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      edges {
        node {
          id
          processedAt
          retailLocation { id }
          lineItems(first: 100) {
            edges {
              node {
                id
                quantity
                variant { id }
                product { id }
              }
            }
          }
          fulfillments {
            location { id }
            fulfillmentLineItems(first: 100) {
              edges {
                node {
                  quantity
                  lineItem { id }
                }
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

interface RawOrderNode {
  id: string;
  processedAt: string;
  retailLocation: { id: string } | null;
  lineItems: {
    edges: Array<{
      node: {
        id: string;
        quantity: number;
        variant: { id: string } | null;
        product: { id: string } | null;
      };
    }>;
  };
  fulfillments: Array<{
    location: { id: string } | null;
    fulfillmentLineItems: {
      edges: Array<{
        node: {
          quantity: number;
          lineItem: { id: string } | null;
        };
      }>;
    };
  }>;
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
}

/**
 * Extract the trailing numeric portion from a Shopify gid. The orders
 * search index accepts `location_id:<numeric>` for POS retail-location
 * matching, but the gid that comes back from `locations` lists is
 * `gid://shopify/Location/123`. Strip everything before the last slash.
 */
function gidNumeric(gid: string): string {
  const slash = gid.lastIndexOf("/");
  return slash >= 0 ? gid.slice(slash + 1) : gid;
}

/**
 * Pull POS orders at a single retail location across the date range,
 * net out refunds at the line-item level, and return flat per-variant
 * net-sold quantities.
 *
 * Used by the Replenishment report. Defensive-belt-and-suspenders for
 * the location filter: the GraphQL `orders(query:)` search accepts
 * `location_id:<numeric>` for POS orders, but we also check
 * `order.retailLocation { id }` client-side and discard mismatches so
 * a stale index or a missing scope can't silently widen the dataset.
 *
 * The `paid` filter mirrors the existing sales-sync behavior — refunds
 * are tracked via `refunds.refundLineItems` so a partially-refunded
 * paid order nets correctly without being excluded entirely.
 */
export async function fetchNetSalesAtLocation(
  admin: AdminApiContext,
  options: {
    locationGid: string;
    /** ISO date string (yyyy-mm-dd) — inclusive */
    startDate: string;
    /** ISO date string (yyyy-mm-dd) — inclusive */
    endDate: string;
  },
): Promise<NetSalesLineItem[]> {
  const { locationGid, startDate, endDate } = options;
  const numericLocation = gidNumeric(locationGid);
  const query =
    `processed_at:>='${startDate}' AND processed_at:<='${endDate}' ` +
    `AND financial_status:paid AND location_id:${numericLocation}`;

  // Aggregate net quantity per variant gid.
  const netByVariant = new Map<
    string,
    { productId: string; netQuantity: number }
  >();

  let hasNextPage = true;
  let after: string | undefined;
  while (hasNextPage) {
    const response = await admin.graphql(LOCATION_ORDERS_QUERY, {
      variables: { first: 50, after: after ?? null, query },
    });
    const data = (await response.json()) as {
      data?: { orders?: { edges?: Array<{ node: RawOrderNode }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
    };
    const page = data.data?.orders;
    if (!page) break;

    for (const edge of page.edges ?? []) {
      const order = edge.node;
      // Belt: also enforce the location client-side. Drop orders whose
      // retailLocation doesn't match (covers an over-broad search index
      // returning unexpected hits — better silent zero than wrong totals).
      if (
        order.retailLocation &&
        order.retailLocation.id !== locationGid
      ) {
        continue;
      }

      // Build a quantity-per-line-item map first; then subtract refunds.
      const perLine = new Map<
        string,
        { variantId: string; productId: string; net: number }
      >();
      for (const liEdge of order.lineItems.edges) {
        const li = liEdge.node;
        if (!li.variant?.id) continue;
        perLine.set(li.id, {
          variantId: li.variant.id,
          productId: li.product?.id ?? "",
          net: li.quantity,
        });
      }
      // Ship-to-customer filter: tally fulfillments per line item by
      // location. Any quantity fulfilled away from the retail register
      // (i.e. fulfilled at a different location, typically the online
      // warehouse) is shipped, not walked-out — subtract it from the
      // line item's net so it doesn't pollute the in-store sales figure
      // used by Replenishment. Orders with no fulfillments at all stay
      // as-is (cash receipt-only POS sales).
      for (const fulfillment of order.fulfillments ?? []) {
        const fulfilledAt = fulfillment.location?.id ?? null;
        if (fulfilledAt && fulfilledAt === locationGid) continue;
        for (const fEdge of fulfillment.fulfillmentLineItems?.edges ?? []) {
          const fLine = fEdge.node;
          if (!fLine.lineItem?.id) continue;
          const entry = perLine.get(fLine.lineItem.id);
          if (!entry) continue;
          entry.net -= fLine.quantity;
        }
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
        const existing = netByVariant.get(entry.variantId);
        if (existing) {
          existing.netQuantity += entry.net;
        } else {
          netByVariant.set(entry.variantId, {
            productId: entry.productId,
            netQuantity: entry.net,
          });
        }
      }
    }

    hasNextPage = page.pageInfo.hasNextPage;
    after = page.pageInfo.endCursor ?? undefined;
  }

  return [...netByVariant.entries()].map(([variantId, v]) => ({
    variantId,
    productId: v.productId,
    netQuantity: v.netQuantity,
  }));
}
