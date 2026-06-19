import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import db from "../../db.server";

/**
 * Builds one InventoryValueSnapshot row per (location, vendor) plus
 * one per-location rollup (vendor = null). Aggregates current stock at
 * its current cost + retail across the entire catalog.
 *
 * Idempotent on (shop, locationId, vendor, periodEnd) — re-running the
 * same day overwrites the day's row rather than duplicating.
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
                  inventoryLevels(first: 20) {
                    edges {
                      node {
                        location { id }
                        quantities(names: ["available"]) {
                          name
                          quantity
                        }
                      }
                    }
                  }
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
        inventoryItem: {
          unitCost: { amount: string } | null;
          inventoryLevels: {
            edges: Array<{
              node: {
                location: { id: string };
                quantities: Array<{ name: string; quantity: number }>;
              };
            }>;
          };
        } | null;
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

/**
 * Walk the entire product catalog page-by-page and write the day's
 * inventory-value snapshot rows. Safe to call from a cron tick or a
 * "rebuild today's snapshot" button.
 */
export async function buildInventoryValueSnapshot(
  admin: AdminApiContext,
  shop: string,
): Promise<BuildInventoryValueResult> {
  const periodEnd = endOfDayUtc(new Date());
  const buckets = new Map<string, { vendor: string | null; locationId: string; metrics: Bucket }>();
  const rollupByLocation = new Map<string, Bucket>();

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
        if (!variant.inventoryItem) continue;
        const cost = parseFloat(variant.inventoryItem.unitCost?.amount ?? "0") || 0;
        const retail = parseFloat(variant.price ?? "0") || 0;
        for (const lEdge of variant.inventoryItem.inventoryLevels.edges) {
          const level = lEdge.node;
          const locationId = level.location.id;
          const avail =
            level.quantities.find((q) => q.name === "available")?.quantity ?? 0;
          if (avail === 0) continue;
          // Per-vendor bucket
          const vendorKey = bucketKey(locationId, vendor);
          const vendorBucket =
            buckets.get(vendorKey)?.metrics ?? {
              totalUnits: 0,
              totalCostValue: 0,
              totalRetailValue: 0,
            };
          vendorBucket.totalUnits += avail;
          vendorBucket.totalCostValue += avail * cost;
          vendorBucket.totalRetailValue += avail * retail;
          buckets.set(vendorKey, {
            vendor,
            locationId,
            metrics: vendorBucket,
          });
          // Location rollup (vendor = null)
          const rollup =
            rollupByLocation.get(locationId) ?? {
              totalUnits: 0,
              totalCostValue: 0,
              totalRetailValue: 0,
            };
          rollup.totalUnits += avail;
          rollup.totalCostValue += avail * cost;
          rollup.totalRetailValue += avail * retail;
          rollupByLocation.set(locationId, rollup);
        }
      }
    }
    hasNext = page.pageInfo.hasNextPage;
    after = page.pageInfo.endCursor;
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
  // De-dup vendor=null rows (per-vendor null + rollup null) — keep the
  // larger (the rollup). A product with a null vendor would otherwise
  // collide with the rollup on the unique key.
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
