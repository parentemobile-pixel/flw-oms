import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, Link } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Badge,
  Text,
  EmptyState,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { getPurchaseOrderSummaries } from "../services/purchase-orders/po-service.server";
import { PO_STATUS_LABELS, PO_STATUS_TONES } from "../utils/constants";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const purchaseOrders = await getPurchaseOrderSummaries(session.shop);
  return json({ purchaseOrders });
};

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString();
}

export default function PurchaseOrdersList() {
  const { purchaseOrders } = useLoaderData<typeof loader>();

  const resourceName = {
    singular: "purchase order",
    plural: "purchase orders",
  };

  const emptyStateMarkup = (
    <EmptyState
      heading="Create your first purchase order"
      action={{ content: "Create PO", url: "/app/purchase-orders/new" }}
      image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
    >
      <p>Track incoming inventory with purchase orders.</p>
    </EmptyState>
  );

  const rowMarkup = purchaseOrders.map((po, index) => (
    <IndexTable.Row id={po.id} key={po.id} position={index}>
      <IndexTable.Cell>
        <Link
          to={`/app/purchase-orders/${po.id}`}
          style={{ textDecoration: "none" }}
        >
          <Text variant="bodyMd" fontWeight="bold" as="span">
            {po.poNumber}
          </Text>
        </Link>
      </IndexTable.Cell>
      <IndexTable.Cell>{po.vendor || "—"}</IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={PO_STATUS_TONES[po.status] || "info"}>
          {PO_STATUS_LABELS[po.status] || po.status}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>{po.totalUnits} units</IndexTable.Cell>
      <IndexTable.Cell>
        {po.totalReceived} / {po.totalUnits}
      </IndexTable.Cell>
      <IndexTable.Cell>${po.totalCost.toFixed(2)}</IndexTable.Cell>
      <IndexTable.Cell>{formatDate(po.shippingDate)}</IndexTable.Cell>
      <IndexTable.Cell>{formatDate(po.expectedDate)}</IndexTable.Cell>
      <IndexTable.Cell>{formatDate(po.createdAt)}</IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      title="Purchase Orders"
      primaryAction={{
        content: "Create PO",
        url: "/app/purchase-orders/new",
      }}
    >
      <Layout>
        <Layout.Section>
          <Card padding="0">
            {purchaseOrders.length === 0 ? (
              emptyStateMarkup
            ) : (
              <IndexTable
                resourceName={resourceName}
                itemCount={purchaseOrders.length}
                headings={[
                  { title: "PO Number" },
                  { title: "Vendor" },
                  { title: "Status" },
                  { title: "Units" },
                  { title: "Received" },
                  { title: "Total Cost" },
                  { title: "Ship By" },
                  { title: "Expected" },
                  { title: "Created" },
                ]}
                selectable={false}
              >
                {rowMarkup}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
