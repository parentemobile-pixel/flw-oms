import db from "../../db.server";
import { format } from "date-fns";

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

export async function createPurchaseOrder(
  shop: string,
  data: {
    vendor?: string;
    notes?: string;
    lineItems: Array<{
      shopifyProductId: string;
      shopifyVariantId: string;
      productTitle: string;
      variantTitle: string;
      sku?: string;
      barcode?: string;
      unitCost: number;
      retailPrice: number;
      quantityOrdered: number;
    }>;
  },
) {
  const poNumber = await generatePoNumber(shop);
  const totalCost = data.lineItems.reduce((sum, li) => sum + li.unitCost * li.quantityOrdered, 0);

  return db.purchaseOrder.create({
    data: {
      shop,
      poNumber,
      vendor: data.vendor,
      notes: data.notes,
      totalCost,
      lineItems: {
        create: data.lineItems,
      },
    },
    include: { lineItems: true },
  });
}

export async function getPurchaseOrders(shop: string, status?: string) {
  return db.purchaseOrder.findMany({
    where: {
      shop,
      ...(status ? { status } : {}),
    },
    include: {
      lineItems: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getPurchaseOrder(shop: string, id: string) {
  return db.purchaseOrder.findFirst({
    where: { shop, id },
    include: { lineItems: true },
  });
}

export async function updatePurchaseOrderStatus(shop: string, id: string, status: string) {
  return db.purchaseOrder.update({
    where: { id },
    data: {
      status,
      ...(status === "ordered" ? { orderDate: new Date() } : {}),
    },
  });
}

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

  // Check if all items are fully received
  const updatedPo = await db.purchaseOrder.findUnique({
    where: { id },
    include: { lineItems: true },
  });
  if (!updatedPo) throw new Error("PO not found");

  const allReceived = updatedPo.lineItems.every((li) => li.quantityReceived >= li.quantityOrdered);
  const someReceived = updatedPo.lineItems.some((li) => li.quantityReceived > 0);

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
  return db.purchaseOrder.delete({
    where: { id },
  });
}

// Get on-order quantities for variants (from open POs)
export async function getOnOrderQuantities(shop: string): Promise<Record<string, number>> {
  const openPOs = await db.purchaseOrder.findMany({
    where: {
      shop,
      status: { in: ["draft", "ordered", "partially_received"] },
    },
    include: { lineItems: true },
  });

  const onOrder: Record<string, number> = {};
  for (const po of openPOs) {
    for (const li of po.lineItems) {
      const remaining = li.quantityOrdered - li.quantityReceived;
      if (remaining > 0) {
        onOrder[li.shopifyVariantId] = (onOrder[li.shopifyVariantId] || 0) + remaining;
      }
    }
  }
  return onOrder;
}
