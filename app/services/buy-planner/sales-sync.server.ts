import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { fetchAllOrdersInRange } from "../shopify-api/orders.server";
import db from "../../db.server";
import { startOfWeek, startOfMonth, format, subYears } from "date-fns";

export async function syncSalesData(admin: AdminApiContext, shop: string) {
  // Update sync status
  await db.syncStatus.upsert({
    where: { shop },
    create: { shop, lastSyncAt: new Date(), status: "syncing" },
    update: { lastSyncAt: new Date(), status: "syncing", error: null },
  });

  try {
    const endDate = new Date();
    const startDate = subYears(endDate, 2); // Fetch 2 years of data for YoY

    const orders = await fetchAllOrdersInRange(
      admin,
      format(startDate, "yyyy-MM-dd"),
      format(endDate, "yyyy-MM-dd"),
    );

    // Aggregate by variant + period
    const weeklyMap = new Map<string, { productId: string; variantId: string; periodStart: Date; qty: number; revenue: number }>();
    const monthlyMap = new Map<string, { productId: string; variantId: string; periodStart: Date; qty: number; revenue: number }>();

    for (const order of orders) {
      const orderDate = new Date(order.createdAt);
      const weekStart = startOfWeek(orderDate, { weekStartsOn: 1 });
      const monthStart = startOfMonth(orderDate);

      for (const li of order.lineItems) {
        if (!li.variantId || !li.productId) continue;

        // Weekly aggregation
        const weekKey = `${li.variantId}:${format(weekStart, "yyyy-MM-dd")}`;
        const weekEntry = weeklyMap.get(weekKey) || {
          productId: li.productId,
          variantId: li.variantId,
          periodStart: weekStart,
          qty: 0,
          revenue: 0,
        };
        weekEntry.qty += li.quantity;
        weekEntry.revenue += li.revenue;
        weeklyMap.set(weekKey, weekEntry);

        // Monthly aggregation
        const monthKey = `${li.variantId}:${format(monthStart, "yyyy-MM-dd")}`;
        const monthEntry = monthlyMap.get(monthKey) || {
          productId: li.productId,
          variantId: li.variantId,
          periodStart: monthStart,
          qty: 0,
          revenue: 0,
        };
        monthEntry.qty += li.quantity;
        monthEntry.revenue += li.revenue;
        monthlyMap.set(monthKey, monthEntry);
      }
    }

    // Upsert weekly snapshots
    for (const entry of weeklyMap.values()) {
      await db.salesSnapshot.upsert({
        where: {
          shop_shopifyVariantId_periodStart_periodType: {
            shop,
            shopifyVariantId: entry.variantId,
            periodStart: entry.periodStart,
            periodType: "weekly",
          },
        },
        create: {
          shop,
          shopifyProductId: entry.productId,
          shopifyVariantId: entry.variantId,
          periodStart: entry.periodStart,
          periodType: "weekly",
          quantitySold: entry.qty,
          revenue: entry.revenue,
        },
        update: {
          quantitySold: entry.qty,
          revenue: entry.revenue,
        },
      });
    }

    // Upsert monthly snapshots
    for (const entry of monthlyMap.values()) {
      await db.salesSnapshot.upsert({
        where: {
          shop_shopifyVariantId_periodStart_periodType: {
            shop,
            shopifyVariantId: entry.variantId,
            periodStart: entry.periodStart,
            periodType: "monthly",
          },
        },
        create: {
          shop,
          shopifyProductId: entry.productId,
          shopifyVariantId: entry.variantId,
          periodStart: entry.periodStart,
          periodType: "monthly",
          quantitySold: entry.qty,
          revenue: entry.revenue,
        },
        update: {
          quantitySold: entry.qty,
          revenue: entry.revenue,
        },
      });
    }

    await db.syncStatus.update({
      where: { shop },
      data: { status: "idle", lastSyncAt: new Date() },
    });

    return { success: true, ordersProcessed: orders.length };
  } catch (error) {
    await db.syncStatus.update({
      where: { shop },
      data: { status: "error", error: String(error) },
    });
    throw error;
  }
}
