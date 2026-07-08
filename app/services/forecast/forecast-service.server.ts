import db from "../../db.server";
import {
  suggestOrder,
  type ForecastParams,
  type StyleForecastResult,
  type VariantForecastInput,
  type VariantMonthHistory,
} from "./forecast-engine";

/**
 * Data-loading glue between the pure forecast engine and the app's
 * Prisma layer. Turns a productId + params into a fully-hydrated
 * StyleForecastResult.
 *
 * History priority (per spec): if VariantDaySnapshot rows exist for
 * a month, they take precedence over VariantMonthSnapshot's coarser
 * backfilled approximation for that same month.
 */

export interface ForecastRunOptions {
  shop: string;
  productId: string;
  /** Number of trailing months of history to load. Default 18. */
  trailingMonths?: number;
  /** Defaults + overrides. See ForecastParams for meaning. */
  coverageStart: Date;
  coverageMonths: number;
  safetyBuffer?: number;
  growth?: number;
  casePack?: number;
  moq?: number;
  /**
   * Category key for seasonal-index lookup. Callers usually don't
   * pass this — the service prefers ProductForecastConfig.category
   * ?? the product's Shopify productType.
   */
  category?: string;
}

export interface ForecastRunResult extends StyleForecastResult {
  variantMeta: Array<{
    variantId: string;
    variantTitle: string;
    sku: string | null;
  }>;
  categoryUsed: string;
  productTitle: string;
  productType: string;
}

const DEFAULT_SAFETY_BUFFER = 0.25;
const DEFAULT_GROWTH = 0.2;
const DEFAULT_TRAILING_MONTHS = 18;

// ─── Helpers ──────────────────────────────────────────────────────────

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function trailingMonthKeys(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 1; i <= n; i++) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
    );
    out.push(monthKey(d));
  }
  return out;
}

