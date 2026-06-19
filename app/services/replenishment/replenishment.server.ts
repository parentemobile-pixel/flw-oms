import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import { fetchNetSalesAtLocation } from "../shopify-api/orders.server";
import { getVariantsInventory } from "../shopify-api/inventory.server";

export interface ReplenishmentRow {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  selectedOptions: Array<{ name: string; value: string }>;
  /** Net units sold at the destination location (sales − refunds). */
  sold: number;
  /** Units currently available at the source location. */
  sourceAvailable: number;
}

export interface ReplenishmentSummary {
  totalUnitsSold: number;
  variantsSold: number;
  fullyRestockable: number;
  shortOrOOS: number;
}

export interface ReplenishmentReport {
  rows: ReplenishmentRow[];
  /**
   * Variants of products that had at least one sale but weren't sold
   * themselves. Used by the UI's click-empty-cell affordance so the user
   * can add an unsold sister size to the working set without searching.
   * Same shape as `rows` minus the `sold` count (always 0 here).
   */
  peerVariants: ReplenishmentRow[];
  summary: ReplenishmentSummary;
}

const VARIANT_INFO_QUERY = `#graphql
  query ReplenishmentVariantInfo($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        sku
        selectedOptions { name value }
        product {
          id
          title
        }
      }
    }
  }
`;

const PRODUCT_PEER_VARIANTS_QUERY = `#graphql
  query ReplenishmentPeerVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        variants(first: 100) {
          edges {
            node {
              id
              title
              sku
              selectedOptions { name value }
            }
          }
        }
      }
    }
  }
`;

/**
 * Build the replenishment report for one (source → destination) pair:
 *   1. Pull net POS sales at the destination over the date range
 *      (location_id + refunds netted in `fetchNetSalesAtLocation`).
 *   2. Hydrate variant metadata (title, options, sku, product title) in
 *      one batched `nodes` call.
 *   3. Fetch per-location inventory in batches via the existing
 *      `getVariantsInventory` helper and pluck the source-location's
 *      `available` qty per variant.
 *   4. Assemble flat report rows + roll-up summary.
 *
 * The route computes per-row note flags ("Restockable", "Last unit",
 * etc.) from these rows — keeping that logic in the route gives the UI
 * direct access to the size-grouping context without a second pass.
 */
