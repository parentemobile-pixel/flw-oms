import { describe, it, expect } from "vitest";
import {
  suggestOrder,
  computeWindow,
  type ForecastParams,
  type VariantForecastInput,
} from "./forecast-engine";

/**
 * Hand-computed regression suite. Every expected value below can be
 * re-derived from the formula in the engine comments — a reader can
 * check the math without running the code, which is the point.
 */

// All-ones seasonality — turns seasonality into a no-op so the other
// terms are readable in isolation. See the seasonal test for the
// non-trivial version.
const FLAT_SEASONS: Record<number, number> = Object.fromEntries(
  Array.from({ length: 12 }, (_, i) => [i + 1, 1.0]),
);

function isoDate(d: string): Date {
  return new Date(`${d}T00:00:00Z`);
}

describe("suggestOrder — basic style with two active variants", () => {
  // Two variants, two months, always in stock, flat seasonality.
  //
  //   S:  sold 10, sold 10  → corrected 20   ↘
  //   M:  sold 20, sold 20  → corrected 40   → total active = 60
  //
  //   style_rate = 60 / 4  (denominator = Σ in_stock × seasonal = 4×1×1)
  //              = 15
  //   share:     S = 20/60 = 1/3
  //              M = 40/60 = 2/3
  //   window:    Jul 1 + 30 days → Jul 31   (July has 31 days)
  //              contribution = 1.0 × 30/31 = 30/31
  //   growth=0, buffer=0, on_hand=0, on_order=0
  //
  //   forecast_S = 15 × 1/3 × 30/31 = 150/31 ≈ 4.8387 → ceil = 5
  //   forecast_M = 15 × 2/3 × 30/31 = 300/31 ≈ 9.6774 → ceil = 10
  //   confidence = 2 months < 4 → LOW

  const variants: VariantForecastInput[] = [
    {
      variantId: "gid://Variant/S",
      productId: "gid://Product/1",
      onHand: 0,
      onOrder: 0,
      isActive: true,
      history: [
        { month: "2026-05", unitsSold: 10, inStockFraction: 1.0 },
        { month: "2026-06", unitsSold: 10, inStockFraction: 1.0 },
      ],
    },
    {
      variantId: "gid://Variant/M",
      productId: "gid://Product/1",
      onHand: 0,
      onOrder: 0,
      isActive: true,
      history: [
        { month: "2026-05", unitsSold: 20, inStockFraction: 1.0 },
        { month: "2026-06", unitsSold: 20, inStockFraction: 1.0 },
      ],
    },
  ];
  const params: ForecastParams = {
    coverageStart: isoDate("2026-07-01"),
    coverageMonths: 1,
    safetyBuffer: 0,
    growth: 0,
    seasonalIndices: FLAT_SEASONS,
  };
  const result = suggestOrder("gid://Product/1", variants, params);

  it("style rate = total sold ÷ Σ (in-stock × seasonal)", () => {
    expect(result.styleRate).toBeCloseTo(15, 5);
  });
  it("variant shares split by corrected-sales weight", () => {
    expect(result.variants[0].variantShare).toBeCloseTo(1 / 3, 5);
    expect(result.variants[1].variantShare).toBeCloseTo(2 / 3, 5);
  });
  it("forecast units scale by share × window", () => {
    expect(result.variants[0].forecastUnits).toBeCloseTo(150 / 31, 5);
    expect(result.variants[1].forecastUnits).toBeCloseTo(300 / 31, 5);
  });
  it("suggested order = ceil(forecast) when on_hand + on_order = 0", () => {
    expect(result.variants[0].suggestedOrder).toBe(5);
    expect(result.variants[1].suggestedOrder).toBe(10);
  });
  it("2 months of history → LOW confidence", () => {
    expect(result.confidence).toBe("LOW");
    expect(result.monthsOfHistory).toBe(2);
  });
});

