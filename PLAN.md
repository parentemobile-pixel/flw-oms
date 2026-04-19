# FLW-OMS V2 Plan

## Context
FL Woods is a clothing retailer running Shopify POS in one brick-and-mortar flagship, a Shopify online store, and opening a second B&M location summer 2026. They sell three product tiers: FLW-branded (their designs, manufactured with partners), private-label (their mark on vendor blanks), and resale brands (Helly Hansen, Barbour, etc.). Shopify's admin UX is painful for apparel operations — multi-size/multi-color variants make everything clunky. A V1 of this OMS exists (Product Builder, PO system, receiving, label printing) but has UX gaps and no multi-location support.

V2 goal: a rebuilt, multi-location-aware OMS with 7 modules — Product Builder, PO system (with grid view + PDF + scan-to-receive), Inventory Adjust, Inventory Transfer, Standalone Barcode Printer, Stock Count, and Inventory Planning. Target user: small non-technical team; UI needs to be foolproof.

User preferences established:
- **Phasing:** build in the order that makes most structural sense (foundation first); robust before launch
- **Device:** must work on both phone/iPad and desktop
- **Inventory planning view:** product-by-product table (primary)
- **Data:** fresh-start DB is fine
- **Zebra printing:** browser print → driver (defer Print Bridge)
- **Permissions:** everyone full access (no roles for V2)
- **Multi-location:** second store opens summer 2026
- **Database:** stay on SQLite + Litestream

---

## Architecture decisions

### Keep
- Remix + Polaris + App Bridge (already in place, no migration)
- SQLite + Litestream backup to S3
- Prisma for DB access
- bwip-js + jsPDF for label generation (`app/services/purchase-orders/label-generator.server.ts` — already generic, reusable)
- Shopify GraphQL service files as the pattern (`app/services/shopify-api/*.server.ts`)
- Vendor autocomplete + "add new vendor" modal from existing Product Builder
- Image staged-upload flow (`/api/staged-upload`)
- Metafield dynamic rendering (handles weight/dimension/volume/boolean/number/text)
- CODE128 barcode format on 2.25" × 1.25" thermal labels
- Fly.io + GitHub Actions push-to-deploy (already working)

### Refactor / Rebuild
- **Database schema:** add `locationId` to all inventory-related models; add new models (`StockCount`, `InventoryTransfer`, `BarcodeLabel`, `PlanningSnapshot`)
- **PO service:** move from `include: { lineItems }` to aggregate counts, add grid-view data shape, transactional receive with rollback
- **PO receive:** fix race condition (DB write then inventory adjust can diverge — wrap in try/catch with rollback)
- **Shopify inventory queries:** fetch per-location levels in the initial product query instead of inline fetches in routes
- **Product Builder:** add barcode generation on creation, add optional "set initial inventory at location X" step
- **Homepage / navigation:** restructure menu for the 7 modules

### New foundations
- **`app/services/locations.server.ts`** — fetch + cache Shopify locations; all location-scoped features use this
- **`app/services/inventory.server.ts`** (rewrite) — per-location level fetches in bulk (batched 50 variants at a time), transfer primitive, adjust-with-reason
- **`app/services/barcodes.server.ts`** — deterministic barcode generation for SKUs (reusable by Product Builder, Standalone Label Printer, PO labels)
- **`app/services/cache/shopify-cache.server.ts`** — 1-hour TTL cache for vendors/publications/metafield defs (already planned, never shipped) — fixes Product Builder slowness
- **Shared `ProductGrid` component** — the sizes-as-columns, products-as-rows grid that's reused across **PO create, PO receive, Inventory Adjust, Stock Count, Inventory Transfer**
- **Shared `BarcodeScanInput` component** — autofocus text input that listens for scanner output (USB scanners act as keyboards) + optional camera scan (for mobile) using `@zxing/library` or `html5-qrcode`
- **Mobile-aware layout** — Polaris is already responsive; add a "compact mode" variant of ProductGrid for phones

---

## Shopify AI tooling — what to use vs. what not to use

Researched in April 2026. Shopify's AI story splits cleanly in two: **developer tooling** (real, official, valuable to us) and **runtime AI SDK** (does not exist — we BYO).

### Use: `@shopify/dev-mcp` (developer-side, during build)
Official Shopify-published MCP server for coding assistants. Adds it to Claude Code's MCP config so during implementation we get:
- Live Shopify GraphQL schema introspection — generated queries validate against the current API version, not a stale mental model
- Full-text search over shopify.dev docs without leaving the editor
- Code validation for generated GraphQL against the schema

