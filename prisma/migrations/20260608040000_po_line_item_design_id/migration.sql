-- Add per-line-item designId. One designId per colorway row (product +
-- non-size variant), not per individual size SKU — the UI groups rows
-- by (productId, nonSizeLabel) and writes the same designId to every
-- line within a row.
--
-- Nullable column — safe ALTER on a populated table (no INSERT/SELECT
-- backfill needed, no NOT-NULL constraint to satisfy).
ALTER TABLE "PurchaseOrderLineItem" ADD COLUMN "designId" TEXT;
