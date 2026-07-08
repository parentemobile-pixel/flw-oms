-- Nightly per-variant snapshot. One row per variant per day.
CREATE TABLE "VariantDaySnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL DEFAULT '',
    "productType" TEXT NOT NULL DEFAULT '',
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "unitsSold" INTEGER NOT NULL DEFAULT 0,
    "unitCost" REAL NOT NULL DEFAULT 0,
    "price" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "VariantDaySnapshot_shop_date_shopifyVariantId_key" ON "VariantDaySnapshot"("shop", "date", "shopifyVariantId");
CREATE INDEX "VariantDaySnapshot_shop_date_idx" ON "VariantDaySnapshot"("shop", "date");
CREATE INDEX "VariantDaySnapshot_shop_shopifyVariantId_idx" ON "VariantDaySnapshot"("shop", "shopifyVariantId");
CREATE INDEX "VariantDaySnapshot_shop_shopifyProductId_idx" ON "VariantDaySnapshot"("shop", "shopifyProductId");

-- Monthly rollup for pre-cutover history (approx from Shopify + ShopifyQL).
CREATE TABLE "VariantMonthSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL DEFAULT '',
    "productType" TEXT NOT NULL DEFAULT '',
    "unitsSold" INTEGER NOT NULL DEFAULT 0,
    "inStockFraction" REAL NOT NULL DEFAULT 1.0,
    "source" TEXT NOT NULL DEFAULT 'approx',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "VariantMonthSnapshot_shop_month_shopifyVariantId_key" ON "VariantMonthSnapshot"("shop", "month", "shopifyVariantId");
CREATE INDEX "VariantMonthSnapshot_shop_month_idx" ON "VariantMonthSnapshot"("shop", "month");
CREATE INDEX "VariantMonthSnapshot_shop_shopifyVariantId_idx" ON "VariantMonthSnapshot"("shop", "shopifyVariantId");
CREATE INDEX "VariantMonthSnapshot_shop_shopifyProductId_idx" ON "VariantMonthSnapshot"("shop", "shopifyProductId");

-- 12 editable numbers per category (mean ~ 1.0).
CREATE TABLE "SeasonalIndex" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "value" REAL NOT NULL DEFAULT 1.0,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "SeasonalIndex_shop_category_month_key" ON "SeasonalIndex"("shop", "category", "month");
CREATE INDEX "SeasonalIndex_shop_category_idx" ON "SeasonalIndex"("shop", "category");

-- Per-product overrides on the global forecast defaults.
CREATE TABLE "ProductForecastConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "category" TEXT,
    "safetyBuffer" REAL,
    "growth" REAL,
    "leadTimeDays" INTEGER,
    "moq" INTEGER,
    "casePack" INTEGER,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ProductForecastConfig_shop_shopifyProductId_key" ON "ProductForecastConfig"("shop", "shopifyProductId");
CREATE INDEX "ProductForecastConfig_shop_idx" ON "ProductForecastConfig"("shop");
