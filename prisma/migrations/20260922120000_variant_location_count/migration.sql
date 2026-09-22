-- Rolling "last counted" record per (shop, location, variant). Replaces
-- the session-based StockCount flow: every Save Row on the Stock Counts
-- page upserts here, whether or not Shopify needed an adjustment.
CREATE TABLE "VariantLocationCount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL,
    "vendor" TEXT,
    "sku" TEXT,
    "barcode" TEXT,
    "lastCountedAt" DATETIME NOT NULL,
    "lastCountedQty" INTEGER NOT NULL,
    "previousQty" INTEGER NOT NULL,
    "countedBy" TEXT,
    "sessionId" TEXT,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "VariantLocationCount_shop_locationId_shopifyVariantId_key"
    ON "VariantLocationCount"("shop", "locationId", "shopifyVariantId");

CREATE INDEX "VariantLocationCount_shop_locationId_lastCountedAt_idx"
    ON "VariantLocationCount"("shop", "locationId", "lastCountedAt");

-- Backfill from the retired session counts so "last counted" history
-- survives: freshest countedAt per (shop, location, variant) across
-- every StockCount that had a counted line. Ids reuse the line-item id
-- (already unique) so the insert is idempotent-safe on re-run.
INSERT INTO "VariantLocationCount" (
    "id", "shop", "locationId", "shopifyVariantId", "shopifyProductId",
    "productTitle", "variantTitle", "vendor", "sku", "barcode",
    "lastCountedAt", "lastCountedQty", "previousQty", "countedBy",
    "sessionId", "updatedAt"
)
SELECT
    li."id", sc."shop", sc."locationId", li."shopifyVariantId", li."shopifyProductId",
    li."productTitle", li."variantTitle", li."vendor", li."sku", li."barcode",
    li."countedAt", li."countedQuantity",
    COALESCE(li."shopifyQtyAtSave", li."expectedQuantity"), li."countedBy",
    NULL, CURRENT_TIMESTAMP
FROM "StockCountLineItem" li
JOIN "StockCount" sc ON sc."id" = li."stockCountId"
WHERE li."countedAt" IS NOT NULL
  AND li."countedQuantity" IS NOT NULL
  AND li."countedAt" = (
    SELECT MAX(li2."countedAt")
    FROM "StockCountLineItem" li2
    JOIN "StockCount" sc2 ON sc2."id" = li2."stockCountId"
    WHERE li2."shopifyVariantId" = li."shopifyVariantId"
      AND sc2."shop" = sc."shop"
      AND sc2."locationId" = sc."locationId"
      AND li2."countedAt" IS NOT NULL
  )
GROUP BY sc."shop", sc."locationId", li."shopifyVariantId";
