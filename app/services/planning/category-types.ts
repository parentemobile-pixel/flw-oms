// Pure types + CSV helper for the category aggregate dashboard.
// Kept out of category-service.server.ts so the route file can import CSV
// generation client-side without pulling the server bundle in.

export const SEASON_TAGS = ["FW25", "SS26", "FW26", "SS27", "FW27"] as const;
export const BRAND_TIER_TAGS = [
  "FLW Brand",
  "Private Label",
  "Partner Brand",
] as const;

export interface CategoryAggregate {
  key: string;
  label: string;
  productCount: number;
  variantCount: number;
  unitsInStock: number;
  stockCostValue: number;
  stockRetailValue: number;
  unitsSold: number;
  revenueSold: number;
  unitsSoldPriorYear: number;
  revenueSoldPriorYear: number;
  yoyUnitsPct: number | null;
  sellThroughPct: number;
  onOrder: number;
}

export interface CategoryAggregates {
  seasons: CategoryAggregate[];
  brandTiers: CategoryAggregate[];
  vendors: CategoryAggregate[];
  periodDays: number;
  totals: {
    products: number;
    variants: number;
    unitsInStock: number;
    stockCostValue: number;
    unitsSold: number;
    revenueSold: number;
  };
}

function csvEscape(v: string | number | null): string {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function aggregatesToCSV(agg: CategoryAggregates): string {
  const header = [
    "dimension",
    "bucket",
    "products",
    "variants",
    "units_in_stock",
    "stock_cost_usd",
    "stock_retail_usd",
    "units_sold",
    "revenue_sold_usd",
    "units_sold_prior_year",
    "revenue_sold_prior_year_usd",
    "yoy_units_pct",
    "sell_through_pct",
    "on_order",
  ];
  const lines: string[] = [header.join(",")];

  const emit = (dim: string, rows: CategoryAggregate[]) => {
    for (const r of rows) {
      lines.push(
        [
          dim,
          r.label,
          r.productCount,
          r.variantCount,
          r.unitsInStock,
          r.stockCostValue.toFixed(2),
          r.stockRetailValue.toFixed(2),
          r.unitsSold,
          r.revenueSold.toFixed(2),
          r.unitsSoldPriorYear,
          r.revenueSoldPriorYear.toFixed(2),
          r.yoyUnitsPct == null ? "" : r.yoyUnitsPct.toFixed(1),
          r.sellThroughPct.toFixed(1),
          r.onOrder,
        ]
          .map(csvEscape)
          .join(","),
      );
    }
  };

  emit("season", agg.seasons);
  emit("brand_tier", agg.brandTiers);
  emit("vendor", agg.vendors);

  return lines.join("\n");
}
