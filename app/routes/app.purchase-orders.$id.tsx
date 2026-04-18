import { useCallback } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useSubmit } from "@remix-run/react";
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
  Divider,
  ButtonGroup,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import {
  getPurchaseOrder,
  updatePurchaseOrderStatus,
  deletePurchaseOrder,
} from "../services/purchase-orders/po-service.server";
import { getLocations } from "../services/shopify-api/locations.server";
import { PO_STATUS_LABELS, PO_STATUS_TONES } from "../utils/constants";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const po = await getPurchaseOrder(session.shop, params.id!);
  if (!po) throw new Response("Not found", { status: 404 });
  const locations = await getLocations(admin, session.shop).catch(() => []);
  const locationName =
    locations.find((l) => l.id === po.shopifyLocationId)?.name ?? null;
  return json({ po, locationName });
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
    throw redirect("/app/purchase-orders");
  }

  return json({});
};

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
}

export default function PurchaseOrderDetail() {
  const { po, locationName } = useLoaderData<typeof loader>();
  const submit = useSubmit();

  const handleStatusChange = useCallback(
    (status: string) => {
      const formData = new FormData();
      formData.set("intent", "updateStatus");
      formData.set("status", status);
      submit(formData, { method: "post" });
    },
    [submit],
  );

  const handleDelete = useCallback(() => {
    if (
      !window.confirm(
        "Delete this PO? This can't be undone. Inventory is unaffected.",
      )
    )
      return;
    const formData = new FormData();
    formData.set("intent", "delete");
    submit(formData, { method: "post" });
  }, [submit]);

  const totalOrdered = po.lineItems.reduce(
    (sum, li) => sum + li.quantityOrdered,
    0,
  );
  const totalReceived = po.lineItems.reduce(
    (sum, li) => sum + li.quantityReceived,
    0,
  );
  const totalRetail = po.lineItems.reduce(
    (sum, li) => sum + (li.retailPrice ?? 0) * li.quantityOrdered,
    0,
  );

  const rows = po.lineItems.map((li) => [
    li.productTitle,
    li.variantTitle,
    li.sku || "—",
    li.barcode || "—",
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
            <Button onClick={() => handleStatusChange("ordered")}>
              Mark as Ordered
            </Button>
            <Button
              tone="critical"
              onClick={() => handleStatusChange("cancelled")}
            >
              Cancel PO
            </Button>
            <Button tone="critical" variant="plain" onClick={handleDelete}>
              Delete
            </Button>
          </ButtonGroup>
        );
      case "ordered":
        return (
          <Button
            variant="primary"
            url={`/app/purchase-orders/${po.id}/receive`}
          >
            Receive Items
          </Button>
        );
      case "partially_received":
        return (
          <Button
            variant="primary"
            url={`/app/purchase-orders/${po.id}/receive`}
          >
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
        {
          content: "Download PDF (Line)",
          url: `/api/po-pdf/${po.id}?view=line`,
          external: true,
        },
        {
          content: "Download PDF (Grid)",
          url: `/api/po-pdf/${po.id}?view=grid`,
          external: true,
        },
      ]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="600" wrap>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Vendor
                  </Text>
                  <Text as="p" variant="bodyMd">
                    {po.vendor || "—"}
                  </Text>
                </BlockStack>
                {po.poNumberExt && (
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Vendor PO #
                    </Text>
                    <Text as="p" variant="bodyMd">
                      {po.poNumberExt}
                    </Text>
                  </BlockStack>
                )}
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Receive at
                  </Text>
                  <Text as="p" variant="bodyMd">
                    {locationName ?? "—"}
                  </Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Ship by
                  </Text>
                  <Text as="p" variant="bodyMd">
                    {formatDate(po.shippingDate)}
                  </Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Expected
                  </Text>
                  <Text as="p" variant="bodyMd">
                    {formatDate(po.expectedDate)}
                  </Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Created
                  </Text>
                  <Text as="p" variant="bodyMd">
                    {formatDate(po.createdAt)}
                  </Text>
                </BlockStack>
                {po.orderDate && (
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Ordered
                    </Text>
                    <Text as="p" variant="bodyMd">
                      {formatDate(po.orderDate)}
                    </Text>
                  </BlockStack>
                )}
              </InlineStack>
              <Divider />
              <InlineStack gap="600" wrap>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Total Cost
                  </Text>
                  <Text as="p" variant="headingMd">
                    ${po.totalCost.toFixed(2)}
                  </Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Total Retail
                  </Text>
                  <Text as="p" variant="headingMd">
                    ${totalRetail.toFixed(2)}
                  </Text>
                </BlockStack>
                <BlockStack gap="100">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Progress
                  </Text>
                  <Text as="p" variant="headingMd">
                    {totalReceived} / {totalOrdered}
                  </Text>
                </BlockStack>
              </InlineStack>
              {po.notes && (
                <>
                  <Divider />
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Notes
                    </Text>
                    <Text as="p" variant="bodyMd">
                      {po.notes}
                    </Text>
                  </BlockStack>
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <DataTable
              columnContentTypes={[
                "text",
                "text",
                "text",
                "text",
                "numeric",
                "numeric",
                "numeric",
                "text",
                "numeric",
              ]}
              headings={[
                "Product",
                "Variant",
                "SKU",
                "Barcode",
                "Cost",
                "Retail",
                "Ordered",
                "Received",
                "Line Total",
              ]}
              rows={rows}
              totals={[
                "",
                "",
                "",
                "",
                "",
                "",
                String(totalOrdered),
                `${totalReceived} / ${totalOrdered}`,
                `$${po.totalCost.toFixed(2)}`,
              ]}
            />
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineStack align="end" gap="200">
            {statusActions()}
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
