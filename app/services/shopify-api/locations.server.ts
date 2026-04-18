import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import {
  CACHE_KEYS,
  CACHE_TTL,
  getCached,
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

interface LocationsQueryResponse {
  data: {
    locations: {
      edges: Array<{ node: Location }>;
    };
  };
}

/**
 * Fetches active Shopify locations for the shop, cached aggressively —
 * locations change very rarely.
 */
export async function getLocations(
  admin: AdminApiContext,
  shop: string,
): Promise<Location[]> {
  return getCached(shop, CACHE_KEYS.LOCATIONS, CACHE_TTL.LOCATIONS, async () => {
    const response = await admin.graphql(LOCATIONS_QUERY, {
      variables: { first: 20 },
    });
    const body = (await response.json()) as LocationsQueryResponse;
    return body.data.locations.edges.map((edge) => edge.node);
  });
}

/**
 * Convenience lookup by ID. Does NOT hit the network if the cache is warm.
 */
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
