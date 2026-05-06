import { useCallback, useMemo, useState } from "react";
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
  type POSummary,
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

// Column-index → comparator. Mirror the headings array order — adding or
// reordering columns here means updating the headings list below to match.
const SORT_COMPARATORS: Array<(a: POSummary, b: POSummary) => number> = [
  // 0: PO (name preferred, fall back to poNumber)
  (a, b) => (a.name || a.poNumber).localeCompare(b.name || b.poNumber),
  // 1: Vendor
  (a, b) => (a.vendor || "").localeCompare(b.vendor || ""),
  // 2: Status
  (a, b) => a.status.localeCompare(b.status),
  // 3: Paid (paid first when ascending)
  (a, b) => Number(!!b.paidAt) - Number(!!a.paidAt),
  // 4: Units
  (a, b) => a.totalUnits - b.totalUnits,
  // 5: Received (% so a 50/100 PO sorts above 5/5 — partial fulfillment urgency)
  (a, b) => {
    const pa = a.totalUnits > 0 ? a.totalReceived / a.totalUnits : 0;
    const pb = b.totalUnits > 0 ? b.totalReceived / b.totalUnits : 0;
    return pa - pb;
  },
  // 6: Total Cost
  (a, b) => a.totalCost - b.totalCost,
  // 7: Ship By (nulls last when ascending)
  (a, b) => dateAsc(a.shippingDate, b.shippingDate),
  // 8: Expected
  (a, b) => dateAsc(a.expectedDate, b.expectedDate),
  // 9: Created
  (a, b) => dateAsc(a.createdAt, b.createdAt),
];

function dateAsc(
  a: Date | string | null | undefined,
  b: Date | string | null | undefined,
): number {
  // Null / missing dates sort after real dates in ascending order so an
  // empty Ship By doesn't claim the top of the list.
  const ta = a ? new Date(a).getTime() : Number.POSITIVE_INFINITY;
  const tb = b ? new Date(b).getTime() : Number.POSITIVE_INFINITY;
  return ta - tb;
}

export default function PurchaseOrdersList() {
  const { purchaseOrders } = useLoaderData<typeof loader>();
  const paidFetcher = useFetcher<typeof action>();
  // Default sort: created date descending (matches the previous behavior
  // when summaries came back orderBy createdAt desc).
  const [sortIndex, setSortIndex] = useState<number>(9);
  const [sortDir, setSortDir] = useState<"ascending" | "descending">(
    "descending",
  );

  const sortedPOs = useMemo(() => {
    const cmp = SORT_COMPARATORS[sortIndex];
    if (!cmp) return purchaseOrders;
    const out = [...purchaseOrders].sort(cmp);
    if (sortDir === "descending") out.reverse();
    return out;
  }, [purchaseOrders, sortIndex, sortDir]);

  const handleSort = useCallback(
    (index: number, direction: "ascending" | "descending") => {
      setSortIndex(index);
      setSortDir(direction);
    },
    [],
  );

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

  const rowMarkup = sortedPOs.map((po, index) => (
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
          content: "Import PDF / image",
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
                // Sortable columns — every column index here has a matching
                // comparator in SORT_COMPARATORS. Click a header to sort.
                sortable={[
                  true, // PO
                  true, // Vendor
                  true, // Status
                  true, // Paid
                  true, // Units
                  true, // Received
                  true, // Total Cost
                  true, // Ship By
                  true, // Expected
                  true, // Created
                ]}
                sortColumnIndex={sortIndex}
                sortDirection={sortDir}
                onSort={handleSort}
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
