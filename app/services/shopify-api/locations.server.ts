import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import db from "../../db.server";
import {
  CACHE_KEYS,
  getCached,
  invalidateCache,
} from "../cache/shopify-cache.server";

export interface Location {
  id: string; // gid://shopify/Location/xxx
  name: string;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
  address: {
    city: string | null;
    province: string | null;
    country: string | null;
  };
}

const LOCATIONS_QUERY = `#graphql
  query GetLocations($first: Int!) {
    locations(first: $first, includeInactive: false) {
      edges {
        node {
          id
          name
          isActive
          fulfillsOnlineOrders
          address {
            city
            province
            country
          }
        }
      }
    }
  }
`;

/**
 * Fetches active Shopify locations for the shop.
 *
 * Cached with a SHORT TTL (15 min) rather than 24h because missing-scope
 * errors used to get stuck in the cache for a day after the scope was
 * granted. Locations change rarely enough that 15 min is still plenty.
 *
 * Empty results are NOT cached — if the Shopify response returns zero
 * locations (almost always a scope/error issue masquerading as empty data),
 * we re-query next call so the user isn't stuck with an empty dropdown.
 *
 * All errors are logged loudly so they appear in Fly logs where we can
 * see them.
 */
export async function getLocations(
  admin: AdminApiContext,
  shop: string,
): Promise<Location[]> {
  const fetcher = async (): Promise<Location[]> => {
    const response = await admin.graphql(LOCATIONS_QUERY, {
      variables: { first: 20 },
    });
    const body = (await response.json()) as {
      data?: { locations?: { edges?: Array<{ node: Location }> } };
      errors?: Array<{ message: string; extensions?: unknown }>;
    };

    if (body.errors && body.errors.length > 0) {
      const msg = body.errors.map((e) => e.message).join("; ");
      console.error("[getLocations] Shopify returned errors:", msg);
      // Re-throw so the caller's try/catch can decide what to do.
      throw new Error(`locations query failed: ${msg}`);
    }

    const edges = body.data?.locations?.edges ?? [];
    if (edges.length === 0) {
      console.warn(
        "[getLocations] Zero locations returned. This usually means the " +
          "app is missing the read_locations scope — run `shopify app " +
          "deploy` and re-accept permissions in the Shopify admin.",
      );
    }
    return edges.map((edge) => edge.node);
  };

  try {
    const result = await getCached<Location[]>(
      shop,
      CACHE_KEYS.LOCATIONS,
      15, // 15-min TTL instead of 24h
      fetcher,
    );
    // Don't let an empty result sit in the cache — clear it so the next
    // call re-fetches (useful right after the merchant grants scope).
    if (result.length === 0) {
      await invalidateCache(shop, [CACHE_KEYS.LOCATIONS]).catch(() => {});
    }
    return result;
  } catch (error) {
    console.error("[getLocations] failed:", error);
    // Also invalidate any cached entry so next call retries.
    await invalidateCache(shop, [CACHE_KEYS.LOCATIONS]).catch(() => {});
    return [];
  }
}

/** Convenience lookup by ID. */
export async function getLocationById(
  admin: AdminApiContext,
  shop: string,
  locationId: string,
): Promise<Location | null> {
  const locations = await getLocations(admin, shop);
  return locations.find((l) => l.id === locationId) ?? null;
}

/**
 * Returns the default fallback location — the first online-fulfilling
 * active location, or the first location as last resort.
 */
export async function getDefaultLocation(
  admin: AdminApiContext,
  shop: string,
): Promise<Location | null> {
  const locations = await getLocations(admin, shop);
  if (locations.length === 0) return null;
  const online = locations.find((l) => l.fulfillsOnlineOrders && l.isActive);
  if (online) return online;
  const anyActive = locations.find((l) => l.isActive);
  return anyActive ?? locations[0];
}

/**
 * Force-refresh the locations cache for a shop. Used after scope changes
 * or if the merchant adds a new location and wants to see it immediately.
 */
export async function invalidateLocationsCache(shop: string): Promise<void> {
  await db.shopifyCache
    .deleteMany({ where: { shop, key: CACHE_KEYS.LOCATIONS } })
    .catch(() => {});
}
