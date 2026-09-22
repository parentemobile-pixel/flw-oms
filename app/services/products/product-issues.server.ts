import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import db from "../../db.server";
import {
  getAllVariantsForBarcodeAudit,
  updateProductFields,
  updateVariantCosts,
  type AuditVariant,
} from "../shopify-api/products.server";
import {
  adjustInventoryBatch,
  getVariantsInventory,
} from "../shopify-api/inventory.server";
import { getLocations } from "../shopify-api/locations.server";
import {
  classifyBarcodes,
  generateBarcodesFor,
  planDuplicateFix,
} from "../barcodes/barcode-audit.server";
import { recordBulkSession, type ChangeResult } from "./bulk-service.server";
import {
  CACHE_KEYS,
  CACHE_TTL,
  invalidateCache,
  peekCached,
  setCached,
} from "../cache/shopify-cache.server";

/**
 * Product Issues — one scan of the catalog, bucketed into the things a
 * merchandiser fixes by hand:
 *   - duplicate barcodes (flag only; print fresh labels)
 *   - missing barcodes (generate)
 *   - negative stock at any location (set / reset / archive)
 *   - missing cost (inline edit)
 *
 * The scan is expensive (full walk + per-variant inventory pass), so the
 * report lives in ShopifyCache and every fix patches it in place. The
 * page never scans in its loader — the user clicks Run scan / Rescan.
 */

export interface StockLevel {
  locationId: string;
  locationName: string;
  available: number;
}

export interface NegativeStockRow extends AuditVariant {
  levels: StockLevel[];
  negativeLevels: StockLevel[];
}

export interface ProductIssuesReport {
  scannedAt: string;
  includeArchived: boolean;
  locations: Array<{ id: string; name: string }>;
  /** Every scanned variant — kept so barcode fixes can re-classify. */
  variants: AuditVariant[];
  duplicateBarcodes: Array<{ barcode: string; variants: AuditVariant[] }>;
  missingBarcodes: AuditVariant[];
  negativeStock: NegativeStockRow[];
  missingCost: AuditVariant[];
  counts: {
    variants: number;
    duplicateGroups: number;
    duplicatedVariants: number;
    missingBarcodes: number;
    healthyBarcodes: number;
    negativeStock: number;
    negativeLevels: number;
    missingCost: number;
  };
}

function isMissingCost(v: AuditVariant): boolean {
  return v.unitCost === null || v.unitCost === 0;
}

function sortByProduct(a: AuditVariant, b: AuditVariant): number {
  return (
    a.productTitle.localeCompare(b.productTitle) ||
    a.variantTitle.localeCompare(b.variantTitle)
  );
}

function buildCounts(
  r: Omit<ProductIssuesReport, "counts">,
): ProductIssuesReport["counts"] {
  return {
    variants: r.variants.length,
    duplicateGroups: r.duplicateBarcodes.length,
    duplicatedVariants: r.duplicateBarcodes.reduce(
      (s, g) => s + g.variants.length,
      0,
    ),
    missingBarcodes: r.missingBarcodes.length,
    healthyBarcodes:
      r.variants.length -
      r.missingBarcodes.length -
      r.duplicateBarcodes.reduce((s, g) => s + g.variants.length, 0),
    negativeStock: r.negativeStock.length,
    negativeLevels: r.negativeStock.reduce(
      (s, row) => s + row.negativeLevels.length,
      0,
    ),
    missingCost: r.missingCost.length,
  };
}

/** Re-derive every bucket from `variants` + the negative rows. */
function rebuild(
  base: Pick<
    ProductIssuesReport,
    "scannedAt" | "includeArchived" | "locations" | "variants" | "negativeStock"
  >,
): ProductIssuesReport {
  const barcodes = classifyBarcodes(base.variants);
  const partial = {
    ...base,
    duplicateBarcodes: barcodes.duplicates,
    missingBarcodes: barcodes.missing.sort(sortByProduct),
    negativeStock: [...base.negativeStock].sort(
      (a, b) =>
        a.negativeLevels.reduce((s, l) => s + l.available, 0) -
          b.negativeLevels.reduce((s, l) => s + l.available, 0) ||
        sortByProduct(a, b),
    ),
    missingCost: base.variants.filter(isMissingCost).sort(sortByProduct),
  };
  return { ...partial, counts: buildCounts(partial) };
}

// ── Scan ──────────────────────────────────────────────────────────────

