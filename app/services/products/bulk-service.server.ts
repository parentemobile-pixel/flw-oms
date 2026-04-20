import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import db from "../../db.server";
import {
  addTags,
  getProductSnapshots,
  removeTags,
  updateProductFields,
  updateVariantCosts,
  type ProductSnapshot,
} from "../shopify-api/products.server";

// Shopify's GraphQL admin API bucket refills at ~50 points/s with a 1000-point
// ceiling. productUpdate is 10 points; tagsAdd/tagsRemove are 10 points each;
// productVariantsBulkUpdate is 10 points regardless of variant count. A batch
// of 25 keeps us well under the ceiling and leaves headroom for concurrent
// use.
const BATCH_SIZE = 25;

export type BulkAction = "change_vendor" | "set_cogs" | "edit_tags" | "archive";

export interface ChangeResult {
  shopifyProductId: string;
  productTitle: string;
  field: string;
  previousValue: string | null;
  newValue: string | null;
  ok: boolean;
  error: string | null;
}

export interface BulkApplyResult {
  sessionId: string;
  totalCount: number;
  okCount: number;
  errorCount: number;
  changes: ChangeResult[];
}

/**
 * Split a list into fixed-size chunks, yielding each chunk as an array.
 */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function writeSession(
  shop: string,
  action: BulkAction,
  notes: string | null,
  createdBy: string | null,
  changes: ChangeResult[],
): Promise<string> {
  const ok = changes.filter((c) => c.ok).length;
  const err = changes.length - ok;
  const session = await db.productBulkActionSession.create({
    data: {
      shop,
      action,
      notes,
      createdBy,
      totalCount: changes.length,
      okCount: ok,
      errorCount: err,
      changes: {
        create: changes.map((c) => ({
          shopifyProductId: c.shopifyProductId,
          productTitle: c.productTitle,
          field: c.field,
          previousValue: c.previousValue,
          newValue: c.newValue,
          ok: c.ok,
          error: c.error,
        })),
      },
    },
  });
  return session.id;
}

/**
 * Fetch a snapshot of all targeted products up-front so the audit log has
 * before-values even if a mid-batch Shopify error changes state.
 */
async function snapshotAll(
  admin: AdminApiContext,
  productIds: string[],
): Promise<Map<string, ProductSnapshot>> {
  const merged = new Map<string, ProductSnapshot>();
  for (const batch of chunk(productIds, 50)) {
    const snap = await getProductSnapshots(admin, batch);
    for (const [k, v] of snap.entries()) merged.set(k, v);
  }
  return merged;
}

/**
 * Bulk vendor reassignment. Writes one productUpdate per product in batches
 * of 25 (the Shopify throttle budget leaves room for this).
 */
export async function bulkChangeVendor(
  admin: AdminApiContext,
  shop: string,
  productIds: string[],
  newVendor: string,
  {
    notes = null,
    createdBy = null,
  }: { notes?: string | null; createdBy?: string | null } = {},
): Promise<BulkApplyResult> {
  const snapshots = await snapshotAll(admin, productIds);
  const changes: ChangeResult[] = [];

  for (const batch of chunk(productIds, BATCH_SIZE)) {
    const results = await Promise.all(
      batch.map(async (pid) => {
        const snap = snapshots.get(pid);
        const before = snap?.vendor ?? null;
        const title = snap?.title ?? "";
        if (before === newVendor) {
          return {
            shopifyProductId: pid,
            productTitle: title,
            field: "vendor",
            previousValue: before,
            newValue: newVendor,
            ok: true,
            error: null,
          } satisfies ChangeResult;
        }
        const res = await updateProductFields(admin, pid, { vendor: newVendor });
        return {
          shopifyProductId: pid,
          productTitle: title,
          field: "vendor",
          previousValue: before,
          newValue: newVendor,
          ok: res.ok,
          error: res.error,
        } satisfies ChangeResult;
      }),
    );
    changes.push(...results);
  }

  const sessionId = await writeSession(shop, "change_vendor", notes, createdBy, changes);
  return summarize(sessionId, changes);
}

