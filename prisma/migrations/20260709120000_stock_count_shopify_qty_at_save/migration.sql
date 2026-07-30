-- Snapshot of Shopify's `available` at the moment a stock count line
-- was Save-Row'd (or scan-incremented). Used at Complete time as the
-- "expected" for the delta so mid-count sales don't get re-added.
-- Nullable — existing rows fall back to live-Shopify behavior.
ALTER TABLE "StockCountLineItem" ADD COLUMN "shopifyQtyAtSave" INTEGER;
