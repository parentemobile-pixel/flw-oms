import db from "../../db.server";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import {
  adjustInventoryBatch,
  getVariantsInventory,
  type InventoryAdjustReason,
} from "../shopify-api/inventory.server";

export interface AdjustRequest {
  shopifyVariantId: string;
  /** Desired new on-hand value at the location. */
  newQuantity: number;
}

export interface AdjustResult {
  sessionId: string;
  appliedChanges: number;
  skipped: number;
}

/**
 * Apply a batch of new-quantity requests at one location, as one audited
 * inventory adjustment session.
 *
 * Flow:
 *  1. Fetch current per-location inventory for all variants in one batched call
 *  2. Compute deltas (skip lines with delta === 0)
 *  3. Call adjustInventoryBatch with reason
 *  4. Persist InventoryAdjustmentSession + InventoryAdjustmentChange rows
 *
 * Returns the session id so the UI can link to it for audit trail browsing.
 */
export async function applyAdjustments(
  admin: AdminApiContext,
  shop: string,
  locationId: string,
  reason: InventoryAdjustReason,
  notes: string | null,
  requests: AdjustRequest[],
  createdBy: string | null = null,
): Promise<AdjustResult> {
  if (requests.length === 0) {
    throw new Error("No adjustments to apply.");
  }

  const variantIds = [...new Set(requests.map((r) => r.shopifyVariantId))];
  const invMap = await getVariantsInventory(admin, variantIds);

  const changes: Array<{
    inventoryItemId: string;
    locationId: string;
    delta: number;
    previousQuantity: number;
    newQuantity: number;
    shopifyVariantId: string;
  }> = [];
  let skipped = 0;

  for (const req of requests) {
    const inv = invMap.get(req.shopifyVariantId);
    if (!inv) {
      skipped++;
      continue;
    }
    const level = inv.levels.find((l) => l.locationId === locationId);
    const currentQty = level?.quantities.available ?? 0;
    const delta = req.newQuantity - currentQty;
    if (delta === 0) {
      skipped++;
      continue;
    }
    changes.push({
      inventoryItemId: inv.inventoryItemId,
      locationId,
      delta,
      previousQuantity: currentQty,
      newQuantity: req.newQuantity,
      shopifyVariantId: req.shopifyVariantId,
    });
  }

  if (changes.length === 0) {
    throw new Error("All lines match current inventory — nothing to adjust.");
  }

  const result = await adjustInventoryBatch(
    admin,
    changes.map((c) => ({
      inventoryItemId: c.inventoryItemId,
      locationId: c.locationId,
      delta: c.delta,
    })),
    reason,
  );

  if (result.userErrors?.length > 0) {
    throw new Error(
      "Shopify rejected the adjustment: " +
        result.userErrors
          .map((e: { message: string }) => e.message)
          .join("; "),
    );
  }

  const session = await db.inventoryAdjustmentSession.create({
    data: {
      shop,
      locationId,
      reason,
      source: "manual",
      notes,
      createdBy,
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

  return {
    sessionId: session.id,
    appliedChanges: changes.length,
    skipped,
  };
}

/**
 * Recent adjustment sessions for the "Recent adjustments" sidebar.
 */
export async function getRecentAdjustmentSessions(shop: string, limit = 10) {
  return db.inventoryAdjustmentSession.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      _count: { select: { changes: true } },
    },
  });
}
