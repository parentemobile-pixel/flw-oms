import { useCallback } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, useNavigation, Link } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Badge,
  Text,
  BlockStack,
  InlineStack,
  DataTable,
  Button,
  Banner,
  Divider,
  ButtonGroup,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import {
  getPurchaseOrder,
  updatePurchaseOrderStatus,
  deletePurchaseOrder,
} from "../services/purchase-orders/po-service.server";
import { PO_STATUS_LABELS, PO_STATUS_TONES } from "../utils/constants";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const po = await getPurchaseOrder(session.shop, params.id!);
  if (!po) throw new Response("Not found", { status: 404 });
  return json({ po });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "updateStatus") {
    const status = formData.get("status") as string;
    await updatePurchaseOrderStatus(session.shop, params.id!, status);
    return json({ success: true });
  }

  if (intent === "delete") {
    await deletePurchaseOrder(session.shop, params.id!);
    return json({ redirect: "/app/purchase-orders" });
  }

  return json({});
};

export default function PurchaseOrderDetail() {
  const { po } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigation = useNavigation();

  const handleStatusChange = useCallback(
    (status: string) => {
      const formData = new FormData();
      formData.set("intent", "updateStatus");
      formData.set("status", status);
      submit(formData, { method: "post" });
    },
    [submit],
  );

  const totalOrdered = po.lineItems.reduce((sum, li) => sum + li.quantityOrdered, 0);
  const totalReceived = po.lineItems.reduce((sum, li) => sum + li.quantityReceived, 0);

  const rows = po.lineItems.map((li) => [
    li.productTitle,
    li.variantTitle,
    li.sku || "—",
    `$${li.unitCost.toFixed(2)}`,
    `$${(li.retailPrice || 0).toFixed(2)}`,
    String(li.quantityOrdered),
    `${li.quantityReceived} / ${li.quantityOrdered}`,
    `$${(li.unitCost * li.quantityOrdered).toFixed(2)}`,
  ]);

  const statusActions = () => {
    switch (po.status) {
      case "draft":
        return (
          <ButtonGroup>
            <Button onClick={() => handleStatusChange("ordered")}>Mark as Ordered</Button>
            <Button tone="critical" onClick={() => handleStatusChange("cancelled")}>Cancel PO</Button>
          </ButtonGroup>
        );
      case "ordered":
        return (
          <Button variant="primary" url={`/app/purchase-orders/${po.id}/receive`}>
            Receive Items
          </Button>
        );
      case "partially_received":
        return (
          <Button variant="primary" url={`/app/purchase-orders/${po.id}/receive`}>
            Continue Receiving
          </Button>
        );
      default:
        return null;
    }
  };

  return (
    <Page
      title={po.poNumber}
      backAction={{ url: "/app/purchase-orders" }}
      titleMetadata={
        <Badge tone={PO_STATUS_TONES[po.status] || "info"}>
          {PO_STATUS_LABELS[po.status] || po.status}
        </Badge>
      }
      secondaryActions={[
        {
          content: "Print Labels",
          url: `/app/purchase-orders/${po.id}/labels`,
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="800">
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">Vendor</Text>
                  <Text as="p" variant="bodyMd">{po.vendor || "—"}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">Created</Text>
                  <Text as="p" variant="bodyMd">{new Date(po.createdAt).toLocaleDateString()}</Text>
                </BlockStack>
                {po.orderDate && (
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">Order Date</Text>
                    <Text as="p" variant="bodyMd">{new Date(po.orderDate).toLocaleDateString()}</Text>
                  </BlockStack>
                )}
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">Total Cost</Text>
                  <Text as="p" variant="bodyMd">${po.totalCost.toFixed(2)}</Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">Progress</Text>
                  <Text as="p" variant="bodyMd">{totalReceived} / {totalOrdered} received</Text>
                </BlockStack>
              </InlineStack>
              {po.notes && (
                <>
                  <Divider />
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">Notes</Text>
                    <Text as="p" variant="bodyMd">{po.notes}</Text>
                  </BlockStack>
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <DataTable
              columnContentTypes={["text", "text", "text", "numeric", "numeric", "numeric", "text", "numeric"]}
              headings={["Product", "Variant", "SKU", "Cost", "Retail", "Ordered", "Received", "Line Total"]}
              rows={rows}
              totals={["", "", "", "", "", String(totalOrdered), `${totalReceived} / ${totalOrdered}`, `$${po.totalCost.toFixed(2)}`]}
            />
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineStack align="end" gap="200">
            {statusActions()}
          </InlineStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
