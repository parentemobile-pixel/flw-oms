import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { getVariantsInventory } from "../shopify-api/inventory.server";

/**
 * Walk the catalog with an optional (name search + tags) filter, join
 * inventory at a single location, and return per-variant on-hand for
 * anything with stock > 0 at that location.
 *
 * Server-side filtering via the products(query:...) argument is the
 * scalable half — Shopify prunes the result set before we walk it.
 * Location filtering has to happen after we fetch inventory levels,
 * since Shopify has no built-in "products with inventory at X" query.
 */

// Lean products walk — id, title, variants(id, title, sku, options).
// Inventory levels come through the shared getVariantsInventory helper.
const ON_HAND_PRODUCTS_QUERY = `#graphql
  query OnHandProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: TITLE) {
      edges {
        node {
          id
          title
          vendor
          productType
          featuredImage { url altText }
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                selectedOptions { name value }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface RawProduct {
  id: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  featuredImage: { url: string; altText: string | null } | null;
  variants: {
    edges: Array<{
      node: {
        id: string;
        title: string;
        sku: string | null;
        selectedOptions: Array<{ name: string; value: string }>;
      };
    }>;
  };
}

export interface OnHandCell {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  selectedOptions: Array<{ name: string; value: string }>;
  onHand: number;
}

export interface OnHandResult {
  cells: OnHandCell[];
  productCount: number;
  variantCount: number;
  totalUnits: number;
  /** True when Shopify truncated the walk at the internal page cap. */
  truncated: boolean;
}

/**
 * Build a Shopify products search query from a free-text name filter
 * and a set of tags. Everything is AND-joined — tags narrow, not
 * broaden. Empty search / empty tags → returns all products (Shopify
 * treats an empty query as unfiltered).
 */
export function buildProductsSearchQuery(
  search: string,
  tags: string[],
): string {
  const parts: string[] = [];
  const trimmedSearch = search.trim();
  if (trimmedSearch) {
    // title:*foo* matches any product whose title contains "foo".
    // Shopify uses '*' for wildcard on title matches.
    const escaped = trimmedSearch.replace(/["\\]/g, "");
    parts.push(`title:*${escaped}*`);
  }
  for (const tag of tags) {
    const escaped = tag.replace(/["\\]/g, "");
    parts.push(`tag:'${escaped}'`);
  }
  // Only fetch products currently in ACTIVE status — draft/archived
  // aren't sellable so their on-hand isn't meaningful for the view.
  parts.push("status:active");
  return parts.join(" AND ");
}

// Backstop only — Shopify's own pagination + throttle limits govern
// how far the walk goes in practice. The cap here is high enough to
// cover essentially any real shop's active catalog; if it ever fires,
// the truncation banner tells the user to filter down. Bumped from
// 500 to 5000 after the initial cap turned out to be too tight.
const MAX_PRODUCTS_PER_QUERY = 5000;

export async function fetchOnHandAtLocation(
  admin: AdminApiContext,
  options: {
    locationGid: string;
    search: string;
    tags: string[];
  },
): Promise<OnHandResult> {
  const query = buildProductsSearchQuery(options.search, options.tags);

  // Pass 1: walk products matching the filter.
  const products: RawProduct[] = [];
  let after: string | null = null;
  let hasNext = true;
  let truncated = false;
  while (hasNext) {
    if (products.length >= MAX_PRODUCTS_PER_QUERY) {
      truncated = true;
      break;
    }
    const response = await admin.graphql(ON_HAND_PRODUCTS_QUERY, {
      variables: { first: 100, after, query },
    });
    const body = (await response.json()) as {
      data?: {
        products?: {
          edges: Array<{ node: RawProduct }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };
    const page = body.data?.products;
    if (!page) break;
    for (const edge of page.edges) products.push(edge.node);
    hasNext = page.pageInfo.hasNextPage;
    after = page.pageInfo.endCursor;
  }

  // Pass 2: inventory levels for every variant, batched by the helper.
  const variantIds: string[] = [];
  const variantMeta = new Map<
    string,
    {
      productId: string;
      productTitle: string;
      variantTitle: string;
      sku: string | null;
      selectedOptions: Array<{ name: string; value: string }>;
    }
  >();
  for (const p of products) {
    for (const vEdge of p.variants.edges) {
      const v = vEdge.node;
      variantIds.push(v.id);
      variantMeta.set(v.id, {
        productId: p.id,
        productTitle: p.title,
        variantTitle: v.title,
        sku: v.sku,
        selectedOptions: v.selectedOptions ?? [],
      });
    }
  }
  const invMap = await getVariantsInventory(admin, variantIds);

  // Filter to variants with stock > 0 at the target location.
  const cells: OnHandCell[] = [];
  const productsWithStock = new Set<string>();
  let totalUnits = 0;
  for (const [variantId, inv] of invMap.entries()) {
    const level = inv.levels.find((l) => l.locationId === options.locationGid);
    const available = level?.quantities.available ?? 0;
    if (available <= 0) continue;
    const meta = variantMeta.get(variantId);
    if (!meta) continue;
    cells.push({
      variantId,
      productId: meta.productId,
      productTitle: meta.productTitle,
      variantTitle: meta.variantTitle,
      sku: meta.sku,
      selectedOptions: meta.selectedOptions,
      onHand: available,
    });
    productsWithStock.add(meta.productId);
    totalUnits += available;
  }

  return {
    cells,
    productCount: productsWithStock.size,
    variantCount: cells.length,
    totalUnits,
    truncated,
  };
}
