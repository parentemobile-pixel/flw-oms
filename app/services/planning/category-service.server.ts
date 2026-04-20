import db from "../../db.server";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { subDays, subYears } from "date-fns";
import { getPlanningTable, type PlanningTableRow } from "./planning-service.server";
import {
  SEASON_TAGS,
  BRAND_TIER_TAGS,
  type CategoryAggregate,
  type CategoryAggregates,
} from "./category-types";

// ============================================
// Known tag taxonomy
// ============================================
// Imported from ./category-types so the route can share the types without
// pulling this server-only module into the client bundle.

type SeasonTag = (typeof SEASON_TAGS)[number];
type BrandTierTag = (typeof BRAND_TIER_TAGS)[number];

function matchSeasons(tags: string[]): SeasonTag[] {
  const lower = new Set(tags.map((t) => t.toLowerCase()));
  return SEASON_TAGS.filter((s) => lower.has(s.toLowerCase()));
}

function matchBrandTier(tags: string[]): BrandTierTag | null {
  const lower = new Set(tags.map((t) => t.toLowerCase()));
  for (const b of BRAND_TIER_TAGS) {
    if (lower.has(b.toLowerCase())) return b;
  }
  return null;
}

// ============================================
// Variant cost / price batch query
// ============================================
// The planning-service pipeline doesn't need cost/price, so we fetch them
// separately here. Chunked to 50 ids per round-trip (same budget as the
// inventory batcher).

const VARIANT_COSTS_QUERY = `#graphql
  query GetVariantCosts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        price
        inventoryItem {
          unitCost { amount }
        }
      }
    }
  }
`;

interface VariantEconomics {
  unitCost: number;
  price: number;
}

export async function getVariantEconomics(
  admin: AdminApiContext,
  variantIds: string[],
): Promise<Map<string, VariantEconomics>> {
  const out = new Map<string, VariantEconomics>();
  const CHUNK = 50;
  for (let i = 0; i < variantIds.length; i += CHUNK) {
    const chunk = variantIds.slice(i, i + CHUNK);
    try {
      const resp = await admin.graphql(VARIANT_COSTS_QUERY, {
        variables: { ids: chunk },
      });
      const data = (await resp.json()) as any;
      for (const node of data.data?.nodes ?? []) {
        if (!node?.id) continue;
        const cost = parseFloat(node.inventoryItem?.unitCost?.amount ?? "0");
        const price = parseFloat(node.price ?? "0");
        out.set(node.id, {
          unitCost: Number.isFinite(cost) ? cost : 0,
          price: Number.isFinite(price) ? price : 0,
        });
      }
    } catch (error) {
      console.error("VariantCosts query failed:", error);
    }
  }
  return out;
}

// ============================================
// Internal — enriched row used during aggregation
// ============================================

interface EnrichedRow extends PlanningTableRow {
  unitCost: number;
  price: number;
  stockCostValue: number;
  stockRetailValue: number;
  revenueSold: number;
  revenueSoldPriorYear: number;
}

interface Accum {
  productIds: Set<string>;
  variantIds: Set<string>;
  unitsInStock: number;
  stockCostValue: number;
  stockRetailValue: number;
  unitsSold: number;
  revenueSold: number;
  unitsSoldPriorYear: number;
  revenueSoldPriorYear: number;
  onOrder: number;
}

function emptyAccum(): Accum {
  return {
    productIds: new Set(),
    variantIds: new Set(),
    unitsInStock: 0,
    stockCostValue: 0,
    stockRetailValue: 0,
    unitsSold: 0,
    revenueSold: 0,
    unitsSoldPriorYear: 0,
    revenueSoldPriorYear: 0,
    onOrder: 0,
  };
}

