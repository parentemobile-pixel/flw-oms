import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

// ============================================
// MUTATIONS
// ============================================

const ADJUST_INVENTORY_MUTATION = `#graphql
  mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      inventoryAdjustmentGroup {
        id
        reason
        changes {
          name
          delta
          quantityAfterChange
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ============================================
// QUERIES
// ============================================

const INVENTORY_ITEM_QUERY = `#graphql
  query GetInventoryItem($id: ID!) {
    inventoryItem(id: $id) {
      id
      inventoryLevels(first: 20) {
        edges {
          node {
            id
            location {
              id
              name
            }
            quantities(names: ["available", "incoming", "committed", "on_hand"]) {
              name
              quantity
            }
          }
        }
      }
    }
  }
`;

// Batch query: fetch per-location inventory for many variants in one round-trip.
// Uses the `nodes(ids: [])` pattern to avoid N round-trips.
const VARIANTS_INVENTORY_QUERY = `#graphql
  query GetVariantsInventory($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        sku
        barcode
        inventoryItem {
          id
          inventoryLevels(first: 20) {
            edges {
              node {
                id
                location {
                  id
                  name
                }
                quantities(names: ["available", "incoming", "committed", "on_hand"]) {
                  name
                  quantity
                }
              }
            }
          }
        }
      }
    }
  }