describe("suggestOrder — inactive variants redistribute demand", () => {
  // Same S and M as before, plus an inactive L that also had sales.
  // The formula must renormalize variant_share over active variants
  // ONLY, so S and M end up with the same shares as if L never existed.
  const variants: VariantForecastInput[] = [
    {
      variantId: "gid://Variant/S",
      productId: "gid://Product/1",
      onHand: 0,
      onOrder: 0,
      isActive: true,
      history: [
        { month: "2026-05", unitsSold: 10, inStockFraction: 1.0 },
        { month: "2026-06", unitsSold: 10, inStockFraction: 1.0 },
      ],
    },
    {
      variantId: "gid://Variant/M",
      productId: "gid://Product/1",
      onHand: 0,
      onOrder: 0,
      isActive: true,
      history: [
        { month: "2026-05", unitsSold: 20, inStockFraction: 1.0 },
        { month: "2026-06", unitsSold: 20, inStockFraction: 1.0 },
      ],
    },
    {
      variantId: "gid://Variant/L-deleted",
      productId: "gid://Product/1",
      onHand: 0,
      onOrder: 0,
      isActive: false,
      history: [
        { month: "2026-05", unitsSold: 30, inStockFraction: 1.0 },
      ],
    },
  ];
  const params: ForecastParams = {
    coverageStart: isoDate("2026-07-01"),
    coverageMonths: 1,
    safetyBuffer: 0,
    growth: 0,
    seasonalIndices: FLAT_SEASONS,
  };
  const result = suggestOrder("gid://Product/1", variants, params);

  it("inactive variant's variant_share is 0", () => {
    const l = result.variants.find((v) => !v.variantId.includes("S") && !v.variantId.includes("M"));
    expect(l?.variantShare).toBe(0);
    expect(l?.suggestedOrder).toBe(0);
  });
  it("active variants renormalize over just themselves", () => {
    expect(result.variants[0].variantShare).toBeCloseTo(1 / 3, 5);
    expect(result.variants[1].variantShare).toBeCloseTo(2 / 3, 5);
  });
});

describe("suggestOrder — availability correction", () => {
  // Variant M was in stock only half of June. Corrected sales
  // = 20 / max(0.5, 0.2) = 40 for the month vs raw 20. This should
  // shift variant share toward M relative to a naive computation.
  //
  //   S corrected: 10/1 + 10/1 = 20
  //   M corrected: 20/1 + 20/0.5 = 20 + 40 = 60
  //   share: S = 20/80 = 0.25, M = 60/80 = 0.75

  const variants: VariantForecastInput[] = [
    {
      variantId: "gid://Variant/S",
      productId: "gid://Product/1",
      onHand: 0,
      onOrder: 0,
      isActive: true,
      history: [
        { month: "2026-05", unitsSold: 10, inStockFraction: 1.0 },
        { month: "2026-06", unitsSold: 10, inStockFraction: 1.0 },
      ],
    },
    {
      variantId: "gid://Variant/M",
      productId: "gid://Product/1",
      onHand: 0,
      onOrder: 0,
      isActive: true,
      history: [
        { month: "2026-05", unitsSold: 20, inStockFraction: 1.0 },
        { month: "2026-06", unitsSold: 20, inStockFraction: 0.5 },
      ],
    },
  ];
  const params: ForecastParams = {
    coverageStart: isoDate("2026-07-01"),
    coverageMonths: 1,
    safetyBuffer: 0,
    growth: 0,
    seasonalIndices: FLAT_SEASONS,
  };
  const result = suggestOrder("gid://Product/1", variants, params);

  it("availability-corrected share favors the frequently-OOS variant", () => {
    expect(result.variants[0].variantShare).toBeCloseTo(0.25, 5);
    expect(result.variants[1].variantShare).toBeCloseTo(0.75, 5);
  });
});

describe("suggestOrder — negative on_hand adds to the order", () => {
  // Oversold M by 3 units. suggested_order should reflect the
  // 3-unit hole in addition to the forecast.
  //
  //   forecast_M = 15 × 2/3 × 30/31 ≈ 9.6774
  //   need = 9.6774 - (-3) - 0 = 12.6774 → ceil = 13
  const variants: VariantForecastInput[] = [
    {
      variantId: "gid://Variant/S",
      productId: "gid://Product/1",
      onHand: 5,
      onOrder: 0,
      isActive: true,
      history: [
        { month: "2026-05", unitsSold: 10, inStockFraction: 1.0 },
        { month: "2026-06", unitsSold: 10, inStockFraction: 1.0 },
      ],
    },
    {
      variantId: "gid://Variant/M",
      productId: "gid://Product/1",
      onHand: -3,
      onOrder: 0,
      isActive: true,
      history: [
        { month: "2026-05", unitsSold: 20, inStockFraction: 1.0 },
        { month: "2026-06", unitsSold: 20, inStockFraction: 1.0 },
      ],
    },
  ];
  const params: ForecastParams = {
    coverageStart: isoDate("2026-07-01"),
    coverageMonths: 1,
    safetyBuffer: 0,
    growth: 0,
    seasonalIndices: FLAT_SEASONS,
  };
  const result = suggestOrder("gid://Product/1", variants, params);

  it("negative on_hand adds an owed-units hole to suggested_order", () => {
    // forecast_M ≈ 9.6774; hole = -(-3) = +3; ceil(12.6774) = 13
    expect(result.variants[1].suggestedOrder).toBe(13);
    // forecast_S ≈ 4.8387; on_hand covers most; ceil(-0.1613) → 0
    expect(result.variants[0].suggestedOrder).toBe(0);
  });
});

