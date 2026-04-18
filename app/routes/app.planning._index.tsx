import { useCallback, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
  useSubmit,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Select,
  Button,
  Banner,
  Checkbox,
  Badge,
  ButtonGroup,
  Divider,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import {
  getPlanningTable,
  rebuildPlanningSnapshots,
  type PlanningTableRow,
} from "../services/planning/planning-service.server";
import { syncSalesData } from "../services/buy-planner/sales-sync.server";
import { createPurchaseOrder } from "../services/purchase-orders/po-service.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const vendor = url.searchParams.get("vendor");
  const coverage = parseFloat(url.searchParams.get("coverage") ?? "1.0");

  const rows = await getPlanningTable(admin, session.shop, {
    periodDays: 365,
    coverageMultiplier: Number.isFinite(coverage) ? coverage : 1.0,
    vendorFilter: vendor || null,
  });

  const syncStatus = await db.syncStatus.findUnique({
    where: { shop: session.shop },
  });

  const vendors = [
    ...new Set(
      rows
        .map((r) => r.vendor)
        .filter((v): v is string => !!v),
    ),
  ].sort();

  return json({ rows, syncStatus, vendors });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  try {
    if (intent === "sync") {
      await syncSalesData(admin, session.shop);
      await rebuildPlanningSnapshots(admin, session.shop);
      return json({ ok: true as const, message: "Sales data refreshed." });
    }
    if (intent === "rebuild") {
      const { variants } = await rebuildPlanningSnapshots(
        admin,
        session.shop,
      );
      return json({
        ok: true as const,
        message: `Planning snapshots rebuilt for ${variants} variants.`,
      });
    }
    if (intent === "createPO") {
      const vendor = (formData.get("vendor") as string) || undefined;
      const linesJson = String(formData.get("lines") ?? "[]");
      const lines = JSON.parse(linesJson) as Array<{
        shopifyProductId: string;
        shopifyVariantId: string;
        productTitle: string;
        variantTitle: string;
        sku: string | null;
        quantityOrdered: number;
      }>;
      if (lines.length === 0) {
        return json({ error: "No lines selected." });
      }
      const po = await createPurchaseOrder(session.shop, {
        vendor,
        lineItems: lines.map((li) => ({
          shopifyProductId: li.shopifyProductId,
          shopifyVariantId: li.shopifyVariantId,
          productTitle: li.productTitle,
          variantTitle: li.variantTitle,
          sku: li.sku,
          unitCost: 0,
          retailPrice: 0,
          quantityOrdered: li.quantityOrdered,
        })),
      });
      throw redirect(`/app/purchase-orders/${po.id}`);
    }
  } catch (error) {
    if (error instanceof Response) throw error;
    return json({ error: String(error) });
  }
  return json({});
};

type SortKey =
  | "productTitle"
  | "unitsSold"
  | "unitsSoldPriorYear"
  | "currentStock"
  | "suggestedOrder";

