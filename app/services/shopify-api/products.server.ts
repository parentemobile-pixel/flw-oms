import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import {
  CACHE_KEYS,
  CACHE_TTL,
  getCached,
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

// Fetch all unique vendors from the shop
const VENDORS_QUERY = `#graphql
  query GetVendors($first: Int!) {
    products(first: $first) {
      edges {
        node {
          vendor
        }
      }
    }
  }
`;

export async function getVendors(
  admin: AdminApiContext,
  shop?: string,
): Promise<string[]> {
  const fetcher = async () => {
    const response = await admin.graphql(VENDORS_QUERY, {
      variables: { first: 250 },
    });
    const data = await response.json();
    const vendors = data.data.products.edges.map(
      (edge: { node: { vendor: string } }) => edge.node.vendor,
    );
    return [...new Set(vendors)].filter(Boolean).sort() as string[];
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
