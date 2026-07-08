/**
 * Forecast engine — pure function, no I/O, no framework coupling.
 *
 * Core idea: demand rate is units-per-IN-STOCK-day, not per calendar
 * day, so stockouts don't hide popularity. Estimate at the style
 * (product) level, then split across variants using availability-
 * corrected sales history.
 *
 * See PRD §2 for the formal spec. The comments below tie each block
 * to the corresponding step so the tests and the spec stay in sync.
 */

// ─── Types ────────────────────────────────────────────────────────────

/** One month of history for one variant. */
export interface VariantMonthHistory {
  /** "YYYY-MM" */
  month: string;
  unitsSold: number;
  /** Share of days in the month with on_hand > 0. Clamped to [0, 1]. */
  inStockFraction: number;
}

export interface VariantForecastInput {
  variantId: string;
  productId: string;
  /** Current on-hand across all locations. Negative = oversold / owed. */
  onHand: number;
  /** Units already ordered from suppliers, not yet received. */
  onOrder: number;
  /** True when the variant is still active in Shopify (isn't archived). */
  isActive: boolean;
  history: VariantMonthHistory[];
}

export interface ForecastParams {
  /** First day of coverage — typically today + lead_time_days. */
  coverageStart: Date;
  /** Total months of demand this order should cover. */
  coverageMonths: number;
  /** e.g. 0.25 = +25% cushion on top of the point forecast. */
  safetyBuffer: number;
  /** e.g. 0.20 = +20% YoY growth expectation. */
  growth: number;
  /** Optional supplier minimum order quantity (across the style). */
  moq?: number;
  /** Optional case pack — variant suggestions round UP to a multiple. */
  casePack?: number;
  /**
   * Monthly seasonality multipliers keyed 1..12. Values should average
   * near 1.0. Missing months default to 1.0 (no seasonal effect).
   */
  seasonalIndices: Record<number, number>;
}

export type ForecastConfidence = "LOW" | "MEDIUM" | "GOOD";

export interface VariantForecastOutput {
  variantId: string;
  onHand: number;
  onOrder: number;
  /** Share of the style's expected demand this variant should absorb. */
  variantShare: number;
  /** Point forecast in units (before safety buffer). */
  forecastUnits: number;
  /** Final reorder quantity. Case-pack rounded, non-negative. */
  suggestedOrder: number;
  /** Confidence tag derived from months of history for the style. */
  confidence: ForecastConfidence;
}

export interface StyleForecastResult {
  productId: string;
  /** Deseasonalized demand per average in-stock month. */
  styleRate: number;
  /** Distinct months in the trailing window with any in-stock coverage. */
  monthsOfHistory: number;
  confidence: ForecastConfidence;
  /**
   * Total units across the coverage window (Σ variant forecasts).
   * Handy for MOQ checks and quick sanity math in the UI.
   */
  totalForecast: number;
  totalSuggestedOrder: number;
  /**
   * True when the summed suggested_order across the style falls below
   * an optional MOQ. UI can surface a warning or auto-bump.
   */
  belowMoq: boolean;
  variants: VariantForecastOutput[];
}

// ─── Helpers ──────────────────────────────────────────────────────────

/** Extract month number 1..12 from a "YYYY-MM" key. */
function monthNumberOf(key: string): number {
  const parts = key.split("-");
  const n = parseInt(parts[1] ?? "", 10);
  return Number.isFinite(n) ? n : 1;
}

/** Look up seasonal index for month 1..12, defaulting to 1.0. */
function seasonalIndexFor(
  seasonalIndices: Record<number, number>,
  month: number,
): number {
  const v = seasonalIndices[month];
  return Number.isFinite(v) && v > 0 ? v : 1.0;
}

/**
 * Compute the seasonal coverage window: sum of seasonal indices over
 * the months touched by [coverageStart, coverageStart + coverageMonths),
 * with the first and last months prorated by their overlap fraction.
 *
 * Example: coverageStart = 2026-08-15, coverageMonths = 3 →
 *   Aug: (31-14)/31 * s(8)  (Aug 15–31 = 17 days)
 *   Sep: 1.0 * s(9)
 *   Oct: 1.0 * s(10)
 *   Nov: 14/30 * s(11)  (Nov 1–14 = 14 days of the trailing tail)
 * Sum → window contribution to the forecast.
 */
