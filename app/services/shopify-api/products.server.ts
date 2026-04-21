import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import {
  CACHE_KEYS,
  CACHE_TTL,
  getCached,
  invalidateCache,
} from "../cache/shopify-cache.server";
import { generateBarcodeForVariant } from "./barcodes.server";

const PRODUCTS_QUERY = `#graphql
  query GetProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      edges {
        node {
          id
          title
          vendor
          productType
          status
          totalInventory
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                barcode
                price
                compareAtPrice
                inventoryQuantity
                inventoryItem {
                  id
                  unitCost {
                    amount
                    currencyCode
                  }
                }
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
          featuredImage {
            url
            altText
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export async function getProducts(
  admin: AdminApiContext,
  { first = 25, after, query }: { first?: number; after?: string; query?: string } = {},
) {
  const response = await admin.graphql(PRODUCTS_QUERY, {
    variables: { first, after: after || null, query: query || null },
  });
  const data = await response.json();
  return data.data.products;
}

// Preferred source: Shopify's `shop.productVendors` connection — a
// StringConnection of every unique vendor string in the shop. Uses the
// `nodes` shortcut (no edge wrapper) for brevity. Requires `read_products`.
const VENDORS_PRIMARY_QUERY = `#graphql
  query GetVendors($first: Int!, $after: String) {
    shop {
      productVendors(first: $first, after: $after) {
        nodes
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

// Fallback: walk the product catalog and collect unique vendor fields.
// Used when the primary query fails (wrong scope, API change, etc.).
// Paginates so it's not limited to 250 products.
const VENDORS_FALLBACK_QUERY = `#graphql
  query GetVendorsFallback($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      edges { node { vendor } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function fetchVendorsPrimary(
  admin: AdminApiContext,
): Promise<string[]> {
  const vendors: string[] = [];
  let after: string | null = null;
  let hasNext = true;
  while (hasNext) {
    const response = await admin.graphql(VENDORS_PRIMARY_QUERY, {
      variables: { first: 250, after },
    });
    const body = (await response.json()) as {
      data?: {
        shop?: {
          productVendors?: {
            nodes?: string[];
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
      errors?: Array<{ message: string; extensions?: unknown }>;
    };
    if (body.errors && body.errors.length > 0) {
      const msg = body.errors.map((e) => e.message).join("; ");
      console.error("[getVendors] shop.productVendors errors:", msg);
      throw new Error(msg);
    }
    const pv = body.data?.shop?.productVendors;
    if (!pv) {
      console.warn(
        "[getVendors] shop.productVendors missing from response — " +
          "schema might have changed or scope is wrong.",
      );
      throw new Error("missing data.shop.productVendors");
    }
    for (const v of pv.nodes ?? []) {
      if (v) vendors.push(v);
    }
    hasNext = pv.pageInfo?.hasNextPage ?? false;
    after = pv.pageInfo?.endCursor ?? null;
  }
  return [...new Set(vendors)].filter(Boolean).sort();
}

async function fetchVendorsFallback(
  admin: AdminApiContext,
): Promise<string[]> {
  const vendors: string[] = [];
  let after: string | null = null;
  let hasNext = true;
  let pages = 0;
  while (hasNext && pages < 20) {
    pages++;
    const response = await admin.graphql(VENDORS_FALLBACK_QUERY, {
      variables: { first: 250, after },
    });
    const body = (await response.json()) as any;
    const page = body?.data?.products;
    if (!page) break;
    for (const edge of page.edges ?? []) {
      if (edge?.node?.vendor) vendors.push(edge.node.vendor);
    }
    hasNext = page.pageInfo?.hasNextPage ?? false;
    after = page.pageInfo?.endCursor ?? null;
  }
  return [...new Set(vendors)].filter(Boolean).sort();
}

export async function getVendors(
  admin: AdminApiContext,
  shop?: string,
): Promise<string[]> {
  const fetcher = async (): Promise<string[]> => {
    // Try the authoritative source first.
    try {
      const vendors = await fetchVendorsPrimary(admin);
      console.log(
        `[getVendors] shop.productVendors returned ${vendors.length} vendors`,
      );
      if (vendors.length > 0) return vendors;
      // Empty — odd, fall through to the product-scan fallback so a
      // freshly installed shop with products but no named vendors still
      // produces something (though usually empty is genuinely empty).
      console.warn(
        "[getVendors] shop.productVendors returned 0 — trying fallback",
      );
    } catch (error) {
      console.warn(
        "[getVendors] primary failed, falling back to product scan:",
        error,
      );
    }
    const vendors = await fetchVendorsFallback(admin);
    console.log(
      `[getVendors] fallback product-scan returned ${vendors.length} vendors`,
    );
    return vendors;
  };

  // Cached path (preferred). Falls back to direct fetch if no shop given.
  if (shop) {
    try {
      return await getCached(shop, CACHE_KEYS.VENDORS, CACHE_TTL.VENDORS, fetcher);
    } catch (error) {
      console.error("Failed to fetch vendors (cached):", error);
      return [];
    }
  }
  try {
    return await fetcher();
  } catch (error) {
    console.error("Failed to fetch vendors:", error);
    return [];
  }
}

// Fetch available sales channels / publications
const PUBLICATIONS_QUERY = `#graphql
  query GetPublications($first: Int!) {
    publications(first: $first) {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

export interface Publication {
  id: string;
  name: string;
}

export async function getPublications(
  admin: AdminApiContext,
  shop?: string,
): Promise<Publication[]> {
  const fetcher = async () => {
    const response = await admin.graphql(PUBLICATIONS_QUERY, {
      variables: { first: 50 },
    });
    const data = await response.json();
    return data.data.publications.edges.map(
      (edge: { node: Publication }) => edge.node,
    );
  };
  if (shop) {
    try {
      return await getCached(
        shop,
        CACHE_KEYS.PUBLICATIONS,
        CACHE_TTL.PUBLICATIONS,
        fetcher,
      );
    } catch (error) {
      console.error("Failed to fetch publications (cached):", error);
      return [];
    }
  }
  try {
    return await fetcher();
  } catch (error) {
    console.error("Failed to fetch publications:", error);
    return [];
  }
}

// Publish a product to selected sales channels
const PUBLISHABLE_PUBLISH_MUTATION = `#graphql
  mutation PublishProduct($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      publishable {
        ... on Product {
          id
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PUBLISHABLE_UNPUBLISH_MUTATION = `#graphql
  mutation UnpublishProduct($id: ID!, $input: [PublicationInput!]!) {
    publishableUnpublish(id: $id, input: $input) {
      publishable {
        ... on Product {
          id
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function publishProductToChannels(
  admin: AdminApiContext,
  productId: string,
  publicationIds: string[],
) {
  const results = [];
  for (const pubId of publicationIds) {
    try {
      const response = await admin.graphql(PUBLISHABLE_PUBLISH_MUTATION, {
        variables: {
          id: productId,
          input: [{ publicationId: pubId }],
        },
      });
      const data = await response.json();
      results.push(data.data.publishablePublish);
    } catch (error) {
      console.error(`Failed to publish to ${pubId}:`, error);
    }
  }
  return results;
}

// Fetch standard metafield definitions for products
const METAFIELD_DEFINITIONS_QUERY = `#graphql
  query GetMetafieldDefinitions {
    metafieldDefinitions(first: 50, ownerType: PRODUCT) {
      edges {
        node {
          id
          name
          namespace
          key
          type {
            name
          }
          description
          validations {
            name
            value
          }
        }
      }
    }
  }
`;

export interface MetafieldDefinition {
  id: string;
  name: string;
  namespace: string;
  key: string;
  type: string;
  description: string | null;
  validations: Array<{ name: string; value: string }>;
}

export async function getMetafieldDefinitions(
  admin: AdminApiContext,
  shop?: string,
): Promise<MetafieldDefinition[]> {
  const fetcher = async () => {
    const response = await admin.graphql(METAFIELD_DEFINITIONS_QUERY);
    const data = await response.json();
    return data.data.metafieldDefinitions.edges.map(
      (edge: {
        node: {
          id: string;
          name: string;
          namespace: string;
          key: string;
          type: { name: string };
          description: string | null;
          validations: Array<{ name: string; value: string }>;
        };
      }) => ({
        ...edge.node,
        type: edge.node.type.name,
      }),
    );
  };
  if (shop) {
    try {
      return await getCached(
        shop,
        CACHE_KEYS.METAFIELD_DEFINITIONS,
        CACHE_TTL.METAFIELD_DEFINITIONS,
        fetcher,
      );
    } catch (error) {
      console.error("Failed to fetch metafield definitions (cached):", error);
      return [];
    }
  }
  try {
    return await fetcher();
  } catch (error) {
    console.error("Failed to fetch metafield definitions:", error);
    return [];
  }
}

const PRODUCT_SET_MUTATION = `#graphql
  mutation ProductSet($input: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $input, synchronous: $synchronous) {
      product {
        id
        title
        handle
        variants(first: 100) {
          edges {
            node {
              id
              title
              sku
              barcode
              price
              selectedOptions {
                name
                value
              }
            }
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export interface ProductOption {
  name: string;
  values: string[];
}

export interface MetafieldInput {
  namespace: string;
  key: string;
  value: string;
  type: string;
}

export interface CreateProductInput {
  title: string;
  vendor: string;
  options: ProductOption[];
  price: string;
  cost?: string;
  skuPrefix?: string;
  metafields?: MetafieldInput[];
  imageUrl?: string;
  tags?: string[];
  /**
   * If true, auto-generate a deterministic FLW barcode per variant after
   * creation. Default: true.
   */
  generateBarcodes?: boolean;
  /**
   * Optional: set initial on-hand inventory per (variant, location) after
   * creation. Keys into the combinations produced by `generateVariantCombinations`,
   * i.e. values are arrays aligned with active options. Skipped if undefined
   * or empty.
   *
   * Shape: Record<variantOptionKey, Record<locationId, quantity>>
   * where variantOptionKey = activeOption values joined by "/" (e.g. "M/Red").
   */
  initialInventory?: Record<string, Record<string, number>>;
  /**
   * Shop domain — optional, but when provided we invalidate the metadata
   * caches (vendors, option values) after successful creation so the next
   * Product Builder page load reflects the new vendor / option values.
   */
  shop?: string;
}

const PRODUCT_VARIANTS_BULK_UPDATE_MUTATION = `#graphql
  mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        barcode
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Generate all combinations of option values
function generateVariantCombinations(options: ProductOption[]): Array<Array<{ optionName: string; name: string }>> {
  if (options.length === 0) return [[]];

  const [first, ...rest] = options;
  const restCombinations = generateVariantCombinations(rest);

  const combinations: Array<Array<{ optionName: string; name: string }>> = [];
  for (const value of first.values) {
    for (const restCombo of restCombinations) {
      combinations.push([{ optionName: first.name, name: value }, ...restCombo]);
    }
  }
  return combinations;
}

export async function createProduct(admin: AdminApiContext, input: CreateProductInput) {
  // Filter out options with no values
  const activeOptions = input.options.filter((opt) => opt.values.length > 0);

  // Generate variant combinations
  const combos = generateVariantCombinations(activeOptions);

  // Parse cost once so every variant gets the same unit cost (cost is
  // per-product in our UI, not per-variant). productSet accepts it on
  // inventoryItem.cost.
  const parsedCost =
    input.cost != null && input.cost !== ""
      ? parseFloat(input.cost)
      : null;

  const variants = combos.map((combo) => {
    // Build SKU from prefix + option values
    let sku: string | undefined;
    if (input.skuPrefix) {
      const parts = combo.map((c) => c.name.toUpperCase().replace(/\s+/g, ""));
      sku = [input.skuPrefix, ...parts].join("-");
    }

    return {
      optionValues: combo,
      price: parseFloat(input.price),
      ...(sku ? { sku } : {}),
      ...(parsedCost != null && Number.isFinite(parsedCost) && parsedCost >= 0
        ? { inventoryItem: { cost: parsedCost.toFixed(2) } }
        : {}),
    };
  });

  const productSetInput: Record<string, unknown> = {
    title: input.title,
    vendor: input.vendor,
    ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    ...(activeOptions.length > 0
      ? {
          productOptions: activeOptions.map((opt) => ({
            name: opt.name,
            values: opt.values.map((v) => ({ name: v })),
          })),
          variants,
        }
      : {}),
    ...(input.metafields && input.metafields.length > 0
      ? {
          metafields: input.metafields.map((mf) => ({
            namespace: mf.namespace,
            key: mf.key,
            value: mf.value,
            type: mf.type,
          })),
        }
      : {}),
    ...(input.imageUrl
      ? {
          files: [{
            originalSource: input.imageUrl,
            contentType: "IMAGE",
          }],
        }
      : {}),
  };

  const response = await admin.graphql(PRODUCT_SET_MUTATION, {
    variables: { input: productSetInput, synchronous: true },
  });

  const data = await response.json();
  const result = data.data.productSet;

  // Post-create steps: generate barcodes + set initial inventory.
  // If either fails, we log but don't fail the whole creation — the product
  // was created successfully and the user can retry these as follow-up actions.
  const product = result?.product;
  const userErrors = result?.userErrors ?? [];
  if (userErrors.length === 0 && product?.variants?.edges) {
    const variantEdges = product.variants.edges as Array<{
      node: {
        id: string;
        inventoryItem?: { id: string };
        selectedOptions: Array<{ name: string; value: string }>;
      };
    }>;

    // 1. Auto-generate barcodes (default on)
    if (input.generateBarcodes !== false && variantEdges.length > 0) {
      try {
        const variantsPayload = variantEdges.map((edge) => ({
          id: edge.node.id,
          barcode: generateBarcodeForVariant(edge.node.id),
        }));
        await admin.graphql(PRODUCT_VARIANTS_BULK_UPDATE_MUTATION, {
          variables: {
            productId: product.id,
            variants: variantsPayload,
          },
        });
      } catch (error) {
        console.error("Failed to auto-generate barcodes:", error);
      }
    }

    // 2. Set initial inventory (if provided)
    if (
      input.initialInventory &&
      Object.keys(input.initialInventory).length > 0
    ) {
      try {
        // Re-fetch variants to pick up inventoryItem.id (not always returned by productSet)
        const withInv = await getProductVariantsWithInventoryItems(
          admin,
          product.id,
        );
        const { adjustInventoryBatch } = await import("./inventory.server");
        const changes: Array<{
          inventoryItemId: string;
          locationId: string;
          delta: number;
        }> = [];
        for (const variant of withInv) {
          const key = variant.selectedOptions
            .map((o) => o.value)
            .join("/");
          const perLocation = input.initialInventory[key];
          if (!perLocation) continue;
          for (const [locationId, qty] of Object.entries(perLocation)) {
            if (qty && qty > 0) {
              changes.push({
                inventoryItemId: variant.inventoryItemId,
                locationId,
                delta: qty,
              });
            }
          }
        }
        if (changes.length > 0) {
          await adjustInventoryBatch(admin, changes, "received");
        }
      } catch (error) {
        console.error("Failed to set initial inventory:", error);
      }
    }

    // Invalidate vendors + option-value caches so a newly-added vendor or a
    // new option value shows up on the NEXT Product Builder load instead of
    // waiting the full cache TTL. Best-effort, ignore failures.
    if (input.shop) {
      await invalidateCache(input.shop, [
        CACHE_KEYS.VENDORS,
        CACHE_KEYS.OPTION_VALUES,
      ]).catch(() => {});
    }
  }

  return result;
}

// Small helper: fetch variant inventoryItem.id for a newly-created product.
// Used by createProduct's initial-inventory step.
const PRODUCT_VARIANTS_WITH_INV_QUERY = `#graphql
  query ProductVariantsWithInv($id: ID!) {
    product(id: $id) {
      variants(first: 100) {
        edges {
          node {
            id
            selectedOptions { name value }
            inventoryItem { id }
          }
        }
      }
    }
  }
`;

async function getProductVariantsWithInventoryItems(
  admin: AdminApiContext,
  productId: string,
): Promise<
  Array<{
    id: string;
    inventoryItemId: string;
    selectedOptions: Array<{ name: string; value: string }>;
  }>
> {
  const response = await admin.graphql(PRODUCT_VARIANTS_WITH_INV_QUERY, {
    variables: { id: productId },
  });
  const data = await response.json();
  const edges = data.data?.product?.variants?.edges ?? [];
  return edges.map((e: any) => ({
    id: e.node.id,
    inventoryItemId: e.node.inventoryItem.id,
    selectedOptions: e.node.selectedOptions,
  }));
}

const SEARCH_PRODUCTS_QUERY = `#graphql
  query SearchProducts($query: String!) {
    products(first: 25, query: $query) {
      edges {
        node {
          id
          title
          vendor
          featuredImage {
            url
            altText
          }
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                barcode
                price
                inventoryQuantity
                inventoryItem {
                  id
                  unitCost {
                    amount
                    currencyCode
                  }
                }
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Fetch existing option values (Size, Color, etc.) from store products
const EXISTING_OPTIONS_QUERY = `#graphql
  query GetExistingOptions($first: Int!) {
    products(first: $first) {
      edges {
        node {
          options {
            name
            values
          }
        }
      }
    }
  }
`;

export interface ExistingOptionValues {
  [optionName: string]: string[];
}

export async function getExistingOptionValues(
  admin: AdminApiContext,
  shop?: string,
): Promise<ExistingOptionValues> {
  const fetcher = async () => {
    const response = await admin.graphql(EXISTING_OPTIONS_QUERY, {
      variables: { first: 250 },
    });
    const data = await response.json();
    const result: ExistingOptionValues = {};
    for (const edge of data.data.products.edges) {
      for (const option of edge.node.options) {
        const name = option.name;
        if (!result[name]) result[name] = [];
        for (const val of option.values) {
          if (!result[name].includes(val)) {
            result[name].push(val);
          }
        }
      }
    }
    for (const key of Object.keys(result)) {
      result[key].sort();
    }
    return result;
  };
  if (shop) {
    try {
      return await getCached(
        shop,
        CACHE_KEYS.OPTION_VALUES,
        CACHE_TTL.OPTION_VALUES,
        fetcher,
      );
    } catch (error) {
      console.error("Failed to fetch existing option values (cached):", error);
      return {};
    }
  }
  try {
    return await fetcher();
  } catch (error) {
    console.error("Failed to fetch existing option values:", error);
    return {};
  }
}

// Upload a staged image for product creation
const STAGED_UPLOADS_MUTATION = `#graphql
  mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function createStagedUpload(admin: AdminApiContext, filename: string, mimeType: string, fileSize: string) {
  const response = await admin.graphql(STAGED_UPLOADS_MUTATION, {
    variables: {
      input: [{
        filename,
        mimeType,
        httpMethod: "POST",
        resource: "IMAGE",
        fileSize,
      }],
    },
  });
  const data = await response.json();
  return data.data.stagedUploadsCreate.stagedTargets[0];
}

export async function searchProducts(admin: AdminApiContext, query: string) {
  const response = await admin.graphql(SEARCH_PRODUCTS_QUERY, {
    variables: { query },
  });
  const data = await response.json();
  return data.data.products;
}

// Search products filtered by vendor with typeahead
export async function searchProductsByVendor(admin: AdminApiContext, vendor: string, titleQuery?: string) {
  // Build Shopify search query: filter by vendor, optionally by title
  let query = `vendor:"${vendor}"`;
  if (titleQuery && titleQuery.trim()) {
    query += ` AND title:*${titleQuery.trim()}*`;
  }

  const response = await admin.graphql(SEARCH_PRODUCTS_QUERY, {
    variables: { query },
  });
  const data = await response.json();
  return data.data.products;
}

// ============================================
// BULK PRODUCT MANAGEMENT (V2.1 Products module)
// ============================================

// Rich product listing used by the /app/products table. Pulls vendor, status,
// tags, totalInventory, featured image, and unit cost per variant (for the
// COGs column and audit-log "before" snapshots).
const LIST_PRODUCTS_QUERY = `#graphql
  query ListProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: TITLE) {
      edges {
        cursor
        node {
          id
          title
          handle
          vendor
          status
          tags
          totalInventory
          createdAt
          featuredImage { url altText }
          variants(first: 100) {
            edges {
              node {
                id
                sku
                inventoryItem {
                  id
                  unitCost { amount currencyCode }
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export interface ListedProduct {
  id: string;
  title: string;
  handle: string;
  vendor: string | null;
  status: string;
  tags: string[];
  totalInventory: number;
  createdAt: string;
  imageUrl: string | null;
  variantCount: number;
  // Average unit cost across variants with a non-null cost. Null if no variant
  // has a cost set.
  avgUnitCost: number | null;
  variants: Array<{
    id: string;
    sku: string | null;
    inventoryItemId: string;
    unitCost: number | null;
  }>;
}

export async function listProducts(
  admin: AdminApiContext,
  {
    first = 50,
    after,
    query,
  }: { first?: number; after?: string | null; query?: string | null } = {},
): Promise<{
  products: ListedProduct[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}> {
  const response = await admin.graphql(LIST_PRODUCTS_QUERY, {
    variables: { first, after: after ?? null, query: query || null },
  });
  const data = await response.json();
  const edges = data.data?.products?.edges ?? [];
  const products: ListedProduct[] = edges.map((edge: any) => {
    const node = edge.node;
    const vEdges = node.variants?.edges ?? [];
    const variants = vEdges.map((v: any) => ({
      id: v.node.id,
      sku: v.node.sku ?? null,
      inventoryItemId: v.node.inventoryItem?.id ?? "",
      unitCost: v.node.inventoryItem?.unitCost?.amount
        ? parseFloat(v.node.inventoryItem.unitCost.amount)
        : null,
    }));
    const costed = variants.filter((v: any) => v.unitCost !== null);
    const avgUnitCost =
      costed.length > 0
        ? costed.reduce((s: number, v: any) => s + (v.unitCost ?? 0), 0) /
          costed.length
        : null;
    return {
      id: node.id,
      title: node.title,
      handle: node.handle,
      vendor: node.vendor || null,
      status: node.status,
      tags: node.tags ?? [],
      totalInventory: node.totalInventory ?? 0,
      createdAt: node.createdAt,
      imageUrl: node.featuredImage?.url ?? null,
      variantCount: vEdges.length,
      avgUnitCost,
      variants,
    } as ListedProduct;
  });
  const pageInfo = data.data?.products?.pageInfo ?? {
    hasNextPage: false,
    endCursor: null,
  };
  return { products, pageInfo };
}

// Fetch a product's current vendor, status, tags, and per-variant costs — used
// to take a "before" snapshot for the bulk action audit log.
const PRODUCT_AUDIT_SNAPSHOT_QUERY = `#graphql
  query ProductAuditSnapshot($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        vendor
        status
        tags
        variants(first: 100) {
          edges {
            node {
              id
              inventoryItem {
                id
                unitCost { amount currencyCode }
              }
            }
          }
        }
      }
    }
  }
`;

export interface ProductSnapshot {
  id: string;
  title: string;
  vendor: string | null;
  status: string;
  tags: string[];
  variants: Array<{
    id: string;
    inventoryItemId: string;
    unitCost: number | null;
  }>;
}

export async function getProductSnapshots(
  admin: AdminApiContext,
  productIds: string[],
): Promise<Map<string, ProductSnapshot>> {
  if (productIds.length === 0) return new Map();
  const response = await admin.graphql(PRODUCT_AUDIT_SNAPSHOT_QUERY, {
    variables: { ids: productIds },
  });
  const data = await response.json();
  const nodes = data.data?.nodes ?? [];
  const out = new Map<string, ProductSnapshot>();
  for (const node of nodes) {
    if (!node?.id) continue;
    const vEdges = node.variants?.edges ?? [];
    out.set(node.id, {
      id: node.id,
      title: node.title,
      vendor: node.vendor || null,
      status: node.status,
      tags: node.tags ?? [],
      variants: vEdges.map((e: any) => ({
        id: e.node.id,
        inventoryItemId: e.node.inventoryItem?.id ?? "",
        unitCost: e.node.inventoryItem?.unitCost?.amount
          ? parseFloat(e.node.inventoryItem.unitCost.amount)
          : null,
      })),
    });
  }
  return out;
}

// Single-product updates for vendor / status. Shopify rate-limits these to
// ~1000 cost points per 60s; the bulk service batches calls in groups of 25.
const PRODUCT_UPDATE_MUTATION = `#graphql
  mutation UpdateProduct($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id vendor status }
      userErrors { field message }
    }
  }
`;

export async function updateProductFields(
  admin: AdminApiContext,
  productId: string,
  input: { vendor?: string; status?: "ACTIVE" | "ARCHIVED" | "DRAFT" },
): Promise<{ ok: boolean; error: string | null }> {
  try {
    const response = await admin.graphql(PRODUCT_UPDATE_MUTATION, {
      variables: {
        input: {
          id: productId,
          ...(input.vendor !== undefined ? { vendor: input.vendor } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
        },
      },
    });
    const data = await response.json();
    const errs = data.data?.productUpdate?.userErrors ?? [];
    if (errs.length > 0) {
      return { ok: false, error: errs.map((e: any) => e.message).join("; ") };
    }
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// tagsAdd / tagsRemove are cheaper than productUpdate { tags } because they
// don't require re-sending the whole tag list (Shopify merges server-side).
const TAGS_ADD_MUTATION = `#graphql
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { ... on Product { id tags } }
      userErrors { field message }
    }
  }
`;

const TAGS_REMOVE_MUTATION = `#graphql
  mutation TagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { ... on Product { id tags } }
      userErrors { field message }
    }
  }
`;

export async function addTags(
  admin: AdminApiContext,
  productId: string,
  tags: string[],
): Promise<{ ok: boolean; error: string | null }> {
  if (tags.length === 0) return { ok: true, error: null };
  try {
    const response = await admin.graphql(TAGS_ADD_MUTATION, {
      variables: { id: productId, tags },
    });
    const data = await response.json();
    const errs = data.data?.tagsAdd?.userErrors ?? [];
    if (errs.length > 0) {
      return { ok: false, error: errs.map((e: any) => e.message).join("; ") };
    }
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export async function removeTags(
  admin: AdminApiContext,
  productId: string,
  tags: string[],
): Promise<{ ok: boolean; error: string | null }> {
  if (tags.length === 0) return { ok: true, error: null };
  try {
    const response = await admin.graphql(TAGS_REMOVE_MUTATION, {
      variables: { id: productId, tags },
    });
    const data = await response.json();
    const errs = data.data?.tagsRemove?.userErrors ?? [];
    if (errs.length > 0) {
      return { ok: false, error: errs.map((e: any) => e.message).join("; ") };
    }
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// Bulk-update COGs across a product's variants. Reuses the existing
// productVariantsBulkUpdate mutation; Shopify accepts inventoryItem.cost on
// the variant input.
const PRODUCT_VARIANTS_BULK_COST_MUTATION = `#graphql
  mutation VariantsBulkCost($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id inventoryItem { id unitCost { amount } } }
      userErrors { field message }
    }
  }
