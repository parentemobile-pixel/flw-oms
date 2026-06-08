-- Add receiveToken to InventoryTransfer. The original auto-generated
-- migration failed at runtime because the INSERT didn't supply a value
-- for the new NOT NULL column — Prisma's `@default(cuid())` only runs
-- through the client at INSERT time, not in raw SQL. Generate a
-- 32-char random hex token per existing row directly in SQLite. New
-- rows still get their cuid() from Prisma at write time.
--
-- Also drops any partial `new_InventoryTransfer` left over from the
-- prior failed attempt so a retry is clean.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

DROP TABLE IF EXISTS "new_InventoryTransfer";

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

INSERT INTO "new_InventoryTransfer" (
    "createdAt", "fromLocationId", "id", "name", "notes",
    "receivedAt", "receiveToken", "sentAt", "shop", "status",
    "toLocationId", "trackingCarrier", "trackingNumber",
    "transferNumber", "updatedAt"
)
SELECT
    "createdAt", "fromLocationId", "id", "name", "notes",
    "receivedAt",
    -- Random 32-char hex per existing row. Unguessable enough for the
    -- public scan URL; new rows still use Prisma's @default(cuid()).
    lower(hex(randomblob(16))),
    "sentAt", "shop", "status", "toLocationId",
    "trackingCarrier", "trackingNumber", "transferNumber", "updatedAt"
FROM "InventoryTransfer";

DROP TABLE "InventoryTransfer";
ALTER TABLE "new_InventoryTransfer" RENAME TO "InventoryTransfer";
CREATE INDEX "InventoryTransfer_shop_status_idx" ON "InventoryTransfer"("shop", "status");
CREATE INDEX "InventoryTransfer_receiveToken_idx" ON "InventoryTransfer"("receiveToken");
CREATE UNIQUE INDEX "InventoryTransfer_shop_transferNumber_key" ON "InventoryTransfer"("shop", "transferNumber");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
