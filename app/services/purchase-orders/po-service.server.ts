import db from "../../db.server";
import { format } from "date-fns";
import { randomUUID } from "node:crypto";

// ============================================
// TYPES
// ============================================

export interface POLineItemInput {
  shopifyProductId: string;
  shopifyVariantId: string;
  productTitle: string;
  variantTitle: string;
  sku?: string | null;
  barcode?: string | null;
  unitCost: number;
  retailPrice: number;
  quantityOrdered: number;
}

export interface CreatePOInput {
  vendor?: string;
  notes?: string;
  shippingDate?: Date | null;
  expectedDate?: Date | null;
  shopifyLocationId?: string | null;
  poNumberExt?: string | null;
  lineItems: POLineItemInput[];
}

export interface UpdatePOInput {
  vendor?: string | null;
  notes?: string | null;
  shippingDate?: Date | null;
  expectedDate?: Date | null;
  shopifyLocationId?: string | null;
  poNumberExt?: string | null;
  lineItems?: POLineItemInput[]; // if provided, replaces existing line items
}

export interface POSummary {
  id: string;
  poNumber: string;
  vendor: string | null;
  status: string;
  totalCost: number;
  shippingDate: Date | null;
  expectedDate: Date | null;
  orderDate: Date | null;
  createdAt: Date;
  shopifyLocationId: string | null;
  // Aggregates (computed, not stored)
  totalUnits: number;
  totalReceived: number;
}

// ============================================
// FUNCTIONS
// ============================================

export async function generatePoNumber(shop: string): Promise<string> {
  const today = format(new Date(), "yyyyMMdd");
  const existing = await db.purchaseOrder.count({
    where: {
      shop,
      poNumber: { startsWith: `PO-${today}` },
    },
  });
  const seq = String(existing + 1).padStart(3, "0");
  return `PO-${today}-${seq}`;
}

export async function createPurchaseOrder(shop: string, data: CreatePOInput) {
  const poNumber = await generatePoNumber(shop);
  const totalCost = data.lineItems.reduce(
    (sum, li) => sum + li.unitCost * li.quantityOrdered,
    0,
  );

  return db.purchaseOrder.create({
    data: {
      shop,
      poNumber,
      vendor: data.vendor ?? null,
      notes: data.notes ?? null,
      shippingDate: data.shippingDate ?? null,
      expectedDate: data.expectedDate ?? null,
      shopifyLocationId: data.shopifyLocationId ?? null,
      poNumberExt: data.poNumberExt ?? null,
      totalCost,
      lineItems: {
        create: data.lineItems.map((li) => ({
          shopifyProductId: li.shopifyProductId,
          shopifyVariantId: li.shopifyVariantId,
          productTitle: li.productTitle,
          variantTitle: li.variantTitle,
          sku: li.sku ?? null,
          barcode: li.barcode ?? null,
          unitCost: li.unitCost,
          retailPrice: li.retailPrice,
          quantityOrdered: li.quantityOrdered,
        })),
      },
    },
    include: { lineItems: true },
  });
}

/**
 * List POs with aggregate counts — avoids the N+1 pattern of loading all
 * line items for every PO on the index page. Uses a single groupBy query
 * to compute totalUnits + totalReceived per PO.
 */
export async function getPurchaseOrderSummaries(
  shop: string,
  status?: string,
): Promise<POSummary[]> {
  const pos = await db.purchaseOrder.findMany({
    where: { shop, ...(status ? { status } : {}) },
    select: {
      id: true,
      poNumber: true,
      vendor: true,
      status: true,
      totalCost: true,
      shippingDate: true,
      expectedDate: true,
      orderDate: true,
      createdAt: true,
      shopifyLocationId: true,
    },
    orderBy: { createdAt: "desc" },
  });

  if (pos.length === 0) return [];

  const totals = await db.purchaseOrderLineItem.groupBy({
    by: ["purchaseOrderId"],
    where: { purchaseOrderId: { in: pos.map((p) => p.id) } },
    _sum: { quantityOrdered: true, quantityReceived: true },
  });
  const totalsByPo = new Map(
    totals.map((t) => [
      t.purchaseOrderId,
      {
        totalUnits: t._sum.quantityOrdered ?? 0,
        totalReceived: t._sum.quantityReceived ?? 0,
      },
    ]),
  );

  return pos.map((p) => ({
    ...p,
    ...(totalsByPo.get(p.id) ?? { totalUnits: 0, totalReceived: 0 }),
  }));
}

/**
 * Legacy name, used in some older code paths. Prefer
 * `getPurchaseOrderSummaries` for list views.
 */
