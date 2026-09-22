import db from "../../db.server";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import {
  adjustInventoryBatch,
  getVariantsInventory,
} from "../shopify-api/inventory.server";
import { fetchOnHandAtLocation, type OnHandResult } from "../on-hand/on-hand.server";
import {
  CACHE_KEYS,
  CACHE_TTL,
  getCached,
  invalidateCache,
} from "../cache/shopify-cache.server";
import type { CycleCell } from "./cycle-count-utils";

export type { CycleCell } from "./cycle-count-utils";

/**
 * Stock Counts — rolling, location-scoped cycle count.
 *
 * There is no "count session" any more. The page loads every variant
 * with stock at a location, the user counts row by row, and each Save
 * Row (a) adjusts Shopify immediately for any cell whose count differs
 * from live `available`, and (b) stamps VariantLocationCount so the
 * page can show "last counted X ago" and list what hasn't been checked
 * in N days.
 */

export interface CycleRowsResult {
  cells: CycleCell[];
  productCount: number;
  variantCount: number;
  totalUnits: number;
  truncated: boolean;
  /** ISO timestamp of when the Shopify half was fetched (cache-aware). */
  loadedAt: string;
}

const LAST_COUNTED_CHUNK = 500; // SQLite parameter cap safety

/**
 * Attach lastCountedAt / lastCountedQty from VariantLocationCount to a
 * list of cells. Always live — never cached — so a save in another tab
 * shows up on the next Load.
 */
async function attachLastCounted<T extends { variantId: string }>(
  shop: string,
  locationId: string,
  cells: T[],
): Promise<Array<T & { lastCountedAt: string | null; lastCountedQty: number | null }>> {
  const map = new Map<string, { at: Date; qty: number }>();
  const ids = cells.map((c) => c.variantId);
  for (let i = 0; i < ids.length; i += LAST_COUNTED_CHUNK) {
    const chunk = ids.slice(i, i + LAST_COUNTED_CHUNK);
    const rows = await db.variantLocationCount.findMany({
      where: { shop, locationId, shopifyVariantId: { in: chunk } },
      select: { shopifyVariantId: true, lastCountedAt: true, lastCountedQty: true },
    });
    for (const r of rows) {
      map.set(r.shopifyVariantId, { at: r.lastCountedAt, qty: r.lastCountedQty });
    }
  }
  return cells.map((c) => {
    const hit = map.get(c.variantId);
    return {
      ...c,
      lastCountedAt: hit ? hit.at.toISOString() : null,
      lastCountedQty: hit ? hit.qty : null,
    };
  });
}

/**
 * Every variant at `locationId` (available > 0 unless includeZeroStock),
 * joined with its last-counted record. The Shopify walk is cached for a
 * few minutes (CACHE_TTL.CYCLE_ROWS); pass forceRefresh to bust it.
 */
export async function getCycleCountRows(
  admin: AdminApiContext,
  shop: string,
  locationId: string,
  opts: { includeZeroStock?: boolean; forceRefresh?: boolean } = {},
): Promise<CycleRowsResult> {
  const includeZeroStock = opts.includeZeroStock ?? false;
  const key = CACHE_KEYS.cycleRows(locationId, includeZeroStock);
  if (opts.forceRefresh) await invalidateCache(shop, [key]);

  const cached = await getCached<{ result: OnHandResult; loadedAt: string }>(
    shop,
    key,
    CACHE_TTL.CYCLE_ROWS,
    async () => ({
      result: await fetchOnHandAtLocation(admin, {
        locationGid: locationId,
        search: "",
        tags: [],
        includeZeroStock,
      }),
      loadedAt: new Date().toISOString(),
    }),
  );

  const base = cached.result.cells.map((c) => ({
    variantId: c.variantId,
    productId: c.productId,
    inventoryItemId: c.inventoryItemId ?? null,
    productTitle: c.productTitle,
    variantTitle: c.variantTitle,
    vendor: c.vendor ?? null,
    sku: c.sku,
    barcode: c.barcode ?? null,
    selectedOptions: c.selectedOptions,
    onHand: c.onHand,
  }));
  const cells = await attachLastCounted(shop, locationId, base);

  return {
    cells,
    productCount: cached.result.productCount,
    variantCount: cached.result.variantCount,
    totalUnits: cached.result.totalUnits,
    truncated: cached.result.truncated,
    loadedAt: cached.loadedAt,
  };
}

export interface CycleSaveEntry {
  variantId: string;
  countedQty: number;
  // Snapshot fields from the client so the VariantLocationCount row can
  // be self-describing without a catalog lookup.
  productId: string;
  productTitle: string;
  variantTitle: string;
  vendor?: string | null;
  sku?: string | null;
  barcode?: string | null;
}

export interface CycleSaveResult {
  /** Updated rows to merge into client state. */
  rows: Array<{
    variantId: string;
    currentQty: number;
    previousQty: number;
    lastCountedAt: string;
  }>;
  /** Variants Shopify no longer knows about (deleted) — drop from the grid. */
  missing: string[];
  adjusted: number;
  verified: number;
  sessionId: string | null;
}

