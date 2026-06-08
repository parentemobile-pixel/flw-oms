import db from "../../db.server";

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
  name?: string | null;
  vendor?: string;
  notes?: string;
  shippingDate?: Date | null;
  expectedDate?: Date | null;
  shopifyLocationId?: string | null;
  poNumberExt?: string | null;
  designId?: string | null;
  lineItems: POLineItemInput[];
}

export interface UpdatePOInput {
  name?: string | null;
  vendor?: string | null;
  notes?: string | null;
  shippingDate?: Date | null;
  expectedDate?: Date | null;
  shopifyLocationId?: string | null;
  poNumberExt?: string | null;
  designId?: string | null;
  lineItems?: POLineItemInput[]; // if provided, replaces existing line items
}

export interface POSummary {
  id: string;
  poNumber: string;
  name: string | null;
  vendor: string | null;
  status: string;
  totalCost: number;
  shippingDate: Date | null;
  expectedDate: Date | null;
  orderDate: Date | null;
  createdAt: Date;
  shopifyLocationId: string | null;
  paidAt: Date | null;
  printedAt: Date | null;
  // Aggregates (computed, not stored)
  totalUnits: number;
  totalReceived: number;
}

// ============================================
// FUNCTIONS
// ============================================

/**
 * Build a vendor-prefix for a PO number. Takes the first three
 * alphanumeric characters of the vendor name, uppercased, and pads
 * short results with X. Empty / missing vendor → "PO".
 *
 * Examples:
 *   "Comfort Colors"   -> "COM"
 *   "F.L. Woods"       -> "FLW"
 *   "3sixteen"         -> "3SI"
 *   "AB"               -> "ABX"
 *   ""                 -> "PO"
 */
export function poPrefixForVendor(vendor: string | null | undefined): string {
  if (!vendor) return "PO";
  const cleaned = vendor.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (cleaned.length === 0) return "PO";
  return cleaned.slice(0, 3).padEnd(3, "X");
}

/**
 * PO numbers look like `{PREFIX}-{SEQ}` where prefix comes from the
 * vendor (or "PO" if no vendor) and seq is the next free integer for
 * that prefix, starting at 1001.
 *
 * Different vendors that share a prefix (e.g. two 3-letter brand names
 * starting with the same letters) share a sequence — that's fine, the
 * resulting PO number is still globally unique. We just look at every
 * existing PO with the same prefix and take max(seq) + 1.
 */
export async function generatePoNumber(
  shop: string,
  vendor?: string | null,
): Promise<string> {
  const prefix = `${poPrefixForVendor(vendor)}-`;
  const existing = await db.purchaseOrder.findMany({
    where: { shop, poNumber: { startsWith: prefix } },
    select: { poNumber: true },
  });
  let maxSeq = 1000; // first PO for any prefix is 1001
  for (const { poNumber } of existing) {
    const tail = poNumber.slice(prefix.length);
    const n = parseInt(tail, 10);
    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
  }
  return `${prefix}${maxSeq + 1}`;
}

export async function createPurchaseOrder(shop: string, data: CreatePOInput) {
  // Pass the vendor through so the PO number prefix matches it.
  const poNumber = await generatePoNumber(shop, data.vendor);
  const totalCost = data.lineItems.reduce(
    (sum, li) => sum + li.unitCost * li.quantityOrdered,
    0,
  );

  return db.purchaseOrder.create({
    data: {
      shop,
      poNumber,
      name: data.name ?? null,
      vendor: data.vendor ?? null,
      notes: data.notes ?? null,
      shippingDate: data.shippingDate ?? null,
      expectedDate: data.expectedDate ?? null,
      shopifyLocationId: data.shopifyLocationId ?? null,
      poNumberExt: data.poNumberExt ?? null,
      designId: data.designId ?? null,
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
      name: true,
      vendor: true,
      status: true,
      totalCost: true,
      shippingDate: true,
      expectedDate: true,
      orderDate: true,
      createdAt: true,
      shopifyLocationId: true,
      paidAt: true,
      printedAt: true,
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

/**
 * Edit an existing PO.
 *
 * Rules:
 *  - Cancelled POs cannot be edited.
 *  - Metadata fields (vendor, poNumberExt, shippingDate, expectedDate,
 *    shopifyLocationId, notes) are editable on any non-cancelled PO.
 *  - Line items can only be replaced on DRAFT POs. Once a PO is ordered,
 *    line items are locked (they've been sent to the vendor, and partial
 *    receive state on them must be preserved).
 */
export async function updatePurchaseOrder(
  shop: string,
  id: string,
  data: UpdatePOInput,
) {
  const po = await db.purchaseOrder.findFirst({ where: { shop, id } });
  if (!po) throw new Error("PO not found");
  if (po.status === "cancelled") {
    throw new Error("Cancelled POs cannot be edited");
  }
  if (data.lineItems && po.status !== "draft") {
    throw new Error(
      "Line items are locked on non-draft POs — only metadata (dates, notes, vendor PO #, destination) can be edited",
    );
  }

  // If replacing line items (draft only), recompute totalCost, wipe and recreate.
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
      name: data.name === undefined ? undefined : data.name,
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
      designId: data.designId === undefined ? undefined : data.designId,
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
 * Toggle the paid flag on a PO. Stores a timestamp (so we know when it
 * was marked paid) rather than a boolean — `paidAt !== null` is the
 * "is paid" predicate everywhere in the UI.
 */
export async function setPurchaseOrderPaid(
  shop: string,
  id: string,
  paid: boolean,
) {
  // shop guard so a stale id from another store can't be flipped.
  const existing = await db.purchaseOrder.findFirst({
    where: { shop, id },
    select: { id: true },
  });
  if (!existing) throw new Error("PO not found");
  return db.purchaseOrder.update({
    where: { id },
    data: { paidAt: paid ? new Date() : null },
  });
}

/**
 * Toggle the printed flag on a PO. Same pattern as `setPurchaseOrderPaid`
 * — timestamp instead of boolean so we know WHEN it was marked printed.
 * `printedAt !== null` is the "is printed" predicate.
 */
export async function setPurchaseOrderPrinted(
  shop: string,
  id: string,
  printed: boolean,
) {
  const existing = await db.purchaseOrder.findFirst({
    where: { shop, id },
    select: { id: true },
  });
  if (!existing) throw new Error("PO not found");
  return db.purchaseOrder.update({
    where: { id },
    data: { printedAt: printed ? new Date() : null },
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

