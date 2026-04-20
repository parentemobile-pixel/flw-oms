import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import {
  getAllVariantsForBarcodeAudit,
  setVariantBarcodes,
  type AuditVariant,
} from "../shopify-api/products.server";
import {
  generateBarcodeForVariant,
  isFLWBarcode,
} from "../shopify-api/barcodes.server";

export interface BarcodeAuditReport {
  /** Every variant in the store. */
  variants: AuditVariant[];
  /** Variants with no barcode set (null or empty). */
  missing: AuditVariant[];
  /** Groups of 2+ variants sharing the same barcode. Healthy duplicates — when
   * multiple store locations carry the same SKU — don't exist at the variant
   * level, so any duplicate here is a real problem. */
  duplicates: Array<{ barcode: string; variants: AuditVariant[] }>;
  /** Variants that have a unique non-empty barcode. */
  healthy: AuditVariant[];
  /** Counts for the dashboard header. */
  counts: {
    total: number;
    missing: number;
    duplicatedVariants: number; // total variants involved in duplicate groups
    duplicateGroups: number; // number of distinct duplicate barcode values
    healthy: number;
  };
}

/**
 * Walk the entire catalog and classify every variant. Safe to call often —
 * just reads from Shopify, no mutations. The full walk scales with variant
 * count; expect a few seconds for a store with thousands of SKUs.
 */
export async function runBarcodeAudit(
  admin: AdminApiContext,
): Promise<BarcodeAuditReport> {
  const variants = await getAllVariantsForBarcodeAudit(admin);

  const missing: AuditVariant[] = [];
  const byBarcode = new Map<string, AuditVariant[]>();

  for (const v of variants) {
    const code = (v.barcode ?? "").trim();
    if (!code) {
      missing.push(v);
      continue;
    }
    if (!byBarcode.has(code)) byBarcode.set(code, []);
    byBarcode.get(code)!.push(v);
  }

  const duplicates: BarcodeAuditReport["duplicates"] = [];
  const healthy: AuditVariant[] = [];
  for (const [barcode, list] of byBarcode.entries()) {
    if (list.length > 1) {
      duplicates.push({ barcode, variants: list });
    } else {
      healthy.push(list[0]);
    }
  }

  // Most visible first: dup groups ordered by size descending, then by
  // barcode string for stable UI output.
  duplicates.sort(
    (a, b) => b.variants.length - a.variants.length || a.barcode.localeCompare(b.barcode),
  );

  return {
    variants,
    missing,
    duplicates,
    healthy,
    counts: {
      total: variants.length,
      missing: missing.length,
      duplicatedVariants: duplicates.reduce(
        (sum, g) => sum + g.variants.length,
        0,
      ),
      duplicateGroups: duplicates.length,
      healthy: healthy.length,
    },
  };
}

/**
 * Generate + apply FLW-prefixed barcodes for every variant in `variantIds`.
 * Meant for the "Fix missing" flow, but also usable for "Replace duplicates"
 * where the caller passes the variants that should keep a fresh code.
 */
export async function generateBarcodesFor(
  admin: AdminApiContext,
  variants: Array<{ variantId: string; productId: string }>,
): Promise<{
  requested: number;
  updated: number;
  failures: Array<{ variantId: string; error: string }>;
}> {
  if (variants.length === 0) {
    return { requested: 0, updated: 0, failures: [] };
  }

  const updates = variants.map((v) => ({
    productId: v.productId,
    variantId: v.variantId,
    barcode: generateBarcodeForVariant(v.variantId),
  }));

  const result = await setVariantBarcodes(admin, updates);
  return {
    requested: variants.length,
    updated: result.updated,
    failures: result.failures,
  };
}

/**
 * "Fix duplicates" helper: for each duplicate group, keep ONE variant
 * (the one whose barcode is already FLW-prefixed, or the oldest variant
 * id as a tiebreaker) and regenerate unique barcodes for the rest.
 *
 * Returns the plan + result; the caller can preview the plan before applying.
 */
export async function planDuplicateFix(
  duplicates: BarcodeAuditReport["duplicates"],
): Promise<{
  toRegenerate: Array<{ variantId: string; productId: string; previousBarcode: string }>;
  toKeep: Array<{ variantId: string; productId: string; barcode: string }>;
}> {
  const toRegenerate: Array<{
    variantId: string;
    productId: string;
    previousBarcode: string;
  }> = [];
  const toKeep: Array<{
    variantId: string;
    productId: string;
    barcode: string;
  }> = [];

  for (const group of duplicates) {
    // Pick a keeper: prefer one whose barcode already looks like an FLW code,
    // otherwise the variant with the lexicographically smallest id (stable).
    const flwOne = group.variants.find((v) => isFLWBarcode(v.barcode));
    const sorted = [...group.variants].sort((a, b) =>
      a.variantId.localeCompare(b.variantId),
    );
    const keeper = flwOne ?? sorted[0];

    toKeep.push({
      variantId: keeper.variantId,
      productId: keeper.productId,
      barcode: group.barcode,
    });

    for (const v of group.variants) {
      if (v.variantId === keeper.variantId) continue;
      toRegenerate.push({
        variantId: v.variantId,
        productId: v.productId,
        previousBarcode: group.barcode,
      });
    }
  }

  return { toRegenerate, toKeep };
}
