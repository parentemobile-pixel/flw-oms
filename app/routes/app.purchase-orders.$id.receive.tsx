import { useState, useCallback } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useActionData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  TextField,
  Button,
  Banner,
  BlockStack,
  Text,
  InlineStack,
  Badge,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { getPurchaseOrder, receiveLineItems } from "../services/purchase-orders/po-service.server";
import { adjustInventory } from "../services/shopify-api/inventory.server";
import { getLocations } from "../services/shopify-api/locations.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const po = await getPurchaseOrder(session.shop, params.id!);
  if (!po) throw new Response("Not found", { status: 404 });

  const locations = await getLocations(admin, session.shop);
  return json({ po, locations });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const receivedItemsJson = formData.get("receivedItems") as string;
  const locationId = formData.get("locationId") as string;
  const receivedItems = JSON.parse(receivedItemsJson) as Array<{
    lineItemId: string;
    quantityReceived: number;
    shopifyVariantId: string;
    previouslyReceived: number;
  }>;

  try {
    // Update PO line items
    await receiveLineItems(
      params.id!,
      receivedItems.map((item) => ({
        lineItemId: item.lineItemId,
        quantityReceived: item.quantityReceived,
      })),
    );

    // Adjust Shopify inventory for each item with new quantities
    const errors: string[] = [];
    for (const item of receivedItems) {
      const delta = item.quantityReceived - item.previouslyReceived;
      if (delta <= 0) continue;

      try {
        // Get the inventory item ID from the variant
        const variantGid = item.shopifyVariantId;
        // Need to fetch the inventory item ID from the variant
        const variantQuery = `#graphql
          query GetVariant($id: ID!) {
            productVariant(id: $id) {
              inventoryItem {
                id
              }
            }
          }
        `;
        const variantResponse = await admin.graphql(variantQuery, {
          variables: { id: variantGid },
        });
        const variantData = await variantResponse.json();
        const inventoryItemId = variantData.data.productVariant?.inventoryItem?.id;

        if (inventoryItemId) {
          const result = await adjustInventory(admin, inventoryItemId, locationId, delta);
          if (result.userErrors?.length > 0) {
            errors.push(`${item.lineItemId}: ${result.userErrors.map((e: { message: string }) => e.message).join(", ")}`);
          }
        }
      } catch (error) {
        errors.push(`Failed to adjust inventory for variant: ${error}`);
      }
    }

    if (errors.length > 0) {
      return json({ error: `Some inventory adjustments failed: ${errors.join("; ")}`, partialSuccess: true });
    }

    return redirect(`/app/purchase-orders/${params.id}`);
  } catch (error) {
    return json({ error: `Failed to receive items: ${error}` });
  }
};

export default function ReceivePurchaseOrder() {
  const { po, locations } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [selectedLocation, setSelectedLocation] = useState(
    locations.length > 0 ? (locations[0] as { id: string }).id : "",
  );
  const [quantities, setQuantities] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    for (const li of po.lineItems) {
      initial[li.id] = li.quantityReceived;
    }
    return initial;
  });

  const handleQuantityChange = useCallback((lineItemId: string, value: string) => {
    setQuantities((prev) => ({
      ...prev,
      [lineItemId]: parseInt(value) || 0,
    }));
  }, []);

  const handleReceiveAll = useCallback(() => {
    const allReceived: Record<string, number> = {};
    for (const li of po.lineItems) {
      allReceived[li.id] = li.quantityOrdered;
    }
    setQuantities(allReceived);
  }, [po.lineItems]);

  const handleSubmit = useCallback(() => {
    const receivedItems = po.lineItems.map((li) => ({
      lineItemId: li.id,
      quantityReceived: quantities[li.id] || 0,
      shopifyVariantId: li.shopifyVariantId,
      previouslyReceived: li.quantityReceived,
    }));

    const formData = new FormData();
    formData.set("receivedItems", JSON.stringify(receivedItems));
    formData.set("locationId", selectedLocation);
    submit(formData, { method: "post" });
  }, [po.lineItems, quantities, selectedLocation, submit]);

  return (
    <Page title={`Receive: ${po.poNumber}`} backAction={{ url: `/app/purchase-orders/${po.id}` }}>
      <Layout>
        {actionData && "error" in actionData && (
          <Layout.Section>
            <Banner tone={actionData.partialSuccess ? "warning" : "critical"}>
              {actionData.error as string}
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">Receive Items</Text>
                <InlineStack gap="200">
                  {locations.length > 1 && (
                    <select
                      value={selectedLocation}
                      onChange={(e) => setSelectedLocation(e.target.value)}
                      style={{ padding: "6px 12px", borderRadius: "4px", border: "1px solid #ccc" }}
                    >
                      {locations.map((loc: { id: string; name: string }) => (
                        <option key={loc.id} value={loc.id}>{loc.name}</option>
                      ))}
                    </select>
                  )}
                  <Button onClick={handleReceiveAll} size="slim">Receive All</Button>
                </InlineStack>
              </InlineStack>

              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                      <th style={{ padding: "8px", textAlign: "left" }}>Product</th>
                      <th style={{ padding: "8px", textAlign: "left" }}>Variant</th>
                      <th style={{ padding: "8px", textAlign: "left" }}>SKU</th>
                      <th style={{ padding: "8px", textAlign: "right" }}>Ordered</th>
                      <th style={{ padding: "8px", textAlign: "right" }}>Previously Received</th>
                      <th style={{ padding: "8px", textAlign: "right", width: "120px" }}>Receiving Now</th>
                      <th style={{ padding: "8px", textAlign: "center" }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {po.lineItems.map((li) => {
                      const currentQty = quantities[li.id] || 0;
                      const isComplete = currentQty >= li.quantityOrdered;
                      const isPartial = currentQty > 0 && currentQty < li.quantityOrdered;

                      return (
                        <tr key={li.id} style={{ borderBottom: "1px solid #f1f1f1" }}>
                          <td style={{ padding: "8px" }}>{li.productTitle}</td>
                          <td style={{ padding: "8px" }}>{li.variantTitle}</td>
                          <td style={{ padding: "8px" }}>{li.sku || "—"}</td>
                          <td style={{ padding: "8px", textAlign: "right" }}>{li.quantityOrdered}</td>
                          <td style={{ padding: "8px", textAlign: "right" }}>{li.quantityReceived}</td>
                          <td style={{ padding: "8px" }}>
                            <TextField
                              label=""
                              labelHidden
                              value={String(currentQty)}
                              onChange={(val) => handleQuantityChange(li.id, val)}
                              type="number"
                              min={0}
                              max={li.quantityOrdered}
                              autoComplete="off"
                            />
                          </td>
                          <td style={{ padding: "8px", textAlign: "center" }}>
                            {isComplete ? (
                              <Badge tone="success">Complete</Badge>
                            ) : isPartial ? (
                              <Badge tone="warning">Partial</Badge>
                            ) : (
                              <Badge>Pending</Badge>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineStack align="end" gap="200">
            <Button url={`/app/purchase-orders/${po.id}`}>Cancel</Button>
            <Button variant="primary" onClick={handleSubmit} loading={isSubmitting}>
              Confirm Received
            </Button>
          </InlineStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
