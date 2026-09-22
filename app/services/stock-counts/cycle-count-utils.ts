/**
 * Pure helpers for the Stock Counts (cycle count) page. No server
 * imports so they can run client-side and be unit-tested.
 */

export interface CycleCell {
  variantId: string;
  productId: string;
  inventoryItemId: string | null;
  productTitle: string;
  variantTitle: string;
  vendor: string | null;
  sku: string | null;
  barcode: string | null;
  selectedOptions: Array<{ name: string; value: string }>;
  /** Shopify `available` at the location when loaded / last saved. */
  onHand: number;
  /** ISO timestamp of the last count at this location, or null = never. */
  lastCountedAt: string | null;
  lastCountedQty: number | null;
}

const DAY_MS = 86_400_000;

/** True when the cell has never been counted, or not within `days`. */
export function isStale(
  lastCountedAt: string | null | undefined,
  days: number,
  now: number = Date.now(),
): boolean {
  if (!lastCountedAt) return true;
  const t = new Date(lastCountedAt).getTime();
  if (Number.isNaN(t)) return true;
  return now - t > days * DAY_MS;
}

/**
 * Cells not counted in the last `days`. Zero-stock cells are excluded —
 * there is nothing on the shelf to verify, and a phantom that was just
 * zeroed shouldn't keep showing up as "stale".
 */
export function filterStaleCells<T extends Pick<CycleCell, "lastCountedAt" | "onHand">>(
  cells: T[],
  days: number,
  now: number = Date.now(),
): T[] {
  return cells.filter((c) => c.onHand > 0 && isStale(c.lastCountedAt, days, now));
}

/** Barcode match first, then SKU; case-insensitive, whitespace-trimmed. */
export function findCellByCode<T extends Pick<CycleCell, "barcode" | "sku">>(
  cells: T[],
  code: string,
): T | null {
  const needle = code.trim().toUpperCase();
  if (!needle) return null;
  const byBarcode = cells.find(
    (c) => (c.barcode ?? "").trim().toUpperCase() === needle,
  );
  if (byBarcode) return byBarcode;
  const bySku = cells.find((c) => (c.sku ?? "").trim().toUpperCase() === needle);
  return bySku ?? null;
}

export type CycleSort = "vendor" | "product" | "stale";

/**
 * Stable sort used before handing cells to ProductGrid (which preserves
 * input order inside each row group). "stale" puts never-counted first,
 * then oldest count first, then product title.
 */
export function sortCells<T extends CycleCell>(cells: T[], sort: CycleSort): T[] {
  return [...cells].sort((a, b) => {
    if (sort === "vendor") {
      const va = (a.vendor ?? "zzz").toLowerCase();
      const vb = (b.vendor ?? "zzz").toLowerCase();
      if (va !== vb) return va.localeCompare(vb);
    }
    if (sort === "stale") {
      const ta = a.lastCountedAt ? new Date(a.lastCountedAt).getTime() : 0;
      const tb = b.lastCountedAt ? new Date(b.lastCountedAt).getTime() : 0;
      if (ta !== tb) return ta - tb;
    }
    const pa = a.productTitle.toLowerCase();
    const pb = b.productTitle.toLowerCase();
    if (pa !== pb) return pa.localeCompare(pb);
    return a.variantTitle.localeCompare(b.variantTitle);
  });
}

/** Client-side text filter across product / variant / vendor / sku / barcode. */
export function filterCellsByQuery<T extends CycleCell>(cells: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return cells;
  return cells.filter(
    (c) =>
      c.productTitle.toLowerCase().includes(q) ||
      c.variantTitle.toLowerCase().includes(q) ||
      (c.vendor ?? "").toLowerCase().includes(q) ||
      (c.sku ?? "").toLowerCase().includes(q) ||
      (c.barcode ?? "").toLowerCase().includes(q),
  );
}