export default function Planning() {
  const { rows, syncStatus, vendors } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isBusy = navigation.state === "submitting";
  const [searchParams, setSearchParams] = useSearchParams();

  const vendorFilter = searchParams.get("vendor") ?? "";
  const coverage = parseFloat(searchParams.get("coverage") ?? "1.0");

  const [search, setSearch] = useState("");
  const [hideNoSales, setHideNoSales] = useState(false);
  const [onlyOOS, setOnlyOOS] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("suggestedOrder");
  const [sortDesc, setSortDesc] = useState(true);

  // Per-row order qty (user-editable, starts from suggested)
  const [orderQty, setOrderQty] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const r of rows) init[r.variantId] = r.suggestedOrder;
    return init;
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Filter + sort
  const filtered = useMemo(() => {
    let list: PlanningTableRow[] = [...rows];
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (r) =>
          r.productTitle.toLowerCase().includes(q) ||
          r.variantTitle.toLowerCase().includes(q) ||
          (r.sku ?? "").toLowerCase().includes(q),
      );
    }
    if (hideNoSales) {
      list = list.filter(
        (r) => r.unitsSold > 0 || r.unitsSoldPriorYear > 0,
      );
    }
    if (onlyOOS) {
      list = list.filter((r) => r.currentStock === 0);
    }
    list.sort((a, b) => {
      const av = a[sortKey as keyof PlanningTableRow];
      const bv = b[sortKey as keyof PlanningTableRow];
      if (typeof av === "string" && typeof bv === "string") {
        return sortDesc ? bv.localeCompare(av) : av.localeCompare(bv);
      }
      const aN = Number(av);
      const bN = Number(bv);
      return sortDesc ? bN - aN : aN - bN;
    });
    return list;
  }, [rows, search, hideNoSales, onlyOOS, sortKey, sortDesc]);

  const setParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(searchParams);
      if (value) next.set(key, value);
      else next.delete(key);
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const handleSync = useCallback(() => {
    if (
      !window.confirm(
        "Refresh sales data from Shopify? This can take a minute.",
      )
    )
      return;
    const fd = new FormData();
    fd.set("intent", "sync");
    submit(fd, { method: "post" });
  }, [submit]);

  const handleRebuild = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "rebuild");
    submit(fd, { method: "post" });
  }, [submit]);

  const handleQtyChange = useCallback(
    (variantId: string, val: string) => {
      setOrderQty((prev) => ({
        ...prev,
        [variantId]: Math.max(0, parseInt(val, 10) || 0),
      }));
    },
    [],
  );

  const handleToggle = useCallback((variantId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(variantId)) next.delete(variantId);
      else next.add(variantId);
      return next;
    });
  }, []);

  const selectedLines = useMemo(
    () =>
      rows
        .filter(
          (r) => selected.has(r.variantId) && (orderQty[r.variantId] ?? 0) > 0,
        )
        .map((r) => ({
          shopifyProductId: r.productId,
          shopifyVariantId: r.variantId,
          productTitle: r.productTitle,
          variantTitle: r.variantTitle,
          sku: r.sku,
          quantityOrdered: orderQty[r.variantId] ?? 0,
        })),
    [rows, selected, orderQty],
  );

  // Selected vendors — if all selected rows share a vendor, prefill it on the PO
  const selectedVendors = useMemo(() => {
    const set = new Set(
      rows
        .filter((r) => selected.has(r.variantId))
        .map((r) => r.vendor)
        .filter((v): v is string => !!v),
    );
    return set;
  }, [rows, selected]);

  const handleCreatePO = useCallback(() => {
    if (selectedLines.length === 0) return;
    const fd = new FormData();
    fd.set("intent", "createPO");
    if (selectedVendors.size === 1) {
      fd.set("vendor", [...selectedVendors][0]);
    }
    fd.set("lines", JSON.stringify(selectedLines));
    submit(fd, { method: "post" });
  }, [selectedLines, selectedVendors, submit]);

  const handleSortClick = (key: SortKey) => {
    if (key === sortKey) setSortDesc((v) => !v);
    else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  const lastSyncDate = syncStatus?.lastSyncAt
    ? new Date(syncStatus.lastSyncAt)
    : null;

  return (
    <Page
      title="Planning"
      subtitle="Buy planning grounded in YoY sales, OOS-adjusted velocity, and current stock"
    >
      <Layout>
        {actionData && "ok" in actionData && (
          <Layout.Section>
            <Banner tone="success">
              {"message" in actionData
                ? String(actionData.message)
                : "Saved."}
            </Banner>
          </Layout.Section>
        )}
        {actionData && "error" in actionData && (
          <Layout.Section>
            <Banner tone="critical">{actionData.error as string}</Banner>
          </Layout.Section>
        )}

        {/* Sync + controls */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" wrap>
                <BlockStack gap="050">
                  <Text as="p" variant="bodyMd" fontWeight="medium">
                    Sales data
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Last synced:{" "}
                    {lastSyncDate
                      ? lastSyncDate.toLocaleString()
                      : "never — run a sync to get started"}
                  </Text>
                </BlockStack>
                <ButtonGroup>
                  <Button onClick={handleRebuild} loading={isBusy}>
                    Rebuild snapshots
                  </Button>
                  <Button
                    variant="primary"
                    onClick={handleSync}
                    loading={isBusy}
                  >
                    Sync now
                  </Button>
                </ButtonGroup>
              </InlineStack>

              <Divider />

              <InlineStack gap="300" wrap>
                <div style={{ minWidth: "260px", flex: 1 }}>
                  <TextField
                    label="Search"
                    labelHidden
                    value={search}
                    onChange={setSearch}
                    placeholder="Filter by product, variant, or SKU…"
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={() => setSearch("")}
                  />
                </div>
                <Select
                  label="Vendor"
                  labelInline
                  options={[
                    { label: "All vendors", value: "" },
                    ...vendors.map((v) => ({ label: v, value: v })),
                  ]}
                  value={vendorFilter}
                  onChange={(v) => setParam("vendor", v)}
                />
                <Select
                  label="Coverage"
                  labelInline
                  options={[
                    { label: "1.0× YoY", value: "1" },
                    { label: "1.25× YoY", value: "1.25" },
                    { label: "1.5× YoY", value: "1.5" },
                    { label: "0.75× YoY", value: "0.75" },
                  ]}
                  value={String(coverage)}
                  onChange={(v) => setParam("coverage", v)}
                />
                <Checkbox
                  label="Hide no-sales"
                  checked={hideNoSales}
                  onChange={setHideNoSales}
                />
                <Checkbox
                  label="Only OOS"
                  checked={onlyOOS}
                  onChange={setOnlyOOS}
                />
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Table */}
        <Layout.Section>
          <Card padding="0">
            {filtered.length === 0 ? (
              <Banner tone="info" title="No rows to show">
                {rows.length === 0
                  ? "No planning snapshots yet — click Sync now to pull sales data, then Rebuild snapshots."
                  : "Your filters hid everything. Clear filters to see all rows."}
              </Banner>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "13px",
                  }}
                >
                  <thead>
                    <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                      <th style={{ padding: "8px", width: "32px" }}></th>
                      <th
                        style={{
                          padding: "8px",
                          textAlign: "left",
                          cursor: "pointer",
                        }}
                        onClick={() => handleSortClick("productTitle")}
                      >
                        Product / Variant
                      </th>
                      <th style={{ padding: "8px", textAlign: "left" }}>
                        Tags
                      </th>
                      <th
                        style={{
                          padding: "8px",
                          textAlign: "right",
                          cursor: "pointer",
                        }}
                        onClick={() => handleSortClick("currentStock")}
                      >
                        Stock
                      </th>
                      <th style={{ padding: "8px", textAlign: "right" }}>
                        On order
                      </th>
                      <th
                        style={{
                          padding: "8px",
                          textAlign: "right",
                          cursor: "pointer",
                        }}
                        onClick={() => handleSortClick("unitsSold")}
                      >
                        Sold (yr)
                      </th>
                      <th
                        style={{
                          padding: "8px",
                          textAlign: "right",
                          cursor: "pointer",
                        }}
                        onClick={() => handleSortClick("unitsSoldPriorYear")}
                      >
                        Sold PY
                      </th>
                      <th style={{ padding: "8px", textAlign: "right" }}>
                        Days OOS
                      </th>
                      <th style={{ padding: "8px", textAlign: "right" }}>
                        Adj sold
                      </th>
                      <th
                        style={{
                          padding: "8px",
                          textAlign: "right",
                          cursor: "pointer",
                        }}
                        onClick={() => handleSortClick("suggestedOrder")}
                      >
                        Suggested
                      </th>
                      <th
                        style={{
                          padding: "8px",
                          textAlign: "right",
                          width: "90px",
                        }}
                      >
                        Order qty
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => {
                      const isSel = selected.has(r.variantId);
                      return (
                        <tr
                          key={r.variantId}
                          style={{
                            borderBottom: "1px solid #f1f1f1",
                            background: isSel ? "#f0f7ff" : undefined,
                          }}
                        >
                          <td style={{ padding: "4px 8px" }}>
                            <Checkbox
                              label=""
                              labelHidden
                              checked={isSel}
                              onChange={() => handleToggle(r.variantId)}
                            />
                          </td>
                          <td style={{ padding: "8px" }}>
                            <Text as="p" variant="bodyMd" fontWeight="medium">
                              {r.productTitle}
                            </Text>
                            <Text as="p" variant="bodySm" tone="subdued">
                              {r.variantTitle}
                              {r.sku ? ` · ${r.sku}` : ""}
                              {r.vendor ? ` · ${r.vendor}` : ""}
                            </Text>
                          </td>
                          <td style={{ padding: "8px" }}>
                            <InlineStack gap="100" wrap>
                              {r.tags.slice(0, 3).map((t) => (
                                <Badge key={t}>{t}</Badge>
                              ))}
                              {r.tags.length > 3 && (
                                <Text
                                  as="span"
                                  variant="bodySm"
                                  tone="subdued"
                                >
                                  +{r.tags.length - 3}
                                </Text>
                              )}
                            </InlineStack>
                          </td>
                          <td
                            style={{ padding: "8px", textAlign: "right" }}
                            title={Object.entries(r.stockByLocation)
                              .map(([l, q]) => `${l.slice(-5)}: ${q}`)
                              .join("\n")}
                          >
                            {r.currentStock}
                          </td>
                          <td style={{ padding: "8px", textAlign: "right" }}>
                            {r.onOrder > 0 ? r.onOrder : "—"}
                          </td>
                          <td style={{ padding: "8px", textAlign: "right" }}>
                            {r.unitsSold}
                          </td>
                          <td style={{ padding: "8px", textAlign: "right" }}>
                            {r.unitsSoldPriorYear}
                          </td>
                          <td style={{ padding: "8px", textAlign: "right" }}>
                            {r.daysOOS > 0 ? r.daysOOS : "—"}
                          </td>
                          <td style={{ padding: "8px", textAlign: "right" }}>
                            {r.adjustedUnitsSold}
                          </td>
                          <td
                            style={{
                              padding: "8px",
                              textAlign: "right",
                              fontWeight: 600,
                            }}
                          >
                            {r.suggestedOrder}
                          </td>
                          <td style={{ padding: "2px 4px" }}>
                            <TextField
                              label=""
                              labelHidden
                              type="number"
                              min={0}
                              value={String(
                                orderQty[r.variantId] ?? r.suggestedOrder,
                              )}
                              onChange={(val) =>
                                handleQtyChange(r.variantId, val)
                              }
                              autoComplete="off"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </Layout.Section>

        {/* Action bar */}
        {selected.size > 0 && (
          <Layout.Section>
            <Card>
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="050">
                  <Text as="p" variant="bodyMd" fontWeight="medium">
                    {selected.size} variant{selected.size !== 1 ? "s" : ""}{" "}
                    selected ·{" "}
                    {selectedLines.reduce(
                      (s, l) => s + l.quantityOrdered,
                      0,
                    )}{" "}
                    units
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {selectedVendors.size === 1
                      ? `All from ${[...selectedVendors][0]} — vendor will be prefilled.`
                      : selectedVendors.size > 1
                        ? `${selectedVendors.size} vendors selected — PO will have no vendor. Filter by a single vendor first if that's wrong.`
                        : ""}
                  </Text>
                </BlockStack>
                <ButtonGroup>
                  <Button onClick={() => setSelected(new Set())}>
                    Clear
                  </Button>
                  <Button
                    variant="primary"
                    onClick={handleCreatePO}
                    loading={isBusy}
                    disabled={selectedLines.length === 0}
                  >
                    Create PO from selection
                  </Button>
                </ButtonGroup>
              </InlineStack>
            </Card>
          </Layout.Section>
        )}
        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
