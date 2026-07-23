-- Autosaved draft buffer + stale-write guard timestamp on stock count lines.
ALTER TABLE "StockCountLineItem" ADD COLUMN "draftQuantity" INTEGER;
ALTER TABLE "StockCountLineItem" ADD COLUMN "draftUpdatedAt" DATETIME;

-- Powers the location-scoped "last counted N days ago" lookup —
-- MAX(countedAt) per shopifyVariantId across prior counts.
CREATE INDEX "StockCountLineItem_shopifyVariantId_countedAt_idx"
  ON "StockCountLineItem"("shopifyVariantId", "countedAt");