function addRow(a: Accum, r: EnrichedRow) {
  a.productIds.add(r.productId);
  a.variantIds.add(r.variantId);
  a.unitsInStock += r.currentStock;
  a.stockCostValue += r.stockCostValue;
  a.stockRetailValue += r.stockRetailValue;
  a.unitsSold += r.unitsSold;
  a.revenueSold += r.revenueSold;
  a.unitsSoldPriorYear += r.unitsSoldPriorYear;
  a.revenueSoldPriorYear += r.revenueSoldPriorYear;
  a.onOrder += r.onOrder;
}

function finalize(key: string, label: string, a: Accum): CategoryAggregate {
  const yoyUnitsPct =
    a.unitsSoldPriorYear > 0
      ? ((a.unitsSold - a.unitsSoldPriorYear) / a.unitsSoldPriorYear) * 100
      : null;
  const denom = a.unitsSold + a.unitsInStock;
  const sellThroughPct = denom > 0 ? (a.unitsSold / denom) * 100 : 0;
  return {
    key,
    label,
    productCount: a.productIds.size,
    variantCount: a.variantIds.size,
    unitsInStock: a.unitsInStock,
    stockCostValue: Math.round(a.stockCostValue * 100) / 100,
    stockRetailValue: Math.round(a.stockRetailValue * 100) / 100,
    unitsSold: a.unitsSold,
    revenueSold: Math.round(a.revenueSold * 100) / 100,
    unitsSoldPriorYear: a.unitsSoldPriorYear,
    revenueSoldPriorYear: Math.round(a.revenueSoldPriorYear * 100) / 100,
    yoyUnitsPct:
      yoyUnitsPct == null ? null : Math.round(yoyUnitsPct * 10) / 10,
    sellThroughPct: Math.round(sellThroughPct * 10) / 10,
    onOrder: a.onOrder,
  };
}

// ============================================
// Public: build the three aggregates
// ============================================