**Action:** before starting Module 1, register `@shopify/dev-mcp` in `~/.claude/settings.json`. This will noticeably improve the correctness of GraphQL we produce (fewer "field does not exist" bugs caught at runtime). No change to the shipped app.

### Use: shopify.dev AI Toolkit guidance docs (reference)
The `https://shopify.dev/docs/apps/build/ai-toolkit` page — scaffolding recommendations for embedded AI features inside Shopify apps (prompt patterns, UX guidelines, rate-limit expectations). Reference material during AIChat v2 work; no package to install.

### Do NOT use
- **Community MCP servers** (`shopify-ai-mcp`, `cob-shopify-mcp`, etc.) — read-heavy wrappers meant for Claude Desktop users, not embedded apps. Add no capability our existing GraphQL tool-use doesn't already have.
- **Shopify Sidekick** — merchant-facing only, no dev API.
- **Polaris AI components** — don't exist yet.

### Runtime AI approach (unchanged, but articulated)
Keep the existing Anthropic SDK pattern for in-app AI features — it's the right call because:
- Shopify explicitly does not ship a runtime AI SDK; BYO is the expected pattern
- Our AIChat already uses agentic tool-use (Claude → our GraphQL tools → Shopify API) which MCP servers can't orchestrate as cleanly
- Vendor-PO-PDF parsing (bonus feature) benefits from Claude's native document/vision handling — no Shopify equivalent

Specific places runtime AI earns its place in V2:
1. **AIChat v2 (Home):** retain the Anthropic-backed chat; lazy-load it; add location-aware tools (`get_inventory_by_location`, `list_open_pos`, `summarize_sales_by_vendor`)
2. **Planning nudges (Module 8):** optional "ask AI" button on a planning row → Claude summarizes "last year this ran OOS 34 days, suggested qty may be low" — one-shot, no chat state
3. **Vendor PO import (future, post-V2):** drag-drop PDF → Claude extracts line items → prefill a draft PO. Parked for V2.1.

---

## Database schema changes

New + modified Prisma models (full migration, fresh start):

```prisma
// Updated
model InventoryConfig {
  id               String @id @default(cuid())
  shop             String
  shopifyProductId String
  shopifyVariantId String?
  shopifyLocationId String?          // NEW — per-location min levels
  minInventoryLevel Int @default(0)
  coverageDays      Int @default(90)
  // ...
  @@unique([shop, shopifyProductId, shopifyVariantId, shopifyLocationId])
}

model PurchaseOrder {
  // existing fields +
  shopifyLocationId String?          // NEW — where inventory lands on receive
  shippingDate      DateTime?        // NEW — "ship by" date
  expectedDate      DateTime?        // already exists
  poNumberExt       String?          // NEW — vendor's PO# if different
  receiveToken      String @default(cuid())  // NEW — used for scan-to-receive signed URL
  pdfGeneratedAt    DateTime?        // NEW — cache marker
}

model PurchaseOrderLineItem {
  // existing fields —
  // no schema change; retailPrice + quantityReceived already there
}

// New
model InventoryTransfer {
  id               String @id @default(cuid())
  shop             String
  transferNumber   String            // TR-20260601-001
  fromLocationId   String
  toLocationId     String
  status           String @default("draft")  // draft | in_transit | received | cancelled
  notes            String?
  createdAt        DateTime @default(now())
  sentAt           DateTime?
  receivedAt       DateTime?
  lineItems        InventoryTransferLineItem[]
  @@unique([shop, transferNumber])
}

model InventoryTransferLineItem {
  id                  String @id @default(cuid())
  transferId          String
  shopifyProductId    String
  shopifyVariantId    String
  productTitle        String
  variantTitle        String
  sku                 String?
  quantitySent        Int @default(0)
  quantityReceived    Int @default(0)
  transfer            InventoryTransfer @relation(fields: [transferId], references: [id], onDelete: Cascade)
  @@index([transferId])
}

model StockCount {
  id                  String @id @default(cuid())
  shop                String
  locationId          String
  name                String            // "FW25 pre-Thanksgiving count"
  status              String @default("in_progress")  // in_progress | completed | abandoned
  createdAt           DateTime @default(now())
  completedAt         DateTime?
  lineItems           StockCountLineItem[]
  @@index([shop, status])
}

model StockCountLineItem {
  id                  String @id @default(cuid())
  stockCountId        String
  shopifyVariantId    String
  expectedQuantity    Int              // pulled from Shopify at count start
  countedQuantity     Int?             // null until user counts it
  countedAt           DateTime?
  countedBy           String?          // optional user identifier
  stockCount          StockCount @relation(fields: [stockCountId], references: [id], onDelete: Cascade)
  @@index([stockCountId])
  @@unique([stockCountId, shopifyVariantId])
}

model InventoryAdjustmentSession {
  // Tracks a "batch" adjust (grid-based) — lets us show audit log & support undo
  id               String @id @default(cuid())
  shop             String
  locationId       String
  reason           String           // Shopify reason enum
  notes            String?
  createdAt        DateTime @default(now())
  createdBy        String?
  changes          InventoryAdjustmentChange[]
}

model InventoryAdjustmentChange {
  id               String @id @default(cuid())
  sessionId        String
  shopifyVariantId String
  shopifyInventoryItemId String
  previousQuantity Int
  newQuantity      Int
  delta            Int
  session          InventoryAdjustmentSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  @@index([sessionId])
}

model PlanningSnapshot {
  // Cached per-variant sales velocity + stock + YoY for the planning table
  id               String @id @default(cuid())
  shop             String
  shopifyVariantId String
  periodDays       Int              // e.g. 365
  unitsSold        Int
  unitsSoldPriorYear Int
  daysOOS          Int              // days out of stock during period
  generatedAt      DateTime @default(now())
  @@unique([shop, shopifyVariantId, periodDays])
  @@index([shop, generatedAt])
}

model ShopifyCache {
  id        String @id @default(cuid())
  shop      String
  key       String   // "vendors" | "metafield_definitions" | "publications" | "locations"
  value     String   // JSON
  expiresAt DateTime
  updatedAt DateTime @updatedAt
  @@unique([shop, key])
}
```

