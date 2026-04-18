import db from "../../db.server";
import { format } from "date-fns";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import {
  adjustInventoryBatch,
  getVariantsInventory,
} from "../shopify-api/inventory.server";

export interface TransferLineItemInput {
  shopifyProductId: string;
  shopifyVariantId: string;
  productTitle: string;
  variantTitle: string;
  sku?: string | null;
  quantitySent: number;
}

export interface CreateTransferInput {
  fromLocationId: string;
  toLocationId: string;
  notes?: string | null;
  lineItems: TransferLineItemInput[];
}

export async function generateTransferNumber(shop: string): Promise<string> {
  const today = format(new Date(), "yyyyMMdd");
  const existing = await db.inventoryTransfer.count({
    where: { shop, transferNumber: { startsWith: `TR-${today}` } },
  });
  return `TR-${today}-${String(existing + 1).padStart(3, "0")}`;
}

export async function createTransfer(shop: string, data: CreateTransferInput) {
  if (data.fromLocationId === data.toLocationId) {
    throw new Error("From and To locations must be different.");
  }
  const cleanLines = data.lineItems.filter((li) => li.quantitySent > 0);
  if (cleanLines.length === 0) {
    throw new Error("At least one line item must have quantity > 0.");
  }

  const transferNumber = await generateTransferNumber(shop);
  return db.inventoryTransfer.create({
    data: {
      shop,
      transferNumber,
      fromLocationId: data.fromLocationId,
      toLocationId: data.toLocationId,
      notes: data.notes ?? null,
      lineItems: {
        create: cleanLines.map((li) => ({
          shopifyProductId: li.shopifyProductId,
          shopifyVariantId: li.shopifyVariantId,
          productTitle: li.productTitle,
          variantTitle: li.variantTitle,
          sku: li.sku ?? null,
          quantitySent: li.quantitySent,
        })),
      },
    },
    include: { lineItems: true },
  });
}