`;

export async function updateVariantCosts(
  admin: AdminApiContext,
  productId: string,
  variants: Array<{ id: string; cost: number }>,
): Promise<{ ok: boolean; error: string | null }> {
  if (variants.length === 0) return { ok: true, error: null };
  try {
    const response = await admin.graphql(PRODUCT_VARIANTS_BULK_COST_MUTATION, {
      variables: {
        productId,
        variants: variants.map((v) => ({
          id: v.id,
          inventoryItem: { cost: v.cost.toFixed(2) },
        })),
      },
    });
    const data = await response.json();
    const errs = data.data?.productVariantsBulkUpdate?.userErrors ?? [];
    if (errs.length > 0) {
      return { ok: false, error: errs.map((e: any) => e.message).join("; ") };
    }
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// Get all products for a vendor (for loading full catalog)
export async function getProductsByVendor(admin: AdminApiContext, vendor: string) {
  const allProducts: Array<Record<string, unknown>> = [];
  let hasNext = true;
  let after: string | null = null;

  while (hasNext) {
    const query = `vendor:"${vendor}"`;
    const response = await admin.graphql(PRODUCTS_QUERY, {
      variables: { first: 100, after, query },
    });
    const data = await response.json();
    const products = data.data.products;
    for (const edge of products.edges) {
      allProducts.push(edge.node);
    }
    hasNext = products.pageInfo.hasNextPage;
    after = products.pageInfo.endCursor;
  }

  return allProducts;
}

// ============================================
// BARCODE AUDIT (V2.1 Barcode Check module)
// ============================================

// Lean query — pulls only what the audit needs. Paginates 100 products/call.
const BARCODE_AUDIT_QUERY = `#graphql
  query BarcodeAuditProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: TITLE) {
      edges {
        cursor
        node {
          id
          title
          vendor
          status
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                barcode
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export interface AuditVariant {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  vendor: string | null;
  status: string;
  sku: string | null;
  barcode: string | null;
}

/**
 * Walk the full product catalog and return one flat row per variant, with
 * barcode + SKU + product metadata. Used by the Barcode Check module to
 * find missing + duplicate barcodes. Handles pagination internally.
 */
export async function getAllVariantsForBarcodeAudit(
  admin: AdminApiContext,
): Promise<AuditVariant[]> {
  const variants: AuditVariant[] = [];
  let after: string | null = null;
  let hasNext = true;

  while (hasNext) {
    const response = await admin.graphql(BARCODE_AUDIT_QUERY, {
      variables: { first: 100, after },
    });
    const data = await response.json();
    const page = data?.data?.products;
    if (!page) break;
    for (const edge of page.edges as Array<{ node: any }>) {
      const p = edge.node;
      for (const vEdge of p.variants?.edges ?? []) {
        const v = vEdge.node;
        variants.push({
          variantId: v.id,
          productId: p.id,
          productTitle: p.title,
          variantTitle: v.title,
          vendor: p.vendor || null,
          status: p.status,
          sku: v.sku ?? null,
          barcode: v.barcode ?? null,
        });
      }
    }
    hasNext = page.pageInfo.hasNextPage;
    after = page.pageInfo.endCursor;
  }

  return variants;
}

/**
 * Set the barcode on many variants in one Shopify mutation, grouped by
 * product (required by productVariantsBulkUpdate).
 *
 * Returns a summary plus the per-variant result so the caller can render
 * successes/failures.
 */
export async function setVariantBarcodes(
  admin: AdminApiContext,
  updates: Array<{
    productId: string;
    variantId: string;
    barcode: string;
  }>,
): Promise<{
  updated: number;
  failures: Array<{ variantId: string; error: string }>;
}> {
  // Bucket by product since productVariantsBulkUpdate is scoped to one
  // product at a time.
  const byProduct = new Map<
    string,
    Array<{ variantId: string; barcode: string }>
  >();
  for (const u of updates) {
    if (!byProduct.has(u.productId)) byProduct.set(u.productId, []);
    byProduct.get(u.productId)!.push({
      variantId: u.variantId,
      barcode: u.barcode,
    });
  }

  let updated = 0;
  const failures: Array<{ variantId: string; error: string }> = [];

  for (const [productId, list] of byProduct.entries()) {
    try {
      const resp = await admin.graphql(
        PRODUCT_VARIANTS_BULK_UPDATE_MUTATION,
        {
          variables: {
            productId,
            variants: list.map((v) => ({ id: v.variantId, barcode: v.barcode })),
          },
        },
      );
      const data = (await resp.json()) as any;
      const errs = data?.data?.productVariantsBulkUpdate?.userErrors ?? [];
      if (errs.length > 0) {
        for (const v of list) {
          failures.push({
            variantId: v.variantId,
            error: errs
              .map((e: { message: string }) => e.message)
              .join("; "),
          });
        }
      } else {
        updated += list.length;
      }
    } catch (error) {
      for (const v of list) {
        failures.push({ variantId: v.variantId, error: String(error) });
      }
    }
  }

  return { updated, failures };
}