---

## Module-by-module plan

### Module 1 — Foundation (build first, no user-facing feature)
- Migrate schema (fresh DB reset acceptable)
- Build `locations.server.ts`, rewrite `inventory.server.ts` with batched per-location queries, build `shopify-cache.server.ts`, build `barcodes.server.ts`
- Build shared `<ProductGrid>` component — the sizes-as-columns grid used by 5 features
- Build shared `<BarcodeScanInput>` component — keyboard-emulation scanner + camera fallback
- Build shared `<LocationPicker>` — dropdown of Shopify locations, auto-defaults to last-used per user (localStorage)
- Rebuild nav menu for 7 modules: Home / Products / Purchase Orders / Inventory Adjust / Transfers / Stock Counts / Planning / Print Labels

**Files touched:** `prisma/schema.prisma`, `app/services/**`, `app/components/ProductGrid.tsx`, `app/components/BarcodeScanInput.tsx`, `app/components/LocationPicker.tsx`, `app/routes/app.tsx`

### Module 2 — Product Builder v2
Keep 80% of existing logic. Changes:
- **Auto-generate barcode per SKU on creation** (via `barcodes.server.ts` — GTIN-compatible sequence or UUID-based; written via `productSet` mutation)
- **Optional "set initial inventory" step** — after create, show variants × locations grid to enter starting stock. Skip to just create + empty stock if not needed.
- **Tag taxonomy enforcement** — dropdown picker for seasons (FW25, SS26, …) + brand type (FLW Brand / Private Label / Partner Brand) + optional "FLW Core" badge — all written as Shopify tags so the merchandiser can slice by them later.
- **Cache the slow 4-query loader** (vendors / publications / metafield defs / existing options) via `ShopifyCache` (1h TTL) — eliminates the "Product Builder takes 3s to open" pain.

**Files:** `app/routes/app.product-builder._index.tsx` (refactor), `app/services/shopify-api/products.server.ts` (wrap in cache + barcode gen)

### Module 3 — Purchase Orders v2
The biggest change. Build in this order:
1. **PO list page** — use `_count` + groupBy aggregates (no more full lineItem fetch); show status chips, vendor, ship date, $ total
2. **PO create** — redesigned with two views:
   - **Line view:** current table (one SKU per row)
   - **Grid view:** rows = product + non-size variants (color/material), columns = sizes, cell = qty input
   - Toggle preserves state. Keyboard nav in grid (arrow keys, tab).
   - Vendor dropdown + product/variant search + "add variant" from search
   - Extra fields: **shipping date**, **expected date**, **vendor PO #**, **notes**, **destination location**