export async function getPurchaseOrders(shop: string, status?: string) {
  return db.purchaseOrder.findMany({
    where: { shop, ...(status ? { status } : {}) },
    include: { lineItems: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function getPurchaseOrder(shop: string, id: string) {
  return db.purchaseOrder.findFirst({
    where: { shop, id },
    include: { lineItems: true },
  });
}

/** Lookup by scan-to-receive token — used by the public `/r/:token` route. */
export async function getPurchaseOrderByToken(token: string) {
  return db.purchaseOrder.findFirst({
    where: { receiveToken: token },
    include: { lineItems: true },
  });
}

export async function updatePurchaseOrder(
  shop: string,
  id: string,
  data: UpdatePOInput,
) {
  const po = await db.purchaseOrder.findFirst({ where: { shop, id } });
  if (!po) throw new Error("PO not found");
  if (po.status !== "draft") {
    throw new Error("Only draft POs can be edited");
  }

  // If replacing line items, recompute totalCost and wipe + recreate them.
  let totalCost = po.totalCost;
  if (data.lineItems) {
    totalCost = data.lineItems.reduce(
      (sum, li) => sum + li.unitCost * li.quantityOrdered,
      0,
    );
    await db.purchaseOrderLineItem.deleteMany({
      where: { purchaseOrderId: id },
    });
  }

  return db.purchaseOrder.update({
    where: { id },
    data: {
      vendor: data.vendor === undefined ? undefined : data.vendor,
      notes: data.notes === undefined ? undefined : data.notes,
      shippingDate:
        data.shippingDate === undefined ? undefined : data.shippingDate,
      expectedDate:
        data.expectedDate === undefined ? undefined : data.expectedDate,
      shopifyLocationId:
        data.shopifyLocationId === undefined
          ? undefined
          : data.shopifyLocationId,
      poNumberExt:
        data.poNumberExt === undefined ? undefined : data.poNumberExt,
      totalCost,
      ...(data.lineItems
        ? {
            lineItems: {
              create: data.lineItems.map((li) => ({
                shopifyProductId: li.shopifyProductId,
                shopifyVariantId: li.shopifyVariantId,
                productTitle: li.productTitle,
                variantTitle: li.variantTitle,
                sku: li.sku ?? null,
                barcode: li.barcode ?? null,
                unitCost: li.unitCost,
                retailPrice: li.retailPrice,
                quantityOrdered: li.quantityOrdered,
              })),
            },
          }
        : {}),
    },
    include: { lineItems: true },
  });
}

export async function updatePurchaseOrderStatus(
  shop: string,
  id: string,
  status: string,
) {
  return db.purchaseOrder.update({
    where: { id },
    data: {
      status,
      ...(status === "ordered" ? { orderDate: new Date() } : {}),
    },
  });
}

/**
 * Record received line item quantities in the DB. Inventory adjustment at
 * Shopify happens in the route action (`app.purchase-orders.$id.receive.tsx`)
 * which calls `adjustInventoryBatch` and logs an InventoryAdjustmentSession.
 *
 * This function is DB-only and intentionally separate so partial-success
 * scenarios (Shopify adjust failed mid-batch) can still record what DID adjust.
 */
export async function receiveLineItems(
  id: string,
  receivedItems: Array<{ lineItemId: string; quantityReceived: number }>,
) {
  const po = await db.purchaseOrder.findUnique({
    where: { id },
    include: { lineItems: true },
  });
  if (!po) throw new Error("PO not found");

  for (const item of receivedItems) {
    await db.purchaseOrderLineItem.update({
      where: { id: item.lineItemId },
      data: { quantityReceived: item.quantityReceived },
    });
  }

  const updatedPo = await db.purchaseOrder.findUnique({
    where: { id },
    include: { lineItems: true },
  });
  if (!updatedPo) throw new Error("PO not found");

  const allReceived = updatedPo.lineItems.every(
    (li) => li.quantityReceived >= li.quantityOrdered,
  );
  const someReceived = updatedPo.lineItems.some(
    (li) => li.quantityReceived > 0,
  );

  let newStatus = updatedPo.status;
  if (allReceived) {
    newStatus = "received";
  } else if (someReceived) {
    newStatus = "partially_received";
  }

  if (newStatus !== updatedPo.status) {
    await db.purchaseOrder.update({
      where: { id },
      data: { status: newStatus },
    });
  }

  return { ...updatedPo, status: newStatus };
}

export async function deletePurchaseOrder(shop: string, id: string) {
  return db.purchaseOrder.delete({ where: { id } });
}

/**
 * For every variant in open POs, how many units are still on order?
 * Used by the PO create screen and the Planning module to show "on order"
 * alongside current stock.
 */
export async function getOnOrderQuantities(
  shop: string,
): Promise<Record<string, number>> {
  const openLineItems = await db.purchaseOrderLineItem.findMany({
    where: {
      purchaseOrder: {
        shop,
        status: { in: ["draft", "ordered", "partially_received"] },
      },
    },
    select: {
      shopifyVariantId: true,
      quantityOrdered: true,
      quantityReceived: true,
    },
  });

  const onOrder: Record<string, number> = {};
  for (const li of openLineItems) {
    const remaining = li.quantityOrdered - li.quantityReceived;
    if (remaining > 0) {
      onOrder[li.shopifyVariantId] =
        (onOrder[li.shopifyVariantId] ?? 0) + remaining;
    }
  }
  return onOrder;
}

/**
 * Regenerate the receive token — invalidates any existing printed QR codes.
 * Use when the token is suspected leaked or the PO is re-issued.
 */
export async function rotateReceiveToken(shop: string, id: string) {
  // randomUUID is stable enough for a 36-char URL-safe token; the receive
  // route matches by the full token so collisions are effectively impossible.
  return db.purchaseOrder.update({
    where: { id },
    data: { receiveToken: randomUUID() },
  });
}