export function computeWindow(
  coverageStart: Date,
  coverageMonths: number,
  seasonalIndices: Record<number, number>,
): number {
  if (coverageMonths <= 0) return 0;

  const start = new Date(coverageStart);
  // Coverage duration in days = coverageMonths × 30. Using 30 keeps
  // "3 months" ≈ "90 days" independent of which months straddle it,
  // so the window is stable across leap years / short months.
  const durationDays = coverageMonths * 30;
  const end = new Date(start.getTime() + durationDays * 24 * 60 * 60 * 1000);

  let window = 0;
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1),
  );
  while (cursor < end) {
    const monthStart = new Date(cursor);
    const monthEnd = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
    );
    const daysInMonth = Math.round(
      (monthEnd.getTime() - monthStart.getTime()) / (24 * 60 * 60 * 1000),
    );
    const overlapStart = start > monthStart ? start : monthStart;
    const overlapEnd = end < monthEnd ? end : monthEnd;
    const overlapDays = Math.max(
      0,
      Math.round(
        (overlapEnd.getTime() - overlapStart.getTime()) / (24 * 60 * 60 * 1000),
      ),
    );
    if (overlapDays > 0) {
      const monthIdx = monthStart.getUTCMonth() + 1;
      const s = seasonalIndexFor(seasonalIndices, monthIdx);
      window += s * (overlapDays / daysInMonth);
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return window;
}

function confidenceFor(months: number): ForecastConfidence {
  if (months < 4) return "LOW";
  if (months < 9) return "MEDIUM";
  return "GOOD";
}

function roundUpToPack(qty: number, casePack?: number): number {
  if (!casePack || casePack <= 1) return qty;
  if (qty <= 0) return 0;
  return Math.ceil(qty / casePack) * casePack;
}

// ─── Engine ───────────────────────────────────────────────────────────

/**
 * Suggest an order for one style (product) at the variant level.
 *
 * Callers pass the full variant history for the style, whether the
 * variant is still active, current on-hand + on-order, and the
 * forecast params. The engine returns a per-variant table and roll-up
 * numbers for the whole style.
 *
 * No I/O. Deterministic given inputs. Safe to unit-test.
 */
export function suggestOrder(
  productId: string,
  variants: VariantForecastInput[],
  params: ForecastParams,
): StyleForecastResult {
  const {
    coverageStart,
    coverageMonths,
    safetyBuffer,
    growth,
    moq,
    casePack,
    seasonalIndices,
  } = params;

  // Style rate — deseasonalized demand per average in-stock month.
  //   style_rate = Σ units_sold  /  Σ (in_stock_fraction × seasonal_index[month])
  // over every (variant, month) in the trailing window.
  let numerator = 0;
  let denominator = 0;
  const seenMonths = new Set<string>();
  for (const v of variants) {
    for (const h of v.history) {
      numerator += h.unitsSold;
      const monthNum = monthNumberOf(h.month);
      const s = seasonalIndexFor(seasonalIndices, monthNum);
      denominator += h.inStockFraction * s;
      // Any activity for the month — sold OR in-stock — counts toward
      // history coverage for the style's confidence tag.
      if (h.unitsSold > 0 || h.inStockFraction > 0) seenMonths.add(h.month);
    }
  }
  const styleRate = denominator > 0 ? numerator / denominator : 0;
  const monthsOfHistory = seenMonths.size;
  const confidence = confidenceFor(monthsOfHistory);

  // Variant share — availability-corrected sales, normalized over
  // active variants only. Deleted or archived variants' demand
  // redistributes to their currently-active siblings.
  const correctedByVariant = new Map<string, number>();
  for (const v of variants) {
    let corrected = 0;
    for (const h of v.history) {
      const denom = Math.max(h.inStockFraction, 0.2);
      corrected += h.unitsSold / denom;
    }
    correctedByVariant.set(v.variantId, corrected);
  }
  const totalActiveCorrected = variants
    .filter((v) => v.isActive)
    .reduce((s, v) => s + (correctedByVariant.get(v.variantId) ?? 0), 0);

  // Seasonal window over the coverage months.
  const window = computeWindow(coverageStart, coverageMonths, seasonalIndices);
  const growthMultiplier = 1 + growth;
  const bufferMultiplier = 1 + safetyBuffer;

  // Per-variant projections.
  let totalForecast = 0;
  let totalSuggestedOrder = 0;
  const variantResults: VariantForecastOutput[] = variants.map((v) => {
    const variantShare = v.isActive && totalActiveCorrected > 0
      ? (correctedByVariant.get(v.variantId) ?? 0) / totalActiveCorrected
      : 0;
    const forecastUnits = styleRate * variantShare * window * growthMultiplier;
    // Buffered forecast minus what we already have + already ordered.
    // Negative on_hand (oversold) subtracts as a POSITIVE — we owe
    // those units, so the order must cover them too.
    const need = forecastUnits * bufferMultiplier - v.onHand - v.onOrder;
    let suggested = Math.max(0, Math.ceil(need));
    suggested = roundUpToPack(suggested, casePack);
    totalForecast += forecastUnits;
    totalSuggestedOrder += suggested;
    return {
      variantId: v.variantId,
      onHand: v.onHand,
      onOrder: v.onOrder,
      variantShare,
      forecastUnits,
      suggestedOrder: suggested,
      confidence,
    };
  });

  return {
    productId,
    styleRate,
    monthsOfHistory,
    confidence,
    totalForecast,
    totalSuggestedOrder,
    belowMoq: !!(moq && totalSuggestedOrder > 0 && totalSuggestedOrder < moq),
    variants: variantResults,
  };
}