describe("suggestOrder — case pack rounds UP", () => {
  // Single active variant absorbs the whole style rate. Numerator = 40
  // units, denominator = 2 (two months × 1.0 × 1.0) → style_rate = 20.
  // share = 1.0, window = 30/31, growth = 0.
  //   forecast = 20 × 1.0 × 30/31 ≈ 19.354
  //   need = 19.354 → ceil = 20 → next 12-pack ≥ 20 = 24
  const variants: VariantForecastInput[] = [
    {
      variantId: "gid://Variant/M",
      productId: "gid://Product/1",
      onHand: 0,
      onOrder: 0,
      isActive: true,
      history: [
        { month: "2026-05", unitsSold: 20, inStockFraction: 1.0 },
        { month: "2026-06", unitsSold: 20, inStockFraction: 1.0 },
      ],
    },
  ];
  const params: ForecastParams = {
    coverageStart: isoDate("2026-07-01"),
    coverageMonths: 1,
    safetyBuffer: 0,
    growth: 0,
    seasonalIndices: FLAT_SEASONS,
    casePack: 12,
  };
  const result = suggestOrder("gid://Product/1", variants, params);
  it("rounds UP to the next multiple of case_pack", () => {
    expect(result.variants[0].suggestedOrder).toBe(24);
  });
});

describe("suggestOrder — confidence tiers", () => {
  function buildWithMonths(nMonths: number) {
    const history = Array.from({ length: nMonths }, (_, i) => ({
      month: `2026-${String(i + 1).padStart(2, "0")}`,
      unitsSold: 1,
      inStockFraction: 1.0,
    }));
    return suggestOrder(
      "gid://Product/1",
      [
        {
          variantId: "gid://Variant/S",
          productId: "gid://Product/1",
          onHand: 0,
          onOrder: 0,
          isActive: true,
          history,
        },
      ],
      {
        coverageStart: isoDate("2026-07-01"),
        coverageMonths: 1,
        safetyBuffer: 0,
        growth: 0,
        seasonalIndices: FLAT_SEASONS,
      },
    );
  }
  it("< 4 months → LOW", () => {
    expect(buildWithMonths(3).confidence).toBe("LOW");
  });
  it("4–8 months → MEDIUM", () => {
    expect(buildWithMonths(4).confidence).toBe("MEDIUM");
    expect(buildWithMonths(8).confidence).toBe("MEDIUM");
  });
  it("≥ 9 months → GOOD", () => {
    expect(buildWithMonths(9).confidence).toBe("GOOD");
    expect(buildWithMonths(14).confidence).toBe("GOOD");
  });
});

describe("computeWindow — seasonal proration across calendar months", () => {
  // coverageStart = 2026-08-15, coverageMonths = 3 → 90 days → Nov 13.
  //   Aug: Aug 15 → Aug 31 = 17 days of 31  ; s(8) = 1.86
  //   Sep: Sep 1  → Sep 30 = 30 days of 30 ; s(9) = 0.64
  //   Oct: Oct 1  → Oct 31 = 31 days of 31 ; s(10) = 0.64
  //   Nov: Nov 1  → Nov 13 = 12 days of 30 ; s(11) = 0.54
  //     window = 1.86 × 17/31 + 0.64 + 0.64 + 0.54 × 12/30
  //            = 1.02 + 0.64 + 0.64 + 0.216
  //            = 2.516

  // Seed values from the PRD's tees seasonal indices.
  const seasons: Record<number, number> = {
    1: 0.26, 2: 0.18, 3: 0.32, 4: 0.70, 5: 0.73, 6: 1.94,
    7: 1.67, 8: 1.86, 9: 0.64, 10: 0.64, 11: 0.54, 12: 2.53,
  };
  it("prorates first and last months by their day-of-month overlap", () => {
    const window = computeWindow(isoDate("2026-08-15"), 3, seasons);
    // Rough tolerance for the day-count rounding under DST-free UTC math.
    expect(window).toBeCloseTo(2.516, 2);
  });
});

describe("suggestOrder — MOQ flag", () => {
  const variants: VariantForecastInput[] = [
    {
      variantId: "gid://Variant/S",
      productId: "gid://Product/1",
      onHand: 0,
      onOrder: 0,
      isActive: true,
      history: [
        { month: "2026-05", unitsSold: 1, inStockFraction: 1.0 },
        { month: "2026-06", unitsSold: 1, inStockFraction: 1.0 },
      ],
    },
  ];
  const params: ForecastParams = {
    coverageStart: isoDate("2026-07-01"),
    coverageMonths: 1,
    safetyBuffer: 0,
    growth: 0,
    moq: 50,
    seasonalIndices: FLAT_SEASONS,
  };
  const result = suggestOrder("gid://Product/1", variants, params);
  it("flags when total suggested < MOQ", () => {
    expect(result.belowMoq).toBe(true);
    expect(result.totalSuggestedOrder).toBeLessThan(50);
  });
});
