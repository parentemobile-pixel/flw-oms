import { describe, expect, it } from "vitest";
import {
  filterCellsByQuery,
  filterStaleCells,
  findCellByCode,
  isStale,
  sortCells,
  type CycleCell,
} from "./cycle-count-utils";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-22T12:00:00Z");

function cell(over: Partial<CycleCell> & { variantId: string }): CycleCell {
  return {
    productId: "p1",
    inventoryItemId: null,
    productTitle: "Captain's Shirt",
    variantTitle: "White / M",
    vendor: "FLW",
    sku: null,
    barcode: null,
    selectedOptions: [
      { name: "Color", value: "White" },
      { name: "Size", value: "M" },
    ],
    onHand: 3,
    lastCountedAt: null,
    lastCountedQty: null,
    ...over,
  };
}

describe("isStale", () => {
  it("treats never-counted as stale", () => {
    expect(isStale(null, 30, NOW)).toBe(true);
  });
  it("is stale strictly after N days", () => {
    const exactly = new Date(NOW - 30 * DAY).toISOString();
    const justOver = new Date(NOW - 30 * DAY - 1).toISOString();
    expect(isStale(exactly, 30, NOW)).toBe(false);
    expect(isStale(justOver, 30, NOW)).toBe(true);
  });
});

describe("filterStaleCells", () => {
  it("keeps never/old counts with stock, drops zero-stock and fresh", () => {
    const cells = [
      cell({ variantId: "never" }),
      cell({ variantId: "old", lastCountedAt: new Date(NOW - 45 * DAY).toISOString() }),
      cell({ variantId: "fresh", lastCountedAt: new Date(NOW - 2 * DAY).toISOString() }),
      cell({ variantId: "zero", onHand: 0 }),
    ];
    expect(filterStaleCells(cells, 30, NOW).map((c) => c.variantId)).toEqual([
      "never",
      "old",
    ]);
  });
});

describe("findCellByCode", () => {
  const cells = [
    cell({ variantId: "a", barcode: "123456", sku: "CAP-WHT-M" }),
    cell({ variantId: "b", barcode: null, sku: "123456" }),
  ];
  it("prefers barcode over sku and ignores case/whitespace", () => {
    expect(findCellByCode(cells, " 123456 ")?.variantId).toBe("a");
    expect(findCellByCode(cells, "cap-wht-m")?.variantId).toBe("a");
  });
  it("returns null for unknown or empty codes", () => {
    expect(findCellByCode(cells, "nope")).toBeNull();
    expect(findCellByCode(cells, "   ")).toBeNull();
  });
});

describe("sortCells", () => {
  it("stale sort puts never-counted first, then oldest", () => {
    const cells = [
      cell({ variantId: "fresh", lastCountedAt: new Date(NOW - DAY).toISOString() }),
      cell({ variantId: "never" }),
      cell({ variantId: "old", lastCountedAt: new Date(NOW - 90 * DAY).toISOString() }),
    ];
    expect(sortCells(cells, "stale").map((c) => c.variantId)).toEqual([
      "never",
      "old",
      "fresh",
    ]);
  });
  it("vendor sort groups by vendor then product", () => {
    const cells = [
      cell({ variantId: "z", vendor: "Zeta", productTitle: "A" }),
      cell({ variantId: "a2", vendor: "Alpha", productTitle: "B" }),
      cell({ variantId: "a1", vendor: "Alpha", productTitle: "A" }),
    ];
    expect(sortCells(cells, "vendor").map((c) => c.variantId)).toEqual([
      "a1",
      "a2",
      "z",
    ]);
  });
});

describe("filterCellsByQuery", () => {
  it("matches across title, vendor, sku, barcode", () => {
    const cells = [
      cell({ variantId: "a", sku: "CAP-1" }),
      cell({ variantId: "b", productTitle: "Beanie", vendor: "Other" }),
    ];
    expect(filterCellsByQuery(cells, "cap").map((c) => c.variantId)).toEqual(["a"]);
    expect(filterCellsByQuery(cells, "other").map((c) => c.variantId)).toEqual(["b"]);
    expect(filterCellsByQuery(cells, "").length).toBe(2);
  });
});