export async function getTransfers(shop: string) {
  return db.inventoryTransfer.findMany({
    where: { shop },
    include: { _count: { select: { lineItems: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function getTransfer(shop: string, id: string) {
  return db.inventoryTransfer.findFirst({
    where: { shop, id },
    include: { lineItems: true },
  });
}

/**
 * Execute the "send" step — subtract quantities at the source location.
 * Wraps adjustInventoryBatch and records an InventoryAdjustmentSession.
 * On success, transitions transfer to in_transit.
 */
export async function sendTransfer(
  admin: AdminApiContext,
  shop: string,
  id: string,
) {
  const t = await getTransfer(shop, id);
  if (!t) throw new Error("Transfer not found");
  if (t.status !== "draft") {
    throw new Error(`Transfer is ${t.status} — cannot send again`);
  }

  // Resolve inventory item IDs in one batched call
  const variantIds = [...new Set(t.lineItems.map((li) => li.shopifyVariantId))];
  const invMap = await getVariantsInventory(admin, variantIds);

  const changes: Array<{
    inventoryItemId: string;
    locationId: string;
    delta: number;
    shopifyVariantId: string;
    previousQuantity: number;
    newQuantity: number;
  }> = [];
  for (const li of t.lineItems) {
    const inv = invMap.get(li.shopifyVariantId);
    if (!inv) throw new Error(`Variant not found: ${li.shopifyVariantId}`);
    const level = inv.levels.find((l) => l.locationId === t.fromLocationId);
    const previousQty = level?.quantities.available ?? 0;
    changes.push({
      inventoryItemId: inv.inventoryItemId,
      locationId: t.fromLocationId,
      delta: -li.quantitySent,
      shopifyVariantId: li.shopifyVariantId,
      previousQuantity: previousQty,
      newQuantity: previousQty - li.quantitySent,
    });
  }

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
      "Shopify rejected the send: " +
        result.userErrors
          .map((e: { message: string }) => e.message)
          .join("; "),
    );
  }

  // Audit + flip status
  await db.$transaction([
    db.inventoryAdjustmentSession.create({
      data: {
        shop,
        locationId: t.fromLocationId,
        reason: "correction",
        source: "transfer_send",
        sourceId: t.id,
        notes: `Transfer ${t.transferNumber} sent`,
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
    }),
    db.inventoryTransfer.update({
      where: { id: t.id },
      data: { status: "in_transit", sentAt: new Date() },
    }),
  ]);

  return { ok: true as const };
}

/**
 * Receive a transfer at its destination location. Each line may be received
 * short (some units damaged in transit, say) — we only add `quantityReceived`
 * to the destination, which may be less than `quantitySent`.
 */
export async function receiveTransfer(
  admin: AdminApiContext,
  shop: string,
  id: string,
  receipts: Array<{ lineItemId: string; quantityReceived: number }>,
) {
  const t = await getTransfer(shop, id);
  if (!t) throw new Error("Transfer not found");
  if (t.status !== "in_transit" && t.status !== "draft") {
    throw new Error(`Transfer status is ${t.status} — cannot receive`);
  }

  // For each receipt, compute destination-add delta. Skip zero-delta lines.
  const deltas: Array<{
    lineItemId: string;
    shopifyVariantId: string;
    inventoryItemId: string;
    delta: number;
    previousReceived: number;
    newReceived: number;
  }> = [];

  const variantIds = [
    ...new Set(t.lineItems.map((li) => li.shopifyVariantId)),
  ];
  const invMap = await getVariantsInventory(admin, variantIds);

  for (const li of t.lineItems) {
    const receipt = receipts.find((r) => r.lineItemId === li.id);
    if (!receipt) continue;
    const delta = receipt.quantityReceived - li.quantityReceived;
    if (delta === 0) continue;
    const inv = invMap.get(li.shopifyVariantId);
    if (!inv) continue;
    deltas.push({
      lineItemId: li.id,
      shopifyVariantId: li.shopifyVariantId,
      inventoryItemId: inv.inventoryItemId,
      delta,
      previousReceived: li.quantityReceived,
      newReceived: receipt.quantityReceived,
    });
  }

  if (deltas.length === 0) {
    throw new Error("No changes to apply.");
  }

  const result = await adjustInventoryBatch(
    admin,
    deltas.map((d) => ({
      inventoryItemId: d.inventoryItemId,
      locationId: t.toLocationId,
      delta: d.delta,
    })),
    "received",
  );
  if (result.userErrors?.length > 0) {
    throw new Error(
      "Shopify rejected the receive: " +
        result.userErrors
          .map((e: { message: string }) => e.message)
          .join("; "),
    );
  }

  // Persist receipts + audit. Wrap in a DB transaction so statuses stay consistent.
  await db.$transaction(async (tx) => {
    for (const d of deltas) {
      await tx.inventoryTransferLineItem.update({
        where: { id: d.lineItemId },
        data: { quantityReceived: d.newReceived },
      });
    }

    // Recompute status
    const refreshed = await tx.inventoryTransfer.findUnique({
      where: { id: t.id },
      include: { lineItems: true },
    });
    if (!refreshed) throw new Error("Transfer disappeared");

    const allReceived = refreshed.lineItems.every(
      (li) => li.quantityReceived >= li.quantitySent,
    );

    await tx.inventoryTransfer.update({
      where: { id: t.id },
      data: {
        status: allReceived ? "received" : "in_transit",
        receivedAt: allReceived ? new Date() : null,
      },
    });

    await tx.inventoryAdjustmentSession.create({
      data: {
        shop,
        locationId: t.toLocationId,
        reason: "received",
        source: "transfer_receive",
        sourceId: t.id,
        notes: `Transfer ${t.transferNumber} receive`,
        changes: {
          create: deltas.map((d) => ({
            shopifyVariantId: d.shopifyVariantId,
            shopifyInventoryItemId: d.inventoryItemId,
            previousQuantity: d.previousReceived,
            newQuantity: d.newReceived,
            delta: d.delta,
          })),
        },
      },
    });
  });

  return { ok: true as const };
}

export async function cancelTransfer(shop: string, id: string) {
  const t = await getTransfer(shop, id);
  if (!t) throw new Error("Transfer not found");
  if (t.status !== "draft") {
    throw new Error("Only draft transfers can be cancelled");
  }
  return db.inventoryTransfer.update({
    where: { id },
    data: { status: "cancelled" },
  });
}
