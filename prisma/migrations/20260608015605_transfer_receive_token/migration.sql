/*
  Warnings:

  - The required column `receiveToken` was added to the `InventoryTransfer` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_InventoryTransfer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "transferNumber" TEXT NOT NULL,
    "name" TEXT,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "receiveToken" TEXT NOT NULL,
    "trackingCarrier" TEXT,
    "trackingNumber" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    "receivedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_InventoryTransfer" ("createdAt", "fromLocationId", "id", "name", "notes", "receivedAt", "sentAt", "shop", "status", "toLocationId", "trackingCarrier", "trackingNumber", "transferNumber", "updatedAt") SELECT "createdAt", "fromLocationId", "id", "name", "notes", "receivedAt", "sentAt", "shop", "status", "toLocationId", "trackingCarrier", "trackingNumber", "transferNumber", "updatedAt" FROM "InventoryTransfer";
DROP TABLE "InventoryTransfer";
ALTER TABLE "new_InventoryTransfer" RENAME TO "InventoryTransfer";
CREATE INDEX "InventoryTransfer_shop_status_idx" ON "InventoryTransfer"("shop", "status");
CREATE INDEX "InventoryTransfer_receiveToken_idx" ON "InventoryTransfer"("receiveToken");
CREATE UNIQUE INDEX "InventoryTransfer_shop_transferNumber_key" ON "InventoryTransfer"("shop", "transferNumber");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