export async function buildReplenishmentReport(
  admin: AdminApiContext,
  options: {
    sourceLocationGid: string;
    destLocationGid: string;
    startDate: string;
    endDate: string;
  },
): Promise<ReplenishmentReport> {
  const { sourceLocationGid, destLocationGid, startDate, endDate } = options;

  // 1. Net sales at destination.
  const netSales = await fetchNetSalesAtLocation(admin, {
    locationGid: destLocationGid,
    startDate,
    endDate,
  });
  if (netSales.length === 0) {
    return {
      rows: [],
      peerVariants: [],
      summary: {
        totalUnitsSold: 0,
        variantsSold: 0,
        fullyRestockable: 0,
        shortOrOOS: 0,
      },
    };
  }

  const variantIds = netSales.map((s) => s.variantId);

  // 2. Variant metadata in one batched call. We chunk to 100 ids per
  // request because the `nodes` query has a practical per-call ceiling
  // even though there's no explicit limit.
  const variantInfo = new Map<
    string,
    {
      title: string;
      sku: string | null;
      productId: string;
      productTitle: string;
      selectedOptions: Array<{ name: string; value: string }>;
    }
  >();
  for (let i = 0; i < variantIds.length; i += 100) {
    const chunk = variantIds.slice(i, i + 100);
    const response = await admin.graphql(VARIANT_INFO_QUERY, {
      variables: { ids: chunk },
    });
    const data = (await response.json()) as {
      data?: {
        nodes?: Array<
          | {
              id: string;
              title: string;
              sku: string | null;
              selectedOptions: Array<{ name: string; value: string }>;
              product: { id: string; title: string } | null;
            }
          | null
        >;
      };
    };
    for (const node of data.data?.nodes ?? []) {
      if (!node?.id) continue;
      variantInfo.set(node.id, {
        title: node.title,
        sku: node.sku,
        productId: node.product?.id ?? "",
        productTitle: node.product?.title ?? "Unknown product",
        selectedOptions: node.selectedOptions ?? [],
      });
    }
  }

  // 2b. Pull every other variant of any product that had at least one
  // sale. Powers the click-empty-cell affordance — the user can click a
  // blank size on a sold colorway to add that sister variant to the
  // working transfer set without searching.
  const productIds = Array.from(
    new Set(
      Array.from(variantInfo.values())
        .map((v) => v.productId)
        .filter((id) => id),
    ),
  );
  const peerInfo = new Map<
    string,
    {
      productId: string;
      productTitle: string;
      title: string;
      sku: string | null;
      selectedOptions: Array<{ name: string; value: string }>;
    }
  >();
  for (let i = 0; i < productIds.length; i += 50) {
    const chunk = productIds.slice(i, i + 50);
    const response = await admin.graphql(PRODUCT_PEER_VARIANTS_QUERY, {
      variables: { ids: chunk },
    });
    const data = (await response.json()) as {
      data?: {
        nodes?: Array<
          | {
              id: string;
              title: string;
              variants: {
                edges: Array<{
                  node: {
                    id: string;
                    title: string;
                    sku: string | null;
                    selectedOptions: Array<{ name: string; value: string }>;
                  };
                }>;
              };
            }
          | null
        >;
      };
    };
    for (const product of data.data?.nodes ?? []) {
      if (!product?.id) continue;
      for (const edge of product.variants.edges) {
        const v = edge.node;
        if (variantInfo.has(v.id)) continue;
        peerInfo.set(v.id, {
          productId: product.id,
          productTitle: product.title,
          title: v.title,
          sku: v.sku,
          selectedOptions: v.selectedOptions ?? [],
        });
      }
    }
  }

  // 3. Source-location available qty per variant — for both sold
  // variants and peers (so click-to-add cells know what's available).
  const peerIds = Array.from(peerInfo.keys());
  const invMap = await getVariantsInventory(admin, [
    ...variantIds,
    ...peerIds,
  ]);
  const sourceAvailableByVariant = new Map<string, number>();
  for (const [variantId, inv] of invMap.entries()) {
    const level = inv.levels.find((l) => l.locationId === sourceLocationGid);
    sourceAvailableByVariant.set(variantId, level?.quantities.available ?? 0);
  }

  // 4. Assemble rows. Variants whose metadata fetch failed get a
  // placeholder so they're still visible in the grid — the user can
  // investigate rather than silently miss a row.
  const rows: ReplenishmentRow[] = netSales.map((sale) => {
    const meta = variantInfo.get(sale.variantId);
    return {
      variantId: sale.variantId,
      productId: meta?.productId || sale.productId,
      productTitle: meta?.productTitle ?? "Unknown product",
      variantTitle: meta?.title ?? "",
      sku: meta?.sku ?? null,
      selectedOptions: meta?.selectedOptions ?? [],
      sold: sale.netQuantity,
      sourceAvailable: sourceAvailableByVariant.get(sale.variantId) ?? 0,
    };
  });

  // Sort rows so the grid renders a stable order: product title, then
  // non-size option (color/material), then size. The grid's row grouping
  // doesn't care about input order, but stable ordering makes the
  // per-row note logic deterministic across reloads.
  rows.sort((a, b) => {
    const pa = a.productTitle.toLowerCase();
    const pb = b.productTitle.toLowerCase();
    if (pa !== pb) return pa.localeCompare(pb);
    return a.variantTitle.localeCompare(b.variantTitle);
  });

  // Summary roll-up. A variant counts as "fully restockable" when
  // source has at least as much as was sold; "short or OOS" otherwise.
  const totalUnitsSold = rows.reduce((s, r) => s + r.sold, 0);
  let fullyRestockable = 0;
  let shortOrOOS = 0;
  for (const r of rows) {
    if (r.sourceAvailable >= r.sold) fullyRestockable++;
    else shortOrOOS++;
  }

  // Peer variants (unsold sister sizes/colors of products that had a
  // sale). The UI uses these for click-empty-cell add — sold=0, source
  // availability still resolved.
  const peerVariants: ReplenishmentRow[] = Array.from(peerInfo.entries()).map(
    ([variantId, meta]) => ({
      variantId,
      productId: meta.productId,
      productTitle: meta.productTitle,
      variantTitle: meta.title,
      sku: meta.sku,
      selectedOptions: meta.selectedOptions,
      sold: 0,
      sourceAvailable: sourceAvailableByVariant.get(variantId) ?? 0,
    }),
  );

  return {
    rows,
    peerVariants,
    summary: {
      totalUnitsSold,
      variantsSold: rows.length,
      fullyRestockable,
      shortOrOOS,
    },
  };
}
