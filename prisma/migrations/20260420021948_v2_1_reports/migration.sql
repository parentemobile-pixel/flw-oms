-- CreateTable
CREATE TABLE "InventoryValueSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "vendor" TEXT,
    "periodEnd" DATETIME NOT NULL,
    "totalUnits" INTEGER NOT NULL DEFAULT 0,
    "totalCostValue" REAL NOT NULL DEFAULT 0,
    "totalRetailValue" REAL NOT NULL DEFAULT 0,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "InventoryValueSnapshot_shop_periodEnd_idx" ON "InventoryValueSnapshot"("shop", "periodEnd");

-- CreateIndex
CREATE INDEX "InventoryValueSnapshot_shop_locationId_periodEnd_idx" ON "InventoryValueSnapshot"("shop", "locationId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryValueSnapshot_shop_locationId_vendor_periodEnd_key" ON "InventoryValueSnapshot"("shop", "locationId", "vendor", "periodEnd");
