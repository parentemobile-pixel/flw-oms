import db from "../../db.server";

/**
 * Simple key-value cache for slow Shopify metadata queries (vendors,
 * publications, metafield defs, locations, existing option values).
 *
 * Backed by the ShopifyCache Prisma model. Entries expire via `expiresAt`.
 * On a cache miss or expiry we call the fetcher, persist the result, and
 * return it. Errors from the fetcher propagate (caller decides fallback).
 */
export async function getCached<T>(
  shop: string,
  key: string,
  ttlMinutes: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const row = await db.shopifyCache.findUnique({
    where: { shop_key: { shop, key } },
  });

  if (row && row.expiresAt.getTime() > Date.now()) {
    try {
      return JSON.parse(row.value) as T;
    } catch {
      // Corrupt JSON — fall through to refresh
    }
  }

  const fresh = await fetcher();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  await db.shopifyCache.upsert({
    where: { shop_key: { shop, key } },
    create: { shop, key, value: JSON.stringify(fresh), expiresAt },
    update: { value: JSON.stringify(fresh), expiresAt },
  });

  return fresh;
}

/**
 * Force-invalidate one or more cache keys. Used when the user explicitly
 * refreshes (e.g. a "Refresh" button) or when a mutation invalidates state.
 */
export async function invalidateCache(shop: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.shopifyCache.deleteMany({
    where: { shop, key: { in: keys } },
  });
}

/** Convenience TTLs (in minutes) */
export const CACHE_TTL = {
  VENDORS: 60,
  PUBLICATIONS: 60 * 12, // rarely changes
  METAFIELD_DEFINITIONS: 60 * 12,
  LOCATIONS: 60 * 24, // almost never changes
  OPTION_VALUES: 60,
} as const;

/** Standard cache keys — using constants keeps usages consistent */
export const CACHE_KEYS = {
  VENDORS: "vendors",
  PUBLICATIONS: "publications",
  METAFIELD_DEFINITIONS: "metafield_definitions",
  LOCATIONS: "locations",
  OPTION_VALUES: "option_values",
} as const;
