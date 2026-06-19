import db from "../../db.server";
import { STOCKY_BACKFILL } from "./stocky-backfill-data";

/**
 * Sentinel locationId for Stocky-imported "total inventory" rows.
 * Stocky's historical_stock_on_hand reports aren't broken out by
 * location, so we file these under a single synthetic id and keep
 * them visible alongside the per-location cron rows.
 */
export const STOCKY_TOTAL_LOCATION_ID = "stocky-total";
export const STOCKY_TOTAL_LABEL = "All locations (Stocky historical)";

function endOfDayUtc(yyyyMmDd: string): Date {
  const out = new Date(`${yyyyMmDd}T00:00:00Z`);
  out.setUTCHours(23, 59, 59, 999);
  return out;
}

/**
 * One-shot backfill of FL Woods' Stocky historical_stock_on_hand
 * report. Idempotent: if the shop already has any Stocky-source row,
 * skip. Safe to call on every boot.
 */
export async function backfillStockyIfNeeded(shop: string): Promise<void> {
  const existing = await db.inventoryValueSnapshot.findFirst({
    where: { shop, locationId: STOCKY_TOTAL_LOCATION_ID },
    select: { id: true },
  });
  if (existing) return;

  const data = STOCKY_BACKFILL.map(([date, cost, retail]) => ({
    shop,
    locationId: STOCKY_TOTAL_LOCATION_ID,
    vendor: null,
    periodEnd: endOfDayUtc(date),
    totalUnits: 0,
    totalCostValue: cost,
    totalRetailValue: retail,
  }));

  await db.inventoryValueSnapshot.createMany({ data });
  console.log(
    `[StockyBackfill] ${shop}: wrote ${data.length} historical rows`,
  );
}