/**
 * Bulk archive. Sets status=ARCHIVED via productUpdate. Inventory remains on
 * the products — Shopify just hides them from sales channels.
 */
export async function bulkArchive(
  admin: AdminApiContext,
  shop: string,
  productIds: string[],
  {
    notes = null,
    createdBy = null,
  }: { notes?: string | null; createdBy?: string | null } = {},
): Promise<BulkApplyResult> {
  const snapshots = await snapshotAll(admin, productIds);
  const changes: ChangeResult[] = [];

  for (const batch of chunk(productIds, BATCH_SIZE)) {
    const results = await Promise.all(
      batch.map(async (pid) => {
        const snap = snapshots.get(pid);
        const before = snap?.status ?? null;
        const title = snap?.title ?? "";
        if (before === "ARCHIVED") {
          return {
            shopifyProductId: pid,
            productTitle: title,
            field: "status",
            previousValue: before,
            newValue: "ARCHIVED",
            ok: true,
            error: null,
          } satisfies ChangeResult;
        }
        const res = await updateProductFields(admin, pid, {
          status: "ARCHIVED",
        });
        return {
          shopifyProductId: pid,
          productTitle: title,
          field: "status",
          previousValue: before,
          newValue: "ARCHIVED",
          ok: res.ok,
          error: res.error,
        } satisfies ChangeResult;
      }),
    );
    changes.push(...results);
  }

  const sessionId = await writeSession(shop, "archive", notes, createdBy, changes);
  return summarize(sessionId, changes);
}

/**
 * Bulk edit tags. Applies tagsAdd and tagsRemove in sequence per product so
 * the merge is explicit (add-then-remove semantics). Each call is 10 cost
 * points.
 */
export async function bulkEditTags(
  admin: AdminApiContext,
  shop: string,
  productIds: string[],
  addTagsList: string[],
  removeTagsList: string[],
  {
    notes = null,
    createdBy = null,
  }: { notes?: string | null; createdBy?: string | null } = {},
): Promise<BulkApplyResult> {
  const snapshots = await snapshotAll(admin, productIds);
  const changes: ChangeResult[] = [];

  const cleanAdd = addTagsList.map((t) => t.trim()).filter(Boolean);
  const cleanRemove = removeTagsList.map((t) => t.trim()).filter(Boolean);

  for (const batch of chunk(productIds, BATCH_SIZE)) {
    const results = await Promise.all(
      batch.map(async (pid) => {
        const snap = snapshots.get(pid);
        const before = snap?.tags ?? [];
        const title = snap?.title ?? "";
        // Only send tags that would actually change state.
        const toAdd = cleanAdd.filter((t) => !before.includes(t));
        const toRemove = cleanRemove.filter((t) => before.includes(t));
        if (toAdd.length === 0 && toRemove.length === 0) {
          return {
            shopifyProductId: pid,
            productTitle: title,
            field: "tags",
            previousValue: JSON.stringify(before),
            newValue: JSON.stringify(before),
            ok: true,
            error: null,
          } satisfies ChangeResult;
        }
        const addRes = toAdd.length > 0 ? await addTags(admin, pid, toAdd) : { ok: true, error: null };
        const remRes =
          toRemove.length > 0 && addRes.ok
            ? await removeTags(admin, pid, toRemove)
            : { ok: addRes.ok, error: null };
        const ok = addRes.ok && remRes.ok;
        const errorMessages = [addRes.error, remRes.error].filter(Boolean);
        const after = new Set(before);
        if (ok) {
          for (const t of toAdd) after.add(t);
          for (const t of toRemove) after.delete(t);
        }
        return {
          shopifyProductId: pid,
          productTitle: title,
          field: "tags",
          previousValue: JSON.stringify(before),
          newValue: JSON.stringify([...after]),
          ok,
          error: errorMessages.length > 0 ? errorMessages.join("; ") : null,
        } satisfies ChangeResult;
      }),
    );
    changes.push(...results);
  }

  const sessionId = await writeSession(shop, "edit_tags", notes, createdBy, changes);
  return summarize(sessionId, changes);
}