// Roll trailing daily rows up to per-(variant, month) sold/inStock
// aggregates. In-stock fraction = share of days in the month with
// on_hand > 0, per the spec.
function rollDailyIntoMonthly(
  daily: Array<{
    shopifyVariantId: string;
    date: Date;
    onHand: number;
    unitsSold: number;
  }>,
): Map<string, Map<string, { unitsSold: number; inStockFraction: number }>> {
  // outer key: variantId, inner key: "YYYY-MM"
  const perVariant = new Map<
    string,
    Map<string, { sold: number; inStockDays: number; totalDays: number }>
  >();
  for (const row of daily) {
    const mk = monthKey(row.date);
    let byMonth = perVariant.get(row.shopifyVariantId);
    if (!byMonth) {
      byMonth = new Map();
      perVariant.set(row.shopifyVariantId, byMonth);
    }
    let m = byMonth.get(mk);
    if (!m) {
      m = { sold: 0, inStockDays: 0, totalDays: 0 };
      byMonth.set(mk, m);
    }
    m.sold += row.unitsSold;
    m.totalDays += 1;
    // Spec: negative on_hand counts as OOS for in_stock_fraction.
    if (row.onHand > 0) m.inStockDays += 1;
  }
  const out = new Map<
    string,
    Map<string, { unitsSold: number; inStockFraction: number }>
  >();
  for (const [variantId, byMonth] of perVariant.entries()) {
    const inner = new Map<string, { unitsSold: number; inStockFraction: number }>();
    for (const [mk, m] of byMonth.entries()) {
      inner.set(mk, {
        unitsSold: m.sold,
        inStockFraction: m.totalDays > 0 ? m.inStockDays / m.totalDays : 0,
      });
    }
    out.set(variantId, inner);
  }
  return out;
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Compute a full style forecast for a single product. Reads all
 * required inputs from the DB and calls the pure engine.
 */
export async function runProductForecast(
  opts: ForecastRunOptions,
): Promise<ForecastRunResult | null> {
  const trailingMonths = opts.trailingMonths ?? DEFAULT_TRAILING_MONTHS;
  const monthKeys = trailingMonthKeys(trailingMonths);
  const oldestMonth = monthKeys[monthKeys.length - 1];
  // Oldest month → its first day. Enough of a floor for daily fetch.
  const oldestBound = new Date(`${oldestMonth}-01T00:00:00Z`);

  // Pull all variant rows we know about for this product across the
  // trailing window (daily + monthly). Also grab the LATEST daily row
  // per variant so we know current on_hand, product_title, product_type.
  const [dailyRows, monthlyRows, latestDaily, config, openPoLines] =
    await Promise.all([
      db.variantDaySnapshot.findMany({
        where: {
          shop: opts.shop,
          shopifyProductId: opts.productId,
          date: { gte: oldestBound },
        },
        select: {
          shopifyVariantId: true,
          date: true,
          onHand: true,
          unitsSold: true,
        },
      }),
      db.variantMonthSnapshot.findMany({
        where: {
          shop: opts.shop,
          shopifyProductId: opts.productId,
          month: { in: monthKeys },
        },
      }),
      // The latest known daily row per variant for on_hand + metadata.
      // Prisma has no groupBy + take-first, so we fetch the latest date
      // and re-filter in memory.
      db.variantDaySnapshot.findMany({
        where: { shop: opts.shop, shopifyProductId: opts.productId },
        orderBy: { date: "desc" },
        take: 1000,
      }),
      db.productForecastConfig.findUnique({
        where: {
          shop_shopifyProductId: {
            shop: opts.shop,
            shopifyProductId: opts.productId,
          },
        },
      }),
      // Sum of quantityOrdered − quantityReceived on any not-yet-received
      // PO lines. Used as on_order per variant.
      db.purchaseOrderLineItem.findMany({
        where: {
          shopifyProductId: opts.productId,
          purchaseOrder: {
            shop: opts.shop,
            status: { in: ["draft", "ordered", "partially_received"] },
          },
        },
        select: {
          shopifyVariantId: true,
          quantityOrdered: true,
          quantityReceived: true,
        },
      }),
    ]);

  // If nothing is on file at all, we can't produce a meaningful
  // forecast. Bail so the caller renders an empty state.
  if (dailyRows.length === 0 && monthlyRows.length === 0 && latestDaily.length === 0) {
    return null;
  }

  // Latest metadata (title, productType) — use the freshest daily row.
  const latestByVariant = new Map<
    string,
    {
      onHand: number;
      productTitle: string;
      productType: string;
      variantTitle: string;
    }
  >();
  for (const row of latestDaily) {
    if (!latestByVariant.has(row.shopifyVariantId)) {
      latestByVariant.set(row.shopifyVariantId, {
        onHand: row.onHand,
        productTitle: row.productTitle,
        productType: row.productType,
        // The daily snapshot doesn't carry the variant title today; we
        // rely on the variantMeta the route hydrates from Shopify. Left
        // as empty here — the route joins it in for display.
        variantTitle: "",
      });
    }
  }

  const productTitle =
    Array.from(latestByVariant.values())[0]?.productTitle ?? "";
  const productType =
    Array.from(latestByVariant.values())[0]?.productType ?? "";

  // History assembly: prefer daily-derived monthly rollups, fall back
  // to VariantMonthSnapshot for pre-cutover months.
  const dailyMonthly = rollDailyIntoMonthly(
    dailyRows.map((r) => ({
      shopifyVariantId: r.shopifyVariantId,
      date: r.date,
      onHand: r.onHand,
      unitsSold: r.unitsSold,
    })),
  );
  const monthlyIndex = new Map<
    string,
    Map<string, { unitsSold: number; inStockFraction: number }>
  >();
  for (const m of monthlyRows) {
    let inner = monthlyIndex.get(m.shopifyVariantId);
    if (!inner) {
      inner = new Map();
      monthlyIndex.set(m.shopifyVariantId, inner);
    }
    inner.set(m.month, {
      unitsSold: m.unitsSold,
      inStockFraction: m.inStockFraction,
    });
  }

  // Union of variant IDs seen anywhere.
  const allVariantIds = new Set<string>([
    ...dailyMonthly.keys(),
    ...monthlyIndex.keys(),
    ...latestByVariant.keys(),
  ]);

  // On-order per variant from open POs.
  const onOrderByVariant = new Map<string, number>();
  for (const line of openPoLines) {
    const remaining = Math.max(
      0,
      line.quantityOrdered - line.quantityReceived,
    );
    if (remaining <= 0) continue;
    onOrderByVariant.set(
      line.shopifyVariantId,
      (onOrderByVariant.get(line.shopifyVariantId) ?? 0) + remaining,
    );
  }

  // Category → seasonal indices lookup.
  const categoryUsed = opts.category ?? config?.category ?? productType ?? "default";
  const seasonalRows = await db.seasonalIndex.findMany({
    where: { shop: opts.shop, category: categoryUsed },
  });
  const seasonalIndices: Record<number, number> = {};
  for (const row of seasonalRows) {
    seasonalIndices[row.month] = row.value;
  }

  // Build the engine's per-variant input list.
  const forecastInputs: VariantForecastInput[] = [];
  for (const variantId of allVariantIds) {
    // Compose the history: for each month in the trailing window,
    // prefer daily-derived data (source of truth once accumulated),
    // fall back to VariantMonthSnapshot for months where daily is
    // absent or incomplete.
    const history: VariantMonthHistory[] = [];
    for (const mk of monthKeys) {
      const daily = dailyMonthly.get(variantId)?.get(mk);
      const monthly = monthlyIndex.get(variantId)?.get(mk);
      const chosen = daily ?? monthly;
      if (!chosen) continue;
      history.push({
        month: mk,
        unitsSold: chosen.unitsSold,
        inStockFraction: chosen.inStockFraction,
      });
    }
    // isActive proxy: has a latest daily snapshot row (means the
    // catalog walk saw it recently). Deleted / archived variants
    // fall off the catalog walk and lose isActive.
    const isActive = latestByVariant.has(variantId);
    forecastInputs.push({
      variantId,
      productId: opts.productId,
      onHand: latestByVariant.get(variantId)?.onHand ?? 0,
      onOrder: onOrderByVariant.get(variantId) ?? 0,
      isActive,
      history,
    });
  }

  const params: ForecastParams = {
    coverageStart: opts.coverageStart,
    coverageMonths: opts.coverageMonths,
    safetyBuffer: opts.safetyBuffer ?? config?.safetyBuffer ?? DEFAULT_SAFETY_BUFFER,
    growth: opts.growth ?? config?.growth ?? DEFAULT_GROWTH,
    casePack: opts.casePack ?? config?.casePack ?? undefined,
    moq: opts.moq ?? config?.moq ?? undefined,
    seasonalIndices,
  };

  const result = suggestOrder(opts.productId, forecastInputs, params);

  return {
    ...result,
    variantMeta: [], // route hydrates from Shopify for display
    categoryUsed,
    productTitle,
    productType,
  };
}