`;

// ============================================
// TYPES
// ============================================

export type InventoryQuantityName =
  | "available"
  | "incoming"
  | "committed"
  | "on_hand";

/**
 * Shopify's `inventoryAdjustQuantities` mutation requires a reason from a fixed enum.
 * Docs: https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryAdjustQuantities
 */
export type InventoryAdjustReason =
  | "correction"
  | "cycle_count_accuracy"
  | "damaged"
  | "received"
  | "shrinkage"
  | "restock"
  | "other";

export interface InventoryLevel {
  locationId: string;
  locationName: string;
  quantities: Record<InventoryQuantityName, number>;
}

export interface VariantInventory {
  variantId: string;
  inventoryItemId: string;
  sku: string | null;
  barcode: string | null;
  levels: InventoryLevel[];
}

export interface AdjustChange {
  inventoryItemId: string;
  locationId: string;
  delta: number;
}

// ============================================
// FUNCTIONS
// ============================================

/**
 * Adjust inventory at ONE (inventoryItem, location) by a delta.
 * For bulk/multi-variant adjustments see `adjustInventoryBatch`.
 */
export async function adjustInventory(
  admin: AdminApiContext,
  inventoryItemId: string,
  locationId: string,
  delta: number,
  reason: InventoryAdjustReason = "correction",
) {
  const response = await admin.graphql(ADJUST_INVENTORY_MUTATION, {
    variables: {
      input: {
        reason,
        name: "available",
        changes: [{ delta, inventoryItemId, locationId }],
      },
    },
  });

  const data = (await response.json()) as any;
  return data.data.inventoryAdjustQuantities;
}

/**
 * Apply multiple adjustments in a single mutation call. All changes share one
 * reason (Shopify's input enforces this). Returns the mutation result.
 *
 * Use this anywhere you're mutating more than one (variant, location) pair at
 * once (PO receive, inventory grid adjust, stock count apply, transfer receive).
 */
export async function adjustInventoryBatch(
  admin: AdminApiContext,
  changes: AdjustChange[],
  reason: InventoryAdjustReason,
) {
  if (changes.length === 0) {
    return { inventoryAdjustmentGroup: null, userErrors: [] };
  }

  const response = await admin.graphql(ADJUST_INVENTORY_MUTATION, {
    variables: {
      input: {
        reason,
        name: "available",
        changes: changes.map((c) => ({
          delta: c.delta,
          inventoryItemId: c.inventoryItemId,
          locationId: c.locationId,
        })),
      },
    },
  });

  const data = (await response.json()) as any;
  return data.data.inventoryAdjustQuantities;
}

/**
 * Transfer inventory between two locations. Shopify has no atomic transfer
 * mutation, so we issue two adjustments. If the first (subtract at source)
 * fails, nothing happens. If the first succeeds and the second (add at dest)
 * fails, we attempt to rollback the source adjustment.
 *
 * Returns `{ ok: true }` on success, or a detailed failure for manual recovery.
 */
export async function transferInventory(
  admin: AdminApiContext,
  inventoryItemId: string,
  fromLocationId: string,
  toLocationId: string,
  quantity: number,
): Promise<
  | { ok: true }
  | { ok: false; stage: "source" | "dest" | "rollback"; error: string }
> {
  if (quantity <= 0) return { ok: true };

  // Step 1: subtract from source
  const subtract = await adjustInventory(
    admin,
    inventoryItemId,
    fromLocationId,
    -quantity,
    "correction",
  );
  if (subtract.userErrors?.length) {
    return {
      ok: false,
      stage: "source",
      error: subtract.userErrors.map((e: any) => e.message).join("; "),
    };
  }

  // Step 2: add to destination
  const add = await adjustInventory(
    admin,
    inventoryItemId,
    toLocationId,
    quantity,
    "correction",
  );
  if (add.userErrors?.length) {
    // Attempt rollback of source
    const rollback = await adjustInventory(
      admin,
      inventoryItemId,
      fromLocationId,
      quantity,
      "correction",
    );
    if (rollback.userErrors?.length) {
      return {
        ok: false,
        stage: "rollback",
        error: `Dest failed (${add.userErrors
          .map((e: any) => e.message)
          .join("; ")}) AND rollback failed (${rollback.userErrors
          .map((e: any) => e.message)
          .join("; ")})`,
      };
    }
    return {
      ok: false,
      stage: "dest",
      error: add.userErrors.map((e: any) => e.message).join("; "),
    };
  }

  return { ok: true };
}

/**
 * Legacy single-variant query. Prefer `getVariantsInventory` for multi-variant
 * lookups — batched is cheaper than N round-trips.
 */
export async function getInventoryItem(
  admin: AdminApiContext,
  inventoryItemId: string,
) {
  const response = await admin.graphql(INVENTORY_ITEM_QUERY, {
    variables: { id: inventoryItemId },
  });
  const data = (await response.json()) as any;
  return data.data.inventoryItem;
}

/**
 * Fetch inventory levels (per-location quantities) for many variants at once.
 *
 * Batches automatically: Shopify's `nodes(ids:)` accepts up to ~250 ids in
 * one call, but query cost climbs fast. We chunk to 50 ids per request to
 * stay well under the cost budget.
 */
export async function getVariantsInventory(
  admin: AdminApiContext,
  variantIds: string[],
): Promise<Map<string, VariantInventory>> {
  const result = new Map<string, VariantInventory>();
  const CHUNK = 50;

  for (let i = 0; i < variantIds.length; i += CHUNK) {
    const chunk = variantIds.slice(i, i + CHUNK);
    const response = await admin.graphql(VARIANTS_INVENTORY_QUERY, {
      variables: { ids: chunk },
    });
    const body = (await response.json()) as any;
    const nodes = (body.data?.nodes ?? []) as Array<any>;

    for (const node of nodes) {
      if (!node?.id || !node.inventoryItem) continue;
      const levels: InventoryLevel[] =
        node.inventoryItem.inventoryLevels.edges.map((edge: any) => {
          const q: Record<InventoryQuantityName, number> = {
            available: 0,
            incoming: 0,
            committed: 0,
            on_hand: 0,
          };
          for (const { name, quantity } of edge.node.quantities as Array<{
            name: InventoryQuantityName;
            quantity: number;
          }>) {
            q[name] = quantity;
          }
          return {
            locationId: edge.node.location.id,
            locationName: edge.node.location.name,
            quantities: q,
          };
        });

      result.set(node.id, {
        variantId: node.id,
        inventoryItemId: node.inventoryItem.id,
        sku: node.sku ?? null,
        barcode: node.barcode ?? null,
        levels,
      });
    }
  }

  return result;
}

/**
 * Get the `available` quantity for one variant at one location. Convenience
 * wrapper around `getVariantsInventory`.
 */
export async function getAvailableAtLocation(
  admin: AdminApiContext,
  variantId: string,
  locationId: string,
): Promise<number> {
  const map = await getVariantsInventory(admin, [variantId]);
  const inv = map.get(variantId);
  if (!inv) return 0;
  const level = inv.levels.find((l) => l.locationId === locationId);
  return level?.quantities.available ?? 0;
}