export async function getCategoryAggregates(
  admin: AdminApiContext,
  shop: string,
  options: {
    periodDays?: number;
  } = {},
): Promise<CategoryAggregates> {
  const periodDays = options.periodDays ?? 365;

  // 1) Base planning rows (already has vendor, tags, stock, onOrder, sold).
  const rows = await getPlanningTable(admin, shop, { periodDays });

  if (rows.length === 0) {
    return {
      seasons: [],
      brandTiers: [],
      vendors: [],
      periodDays,
      totals: {
        products: 0,
        variants: 0,
        unitsInStock: 0,
        stockCostValue: 0,
        unitsSold: 0,
        revenueSold: 0,
      },
    };
  }

  // 2) Per-variant cost + price (needed for $ aggregates).
  const variantIds = rows.map((r) => r.variantId);
  const economics = await getVariantEconomics(admin, variantIds);

  // 3) Revenue per variant (this period + prior-year-matching period) from
  //    SalesSnapshot. Same windowing as rebuildPlanningSnapshots.
  const now = new Date();
  const startThis = subDays(now, periodDays);
  const startLast = subYears(startThis, 1);
  const endLast = subYears(now, 1);

  const [thisPeriod, priorPeriod] = await Promise.all([
    db.salesSnapshot.findMany({
      where: {
        shop,
        periodType: "weekly",
        periodStart: { gte: startThis, lte: now },
      },
      select: { shopifyVariantId: true, revenue: true },
    }),
    db.salesSnapshot.findMany({
      where: {
        shop,
        periodType: "weekly",
        periodStart: { gte: startLast, lte: endLast },
      },
      select: { shopifyVariantId: true, revenue: true },
    }),
  ]);

  const revThis = new Map<string, number>();
  for (const s of thisPeriod) {
    revThis.set(
      s.shopifyVariantId,
      (revThis.get(s.shopifyVariantId) ?? 0) + s.revenue,
    );
  }
  const revPrior = new Map<string, number>();
  for (const s of priorPeriod) {
    revPrior.set(
      s.shopifyVariantId,
      (revPrior.get(s.shopifyVariantId) ?? 0) + s.revenue,
    );
  }

  // 4) Enrich.
  const enriched: EnrichedRow[] = rows.map((r) => {
    const econ = economics.get(r.variantId);
    const unitCost = econ?.unitCost ?? 0;
    const price = econ?.price ?? 0;
    return {
      ...r,
      unitCost,
      price,
      stockCostValue: r.currentStock * unitCost,
      stockRetailValue: r.currentStock * price,
      revenueSold: revThis.get(r.variantId) ?? 0,
      revenueSoldPriorYear: revPrior.get(r.variantId) ?? 0,
    };
  });

  // 5) Group.
  const seasonBuckets = new Map<string, Accum>();
  const brandBuckets = new Map<string, Accum>();
  const vendorBuckets = new Map<string, Accum>();

  for (const r of enriched) {
    // Seasons: a row may carry multiple season tags; count it in every
    // matching bucket. Rows with no known season tag go to "Untagged".
    const seasons = matchSeasons(r.tags);
    if (seasons.length === 0) {
      const k = "__untagged__";
      const acc = seasonBuckets.get(k) ?? emptyAccum();
      addRow(acc, r);
      seasonBuckets.set(k, acc);
    } else {
      for (const s of seasons) {
        const acc = seasonBuckets.get(s) ?? emptyAccum();
        addRow(acc, r);
        seasonBuckets.set(s, acc);
      }
    }

    // Brand tier: exactly one bucket per row.
    const brand = matchBrandTier(r.tags) ?? "__untagged__";
    const bAcc = brandBuckets.get(brand) ?? emptyAccum();
    addRow(bAcc, r);
    brandBuckets.set(brand, bAcc);

    // Vendor: every row falls in exactly one vendor bucket.
    const vendor = r.vendor && r.vendor.trim() ? r.vendor : "__unknown__";
    const vAcc = vendorBuckets.get(vendor) ?? emptyAccum();
    addRow(vAcc, r);
    vendorBuckets.set(vendor, vAcc);
  }

  // Finalize + order.
  const seasons: CategoryAggregate[] = [];
  for (const s of SEASON_TAGS) {
    const acc = seasonBuckets.get(s);
    if (acc) seasons.push(finalize(s, s, acc));
  }
  const untaggedSeason = seasonBuckets.get("__untagged__");
  if (untaggedSeason)
    seasons.push(finalize("__untagged__", "Untagged", untaggedSeason));

  const brandTiers: CategoryAggregate[] = [];
  for (const b of BRAND_TIER_TAGS) {
    const acc = brandBuckets.get(b);
    if (acc) brandTiers.push(finalize(b, b, acc));
  }
  const untaggedBrand = brandBuckets.get("__untagged__");
  if (untaggedBrand)
    brandTiers.push(finalize("__untagged__", "Untagged", untaggedBrand));

  const vendors: CategoryAggregate[] = [];
  const sortedVendors = [...vendorBuckets.entries()].sort((a, b) => {
    // Sort by revenue desc then by name.
    const aRev = a[1].revenueSold;
    const bRev = b[1].revenueSold;
    if (aRev !== bRev) return bRev - aRev;
    return a[0].localeCompare(b[0]);
  });
  for (const [k, acc] of sortedVendors) {
    const label = k === "__unknown__" ? "Unknown vendor" : k;
    vendors.push(finalize(k, label, acc));
  }

  const totals = {
    products: new Set(enriched.map((r) => r.productId)).size,
    variants: enriched.length,
    unitsInStock: enriched.reduce((s, r) => s + r.currentStock, 0),
    stockCostValue:
      Math.round(
        enriched.reduce((s, r) => s + r.stockCostValue, 0) * 100,
      ) / 100,
    unitsSold: enriched.reduce((s, r) => s + r.unitsSold, 0),
    revenueSold:
      Math.round(enriched.reduce((s, r) => s + r.revenueSold, 0) * 100) / 100,
  };

  return { seasons, brandTiers, vendors, periodDays, totals };
}

