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

  // Only seed variants that have an inventoryLevel at this location (even if 0)
  const lineItems = variants
    .map((v) => {
      const inv = invMap.get(v.variantId);
      if (!inv) return null;
      const level = inv.levels.find((l) => l.locationId === params.locationId);
      if (!level) return null;
      return {
        shopifyProductId: v.productId,
        shopifyVariantId: v.variantId,
        productTitle: v.productTitle,
        vendor: v.vendor || null,
        variantTitle: v.variantTitle,
        sku: v.sku,
        barcode: v.barcode,
        variantOptions: JSON.stringify(v.selectedOptions),
        expectedQuantity: level.quantities.available ?? 0,
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
 * Finalize a stock count: generate an InventoryAdjustmentSession to bring
 * Shopify in line with what was counted. Only lines that were actually
 * counted (countedQuantity != null) are applied. Uncounted lines are
 * surfaced in the variance report but NOT zeroed out — leaves the decision
 * to the merchant.
 */
export async function completeStockCount(
  admin: AdminApiContext,
  shop: string,
  id: string,
): Promise<{ sessionId: string; applied: number; uncounted: number }> {
  const sc = await getStockCount(shop, id);
  if (!sc) throw new Error("Stock count not found");
  if (sc.status !== "in_progress") {
    throw new Error(`Stock count is ${sc.status} — cannot complete again`);
  }

  // Group counted lines and compute deltas
  const counted = sc.lineItems.filter((li) => li.countedQuantity !== null);
  const uncounted = sc.lineItems.filter((li) => li.countedQuantity === null);

  if (counted.length === 0) {
    throw new Error("Nothing was counted — cannot complete.");
  }

  // Resolve inventoryItem IDs in one batched call
  const variantIds = counted.map((li) => li.shopifyVariantId);
  const invMap = await getVariantsInventory(admin, variantIds);

  const changes: Array<{
    inventoryItemId: string;
    locationId: string;
    delta: number;
    shopifyVariantId: string;
    previousQuantity: number;
    newQuantity: number;
  }> = [];
  for (const li of counted) {
    const inv = invMap.get(li.shopifyVariantId);
    if (!inv) continue;
    const level = inv.levels.find((l) => l.locationId === sc.locationId);
    const currentQty = level?.quantities.available ?? 0;
    const delta = (li.countedQuantity ?? 0) - currentQty;
    if (delta === 0) continue;
    changes.push({
      inventoryItemId: inv.inventoryItemId,
      locationId: sc.locationId,
      delta,
      shopifyVariantId: li.shopifyVariantId,
      previousQuantity: currentQty,
      newQuantity: li.countedQuantity ?? 0,
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

  await db.stockCount.update({
    where: { id },
    data: { status: "completed", completedAt: new Date() },
  });

  return {
    sessionId,
    applied: changes.length,
    uncounted: uncounted.length,
  };
}

export async function abandonStockCount(shop: string, id: string) {
  return db.stockCount.update({
    where: { id },
    data: { status: "abandoned", completedAt: new Date() },
  });
}