/**
 * Save a row of counts at a location:
 *   1. re-read live Shopify `available` for every variant in the row
 *   2. adjust any cell whose count differs (one batched mutation,
 *      reason cycle_count_available) and write an audited session
 *   3. upsert VariantLocationCount for EVERY entry, so "verified, no
 *      change" still stamps the last-counted time.
 * DB writes happen only after Shopify accepted the adjustment, so a
 * rejected save never marks anything as counted.
 */
export async function saveCycleCounts(
  admin: AdminApiContext,
  shop: string,
  locationId: string,
  entries: CycleSaveEntry[],
  createdBy: string | null = null,
): Promise<CycleSaveResult> {
  if (entries.length === 0) throw new Error("Nothing to save.");
  for (const e of entries) {
    if (!Number.isInteger(e.countedQty) || e.countedQty < 0) {
      throw new Error(
        `Counted quantity for ${e.productTitle} — ${e.variantTitle} must be a whole number ≥ 0.`,
      );
    }
  }

  const variantIds = [...new Set(entries.map((e) => e.variantId))];
  const invMap = await getVariantsInventory(admin, variantIds);

  const missing: string[] = [];
  const changes: Array<{
    variantId: string;
    inventoryItemId: string;
    previousQuantity: number;
    newQuantity: number;
    delta: number;
  }> = [];
  const current = new Map<string, number>();

  for (const e of entries) {
    const inv = invMap.get(e.variantId);
    if (!inv) {
      missing.push(e.variantId);
      continue;
    }
    const level = inv.levels.find((l) => l.locationId === locationId);
    const currentQty = level?.quantities.available ?? 0;
    current.set(e.variantId, currentQty);
    const delta = e.countedQty - currentQty;
    if (delta !== 0) {
      changes.push({
        variantId: e.variantId,
        inventoryItemId: inv.inventoryItemId,
        previousQuantity: currentQty,
        newQuantity: e.countedQty,
        delta,
      });
    }
  }

  let sessionId: string | null = null;
  if (changes.length > 0) {
    const result = await adjustInventoryBatch(
      admin,
      changes.map((c) => ({
        inventoryItemId: c.inventoryItemId,
        locationId,
        delta: c.delta,
      })),
      "cycle_count_available",
    );
    if (result.userErrors?.length > 0) {
      throw new Error(
        "Shopify rejected the adjustment: " +
          result.userErrors.map((u: { message: string }) => u.message).join("; "),
      );
    }
    const first = entries[0];
    const session = await db.inventoryAdjustmentSession.create({
      data: {
        shop,
        locationId,
        reason: "cycle_count_available",
        source: "cycle_count",
        notes: `Cycle count: ${first.productTitle}${
          entries.length > 1 ? ` (${entries.length} variants)` : ` — ${first.variantTitle}`
        }`,
        createdBy,
        changes: {
          create: changes.map((c) => ({
            shopifyVariantId: c.variantId,
            shopifyInventoryItemId: c.inventoryItemId,
            previousQuantity: c.previousQuantity,
            newQuantity: c.newQuantity,
            delta: c.delta,
          })),
        },
      },
    });
    sessionId = session.id;
  }

  const now = new Date();
  const saved = entries.filter((e) => current.has(e.variantId));
  await db.$transaction(
    saved.map((e) =>
      db.variantLocationCount.upsert({
        where: {
          shop_locationId_shopifyVariantId: {
            shop,
            locationId,
            shopifyVariantId: e.variantId,
          },
        },
        create: {
          shop,
          locationId,
          shopifyVariantId: e.variantId,
          shopifyProductId: e.productId,
          productTitle: e.productTitle,
          variantTitle: e.variantTitle,
          vendor: e.vendor ?? null,
          sku: e.sku ?? null,
          barcode: e.barcode ?? null,
          lastCountedAt: now,
          lastCountedQty: e.countedQty,
          previousQty: current.get(e.variantId) ?? 0,
          countedBy: createdBy,
          sessionId,
        },
        update: {
          shopifyProductId: e.productId,
          productTitle: e.productTitle,
          variantTitle: e.variantTitle,
          vendor: e.vendor ?? null,
          sku: e.sku ?? null,
          barcode: e.barcode ?? null,
          lastCountedAt: now,
          lastCountedQty: e.countedQty,
          previousQty: current.get(e.variantId) ?? 0,
          countedBy: createdBy,
          sessionId,
        },
      }),
    ),
  );

  return {
    rows: saved.map((e) => ({
      variantId: e.variantId,
      currentQty: e.countedQty,
      previousQty: current.get(e.variantId) ?? 0,
      lastCountedAt: now.toISOString(),
    })),
    missing,
    adjusted: changes.length,
    verified: saved.length - changes.length,
    sessionId,
  };
}
