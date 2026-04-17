import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import Anthropic from "@anthropic-ai/sdk";
import { authenticate } from "../shopify.server";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Define tools for Claude to query Shopify data
const tools: Anthropic.Tool[] = [
  {
    name: "search_products",
    description: "Search for products in the Shopify store. Can filter by vendor, product type, title, or tags. Returns product details including inventory levels.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to find products (searches in title, vendor, product type, tags)",
        },
        vendor: {
          type: "string",
          description: "Filter by specific vendor name (e.g., 'Helly Hansen', 'Nike')",
        },
        limit: {
          type: "number",
          description: "Maximum number of products to return (default 50)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_inventory_levels",
    description: "Get current inventory levels for products. Can filter by vendor or product type.",
    input_schema: {
      type: "object",
      properties: {
        vendor: {
          type: "string",
          description: "Filter by vendor name",
        },
        product_type: {
          type: "string",
          description: "Filter by product type (e.g., 'Shirts', 'Jackets')",
        },
      },
      required: [],
    },
  },
  {
    name: "query_sales_data",
    description: "Query sales data for products over a time period. Can filter by product attributes like color, vendor, or product type.",
    input_schema: {
      type: "object",
      properties: {
        start_date: {
          type: "string",
          description: "Start date in ISO format (e.g., '2024-01-01')",
        },
        end_date: {
          type: "string",
          description: "End date in ISO format (e.g., '2024-03-31')",
        },
        vendor: {
          type: "string",
          description: "Filter by vendor name",
        },
        product_type: {
          type: "string",
          description: "Filter by product type",
        },
        color: {
          type: "string",
          description: "Filter by color (searches in product title and variant options)",
        },
      },
      required: ["start_date", "end_date"],
    },
  },
];

async function searchProducts(admin: any, query: string, vendor?: string, limit = 50) {
  let queryString = `(${query})`;
  if (vendor) {
    queryString += ` AND vendor:${vendor}`;
  }

  const response = await admin.graphql(`
    query searchProducts($query: String!, $limit: Int!) {
      products(first: $limit, query: $query) {
        nodes {
          id
          title
          vendor
          productType
          totalInventory
          variants(first: 50) {
            nodes {
              id
              title
              sku
              inventoryQuantity
              price
            }
          }
        }
      }
    }
  `, {
    variables: { query: queryString, limit },
  });

  const data = await response.json();
  return data.data.products.nodes;
}

async function getInventoryLevels(admin: any, vendor?: string, productType?: string) {
  let queryParts = [];
  if (vendor) queryParts.push(`vendor:${vendor}`);
  if (productType) queryParts.push(`product_type:${productType}`);

  const query = queryParts.length > 0 ? queryParts.join(" AND ") : "";

  const response = await admin.graphql(`
    query getInventory($query: String!) {
      products(first: 100, query: $query) {
        nodes {
          id
          title
          vendor
          productType
          totalInventory
          variants(first: 50) {
            nodes {
              id
              title
              sku
              inventoryQuantity
            }
          }
        }
      }
    }
  `, {
    variables: { query },
  });

  const data = await response.json();
  return data.data.products.nodes;
}

async function querySalesData(
  admin: any,
  startDate: string,
  endDate: string,
  vendor?: string,
  productType?: string,
  color?: string
) {
  // Build the query string
  let queryParts = [`created_at:>='${startDate}'`, `created_at:<='${endDate}'`];

  const response = await admin.graphql(`
    query getSalesData($query: String!) {
      orders(first: 250, query: $query) {
        nodes {
          id
          name
          createdAt
          totalPriceSet {
            shopMoney {
              amount
            }
          }
          lineItems(first: 50) {
            nodes {
              id
              title
              quantity
              variant {
                id
                title
                sku
                product {
                  id
                  title
                  vendor
                  productType
                }
              }
            }
          }
        }
      }
    }
  `, {
    variables: { query: queryParts.join(" AND ") },
  });

  const data = await response.json();
  const orders = data.data.orders.nodes;

  // Filter and aggregate line items
  const lineItems = orders.flatMap((order: any) =>
    order.lineItems.nodes.map((item: any) => ({
      ...item,
      orderDate: order.createdAt,
    }))
  );

  // Apply filters
  let filteredItems = lineItems.filter((item: any) => {
    if (!item.variant?.product) return false;

    if (vendor && item.variant.product.vendor !== vendor) return false;
    if (productType && item.variant.product.productType !== productType) return false;
    if (color) {
      const searchText = `${item.title} ${item.variant.title}`.toLowerCase();
      if (!searchText.includes(color.toLowerCase())) return false;
    }

    return true;
  });

  // Aggregate results
  const totalQuantity = filteredItems.reduce((sum: number, item: any) => sum + item.quantity, 0);
  const productBreakdown = filteredItems.reduce((acc: any, item: any) => {
    const key = item.variant?.product?.title || "Unknown";
    if (!acc[key]) {
      acc[key] = { quantity: 0, product: item.variant?.product };
    }
    acc[key].quantity += item.quantity;
    return acc;
  }, {});

  return {
    totalQuantity,
    totalOrders: orders.length,
    productBreakdown: Object.entries(productBreakdown).map(([title, data]: [string, any]) => ({
      title,
      quantity: data.quantity,
      vendor: data.product?.vendor,
      productType: data.product?.productType,
    })),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  const { messages } = await request.json();

  try {
    let claudeMessages = messages;
    let toolResults: any[] = [];

    // Initial request to Claude
    let response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      tools,
      messages: claudeMessages,
    });

    // Handle tool use loop
    while (response.stop_reason === "tool_use") {
      const toolUse = response.content.find((block) => block.type === "tool_use") as Anthropic.ToolUseBlock;

      if (!toolUse) break;

      let toolResult: any;

      // Execute the appropriate tool
      switch (toolUse.name) {
        case "search_products":
          const searchInput = toolUse.input as any;
          toolResult = await searchProducts(
            admin,
            searchInput.query,
            searchInput.vendor,
            searchInput.limit
          );
          break;

        case "get_inventory_levels":
          const inventoryInput = toolUse.input as any;
          toolResult = await getInventoryLevels(
            admin,
            inventoryInput.vendor,
            inventoryInput.product_type
          );
          break;

        case "query_sales_data":
          const salesInput = toolUse.input as any;
          toolResult = await querySalesData(
            admin,
            salesInput.start_date,
            salesInput.end_date,
            salesInput.vendor,
            salesInput.product_type,
            salesInput.color
          );
          break;

        default:
          toolResult = { error: "Unknown tool" };
      }

      // Add assistant response and tool result to messages
      claudeMessages = [
        ...claudeMessages,
        { role: "assistant", content: response.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: JSON.stringify(toolResult),
            },
          ],
        },
      ];

      // Get next response from Claude
      response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        tools,
        messages: claudeMessages,
      });
    }

    // Extract text response
    const textContent = response.content.find((block) => block.type === "text") as Anthropic.TextBlock;

    return json({
      message: textContent?.text || "I couldn't generate a response.",
      usage: response.usage,
    });
  } catch (error: any) {
    console.error("Chat error:", error);
    return json(
      { error: error.message || "Failed to process chat message" },
      { status: 500 }
    );
  }
}