3. **PO detail page** — header (vendor / dates / location / status / total), same line/grid toggle as create, action buttons based on status
4. **PO PDF download** — single endpoint, `?view=line|grid` query param picks layout. Landscape for grid. Includes FLW letterhead, vendor info, ship/expected dates, totals. QR code in corner links to signed scan-to-receive URL.
5. **PO receive** — dedicated route, supports:
   - **Grid entry** (matches PO create) with keyboard scanner focus
   - **Scan-to-line mode:** cursor in scan field, scan SKU/barcode → qty +1 on that line (rapid receive)
   - **Partial receive:** any line can receive less than ordered, PO moves to `partially_received`; remaining can be received later
   - **Transactional:** DB update + Shopify `inventoryAdjustQuantities` in one try block, log each adjust in `InventoryAdjustmentSession`, on error rollback DB + show what succeeded
6. **Label print from PO** — already works; add "print subset" (select which lines + qty per line) for cases where a unit arrives damaged or short
7. **Scan-to-receive** — `/r/:token` public route (no auth, just token-based). Mobile-optimized UI. Shows PO summary + grid-entry receive. Write actions still hit the authed backend (token → session lookup by `receiveToken`). Token rotatable. *This is the "bonus" feature — plan it now but ship after core PO v2 is stable.*

**Files:** `app/routes/app.purchase-orders.*`, `app/services/purchase-orders/*`, new `app/routes/r.$token.tsx` for public receive

### Module 4 — Inventory Adjust
New module. Desktop-first with mobile support.
- Location picker → product search → variant grid (same `<ProductGrid>`)
- Cells show: current qty (fetched), new qty (editable)
- Bottom bar: reason dropdown (Shopify enum), notes, "Apply Adjustments"
- On apply: compute deltas, batch `inventoryAdjustQuantities`, record `InventoryAdjustmentSession` for audit
- Show last 10 adjustments as a sidebar ("Recent adjustments")

**Files:** `app/routes/app.adjust._index.tsx`, `app/services/inventory/adjust.server.ts`

### Module 5 — Inventory Transfer
New module. Similar to PO flow but location-to-location.
- **Create transfer:** From/To location pickers → product search → grid of variants × "qty to send" → save as draft
- **Send:** confirms "Send from A" — subtracts at A, sets status `in_transit`
- **Receive at destination:** same grid, "qty received" column, on apply: adds at B, marks received
- **Transaction safety:** if A-subtract fails, abort. If A-subtract succeeds but B-add fails, show retry UI and the PO is "stuck" at in_transit with partial at neither — can be recovered manually.
- Print transfer manifest as PDF (like PO PDF but labeled "TRANSFER")

**Files:** `app/routes/app.transfers.*`, `app/services/transfers/*.server.ts`

### Module 6 — Standalone Barcode Printer
Small, isolated.
- Search product → pick variant → enter quantity → "Print Labels"
- Reuses `generateLabelsPDF()` verbatim
- Optional: "reprint from PO" button on PO detail page (exists already)

**Files:** `app/routes/app.print-labels._index.tsx` (new), `app/routes/api.labels.adhoc.tsx` (new POST endpoint — `{variantId, quantity}` → PDF)

### Module 7 — Stock Count
New module. Foolproof UI is the key requirement ("people lose track of where they are").
- **Create count session:** name, location → generates a `StockCountLineItem` per variant at that location (pulls expected qty from Shopify at create time — snapshot)
- **Count UI:** 
  - Big search / scan box at top
  - Scrollable list of variants grouped by product, showing: image, title, variant, expected qty, **counted qty field**
  - Counted items get a green check + move to "Counted" section (collapsed by default)
  - Uncounted items stay in "Remaining" section — always easy to see what's left
  - Auto-save on each count entry (debounced)
  - **Can pause and resume** — close tab, come back later, progress is saved
  - Mobile-first: each line is a big touch target, scanner input at top always focused
- **Complete count:**
  - Shows variance report: expected vs counted, $ impact at cost
  - Uncounted items list with "archive these?" action (likely dead SKUs)
  - "Apply to Shopify" — generates `InventoryAdjustmentSession` with reason `cycle_count_accuracy`, applies deltas
- Archived/abandoned counts kept for history

**Files:** `app/routes/app.stock-counts.*`, `app/services/stock-counts/*.server.ts`

### Module 8 — Inventory Planning
The hard one. Built **last** because it depends on sales-data sync maturity. Product-by-product table (per user preference).

**Data pipeline:**
- Nightly cron: sync last 14 months of order line items into `SalesSnapshot` (already partially built in `app/services/buy-planner/sales-sync.server.ts`)
- On-demand: rebuild `PlanningSnapshot` table with for each variant: units sold (trailing period), units sold (same period prior year), days OOS during period (inferred from `inventoryLevels` history — approximate), current stock across locations, current "on order" from open POs + in-transit transfers