export async function scanProductIssues(
  admin: AdminApiContext,
  shop: string,
  opts: { includeArchived?: boolean } = {},
): Promise<ProductIssuesReport> {
  const includeArchived = opts.includeArchived ?? false;
  const [allVariants, locations] = await Promise.all([
    getAllVariantsForBarcodeAudit(admin),
    getLocations(admin, shop).catch(() => []),
  ]);
  const variants = includeArchived
    ? allVariants
    : allVariants.filter((v) => v.status !== "ARCHIVED");

  // Per-location pass — the only way to see a negative at one location
  // that's masked by a positive at another (inventory_quantity:<0 is an
  // aggregate). getVariantsInventory chunks 50 ids/call.
  const invMap = await getVariantsInventory(
    admin,
    variants.map((v) => v.variantId),
  );
  const negativeStock: NegativeStockRow[] = [];
  for (const v of variants) {
    const inv = invMap.get(v.variantId);
    if (!inv) continue;
    const levels: StockLevel[] = inv.levels.map((l) => ({
      locationId: l.locationId,
      locationName: l.locationName,
      available: l.quantities.available ?? 0,
    }));
    const negativeLevels = levels.filter((l) => l.available < 0);
    if (negativeLevels.length === 0) continue;
    negativeStock.push({
      ...v,
      inventoryItemId: v.inventoryItemId ?? inv.inventoryItemId,
      levels,
      negativeLevels,
    });
  }

  const report = rebuild({
    scannedAt: new Date().toISOString(),
    includeArchived,
    locations: locations.map((l) => ({ id: l.id, name: l.name })),
    variants,
    negativeStock,
  });
  await setCached(shop, CACHE_KEYS.PRODUCT_ISSUES, CACHE_TTL.PRODUCT_ISSUES, report);
  return report;
}

export async function getProductIssuesReport(
  shop: string,
): Promise<ProductIssuesReport | null> {
  return peekCached<ProductIssuesReport>(shop, CACHE_KEYS.PRODUCT_ISSUES);
}

export async function clearProductIssuesReport(shop: string): Promise<void> {
  await invalidateCache(shop, [CACHE_KEYS.PRODUCT_ISSUES]);
}

async function patchReport(
  shop: string,
  mutate: (r: ProductIssuesReport) => ProductIssuesReport,
): Promise<void> {
  const current = await getProductIssuesReport(shop);
  if (!current) return;
  await setCached(
    shop,
    CACHE_KEYS.PRODUCT_ISSUES,
    CACHE_TTL.PRODUCT_ISSUES,
    mutate(current),
  );
}

// ── Negative stock: set / reset ───────────────────────────────────────

export interface SetStockTarget {
  variantId: string;
  locationId: string;
  /** Desired `available` at that location (0 = reset). */
  newQty: number;
}

export interface SetStockResult {
  applied: number;
  skipped: number;
  sessionIds: string[];
}

/**
 * Set `available` to an absolute number at specific (variant, location)
 * pairs. Re-reads live Shopify first — the cached scan is never trusted
 * for deltas. One batched mutation; one audited session per location.
 */
