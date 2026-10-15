import { useCallback, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useFetcher,
  useLoaderData,
  useSearchParams,
  Link,
} from "@remix-run/react";
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
  InlineStack,
  Select,
  TextField,
  Button,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import {
  getPurchaseOrderSummaries,
  setPurchaseOrderPaid,
  setPurchaseOrderPrinted,
  type POSummary,
} from "../services/purchase-orders/po-service.server";
import { getLocations } from "../services/shopify-api/locations.server";
import {
  PO_STATUSES,
  PO_STATUS_LABELS,
  PO_STATUS_TONES,
} from "../utils/constants";
import { shortLocationLabel } from "../utils/locations";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [purchaseOrders, locations] = await Promise.all([
    getPurchaseOrderSummaries(session.shop),
    getLocations(admin, session.shop).catch(() => []),
  ]);
  // Only id → short label ("TB", "MHD") is needed for the Store column
  // and filter.
  return json({
    purchaseOrders,
    stores: locations.map((l) => ({ id: l.id, label: shortLocationLabel(l.name) })),
  });
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
  if (intent === "togglePrinted") {
    const id = String(formData.get("id"));
    const printed = formData.get("printed") === "1";
    try {
      await setPurchaseOrderPrinted(session.shop, id, printed);
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
// `null` = not sortable (the Store column — there are only two stores,
// and the Store filter covers it).
const SORT_COMPARATORS: Array<((a: POSummary, b: POSummary) => number) | null> = [
  // 0: PO (name preferred, fall back to poNumber)
  (a, b) => (a.name || a.poNumber).localeCompare(b.name || b.poNumber),
  // 1: Vendor
  (a, b) => (a.vendor || "").localeCompare(b.vendor || ""),
  // 2: Store
  null,
  // 3: Status
  (a, b) => a.status.localeCompare(b.status),
  // 4: Paid (paid first when ascending)
  (a, b) => Number(!!b.paidAt) - Number(!!a.paidAt),
  // 5: Printed (printed first when ascending)
  (a, b) => Number(!!b.printedAt) - Number(!!a.printedAt),
  // 6: Units
  (a, b) => a.totalUnits - b.totalUnits,
  // 7: Received (% so a 50/100 PO sorts above 5/5 — partial fulfillment urgency)
  (a, b) => {
    const pa = a.totalUnits > 0 ? a.totalReceived / a.totalUnits : 0;
    const pb = b.totalUnits > 0 ? b.totalReceived / b.totalUnits : 0;
    return pa - pb;
  },
  // 8: Total Cost
  (a, b) => a.totalCost - b.totalCost,
  // 9: Ship By (nulls last when ascending)
  (a, b) => dateAsc(a.shippingDate, b.shippingDate),
  // 10: Expected
  (a, b) => dateAsc(a.expectedDate, b.expectedDate),
  // 11: Created
  (a, b) => dateAsc(a.createdAt, b.createdAt),
];
const CREATED_COLUMN = 11;

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
  const { purchaseOrders, stores } = useLoaderData<typeof loader>();
  const paidFetcher = useFetcher<typeof action>();
  const printedFetcher = useFetcher<typeof action>();
  // Default sort: created date descending (matches the previous behavior
  // when summaries came back orderBy createdAt desc).
  const [sortIndex, setSortIndex] = useState<number>(CREATED_COLUMN);
  const [sortDir, setSortDir] = useState<"ascending" | "descending">(
    "descending",
  );

  // Filters live in the URL so a filtered view survives reloads and
  // back-navigation from a PO. Store matches on short label so "TB"
  // covers every location that abbreviates to TB.
  const [searchParams, setSearchParams] = useSearchParams();
  const storeFilter = searchParams.get("store") ?? "";
  const statusFilter = searchParams.get("status") ?? "";
  const vendorFilter = searchParams.get("vendor") ?? "";
  const appliedSearch = searchParams.get("q") ?? "";
  const [searchDraft, setSearchDraft] = useState(appliedSearch);
  const setParam = useCallback(
    (key: string, value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(key, value);
          else next.delete(key);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const storeLabelById = useMemo(
    () => new Map(stores.map((s) => [s.id, s.label])),
    [stores],
  );
  const storeOptions = useMemo(
    () => [...new Set(stores.map((s) => s.label))].sort(),
    [stores],
  );
  const vendorOptions = useMemo(
    () =>
      [...new Set(purchaseOrders.map((po) => po.vendor).filter(Boolean) as string[])].sort(
        (a, b) => a.localeCompare(b),
      ),
    [purchaseOrders],
  );

  const filteredPOs = useMemo(() => {
    const q = appliedSearch.trim().toLowerCase();
    return purchaseOrders.filter((po) => {
      if (storeFilter) {
        const label = po.shopifyLocationId
          ? storeLabelById.get(po.shopifyLocationId)
          : undefined;
        if (label !== storeFilter) return false;
      }
      if (statusFilter && po.status !== statusFilter) return false;
      if (vendorFilter && po.vendor !== vendorFilter) return false;
      if (q) {
        const haystack = [po.name, po.poNumber, po.poNumberExt, po.vendor]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [purchaseOrders, storeFilter, statusFilter, vendorFilter, appliedSearch, storeLabelById]);
  const hasFilters = !!(storeFilter || statusFilter || vendorFilter || appliedSearch);

  const sortedPOs = useMemo(() => {
    const cmp = SORT_COMPARATORS[sortIndex];
    if (!cmp) return filteredPOs;
    const out = [...filteredPOs].sort(cmp);
    if (sortDir === "descending") out.reverse();
    return out;
  }, [filteredPOs, sortIndex, sortDir]);

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

  const handleTogglePrinted = useCallback(
    (id: string, currentlyPrinted: boolean) => {
      const fd = new FormData();
      fd.set("intent", "togglePrinted");
      fd.set("id", id);
      fd.set("printed", currentlyPrinted ? "0" : "1");
      printedFetcher.submit(fd, { method: "post" });
    },
    [printedFetcher],
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
        {(po.shopifyLocationId && storeLabelById.get(po.shopifyLocationId)) || "—"}
      </IndexTable.Cell>
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
      <IndexTable.Cell>
        <div onClick={(e) => e.stopPropagation()}>
          <Checkbox
            label={po.printedAt ? "Printed" : "Not printed"}
            labelHidden
            checked={!!po.printedAt}
            onChange={() => handleTogglePrinted(po.id, !!po.printedAt)}
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
        {purchaseOrders.length > 0 && (
          <Layout.Section>
            <Card>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setParam("q", searchDraft.trim());
                }}
              >
                <InlineStack gap="300" wrap blockAlign="center">
                  <div style={{ flex: 1, minWidth: "260px" }}>
                    <TextField
                      label="Search"
                      labelHidden
                      value={searchDraft}
                      onChange={setSearchDraft}
                      placeholder="Search PO #, name, vendor…"
                      autoComplete="off"
                      clearButton
                      onClearButtonClick={() => {
                        setSearchDraft("");
                        setParam("q", "");
                      }}
                    />
                  </div>
                  <Button submit>Search</Button>
                  <Select
                    label="Store"
                    labelInline
                    options={[
                      { label: "Both", value: "" },
                      ...storeOptions.map((l) => ({ label: l, value: l })),
                    ]}
                    value={storeFilter}
                    onChange={(v) => setParam("store", v)}
                  />
                  <Select
                    label="Status"
                    labelInline
                    options={[
                      { label: "All", value: "" },
                      ...Object.values(PO_STATUSES).map((st) => ({
                        label: PO_STATUS_LABELS[st] ?? st,
                        value: st,
                      })),
                    ]}
                    value={statusFilter}
                    onChange={(v) => setParam("status", v)}
                  />
                  <Select
                    label="Vendor"
                    labelInline
                    options={[
                      { label: "All vendors", value: "" },
                      ...vendorOptions.map((v) => ({ label: v, value: v })),
                    ]}
                    value={vendorFilter}
                    onChange={(v) => setParam("vendor", v)}
                  />
                  {hasFilters && (
                    <Button
                      variant="plain"
                      onClick={() => {
                        setSearchDraft("");
                        setSearchParams(new URLSearchParams(), { replace: true });
                      }}
                    >
                      Clear filters
                    </Button>
                  )}
                </InlineStack>
              </form>
            </Card>
          </Layout.Section>
        )}
        <Layout.Section>
          <Card padding="0">
            {purchaseOrders.length === 0 ? (
              emptyStateMarkup
            ) : (
              <IndexTable
                resourceName={resourceName}
                itemCount={sortedPOs.length}
                // Sortable columns — every column index here has a matching
                // comparator in SORT_COMPARATORS. Click a header to sort.
                sortable={[
                  true, // PO
                  true, // Vendor
                  false, // Store
                  true, // Status
                  true, // Paid
                  true, // Printed
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
                  { title: "Store" },
                  { title: "Status" },
                  { title: "Paid" },
                  { title: "Printed" },
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
