import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import db from "../../db.server";
import { getVariantsInventory } from "../shopify-api/inventory.server";

/**
 * Builds one InventoryValueSnapshot row per (location, vendor) plus
 * one per-location rollup (vendor = null). Aggregates current stock at
 * its current cost + retail across the entire catalog.
 *
 * Idempotent on (shop, locationId, vendor, periodEnd) — re-running the
 * same day overwrites the day's row rather than duplicating.
 *
 * Two-pass design: a lean products query (no nested inventoryLevels)
 * collects per-variant cost + retail + vendor, then the shared
 * `getVariantsInventory` helper fetches per-location available qty in
 * batches of 50. Pulling inventoryLevels inline blows past Shopify's
 * 1000-point single-query cost limit on shops with deep variant counts.
 */
const SNAPSHOT_PRODUCTS_QUERY = `#graphql
  query InventoryValueProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: TITLE) {
      edges {
        cursor
        node {
          id
          vendor
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

interface RawProduct {
  id: string;
  vendor: string | null;
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

interface Bucket {
  totalUnits: number;
  totalCostValue: number;
  totalRetailValue: number;
}

function bucketKey(locationId: string, vendor: string | null): string {
  return `${locationId}::${vendor ?? ""}`;
}

export interface BuildInventoryValueResult {
  /** ISO date string the snapshot was filed under (end-of-day UTC). */
  periodEnd: string;
  /** Number of (location, vendor) buckets written, including rollups. */
  rowsWritten: number;
  /** Total products walked. */
  productCount: number;
}

export async function buildInventoryValueSnapshot(
  admin: AdminApiContext,
  shop: string,
): Promise<BuildInventoryValueResult> {
  const periodEnd = endOfDayUtc(new Date());

  // Pass 1 — walk every product, capture (variantId → cost/retail/vendor).
  interface VariantMeta {
    productVendor: string | null;
    cost: number;
    retail: number;
  }
  const variantMeta = new Map<string, VariantMeta>();
  let after: string | null = null;
  let hasNext = true;
  let productCount = 0;

  while (hasNext) {
    const response = await admin.graphql(SNAPSHOT_PRODUCTS_QUERY, {
      variables: { first: 50, after },
    });
    const body = (await response.json()) as {
      data?: {
        products?: {
          edges: Array<{ node: RawProduct }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };
    const page = body.data?.products;
    if (!page) break;

    for (const edge of page.edges) {
      productCount++;
      const product = edge.node;
      const vendor = product.vendor || null;
      for (const vEdge of product.variants.edges) {
        const variant = vEdge.node;
        const cost = parseFloat(variant.inventoryItem?.unitCost?.amount ?? "0") || 0;
        const retail = parseFloat(variant.price ?? "0") || 0;
        variantMeta.set(variant.id, { productVendor: vendor, cost, retail });
      }
    }
    hasNext = page.pageInfo.hasNextPage;
    after = page.pageInfo.endCursor;
  }

  // Pass 2 — fetch per-location levels in 50-id batches. Aggregate as
  // we go to avoid holding the full level set in memory.
  const buckets = new Map<
    string,
    { vendor: string | null; locationId: string; metrics: Bucket }
  >();
  const rollupByLocation = new Map<string, Bucket>();

  const variantIds = Array.from(variantMeta.keys());
  const invMap = await getVariantsInventory(admin, variantIds);
  for (const [variantId, inv] of invMap.entries()) {
    const meta = variantMeta.get(variantId);
    if (!meta) continue;
    for (const level of inv.levels) {
      const avail = level.quantities.available ?? 0;
      if (avail === 0) continue;
      const vendorKey = bucketKey(level.locationId, meta.productVendor);
      const vendorBucket =
        buckets.get(vendorKey)?.metrics ?? {
          totalUnits: 0,
          totalCostValue: 0,
          totalRetailValue: 0,
        };
      vendorBucket.totalUnits += avail;
      vendorBucket.totalCostValue += avail * meta.cost;
      vendorBucket.totalRetailValue += avail * meta.retail;
      buckets.set(vendorKey, {
        vendor: meta.productVendor,
        locationId: level.locationId,
        metrics: vendorBucket,
      });
      const rollup =
        rollupByLocation.get(level.locationId) ?? {
          totalUnits: 0,
          totalCostValue: 0,
          totalRetailValue: 0,
        };
      rollup.totalUnits += avail;
      rollup.totalCostValue += avail * meta.cost;
      rollup.totalRetailValue += avail * meta.retail;
      rollupByLocation.set(level.locationId, rollup);
    }
  }

  // Idempotent write: delete the day's rows for this shop first, then
  // insert fresh. Avoids upsert-loop on a many-row composite key.
  await db.inventoryValueSnapshot.deleteMany({
    where: { shop, periodEnd },
  });

  const rows: Array<{
    shop: string;
    locationId: string;
    vendor: string | null;
    periodEnd: Date;
    totalUnits: number;
    totalCostValue: number;
    totalRetailValue: number;
  }> = [];
  for (const { vendor, locationId, metrics } of buckets.values()) {
    rows.push({
      shop,
      locationId,
      vendor,
      periodEnd,
      ...metrics,
    });
  }
  for (const [locationId, metrics] of rollupByLocation.entries()) {
    rows.push({
      shop,
      locationId,
      vendor: null,
      periodEnd,
      ...metrics,
    });
  }
  // De-dup: a product with a null vendor would collide on the unique
  // key with the rollup row. Keep whichever has more units (the rollup,
  // by construction — it sums across all vendors).
  const byKey = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const k = `${r.locationId}::${r.vendor ?? ""}`;
    const prev = byKey.get(k);
    if (!prev || r.totalUnits > prev.totalUnits) byKey.set(k, r);
  }

  await db.inventoryValueSnapshot.createMany({
    data: Array.from(byKey.values()),
  });

  return {
    periodEnd: periodEnd.toISOString(),
    rowsWritten: byKey.size,
    productCount,
  };
}

function endOfDayUtc(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(23, 59, 59, 999);
  return out;
}