export async function setNegativeStock(
  admin: AdminApiContext,
  shop: string,
  targets: SetStockTarget[],
  createdBy: string | null = null,
): Promise<SetStockResult> {
  if (targets.length === 0) throw new Error("Nothing to adjust.");
  for (const t of targets) {
    if (!Number.isInteger(t.newQty) || t.newQty < 0) {
      throw new Error("New quantity must be a whole number ≥ 0.");
    }
  }

  const variantIds = [...new Set(targets.map((t) => t.variantId))];
  const invMap = await getVariantsInventory(admin, variantIds);

  const changes: Array<{
    variantId: string;
    inventoryItemId: string;
    locationId: string;
    previousQuantity: number;
    newQuantity: number;
    delta: number;
  }> = [];
  let skipped = 0;
  for (const t of targets) {
    const inv = invMap.get(t.variantId);
    if (!inv) {
      skipped++;
      continue;
    }
    const level = inv.levels.find((l) => l.locationId === t.locationId);
    const current = level?.quantities.available ?? 0;
    const delta = t.newQty - current;
    if (delta === 0) {
      skipped++;
      continue;
    }
    changes.push({
      variantId: t.variantId,
      inventoryItemId: inv.inventoryItemId,
      locationId: t.locationId,
      previousQuantity: current,
      newQuantity: t.newQty,
      delta,
    });
  }

  const sessionIds: string[] = [];
  if (changes.length > 0) {
    const result = await adjustInventoryBatch(
      admin,
      changes.map((c) => ({
        inventoryItemId: c.inventoryItemId,
        locationId: c.locationId,
        delta: c.delta,
      })),
      "correction",
    );
    if (result.userErrors?.length > 0) {
      throw new Error(
        "Shopify rejected the adjustment: " +
          result.userErrors.map((u: { message: string }) => u.message).join("; "),
      );
    }
    // InventoryAdjustmentSession is per-location — one per location touched.
    const byLocation = new Map<string, typeof changes>();
    for (const c of changes) {
      if (!byLocation.has(c.locationId)) byLocation.set(c.locationId, []);
      byLocation.get(c.locationId)!.push(c);
    }
    for (const [locationId, list] of byLocation) {
      const session = await db.inventoryAdjustmentSession.create({
        data: {
          shop,
          locationId,
          reason: "correction",
          source: "product_issues",
          notes: "Product Issues: negative stock corrected",
          createdBy,
          changes: {
            create: list.map((c) => ({
              shopifyVariantId: c.variantId,
              shopifyInventoryItemId: c.inventoryItemId,
              previousQuantity: c.previousQuantity,
              newQuantity: c.newQuantity,
              delta: c.delta,
            })),
          },
        },
      });
      sessionIds.push(session.id);
    }
  }

  // Patch the cached report with the live numbers we just read/wrote.
  await patchReport(shop, (r) => {
    const negativeStock = r.negativeStock
      .map((row) => {
        const inv = invMap.get(row.variantId);
        if (!inv) return row;
        const levels: StockLevel[] = inv.levels.map((l) => {
          const change = changes.find(
            (c) => c.variantId === row.variantId && c.locationId === l.locationId,
          );
          return {
            locationId: l.locationId,
            locationName: l.locationName,
            available: change ? change.newQuantity : (l.quantities.available ?? 0),
          };
        });
        return {
          ...row,
          levels,
          negativeLevels: levels.filter((l) => l.available < 0),
        };
      })
      .filter((row) => row.negativeLevels.length > 0);
    return rebuild({ ...r, negativeStock });
  });

  return { applied: changes.length, skipped, sessionIds };
}

// ── Archive ───────────────────────────────────────────────────────────

export async function archiveProducts(
  admin: AdminApiContext,
  shop: string,
  productIds: string[],
  createdBy: string | null = null,
): Promise<{ archived: number; failures: Array<{ productId: string; error: string }>; sessionId: string | null }> {
  const ids = [...new Set(productIds)].filter(Boolean);
  if (ids.length === 0) throw new Error("No products to archive.");
  const report = await getProductIssuesReport(shop);
  const titleOf = (pid: string) =>
    report?.variants.find((v) => v.productId === pid)?.productTitle ?? pid;

  const changes: ChangeResult[] = [];
  const failures: Array<{ productId: string; error: string }> = [];
  for (const pid of ids) {
    const res = await updateProductFields(admin, pid, { status: "ARCHIVED" });
    changes.push({
      shopifyProductId: pid,
      productTitle: titleOf(pid),
      field: "status",
      previousValue: report?.variants.find((v) => v.productId === pid)?.status ?? null,
      newValue: "ARCHIVED",
      ok: res.ok,
      error: res.error,
    });
    if (!res.ok) failures.push({ productId: pid, error: res.error ?? "Unknown error" });
  }
  const sessionId = await recordBulkSession(
    shop,
    "archive",
    "Product Issues: archived",
    createdBy,
    changes,
  );

  const archivedIds = new Set(changes.filter((c) => c.ok).map((c) => c.shopifyProductId));
  await patchReport(shop, (r) => {
    if (r.includeArchived) {
      return rebuild({
        ...r,
        variants: r.variants.map((v) =>
          archivedIds.has(v.productId) ? { ...v, status: "ARCHIVED" } : v,
        ),
      });
    }
    return rebuild({
      ...r,
      variants: r.variants.filter((v) => !archivedIds.has(v.productId)),
      negativeStock: r.negativeStock.filter((v) => !archivedIds.has(v.productId)),
    });
  });

  return { archived: archivedIds.size, failures, sessionId };
}

// ── Missing cost ──────────────────────────────────────────────────────

export interface CostUpdate {
  productId: string;
  variantId: string;
  cost: number;
}

