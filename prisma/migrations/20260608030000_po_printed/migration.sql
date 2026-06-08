-- Add optional printedAt timestamp to PurchaseOrder.
-- Same shape / semantics as paidAt: null = unprinted; timestamp = when
-- the user marked the PO printed. Nullable column on an existing table,
-- so no INSERT-INTO-SELECT dance is needed (unlike the receiveToken
-- migration that bit us earlier).
ALTER TABLE "PurchaseOrder" ADD COLUMN "printedAt" DATETIME;
