import db from "../../db.server";
import { subDays, format } from "date-fns";

export interface BuyRecommendation {
  shopifyProductId: string;
  shopifyVariantId: string;
  productTitle: string;
  variantTitle: string;
  currentStock: number;
  avgDailySales: number;
  daysOfCoverage: number;
  minLevel: number;
  coverageDays: number;
  recommendedBuyQty: number;
  lastYearSameMonth: number;
  thisYearSameMonth: number;
}

export async function getBuyRecommendations(
  shop: string,
  products: Array<{
    productId: string;
    title: string;
    variants: Array<{
      variantId: string;
      title: string;
      inventoryQuantity: number;
    }>;
  }>,
): Promise<BuyRecommendation[]> {
  const recommendations: BuyRecommendation[] = [];

  // Get all inventory configs for this shop
  const configs = await db.inventoryConfig.findMany({ where: { shop } });
  const configMap = new Map(
    configs.map((c) => [`${c.shopifyProductId}:${c.shopifyVariantId || "all"}`, c]),
  );

  // Get sales data for the last 90 days to calculate velocity
  const ninetyDaysAgo = subDays(new Date(), 90);
  const salesData = await db.salesSnapshot.findMany({
    where: {
      shop,
      periodType: "weekly",
      periodStart: { gte: ninetyDaysAgo },
    },
  });

  // Group sales by variant
  const salesByVariant = new Map<string, number>();
  for (const snap of salesData) {
    const current = salesByVariant.get(snap.shopifyVariantId) || 0;
    salesByVariant.set(snap.shopifyVariantId, current + snap.quantitySold);
  }

  // YoY comparison: same month this year vs last year
  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastYearMonthStart = new Date(now.getFullYear() - 1, now.getMonth(), 1);
  const lastYearMonthEnd = new Date(now.getFullYear() - 1, now.getMonth() + 1, 0);

  const thisYearSnapshots = await db.salesSnapshot.findMany({
    where: {
      shop,
      periodType: "monthly",
      periodStart: thisMonthStart,
    },
  });
  const lastYearSnapshots = await db.salesSnapshot.findMany({
    where: {
      shop,
      periodType: "monthly",
      periodStart: {
        gte: lastYearMonthStart,
        lte: lastYearMonthEnd,
      },
    },
  });

  const thisYearByVariant = new Map(thisYearSnapshots.map((s) => [s.shopifyVariantId, s.quantitySold]));
  const lastYearByVariant = new Map(lastYearSnapshots.map((s) => [s.shopifyVariantId, s.quantitySold]));

  for (const product of products) {
    for (const variant of product.variants) {
      // Get config (variant-specific or product-level fallback)
      const variantConfig = configMap.get(`${product.productId}:${variant.variantId}`);
      const productConfig = configMap.get(`${product.productId}:all`);
      const config = variantConfig || productConfig;

      const minLevel = config?.minInventoryLevel || 0;
      const coverageDays = config?.coverageDays || 90;

      // Calculate velocity
      const totalSold90Days = salesByVariant.get(variant.variantId) || 0;
      const avgDailySales = totalSold90Days / 90;

      // Days of coverage remaining
      const daysOfCoverage = avgDailySales > 0
        ? Math.floor(variant.inventoryQuantity / avgDailySales)
        : variant.inventoryQuantity > 0 ? 999 : 0;

      // Recommended buy
      const targetStock = (avgDailySales * coverageDays) + minLevel;
      const recommendedBuyQty = Math.max(0, Math.ceil(targetStock - variant.inventoryQuantity));

      recommendations.push({
        shopifyProductId: product.productId,
        shopifyVariantId: variant.variantId,
        productTitle: product.title,
        variantTitle: variant.title,
        currentStock: variant.inventoryQuantity,
        avgDailySales: Math.round(avgDailySales * 100) / 100,
        daysOfCoverage,
        minLevel,
        coverageDays,
        recommendedBuyQty,
        lastYearSameMonth: lastYearByVariant.get(variant.variantId) || 0,
        thisYearSameMonth: thisYearByVariant.get(variant.variantId) || 0,
      });
    }
  }

  return recommendations;
}

export async function updateInventoryConfig(
  shop: string,
  shopifyProductId: string,
  shopifyVariantId: string | null,
  minInventoryLevel: number,
  coverageDays: number,
) {
  return db.inventoryConfig.upsert({
    where: {
      shop_shopifyProductId_shopifyVariantId: {
        shop,
        shopifyProductId,
        shopifyVariantId: shopifyVariantId || "all",
      },
    },
    create: {
      shop,
      shopifyProductId,
      shopifyVariantId: shopifyVariantId || "all",
      minInventoryLevel,
      coverageDays,
    },
    update: {
      minInventoryLevel,
      coverageDays,
    },
  });
}
