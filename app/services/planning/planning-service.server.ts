import db from "../../db.server";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { subDays, subYears } from "date-fns";
import { getOnOrderQuantities } from "../purchase-orders/po-service.server";
import { getVariantsInventory } from "../shopify-api/inventory.server";

/**
 * Rebuild the PlanningSnapshot table from SalesSnapshot + current Shopify
 * inventory + open POs.
 *
 * For each variant:
 *   unitsSold          = sum(SalesSnapshot weekly.qty) across [today-period, today]
 *   unitsSoldPriorYear = same window, -1 year
 *   daysOOS            = approximated via: days in window with zero sales AND current
 *                        stock at zero. Proper OOS tracking requires inventory history
 *                        we don't have, so this is a cheap proxy.
 *
 * Runs on-demand. Could be nightly-cronned later.
 */
export async function rebuildPlanningSnapshots(
  admin: AdminApiContext,
  shop: string,
  periodDays: number = 365,
) {
  const now = new Date();
  const startThis = subDays(now, periodDays);
  const startLast = subYears(startThis, 1);
  const endLast = subYears(now, 1);

  // Fetch weekly snapshots for this period and prior-year-matching period
  const [thisPeriod, priorPeriod] = await Promise.all([
    db.salesSnapshot.findMany({
      where: {
        shop,
        periodType: "weekly",
        periodStart: { gte: startThis, lte: now },
      },
      select: {
        shopifyProductId: true,
        shopifyVariantId: true,
        quantitySold: true,
      },
    }),
    db.salesSnapshot.findMany({
      where: {
        shop,
        periodType: "weekly",
        periodStart: { gte: startLast, lte: endLast },
      },
      select: { shopifyVariantId: true, quantitySold: true },
    }),
  ]);

  const thisByVariant = new Map<
    string,
    { productId: string; units: number }
  >();
  for (const s of thisPeriod) {
    const key = s.shopifyVariantId;
    const cur = thisByVariant.get(key) ?? {
      productId: s.shopifyProductId,
      units: 0,
    };
    cur.units += s.quantitySold;
    thisByVariant.set(key, cur);
  }
  const priorByVariant = new Map<string, number>();
  for (const s of priorPeriod) {
    priorByVariant.set(
      s.shopifyVariantId,
      (priorByVariant.get(s.shopifyVariantId) ?? 0) + s.quantitySold,
    );
  }

  // Union of variants appearing in either period
  const allVariants = new Set<string>([
    ...thisByVariant.keys(),
    ...priorByVariant.keys(),
  ]);

  // Rough days-OOS estimate: variants with sales in prior year but none this year
  // get a rough "probably out most of the window" signal. Not perfect.
  // Write snapshots.
  const rows: Array<{
    shop: string;
    shopifyProductId: string;
    shopifyVariantId: string;
    periodDays: number;
    unitsSold: number;
    unitsSoldPriorYear: number;
    daysOOS: number;
  }> = [];

  for (const vid of allVariants) {
    const t = thisByVariant.get(vid);
    const priorUnits = priorByVariant.get(vid) ?? 0;
    const unitsSold = t?.units ?? 0;

    // If we sold this last year but not this year, mark full period OOS as worst case
    let daysOOS = 0;
    if (priorUnits > 0 && unitsSold === 0) {
      daysOOS = Math.floor(periodDays * 0.5); // Conservative — half the window
    }

    rows.push({
      shop,
      shopifyProductId: t?.productId ?? "",
      shopifyVariantId: vid,
      periodDays,
      unitsSold,
      unitsSoldPriorYear: priorUnits,
      daysOOS,
    });
  }

  // Wipe + replace snapshots for this shop/period to keep things simple
  await db.$transaction([
    db.planningSnapshot.deleteMany({ where: { shop, periodDays } }),
    db.planningSnapshot.createMany({ data: rows }),
  ]);

  return { variants: rows.length };
}

// ============================================
// QUERY — build the planning table
// ============================================

export interface PlanningTableRow {
  productId: string;
  productTitle: string;
  vendor: string | null;
  tags: string[];
  variantId: string;
  variantTitle: string;
  sku: string | null;

  // Sales
  unitsSold: number;
  unitsSoldPriorYear: number;
  daysOOS: number;
  adjustedUnitsSold: number;

  // Stock across all locations
  currentStock: number;
  stockByLocation: Record<string, number>;

  // On order
  onOrder: number;

  // Suggested order qty
  suggestedOrder: number;
}

