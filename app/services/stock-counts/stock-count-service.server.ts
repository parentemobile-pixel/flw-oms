import db from "../../db.server";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import {
  adjustInventoryBatch,
  getVariantsInventory,
} from "../shopify-api/inventory.server";

// ============================================
// CREATE
// ============================================

/**
 * Create a stock count session. Seeds a StockCountLineItem for every variant
 * the shop has that also has inventory at the chosen location. Expected
 * quantities are a snapshot — they might be stale by the time counting ends.
 *
 * Optional filter: pass a vendor or tag list to scope the count to a subset
 * (e.g. "count only FW25 items").
 */
export async function createStockCount(
  admin: AdminApiContext,
  shop: string,
  params: {
    locationId: string;
    name: string;
    /** If set, only seed variants from products matching this vendor. */
    vendorFilter?: string | null;
    /**
     * When false (default), only seed variants with `available > 0`
     * at this location. That way uncounted lines at completion are
     * genuine phantom stock ("we thought we had it, but it's not on
     * the shelf"). Pass `true` to include zero-stock variants — for
     * counts where you specifically want to reconcile slow movers.
     */
    includeZeroStock?: boolean;
  },
) {
  const allProducts: Array<{
    id: string;
    title: string;
    vendor: string;
    variants: {
      edges: Array<{
        node: {
          id: string;
          title: string;
          sku: string | null;
          barcode: string | null;
          selectedOptions: Array<{ name: string; value: string }>;
        };
      }>;
    };
  }> = [];

  let after: string | null = null;
  let hasNext = true;
  const baseQuery = params.vendorFilter
    ? `vendor:"${params.vendorFilter.replace(/"/g, '\\"')}"`
    : undefined;

  const PAGE_QUERY = `#graphql
    query StockCountProducts($first: Int!, $after: String, $query: String) {
      products(first: $first, after: $after, query: $query) {
        edges {
          node {
            id
            title
            vendor
            variants(first: 100) {
              edges {
                node {
                  id
                  title
                  sku
                  barcode
                  selectedOptions {
                    name
                    value
                  }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  while (hasNext) {
    const resp = await admin.graphql(PAGE_QUERY, {
      variables: { first: 100, after, query: baseQuery ?? null },
    });
    const data = (await resp.json()) as any;
    const page = data.data?.products;
    if (!page) break;
    for (const edge of page.edges) allProducts.push(edge.node);
    hasNext = page.pageInfo.hasNextPage;
    after = page.pageInfo.endCursor;
  }

  // Flatten to variant list
  const variants: Array<{
    productId: string;
    productTitle: string;
    vendor: string;
    variantId: string;
    variantTitle: string;
    sku: string | null;
    barcode: string | null;
    selectedOptions: Array<{ name: string; value: string }>;
  }> = [];
  for (const p of allProducts) {
    for (const v of p.variants.edges) {
      variants.push({
        productId: p.id,
        productTitle: p.title,
        vendor: p.vendor,
        variantId: v.node.id,
        variantTitle: v.node.title,
        sku: v.node.sku,
        barcode: v.node.barcode,
        selectedOptions: v.node.selectedOptions ?? [],
      });
    }
  }

  // Fetch per-location inventory for all variants (batched to 50/call)
  const invMap = await getVariantsInventory(
    admin,
    variants.map((v) => v.variantId),
  );

  // Default seed: variants Shopify says have stock at this location
  // (available > 0). This makes uncounted rows at Complete = phantom
  // stock. `includeZeroStock` opens the seed to zero-stock variants
  // for edge cases (reconciling slow movers you know were on shelf).
  const lineItems = variants
    .map((v) => {
      const inv = invMap.get(v.variantId);
      if (!inv) return null;
      const level = inv.levels.find((l) => l.locationId === params.locationId);
      if (!level) return null;
      const available = level.quantities.available ?? 0;
      if (!params.includeZeroStock && available <= 0) return null;
      return {
        shopifyProductId: v.productId,
        shopifyVariantId: v.variantId,
        productTitle: v.productTitle,
        vendor: v.vendor || null,
        variantTitle: v.variantTitle,
        sku: v.sku,
        barcode: v.barcode,
        variantOptions: JSON.stringify(v.selectedOptions),
        expectedQuantity: available,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return db.stockCount.create({
    data: {
      shop,
      locationId: params.locationId,
      name: params.name,
      lineItems: { create: lineItems },
    },
    include: { _count: { select: { lineItems: true } } },
  });
}

// ============================================
// READ
// ============================================

export async function getStockCounts(shop: string) {
  return db.stockCount.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: {
          lineItems: true,
        },
      },
    },
  });
}

export async function getStockCount(shop: string, id: string) {
  return db.stockCount.findFirst({
    where: { shop, id },
    include: {
      lineItems: {
        orderBy: [{ productTitle: "asc" }, { variantTitle: "asc" }],
      },
    },
  });
}

// ============================================
// UPDATE (during counting)
// ============================================

export async function recordCount(
  id: string,
  lineItemId: string,
  // null clears a previously-saved count — the line goes back to
  // "not counted yet" (empty grid cell, no green tick, won't be applied
  // on Complete).
  countedQuantity: number | null,
  countedBy: string | null = null,
) {
  return db.stockCountLineItem.update({
    where: { id: lineItemId },
    data: {
      countedQuantity,
      countedAt: countedQuantity === null ? null : new Date(),
      countedBy: countedQuantity === null ? null : countedBy,
    },
  });
}

/**
 * Persist counted quantities for a batch of line items in one shot.
 * Used by the per-row "Save" button on the count detail page so the
 * whole row flips to "counted" atomically.
 *
 * Also SNAPSHOTS Shopify's current `available` for each involved
 * variant into `shopifyQtyAtSave`. That snapshot is what Complete's
 * delta computation uses — so sales that hit Shopify BETWEEN Save
 * Row and Complete don't get re-added. Without this a long-running
 * count (e.g. counting Monday, completing Friday, with sales during
 * the week) would produce wrong adjustments.
 */
export async function saveRowCounts(
  admin: AdminApiContext,
  stockCountId: string,
  locationId: string,
  entries: Array<{
    lineItemId: string;
    countedQuantity: number;
    shopifyVariantId: string;
  }>,
  countedBy: string | null = null,
) {
  if (entries.length === 0) return;

  // Snapshot Shopify's current `available` for each variant. If the
  // fetch fails, save the counts anyway (shopifyQtyAtSave stays null →
  // Complete falls back to live Shopify, i.e. pre-rework behavior).
  const variantIds = [...new Set(entries.map((e) => e.shopifyVariantId))];
  let snapByVariant = new Map<string, number>();
  try {
    const invMap = await getVariantsInventory(admin, variantIds);
    for (const [variantId, inv] of invMap.entries()) {
      const level = inv.levels.find((l) => l.locationId === locationId);
      if (level) snapByVariant.set(variantId, level.quantities.available ?? 0);
    }
  } catch (error) {
    console.warn(
      "[saveRowCounts] inventory snapshot failed — falling back to live-Shopify delta at Complete",
      error,
    );
    snapByVariant = new Map();
  }

  const now = new Date();
  await db.$transaction(
    entries.map((e) =>
      db.stockCountLineItem.update({
        where: { id: e.lineItemId },
        data: {
          countedQuantity: e.countedQuantity,
          countedAt: now,
          countedBy,
          shopifyQtyAtSave: snapByVariant.get(e.shopifyVariantId) ?? null,
          // Clear the draft atomically with the commit — otherwise a
          // stale in-flight draft POST landing after Save Row would
          // leave the row showing "Draft" until the next revalidate.
          draftQuantity: null,
          draftUpdatedAt: null,
        },
      }),
    ),
  );
}

/**
 * Persist autosaved draft quantities for one or more line items. Called
 * from the debounced client-side buffer as the user types. Does NOT
 * touch `countedQuantity` — the row is only "counted" once the user
 * hits Save Row (`saveRowCounts`).
 *
 * Stale-write guard: skips any line whose `countedAt` is newer than the
 * client-side edit timestamp. Prevents a slow-in-flight draft POST from
 * overwriting a Save Row or scan that arrived first.
 */
export async function saveDraftQuantities(
  stockCountId: string,
  entries: Array<{
    lineItemId: string;
    draftQuantity: number | null;
    clientEditedAt: number;
  }>,
) {
  if (entries.length === 0) return;
  const now = new Date();
  await db.$transaction(
    entries.map((e) =>
      db.stockCountLineItem.updateMany({
        // updateMany over update so we can add the countedAt guard in
        // the WHERE without Prisma yelling about non-unique-key access.
        where: {
          id: e.lineItemId,
          stockCountId,
          OR: [
            { countedAt: null },
            { countedAt: { lt: new Date(e.clientEditedAt) } },
          ],
        },
        data: {
          draftQuantity: e.draftQuantity,
          draftUpdatedAt: now,
        },
      }),
    ),
  );
}

/**
 * For each variantId, return the most recent `countedAt` from any OTHER
 * completed / in-progress count AT THE SAME LOCATION. Powers the
 * "Last counted N days ago" row subtext on the counting screen.
 * Location-scoped because history at Marblehead isn't relevant when
 * you're counting shrink at Tiburon.
 *
 * Chunks the IN() list at 500 to stay under SQLite's parameter cap.
 */
export async function getPreviouslyCountedAtMap(
  shop: string,
  locationId: string,
  variantIds: string[],
  excludeStockCountId: string,
): Promise<
  Map<string, { countedAt: Date; countName: string; stockCountId: string }>
> {
  const out = new Map<
    string,
    { countedAt: Date; countName: string; stockCountId: string }
  >();
  if (variantIds.length === 0) return out;

  const CHUNK = 500;
  for (let i = 0; i < variantIds.length; i += CHUNK) {
    const chunk = variantIds.slice(i, i + CHUNK);
    // Get the freshest counted line per (variantId) restricted to this
    // shop + location + not-this-count. Prisma raw for the GROUP BY.
    const rows = await db.stockCountLineItem.findMany({
      where: {
        shopifyVariantId: { in: chunk },
        countedAt: { not: null },
        stockCount: {
          shop,
          locationId,
          id: { not: excludeStockCountId },
        },
      },
      orderBy: { countedAt: "desc" },
      select: {
        shopifyVariantId: true,
        countedAt: true,
        stockCountId: true,
        stockCount: { select: { name: true } },
      },
    });
    // orderBy desc + first-seen-wins → freshest per variant.
    for (const r of rows) {
      if (out.has(r.shopifyVariantId)) continue;
      if (!r.countedAt) continue;
      out.set(r.shopifyVariantId, {
        countedAt: r.countedAt,
        countName: r.stockCount.name,
        stockCountId: r.stockCountId,
      });
    }
  }
  return out;
}

export async function incrementCount(
  admin: AdminApiContext,
  stockCountId: string,
  locationId: string,
  lineItemId: string,
  delta: number = 1,
  countedBy: string | null = null,
) {
  const current = await db.stockCountLineItem.findUnique({
    where: { id: lineItemId },
  });
  if (!current) throw new Error("line not found");
  const next = Math.max(0, (current.countedQuantity ?? 0) + delta);

  // Snapshot Shopify at scan-time so the delta at Complete reflects
  // what was on the shelf when the scan happened, not what Shopify
  // says at Complete-time. Best-effort; failure leaves the field null
  // (falls back to live-Shopify at Complete).
  let snap: number | null = null;
  try {
    const invMap = await getVariantsInventory(admin, [current.shopifyVariantId]);
    const inv = invMap.get(current.shopifyVariantId);
    const level = inv?.levels.find((l) => l.locationId === locationId);
    snap = level?.quantities.available ?? null;
  } catch (error) {
    console.warn(
      "[incrementCount] inventory snapshot failed — falling back to live-Shopify delta at Complete",
      error,
    );
  }

  return db.stockCountLineItem.update({
    where: { id: lineItemId },
    data: {
      countedQuantity: next,
      countedAt: new Date(),
      countedBy,
      shopifyQtyAtSave: snap,
      draftQuantity: null,
      draftUpdatedAt: null,
    },
  });
}

/**
 * Resolve a scanned code (barcode or SKU) to a line item within the current
 * stock count. Used by the scan field on the count page.
 */
export async function findLineByCode(
  stockCountId: string,
  code: string,
): Promise<string | null> {
  const normalized = code.trim().toUpperCase();
  const match = await db.stockCountLineItem.findFirst({
    where: {
      stockCountId,
      OR: [
        { barcode: { equals: normalized } },
        { sku: { equals: normalized } },
      ],
    },
    select: { id: true },
  });
  return match?.id ?? null;
}

// ============================================
// COMPLETE
// ============================================

/**
 * Finalize a stock count: generate an InventoryAdjustmentSession to
 * bring Shopify in line with what was counted. Counted lines apply
 * their (counted − current) delta. Uncounted lines the user has
 * checked in the Complete modal apply as `counted = 0` (phantom stock
 * reconciliation). Everything else is skipped.
 *
 * Atomicity: DB writes for zero-out only fire AFTER Shopify accepts
 * the adjustment. A Shopify failure leaves the count in `in_progress`
 * with drafts + counts untouched, safe to retry.
 */
export async function completeStockCount(
  admin: AdminApiContext,
  shop: string,
  id: string,
  params: { zeroOutLineItemIds?: string[] } = {},
): Promise<{
  sessionId: string;
  applied: number;
  zeroed: number;
  uncounted: number;
}> {
  const sc = await getStockCount(shop, id);
  if (!sc) throw new Error("Stock count not found");
  if (sc.status !== "in_progress") {
    throw new Error(`Stock count is ${sc.status} — cannot complete again`);
  }

  const counted = sc.lineItems.filter((li) => li.countedQuantity !== null);
  const uncounted = sc.lineItems.filter((li) => li.countedQuantity === null);

  // Filter zero-out ids to lines that are (still) uncounted — defends
  // against a stale modal that references a line another tab just saved.
  const zeroSet = new Set(params.zeroOutLineItemIds ?? []);
  const zeroApplied = uncounted.filter((li) => zeroSet.has(li.id));

  if (counted.length === 0 && zeroApplied.length === 0) {
    throw new Error(
      "Nothing to apply — count at least one line or zero out an uncounted one.",
    );
  }

  // Merged apply list. Zero-out lines are synthesized with
  // countedQuantity = 0 so the delta computation works uniformly.
  const applyList: Array<
    (typeof sc.lineItems)[number] & { countedQuantity: number }
  > = [
    ...counted.map((li) => ({
      ...li,
      countedQuantity: li.countedQuantity!,
    })),
    ...zeroApplied.map((li) => ({ ...li, countedQuantity: 0 })),
  ];

  const variantIds = applyList.map((li) => li.shopifyVariantId);
  const invMap = await getVariantsInventory(admin, variantIds);

  const changes: Array<{
    inventoryItemId: string;
    locationId: string;
    delta: number;
    shopifyVariantId: string;
    previousQuantity: number;
    newQuantity: number;
  }> = [];
  for (const li of applyList) {
    const inv = invMap.get(li.shopifyVariantId);
    if (!inv) continue;
    const level = inv.levels.find((l) => l.locationId === sc.locationId);
    const currentQty = level?.quantities.available ?? 0;
    // Delta anchor: prefer the Save-Row snapshot ("what Shopify said
    // when the user counted"), fall back to live-Shopify for lines
    // saved before the snapshot column existed. Using the snapshot
    // means sales between Save Row and Complete don't get re-added.
    const anchorQty = li.shopifyQtyAtSave ?? currentQty;
    const delta = li.countedQuantity - anchorQty;
    if (delta === 0) continue;
    changes.push({
      inventoryItemId: inv.inventoryItemId,
      locationId: sc.locationId,
      delta,
      shopifyVariantId: li.shopifyVariantId,
      previousQuantity: anchorQty,
      newQuantity: li.countedQuantity,
    });
  }

  let sessionId = "";
  if (changes.length > 0) {
    const result = await adjustInventoryBatch(
      admin,
      changes.map((c) => ({
        inventoryItemId: c.inventoryItemId,
        locationId: c.locationId,
        delta: c.delta,
      })),
      "cycle_count_available",
    );
    if (result.userErrors?.length > 0) {
      throw new Error(
        "Shopify rejected count reconciliation: " +
          result.userErrors.map((e: any) => e.message).join("; "),
      );
    }
    const session = await db.inventoryAdjustmentSession.create({
      data: {
        shop,
        locationId: sc.locationId,
        reason: "cycle_count_available",
        source: "stock_count",
        sourceId: sc.id,
        notes: `Stock count: ${sc.name}`,
        changes: {
          create: changes.map((c) => ({
            shopifyVariantId: c.shopifyVariantId,
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

  // Post-Shopify writes:
  //   - persist countedQuantity=0 for zero-out lines (audit trail)
  //   - REFRESH shopifyQtyAtSave for every applied line to reflect
  //     the post-adjustment Shopify state (= countedQuantity, since
  //     that's what Shopify is now at). Makes re-Complete idempotent:
  //     if the user re-opens and hits Complete again without changing
  //     anything, delta = counted - counted = 0 → no double-adjust.
  //   - flip the count status to completed.
  // Grouped in one transaction so a hiccup between them can't leave
  // a completed count with unwritten lines.
  const now = new Date();
  const changedIds = new Set(changes.map((c) => c.shopifyVariantId));
  const refreshUpdates = applyList
    .filter((li) => changedIds.has(li.shopifyVariantId))
    .map((li) =>
      db.stockCountLineItem.update({
        where: { id: li.id },
        data: { shopifyQtyAtSave: li.countedQuantity },
      }),
    );
  await db.$transaction([
    ...zeroApplied.map((li) =>
      db.stockCountLineItem.update({
        where: { id: li.id },
        data: {
          countedQuantity: 0,
          countedAt: now,
          countedBy: null,
          shopifyQtyAtSave: 0,
          draftQuantity: null,
          draftUpdatedAt: null,
        },
      }),
    ),
    ...refreshUpdates,
    db.stockCount.update({
      where: { id },
      data: { status: "completed", completedAt: now },
    }),
  ]);

  return {
    sessionId,
    applied: changes.length,
    zeroed: zeroApplied.length,
    uncounted: uncounted.length - zeroApplied.length,
  };
}

/**
 * Re-open a previously completed stock count. Flips status back to
 * in_progress and clears completedAt. All counted values +
 * shopifyQtyAtSave snapshots are PRESERVED — the count is picked up
 * exactly where it left off. Shopify adjustments from prior Complete
 * cycles remain applied (audit trail via InventoryAdjustmentSession).
 *
 * Re-Complete after a re-open is idempotent for untouched lines
 * because Complete's post-write refreshes shopifyQtyAtSave to
 * countedQuantity — so delta = counted - counted = 0. Sales that
 * happened after the last Complete are NOT erased (Shopify at
 * Complete-time is lower than the snapshot; delta stays 0).
 *
 * Only allowed on completed counts. abandoned / in_progress reject.
 */
export async function reopenStockCount(shop: string, id: string) {
  const existing = await db.stockCount.findFirst({
    where: { shop, id },
    select: { id: true, status: true },
  });
  if (!existing) throw new Error("Stock count not found");
  if (existing.status !== "completed") {
    throw new Error(
      `Only completed counts can be re-opened. This count is ${existing.status}.`,
    );
  }
  return db.stockCount.update({
    where: { id },
    data: { status: "in_progress", completedAt: null },
  });
}

export async function abandonStockCount(shop: string, id: string) {
  return db.stockCount.update({
    where: { id },
    data: { status: "abandoned", completedAt: new Date() },
  });
}

/**
 * Hard-delete a stock count and its line items. Use when a count was
 * created in error or the user wants to clear history. Does NOT reverse
 * any Shopify inventory adjustments already applied — completed counts
 * have already written to Shopify and those adjustments live in
 * InventoryAdjustmentSession (preserved).
 */
export async function deleteStockCount(shop: string, id: string) {
  // scope-check: don't let a delete from one shop nuke another shop's
  // row if an id ever collides.
  const existing = await db.stockCount.findFirst({
    where: { shop, id },
    select: { id: true },
  });
  if (!existing) throw new Error("Stock count not found");
  // Line items cascade via the relation's onDelete: Cascade.
  await db.stockCount.delete({ where: { id } });
}
