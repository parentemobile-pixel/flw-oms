import { useCallback } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, Link } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Badge,
  Text,
  EmptyState,
  Checkbox,
  BlockStack,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import {
  getPurchaseOrderSummaries,
  setPurchaseOrderPaid,
} from "../services/purchase-orders/po-service.server";
import { PO_STATUS_LABELS, PO_STATUS_TONES } from "../utils/constants";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const purchaseOrders = await getPurchaseOrderSummaries(session.shop);
  return json({ purchaseOrders });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  if (intent === "togglePaid") {
    const id = String(formData.get("id"));
    const paid = formData.get("paid") === "1";
    try {
      await setPurchaseOrderPaid(session.shop, id, paid);
      return json({ ok: true as const });
    } catch (error) {
      return json({ error: String(error) }, { status: 400 });
    }
  }
  return json({});
};

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return new Date(date).toLocaleDateString();
}

export default function PurchaseOrdersList() {
  const { purchaseOrders } = useLoaderData<typeof loader>();
  const paidFetcher = useFetcher<typeof action>();

  const handleTogglePaid = useCallback(
    (id: string, currentlyPaid: boolean) => {
      const fd = new FormData();
      fd.set("intent", "togglePaid");
      fd.set("id", id);
      fd.set("paid", currentlyPaid ? "0" : "1");
      paidFetcher.submit(fd, { method: "post" });
    },
    [paidFetcher],
  );

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
          <BlockStack gap="050">
            <Text variant="bodyMd" fontWeight="bold" as="span">
              {po.name || po.poNumber}
            </Text>
            {/* Always show the PO number as a secondary line so it's
                still scannable even when the user gave the PO a name. */}
            {po.name && (
              <Text variant="bodySm" tone="subdued" as="span">
                {po.poNumber}
              </Text>
            )}
          </BlockStack>
        </Link>
      </IndexTable.Cell>
      <IndexTable.Cell>{po.vendor || "—"}</IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={PO_STATUS_TONES[po.status] || "info"}>
          {PO_STATUS_LABELS[po.status] || po.status}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {/* Stop click bubbling so toggling Paid doesn't also navigate
            into the detail page (the cell is inside an IndexTable.Row,
            which makes the whole row clickable). */}
        <div onClick={(e) => e.stopPropagation()}>
          <Checkbox
            label={po.paidAt ? "Paid" : "Unpaid"}
            labelHidden
            checked={!!po.paidAt}
            onChange={() => handleTogglePaid(po.id, !!po.paidAt)}
          />
        </div>
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
      secondaryActions={[
        {
          content: "Import PDF",
          url: "/app/purchase-orders/import",
        },
      ]}
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
                  { title: "PO" },
                  { title: "Vendor" },
                  { title: "Status" },
                  { title: "Paid" },
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
