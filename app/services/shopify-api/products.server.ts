import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

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

export async function getVendors(admin: AdminApiContext): Promise<string[]> {
  try {
    const response = await admin.graphql(VENDORS_QUERY, {
      variables: { first: 250 },
    });
    const data = await response.json();
    const vendors = data.data.products.edges.map((edge: { node: { vendor: string } }) => edge.node.vendor);
    return [...new Set(vendors)].filter(Boolean).sort() as string[];
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

export async function getPublications(admin: AdminApiContext): Promise<Publication[]> {
  try {
    const response = await admin.graphql(PUBLICATIONS_QUERY, {
      variables: { first: 50 },
    });
    const data = await response.json();
    return data.data.publications.edges.map((edge: { node: Publication }) => edge.node);
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

export async function getMetafieldDefinitions(admin: AdminApiContext): Promise<MetafieldDefinition[]> {
  try {
    const response = await admin.graphql(METAFIELD_DEFINITIONS_QUERY);
    const data = await response.json();
    return data.data.metafieldDefinitions.edges.map(
      (edge: { node: { id: string; name: string; namespace: string; key: string; type: { name: string }; description: string | null; validations: Array<{ name: string; value: string }> } }) => ({
        ...edge.node,
        type: edge.node.type.name,
      }),
    );
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
}

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
  return data.data.productSet;
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

export async function getExistingOptionValues(admin: AdminApiContext): Promise<ExistingOptionValues> {
  try {
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
    // Sort each option's values
    for (const key of Object.keys(result)) {
      result[key].sort();
    }
    return result;
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