**UI: Primary table view**
- Columns (sortable/filterable):
  - Product / Variant / SKU
  - Tags (season, brand type) — filterable
  - Current stock (all locations + per-location breakdown on hover)
  - Units sold — this period
  - Units sold — prior year same period
  - Days out of stock (this period)
  - "Adjusted" units sold (units sold ÷ days in stock × days in period — accounts for OOS)
  - On order (POs + transfers in flight)
  - **Suggested order qty** (computed: `max(0, adjusted_sold × coverage_multiplier − current_stock − on_order)`; coverage_multiplier defaults to 1.0 = "same as last year", adjustable globally)
  - **Order qty** (editable input) — user's final call
  - Min order qty flag (warning if below vendor's minimum)
- Filters: vendor, season tag, brand tag, out-of-stock only, "has prior-year sales"
- Select rows → "Create PO from selection" — populates a new PO with the qty column as initial quantities
- Aggregations at bottom: total units, total cost estimate, # vendors

**Parking lot for later:**
- Category/season aggregate dashboard (the second lens you mentioned)
- Forecasting models beyond simple YoY

**Files:** `app/routes/app.planning.*`, `app/services/planning/*.server.ts`, cron in `app/services/cron.server.ts`

### Module 9 — Home & Polish
- New dashboard: "what needs attention" — open POs past expected date, low-stock alerts, unreceived transfers, in-progress stock counts
- Quick-action cards for each module
- Location switcher in top nav (store-wide default)
- **AIChat v2:** keep the Anthropic-backed chat, lazy-load it, expand its tool set to be multi-location aware (`get_inventory_by_location`, `list_open_pos`, `summarize_sales_by_vendor`). See the "Shopify AI tooling" section above for the rationale.

---

## Verification plan

**Per-module smoke tests** (can be partially automated with Playwright; otherwise manual in the admin):
1. **Foundation:** `flyctl logs` shows no errors on boot; nav renders; location picker shows both store locations.
2. **Product Builder:** create men's tee, 5 sizes × 3 colors, confirm 15 variants in Shopify admin, each with unique SKU + unique barcode; rerun creation form → loads in < 500ms (cache hit).
3. **PO v2:** create 10-line PO in grid view, save, export PDF both layouts, mark ordered, receive 60% via grid, confirm Shopify inventory at target location increases by received qty; verify `InventoryAdjustmentSession` audit row exists.
4. **Scan-to-receive:** open printed PO PDF, scan QR on phone, complete receive flow; verify identical state to step 3.
5. **Inventory Adjust:** grid-adjust 20 SKUs at one location, apply, verify Shopify matches; audit session shows all 20 changes with delta & reason.
6. **Transfer:** create 5-line transfer, mark sent, confirm subtracted at A; mark received, confirm added at B; break mid-flow (kill server after step 1) → recovery UI appears; retry succeeds.
7. **Standalone labels:** print 6 labels for one variant, confirm PDF has 6 correct labels.
8. **Stock count:** create count at location A (>100 variants), count 50, close tab, reopen → 50 still counted, 50+ remaining; finish + apply → Shopify matches counts; variance report accurate.
9. **Planning:** after sales sync, open planning table, filter to one vendor + FW25 tag, edit order qty on 5 rows, "Create PO" → PO draft appears with exactly those 5 lines and quantities.
10. **Production smoke:** deploy to Fly, open the app in Shopify admin, walk through one full real-world workflow (create PO → receive → stock count reconcile).

**Files of record:**
- `/Users/nicholasparente/.claude/plans/bright-wandering-quail.md` (this plan)
- `prisma/schema.prisma` (new schema target)
- `app/services/shopify-api/` (API service layer)
- `app/components/ProductGrid.tsx`, `BarcodeScanInput.tsx`, `LocationPicker.tsx` (shared building blocks)

---

## Build sequence (recommended order)

0. **Register `@shopify/dev-mcp`** in Claude Code settings (5 min) — quality-of-life for the rest of the build; catches bad GraphQL before it ships
1. **Foundation + Schema migration** (1–2 days) — new schema, location/inventory services, shared components
2. **Product Builder v2** (1 day) — incremental on existing code
3. **Barcode Printer standalone** (half day) — reuses label generator
4. **PO v2 — list + create + detail** (2–3 days) — biggest UX lift, grid view is the star
5. **PO v2 — receive + PDF + scan-to-receive** (2 days)
6. **Inventory Adjust** (1 day) — reuses ProductGrid
7. **Inventory Transfer** (1–2 days) — reuses ProductGrid + adjust pattern
8. **Stock Count** (2 days) — unique UI (counted/remaining split), mobile-first
9. **Inventory Planning** (3–4 days) — data pipeline + table + "create PO from selection"
10. **Home + polish + real-world QA** (1–2 days)

Total: ~15–20 build days. We ship the whole thing as V2 once QA passes (per your "fully robust before launch" preference), not module-by-module.

---

## V2.1 roadmap (parked after V2 ships)

These ideas came up during V2 delivery. Noted here so they don't get lost;
none are in the V2 scope.

### Bulk product management — "Products" module
A dedicated screen for viewing + editing many products at once, without
clicking into each one in the Shopify admin.

**Use cases the user called out:**
1. **View & update vendor associations** — see which products belong to a
   vendor, reassign products between vendors in bulk (vendor got renamed,
   rebranded, or consolidated).
2. **Bulk edit COGs (unit cost)** — update inventoryItem.unitCost across a
   selection of variants at once. Necessary when a vendor raises prices
   across a category.
3. **Bulk edit tags** — add/remove a tag on many products at once (e.g. add
   "FW26" to a whole vendor's current order, remove "SS24" from expired
   items, mark a set as "FLW Core").
4. **Bulk archive** — set status = ARCHIVED on many products at once. The
   Stock Count module already surfaces "uncounted / likely dead SKUs" as
   candidates; wire that into a one-click bulk archive from the count
   completion screen.

**UI shape (proposed, not committed):**
- `/app/products` — indexed table of all products with columns: image,
  title, vendor, status, tags, inventory total, COGs, # variants.
- Filters: vendor, status, tag (multi), has-sales (planning data join),
  created-date range.
- Row selection (IndexTable selectable + select-all). An action bar
  appears when ≥ 1 selected with four actions:
  - **Change vendor** — dropdown of existing vendors + "+ add new"
    (mirrors Product Builder pattern).
  - **Set COGs** — number input with "set to $X" or "adjust by ±%" modes;
    optional "only variants where cost is currently $0" filter to avoid
    stomping manual overrides.
  - **Edit tags** — two inputs: "add these tags" and "remove these tags"
    (comma-separated). Applied idempotently across selection.
  - **Archive** — single-click set status=ARCHIVED; confirmation modal
    shows the count and a "keep inventory as-is" note (archived products
    don't push to sales channels but inventory still exists).
- Progress toast for long mutations (100s of products = many GraphQL calls
  batched into groups of 25).
- All operations go through a new bulk action log table so we can audit /
  undo catastrophic edits.

**Schema additions:**
- `ProductBulkActionSession` + `ProductBulkActionChange` (mirror of
  `InventoryAdjustmentSession` / `InventoryAdjustmentChange`) — records
  every (product, field, before, after) so an accidental "set cost to $0
  for everyone" can be reviewed and reversed.
- No product data stored locally beyond audit — Shopify is the source of
  truth; we just update it.

**Shopify APIs needed:**
- `productsBulkMutate` or individual `productUpdate` for vendor/tags (GraphQL
  has a `tagsAdd` / `tagsRemove` pair that's cheaper than replacing).
- `productVariantsBulkUpdate` already imported in `products.server.ts` —
  reuse for COGs via `inventoryItem { cost }` field.
- `productUpdate { status: ARCHIVED }` for bulk archive.
- Batch in groups of 25 to stay under Shopify's 1000 cost points per 60s
  throttle.

**Integration with existing modules:**
- Stock Count completion → "Archive uncounted" button runs this flow.
- Planning table could gain a "retire this SKU" row action that funnels
  into the same audit log.

**Rough estimate:** 2–3 build days after V2 ships.

### Also parked
- **Vendor PO PDF import** — drag-drop a PDF → Claude extracts line items →
  prefill a draft PO (mentioned in Shopify AI tooling section).
- **Category/season aggregate dashboard** — second lens on Planning, above
  the product table.
- **Better OOS modeling** — replace the heuristic daysOOS with real
  inventory history when available.
- **Scan-to-receive auto-sync** — today receipts via the public QR route
  only update the DB; a manager has to sync to Shopify from the admin app.
  Could wire up a follow-up job to sync automatically under a service token.
- **Role-based permissions** — admin vs. store roles (everyone has full
  access in V2).
