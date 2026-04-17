import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

const ADJUST_INVENTORY_MUTATION = `#graphql
  mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      inventoryAdjustmentGroup {
        reason
        changes {
          name
          delta
          quantityAfterChange
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const LOCATIONS_QUERY = `#graphql
  query GetLocations {
    locations(first: 10) {
      edges {
        node {
          id
          name
          isActive
        }
      }
    }
  }
`;

const INVENTORY_ITEM_QUERY = `#graphql
  query GetInventoryItem($id: ID!) {
    inventoryItem(id: $id) {
      id
      inventoryLevels(first: 10) {
        edges {
          node {
            id
            location {
              id
              name
            }
            quantities(names: ["available", "incoming", "committed"]) {
              name
              quantity
            }
          }
        }
      }
    }
  }
`;

export async function getLocations(admin: AdminApiContext) {
  const response = await admin.graphql(LOCATIONS_QUERY);
  const data = await response.json();
  return data.data.locations.edges.map((edge: { node: unknown }) => edge.node);
}

export async function adjustInventory(
  admin: AdminApiContext,
  inventoryItemId: string,
  locationId: string,
  delta: number,
) {
  const response = await admin.graphql(ADJUST_INVENTORY_MUTATION, {
    variables: {
      input: {
        reason: "received",
        name: "available",
        changes: [
          {
            delta,
            inventoryItemId,
            locationId,
          },
        ],
      },
    },
  });

  const data = await response.json();
  return data.data.inventoryAdjustQuantities;
}

export async function getInventoryItem(admin: AdminApiContext, inventoryItemId: string) {
  const response = await admin.graphql(INVENTORY_ITEM_QUERY, {
    variables: { id: inventoryItemId },
  });
  const data = await response.json();
  return data.data.inventoryItem;
}
