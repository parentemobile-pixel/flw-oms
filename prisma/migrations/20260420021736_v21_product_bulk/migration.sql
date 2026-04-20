-- CreateTable
CREATE TABLE "ProductBulkActionSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "okCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "ProductBulkActionChange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "productTitle" TEXT,
    "field" TEXT NOT NULL,
    "previousValue" TEXT,
    "newValue" TEXT,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductBulkActionChange_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ProductBulkActionSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ProductBulkActionSession_shop_createdAt_idx" ON "ProductBulkActionSession"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "ProductBulkActionSession_action_idx" ON "ProductBulkActionSession"("action");

-- CreateIndex
CREATE INDEX "ProductBulkActionChange_sessionId_idx" ON "ProductBulkActionChange"("sessionId");

-- CreateIndex
CREATE INDEX "ProductBulkActionChange_shopifyProductId_idx" ON "ProductBulkActionChange"("shopifyProductId");
