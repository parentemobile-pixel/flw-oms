-- DropIndex
DROP INDEX "InventoryConfig_shop_shopifyProductId_shopifyVariantId_key";

-- AlterTable
ALTER TABLE "InventoryConfig" ADD COLUMN "shopifyLocationId" TEXT;

-- CreateTable
CREATE TABLE "ShopifyCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PlanningSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "periodDays" INTEGER NOT NULL,
    "unitsSold" INTEGER NOT NULL DEFAULT 0,
    "unitsSoldPriorYear" INTEGER NOT NULL DEFAULT 0,
    "daysOOS" INTEGER NOT NULL DEFAULT 0,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "InventoryTransfer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "transferNumber" TEXT NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    "receivedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "InventoryTransferLineItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transferId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL,
    "sku" TEXT,
    "quantitySent" INTEGER NOT NULL DEFAULT 0,
    "quantityReceived" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InventoryTransferLineItem_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "InventoryTransfer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InventoryAdjustmentSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceId" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT
);

-- CreateTable
CREATE TABLE "InventoryAdjustmentChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "shopifyInventoryItemId" TEXT NOT NULL,
    "previousQuantity" INTEGER NOT NULL,
    "newQuantity" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,
    CONSTRAINT "InventoryAdjustmentChange_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "InventoryAdjustmentSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockCount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StockCountLineItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "stockCountId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "expectedQuantity" INTEGER NOT NULL,
    "countedQuantity" INTEGER,
    "countedAt" DATETIME,
    "countedBy" TEXT,
    CONSTRAINT "StockCountLineItem_stockCountId_fkey" FOREIGN KEY ("stockCountId") REFERENCES "StockCount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PurchaseOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "poNumberExt" TEXT,
    "vendor" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "orderDate" DATETIME,
    "shippingDate" DATETIME,
    "expectedDate" DATETIME,
    "totalCost" REAL NOT NULL DEFAULT 0,
    "shopifyLocationId" TEXT,
    "receiveToken" TEXT NOT NULL,
    "pdfGeneratedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_PurchaseOrder" ("createdAt", "expectedDate", "id", "notes", "orderDate", "poNumber", "shop", "status", "totalCost", "updatedAt", "vendor") SELECT "createdAt", "expectedDate", "id", "notes", "orderDate", "poNumber", "shop", "status", "totalCost", "updatedAt", "vendor" FROM "PurchaseOrder";
DROP TABLE "PurchaseOrder";
ALTER TABLE "new_PurchaseOrder" RENAME TO "PurchaseOrder";
CREATE INDEX "PurchaseOrder_shop_status_idx" ON "PurchaseOrder"("shop", "status");
CREATE INDEX "PurchaseOrder_receiveToken_idx" ON "PurchaseOrder"("receiveToken");
CREATE UNIQUE INDEX "PurchaseOrder_shop_poNumber_key" ON "PurchaseOrder"("shop", "poNumber");
CREATE TABLE "new_PurchaseOrderLineItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purchaseOrderId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "unitCost" REAL NOT NULL DEFAULT 0,
    "retailPrice" REAL NOT NULL DEFAULT 0,
    "quantityOrdered" INTEGER NOT NULL DEFAULT 0,
    "quantityReceived" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PurchaseOrderLineItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PurchaseOrderLineItem" ("barcode", "createdAt", "id", "productTitle", "purchaseOrderId", "quantityOrdered", "quantityReceived", "shopifyProductId", "shopifyVariantId", "sku", "unitCost", "updatedAt", "variantTitle") SELECT "barcode", "createdAt", "id", "productTitle", "purchaseOrderId", "quantityOrdered", "quantityReceived", "shopifyProductId", "shopifyVariantId", "sku", "unitCost", "updatedAt", "variantTitle" FROM "PurchaseOrderLineItem";
DROP TABLE "PurchaseOrderLineItem";
ALTER TABLE "new_PurchaseOrderLineItem" RENAME TO "PurchaseOrderLineItem";
CREATE INDEX "PurchaseOrderLineItem_purchaseOrderId_idx" ON "PurchaseOrderLineItem"("purchaseOrderId");
CREATE INDEX "PurchaseOrderLineItem_shopifyVariantId_idx" ON "PurchaseOrderLineItem"("shopifyVariantId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ShopifyCache_shop_idx" ON "ShopifyCache"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyCache_shop_key_key" ON "ShopifyCache"("shop", "key");

-- CreateIndex
CREATE INDEX "PlanningSnapshot_shop_generatedAt_idx" ON "PlanningSnapshot"("shop", "generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlanningSnapshot_shop_shopifyVariantId_periodDays_key" ON "PlanningSnapshot"("shop", "shopifyVariantId", "periodDays");

-- CreateIndex
CREATE INDEX "InventoryTransfer_shop_status_idx" ON "InventoryTransfer"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryTransfer_shop_transferNumber_key" ON "InventoryTransfer"("shop", "transferNumber");

-- CreateIndex
CREATE INDEX "InventoryTransferLineItem_transferId_idx" ON "InventoryTransferLineItem"("transferId");

-- CreateIndex
CREATE INDEX "InventoryAdjustmentSession_shop_createdAt_idx" ON "InventoryAdjustmentSession"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryAdjustmentSession_source_sourceId_idx" ON "InventoryAdjustmentSession"("source", "sourceId");

-- CreateIndex
CREATE INDEX "InventoryAdjustmentChange_sessionId_idx" ON "InventoryAdjustmentChange"("sessionId");

-- CreateIndex
CREATE INDEX "InventoryAdjustmentChange_shopifyVariantId_idx" ON "InventoryAdjustmentChange"("shopifyVariantId");

-- CreateIndex
CREATE INDEX "StockCount_shop_status_idx" ON "StockCount"("shop", "status");

-- CreateIndex
CREATE INDEX "StockCountLineItem_stockCountId_idx" ON "StockCountLineItem"("stockCountId");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLineItem_stockCountId_shopifyVariantId_key" ON "StockCountLineItem"("stockCountId", "shopifyVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryConfig_shop_shopifyProductId_shopifyVariantId_shopifyLocationId_key" ON "InventoryConfig"("shop", "shopifyProductId", "shopifyVariantId", "shopifyLocationId");