export type CogsMode =
  | { kind: "set"; value: number }
  | { kind: "adjust_percent"; percent: number };

/**
 * Bulk set COGs (unit cost). Applies to every variant on each selected
 * product. Two modes:
 *   - set: unconditional absolute $ value
 *   - adjust_percent: multiplicative (+/- %) against the variant's current
 *     cost; variants with no current cost are skipped
 *
 * onlyWhereZero: if true, only variants where unitCost is currently null or 0
 * get updated. Useful to backfill without stomping manual overrides.
 */
export async function bulkSetCogs(
  admin: AdminApiContext,
  shop: string,
  productIds: string[],
  mode: CogsMode,
  {
    onlyWhereZero = false,
    notes = null,
    createdBy = null,
  }: {
    onlyWhereZero?: boolean;
    notes?: string | null;
    createdBy?: string | null;
  } = {},
): Promise<BulkApplyResult> {
  const snapshots = await snapshotAll(admin, productIds);
  const changes: ChangeResult[] = [];

  for (const batch of chunk(productIds, BATCH_SIZE)) {
    const results = await Promise.all(
      batch.map(async (pid) => {
        const snap = snapshots.get(pid);
        const title = snap?.title ?? "";
        if (!snap || snap.variants.length === 0) {
          return {
            shopifyProductId: pid,
            productTitle: title,
            field: "cost",
            previousValue: null,
            newValue: null,
            ok: true,
            error: null,
          } satisfies ChangeResult;
        }
        const targets = snap.variants
          .filter((v) => {
            if (onlyWhereZero) {
              return v.unitCost === null || v.unitCost === 0;
            }
            return true;
          })
          .map((v) => {
            let nextCost: number | null = null;
            if (mode.kind === "set") {
              nextCost = mode.value;
            } else if (mode.kind === "adjust_percent") {
              if (v.unitCost === null) return null;
              nextCost = v.unitCost * (1 + mode.percent / 100);
            }
            if (nextCost === null || !Number.isFinite(nextCost)) return null;
            const rounded = Math.max(0, Math.round(nextCost * 100) / 100);
            return { id: v.id, cost: rounded };
          })
          .filter((x): x is { id: string; cost: number } => !!x);

        const before = snap.variants
          .map((v) => (v.unitCost !== null ? v.unitCost.toFixed(2) : "null"))
          .join(",");
        const after = targets.map((t) => t.cost.toFixed(2)).join(",");

        if (targets.length === 0) {
          return {
            shopifyProductId: pid,
            productTitle: title,
            field: "cost",
            previousValue: before,
            newValue: before,
            ok: true,
            error: null,
          } satisfies ChangeResult;
        }

        const res = await updateVariantCosts(admin, pid, targets);
        return {
          shopifyProductId: pid,
          productTitle: title,
          field: "cost",
          previousValue: before,
          newValue: after,
          ok: res.ok,
          error: res.error,
        } satisfies ChangeResult;
      }),
    );
    changes.push(...results);
  }

  const sessionId = await writeSession(shop, "set_cogs", notes, createdBy, changes);
  return summarize(sessionId, changes);
}

function summarize(sessionId: string, changes: ChangeResult[]): BulkApplyResult {
  const ok = changes.filter((c) => c.ok).length;
  return {
    sessionId,
    totalCount: changes.length,
    okCount: ok,
    errorCount: changes.length - ok,
    changes,
  };
}

/**
 * Recent sessions for the Products page sidebar.
 */
export async function getRecentBulkSessions(shop: string, limit = 10) {
  return db.productBulkActionSession.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { _count: { select: { changes: true } } },
  });
}
