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
 * whole row flips to "counted" atomically instead of trickling in
 * cell-by-cell. Does NOT touch Shopify — that happens on complete.
 */
export async function saveRowCounts(
  stockCountId: string,
  entries: Array<{ lineItemId: string; countedQuantity: number }>,
  countedBy: string | null = null,
) {
  if (entries.length === 0) return;
  const now = new Date();
  await db.$transaction(
    entries.map((e) =>
      db.stockCountLineItem.update({
        where: { id: e.lineItemId },
        data: {
          countedQuantity: e.countedQuantity,
          countedAt: now,
          countedBy,
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
  id: string,
  lineItemId: string,
  delta: number = 1,
  countedBy: string | null = null,
) {
  const current = await db.stockCountLineItem.findUnique({
    where: { id: lineItemId },
  });
  if (!current) throw new Error("line not found");
  const next = Math.max(0, (current.countedQuantity ?? 0) + delta);
  return recordCount(id, lineItemId, next, countedBy);
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
    const delta = li.countedQuantity - currentQty;
    if (delta === 0) continue;
    changes.push({
      inventoryItemId: inv.inventoryItemId,
      locationId: sc.locationId,
      delta,
      shopifyVariantId: li.shopifyVariantId,
      previousQuantity: currentQty,
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
      "cycle_count_accuracy",
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
        reason: "cycle_count_accuracy",
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

  // Post-Shopify writes: persist countedQuantity=0 for the zero-out
  // lines (so the audit trail shows they were reconciled) and flip
  // the count to completed. Grouped in one transaction so a hiccup
  // between them can't leave a completed count with unwritten lines.
  const now = new Date();
  await db.$transaction([
    ...zeroApplied.map((li) =>
      db.stockCountLineItem.update({
        where: { id: li.id },
        data: {
          countedQuantity: 0,
          countedAt: now,
          countedBy: null,
          draftQuantity: null,
          draftUpdatedAt: null,
        },
      }),
    ),
    db.stockCount.update({
      where: { id },
      data: { status: "completed", completedAt: now },
    }),
  ]);

  return {
    sessionId,
    applied: changes.length - zeroApplied.filter((li) => {
      // A zero-out line whose Shopify current was already 0 contributes
      // a 0 delta and never enters `changes`. But it still counts
      // toward `zeroed` (we wrote countedQuantity=0 in DB). Everything
      // else in `changes` counts toward `applied`.
      const inv = invMap.get(li.shopifyVariantId);
      const level = inv?.levels.find((l) => l.locationId === sc.locationId);
      const currentQty = level?.quantities.available ?? 0;
      return currentQty !== 0;
    }).length,
    zeroed: zeroApplied.length,
    uncounted: uncounted.length - zeroApplied.length,
  };
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