/**
 * Save unit costs. `applyToProduct` expands each update to every sibling
 * variant of the same product that is still missing a cost (same
 * "only where zero" semantics as the Products page bulk COGS).
 */
export async function saveMissingCosts(
  admin: AdminApiContext,
  shop: string,
  updates: CostUpdate[],
  opts: { applyToProduct?: boolean; createdBy?: string | null } = {},
): Promise<{
  updated: number;
  failures: Array<{ productId: string; error: string }>;
  sessionId: string | null;
}> {
  if (updates.length === 0) throw new Error("Nothing to save.");
  for (const u of updates) {
    if (!Number.isFinite(u.cost) || u.cost <= 0) {
      throw new Error("Cost must be greater than $0.00.");
    }
  }
  const report = await getProductIssuesReport(shop);

  // Expand + de-dupe into per-product variant lists.
  const perProduct = new Map<string, Map<string, number>>();
  const add = (productId: string, variantId: string, cost: number) => {
    if (!perProduct.has(productId)) perProduct.set(productId, new Map());
    perProduct.get(productId)!.set(variantId, cost);
  };
  for (const u of updates) {
    add(u.productId, u.variantId, u.cost);
    if (opts.applyToProduct && report) {
      for (const v of report.variants) {
        if (v.productId === u.productId && isMissingCost(v)) {
          add(u.productId, v.variantId, u.cost);
        }
      }
    }
  }

  const changes: ChangeResult[] = [];
  const failures: Array<{ productId: string; error: string }> = [];
  const savedCost = new Map<string, number>();
  for (const [productId, variantMap] of perProduct) {
    const list = [...variantMap].map(([id, cost]) => ({ id, cost }));
    const res = await updateVariantCosts(admin, productId, list);
    const title =
      report?.variants.find((v) => v.productId === productId)?.productTitle ??
      productId;
    changes.push({
      shopifyProductId: productId,
      productTitle: title,
      field: "cost",
      previousValue: list
        .map((l) => {
          const prev = report?.variants.find((v) => v.variantId === l.id)?.unitCost;
          return prev == null ? "null" : prev.toFixed(2);
        })
        .join(","),
      newValue: list.map((l) => l.cost.toFixed(2)).join(","),
      ok: res.ok,
      error: res.error,
    });
    if (res.ok) {
      for (const l of list) savedCost.set(l.id, l.cost);
    } else {
      failures.push({ productId, error: res.error ?? "Unknown error" });
    }
  }
  const sessionId = await recordBulkSession(
    shop,
    "set_cogs",
    "Product Issues: missing cost",
    opts.createdBy ?? null,
    changes,
  );

  await patchReport(shop, (r) =>
    rebuild({
      ...r,
      variants: r.variants.map((v) =>
        savedCost.has(v.variantId) ? { ...v, unitCost: savedCost.get(v.variantId)! } : v,
      ),
    }),
  );

  return { updated: savedCost.size, failures, sessionId };
}

// ── Barcodes (moved from Barcode Check) ───────────────────────────────

export async function fixMissingBarcodes(
  admin: AdminApiContext,
  shop: string,
  targets: Array<{ variantId: string; productId: string }>,
) {
  const result = await generateBarcodesFor(admin, targets);
  // The generator doesn't return the new codes, so re-read the affected
  // variants' barcodes from Shopify and patch the cached report.
  await refreshVariantBarcodes(admin, shop, targets.map((t) => t.variantId));
  return result;
}

export async function fixDuplicateBarcodes(admin: AdminApiContext, shop: string) {
  const report = await getProductIssuesReport(shop);
  if (!report) throw new Error("Run a scan first.");
  const plan = await planDuplicateFix(report.duplicateBarcodes);
  const result = await generateBarcodesFor(admin, plan.toRegenerate);
  await refreshVariantBarcodes(
    admin,
    shop,
    plan.toRegenerate.map((t) => t.variantId),
  );
  return result;
}

async function refreshVariantBarcodes(
  admin: AdminApiContext,
  shop: string,
  variantIds: string[],
): Promise<void> {
  if (variantIds.length === 0) return;
  const invMap = await getVariantsInventory(admin, variantIds);
  await patchReport(shop, (r) =>
    rebuild({
      ...r,
      variants: r.variants.map((v) => {
        const inv = invMap.get(v.variantId);
        return inv ? { ...v, barcode: inv.barcode ?? v.barcode } : v;
      }),
    }),
  );
}