/**
 * Get the latest PlanningSnapshots + join against Shopify for product title,
 * vendor, and current per-location stock. Not cached — the user can sort,
 * filter, and edit; we want fresh numbers.
 */
export async function getPlanningTable(
  admin: AdminApiContext,
  shop: string,
  options: {
    periodDays?: number;
    coverageMultiplier?: number;
    vendorFilter?: string | null;
  } = {},
): Promise<PlanningTableRow[]> {
  const periodDays = options.periodDays ?? 365;
  const coverage = options.coverageMultiplier ?? 1.0;

  const snapshots = await db.planningSnapshot.findMany({
    where: { shop, periodDays },
  });
  if (snapshots.length === 0) return [];

  // Get all unique product IDs and variant IDs
  const productIds = [...new Set(snapshots.map((s) => s.shopifyProductId))];
  const variantIds = snapshots.map((s) => s.shopifyVariantId);

  // Fetch product metadata (title, vendor, tags) in batches of 50
  const productMeta = new Map<
    string,
    {
      title: string;
      vendor: string;
      tags: string[];
      variants: Map<string, { title: string; sku: string | null }>;
    }
  >();
  const PRODUCTS_META_QUERY = `#graphql
    query PlanningProducts($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          title
          vendor
          tags
          variants(first: 100) {
            edges { node { id title sku } }
          }
        }
      }
    }
  `;
  for (let i = 0; i < productIds.length; i += 50) {
    const chunk = productIds.slice(i, i + 50);
    try {
      const resp = await admin.graphql(PRODUCTS_META_QUERY, {
        variables: { ids: chunk },
      });
      const data = (await resp.json()) as any;
      for (const node of data.data?.nodes ?? []) {
        if (!node?.id) continue;
        const variants = new Map<string, { title: string; sku: string | null }>();
        for (const ve of node.variants?.edges ?? []) {
          variants.set(ve.node.id, {
            title: ve.node.title,
            sku: ve.node.sku ?? null,
          });
        }
        productMeta.set(node.id, {
          title: node.title,
          vendor: node.vendor ?? "",
          tags: node.tags ?? [],
          variants,
        });
      }
    } catch (error) {
      console.error("PlanningProducts query failed:", error);
    }
  }

  // Per-location inventory (batched)
  const invMap = await getVariantsInventory(admin, variantIds).catch(
    () => new Map(),
  );

  const onOrderMap = await getOnOrderQuantities(shop);

  // Build rows
  const rows: PlanningTableRow[] = [];
  for (const s of snapshots) {
    const meta = productMeta.get(s.shopifyProductId);
    if (!meta) continue;
    const variantMeta = meta.variants.get(s.shopifyVariantId);
    if (!variantMeta) continue;

    if (
      options.vendorFilter &&
      meta.vendor.toLowerCase() !== options.vendorFilter.toLowerCase()
    ) {
      continue;
    }

    // OOS-adjusted units sold — normalize to "what would we have sold if
    // always in stock?" — simple linear extrapolation.
    const daysInStock = Math.max(1, periodDays - s.daysOOS);
    const adjustedUnitsSold =
      s.unitsSold > 0
        ? Math.round((s.unitsSold / daysInStock) * periodDays)
        : 0;

    const inv = invMap.get(s.shopifyVariantId);
    const stockByLocation: Record<string, number> = {};
    let currentStock = 0;
    if (inv) {
      for (const lv of inv.levels) {
        stockByLocation[lv.locationId] = lv.quantities.available ?? 0;
        currentStock += lv.quantities.available ?? 0;
      }
    }

    const onOrder = onOrderMap[s.shopifyVariantId] ?? 0;

    // Suggested order: ((last year's adjusted or this year's — take max)
    // × coverage multiplier) − current stock − on order.
    const baselineSold = Math.max(
      adjustedUnitsSold,
      s.unitsSoldPriorYear,
    );
    const target = Math.round(baselineSold * coverage);
    const suggested = Math.max(0, target - currentStock - onOrder);

    rows.push({
      productId: s.shopifyProductId,
      productTitle: meta.title,
      vendor: meta.vendor || null,
      tags: meta.tags,
      variantId: s.shopifyVariantId,
      variantTitle: variantMeta.title,
      sku: variantMeta.sku,
      unitsSold: s.unitsSold,
      unitsSoldPriorYear: s.unitsSoldPriorYear,
      daysOOS: s.daysOOS,
      adjustedUnitsSold,
      currentStock,
      stockByLocation,
      onOrder,
      suggestedOrder: suggested,
    });
  }

  return rows;
}
