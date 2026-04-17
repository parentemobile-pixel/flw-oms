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
