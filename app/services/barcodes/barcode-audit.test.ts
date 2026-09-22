import { describe, expect, it } from "vitest";
import { classifyBarcodes } from "./barcode-audit.server";
import type { AuditVariant } from "../shopify-api/products.server";

function v(id: string, barcode: string | null): AuditVariant {
  return {
    variantId: id,
    productId: "p",
    productTitle: "P",
    variantTitle: id,
    vendor: null,
    status: "ACTIVE",
    sku: null,
    barcode,
    inventoryItemId: null,
    unitCost: null,
  };
}

describe("classifyBarcodes", () => {
  it("buckets missing, duplicate and healthy and orders groups by size", () => {
    const r = classifyBarcodes([
      v("a", "111"),
      v("b", "111"),
      v("c", "222"),
      v("d", "  "),
      v("e", null),
      v("f", "333"),
      v("g", "333"),
      v("h", "333"),
    ]);
    expect(r.missing.map((x) => x.variantId)).toEqual(["d", "e"]);
    expect(r.duplicates.map((g) => [g.barcode, g.variants.length])).toEqual([
      ["333", 3],
      ["111", 2],
    ]);
    expect(r.healthy.map((x) => x.variantId)).toEqual(["c"]);
    expect(r.counts).toEqual({
      total: 8,
      missing: 2,
      duplicatedVariants: 5,
      duplicateGroups: 2,
      healthy: 1,
    });
  });
});
