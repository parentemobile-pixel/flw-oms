-- CreateTable
CREATE TABLE "InventoryConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT,
    "minInventoryLevel" INTEGER NOT NULL DEFAULT 0,
    "coverageDays" INTEGER NOT NULL DEFAULT 90,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SalesSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodType" TEXT NOT NULL,
    "quantitySold" INTEGER NOT NULL,
    "revenue" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SyncStatus" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "lastSyncAt" DATETIME NOT NULL,
    "lastOrderDate" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "error" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "vendor" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "orderDate" DATETIME,
    "expectedDate" DATETIME,
    "totalCost" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PurchaseOrderLineItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purchaseOrderId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "unitCost" REAL NOT NULL DEFAULT 0,
    "quantityOrdered" INTEGER NOT NULL DEFAULT 0,
    "quantityReceived" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PurchaseOrderLineItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "defaultVendor" TEXT,
    "skuPattern" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "InventoryConfig_shop_idx" ON "InventoryConfig"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryConfig_shop_shopifyProductId_shopifyVariantId_key" ON "InventoryConfig"("shop", "shopifyProductId", "shopifyVariantId");

-- CreateIndex
CREATE INDEX "SalesSnapshot_shop_shopifyProductId_idx" ON "SalesSnapshot"("shop", "shopifyProductId");

-- CreateIndex
CREATE INDEX "SalesSnapshot_periodStart_idx" ON "SalesSnapshot"("periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "SalesSnapshot_shop_shopifyVariantId_periodStart_periodType_key" ON "SalesSnapshot"("shop", "shopifyVariantId", "periodStart", "periodType");

-- CreateIndex
CREATE UNIQUE INDEX "SyncStatus_shop_key" ON "SyncStatus"("shop");

-- CreateIndex
CREATE INDEX "PurchaseOrder_shop_status_idx" ON "PurchaseOrder"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_shop_poNumber_key" ON "PurchaseOrder"("shop", "poNumber");

-- CreateIndex
CREATE INDEX "PurchaseOrderLineItem_purchaseOrderId_idx" ON "PurchaseOrderLineItem"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchaseOrderLineItem_shopifyVariantId_idx" ON "PurchaseOrderLineItem"("shopifyVariantId");

-- CreateIndex
CREATE INDEX "ProductTemplate_shop_idx" ON "ProductTemplate"("shop");
