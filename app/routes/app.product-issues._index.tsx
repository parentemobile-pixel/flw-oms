import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useFetcher,
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
  Badge,
  Button,
  ButtonGroup,
  Banner,
  Checkbox,
  Divider,
  Icon,
  Modal,
  Tabs,
  EmptyState,
  Spinner,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import {
  archiveProducts,
  fixDuplicateBarcodes,
  fixMissingBarcodes,
  getProductIssuesReport,
  saveMissingCosts,
  scanProductIssues,
  setNegativeStock,
  type NegativeStockRow,
  type ProductIssuesReport,
  type SetStockTarget,
} from "../services/products/product-issues.server";
import type { AuditVariant } from "../services/shopify-api/products.server";
import { MoneyField } from "../components/MoneyField";
import { ProductGrid, type GridCell } from "../components/ProductGrid";
import { relativeTime } from "../utils/relative-time";

const TAB_IDS = [
  "duplicate-barcodes",
  "missing-barcodes",
  "negative-stock",
  "missing-cost",
] as const;
type TabId = (typeof TAB_IDS)[number];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const report = await getProductIssuesReport(session.shop);
  return json({ report });
};

type ActionResult =
  | { ok: true; kind: "scan"; counts: ProductIssuesReport["counts"] }
  | { ok: true; kind: "setStock"; applied: number; skipped: number }
  | {
      ok: true;
      kind: "archive";
      archived: number;
      failures: Array<{ productId: string; error: string }>;
    }
  | {
      ok: true;
      kind: "saveCosts";
      updated: number;
      failures: Array<{ productId: string; error: string }>;
    }
  | {
      ok: true;
      kind: "fixMissingBarcodes" | "fixDuplicateBarcodes";
      requested: number;
      updated: number;
      failures: Array<{ variantId: string; error: string }>;
    }
  | { ok: false; error: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  try {
    if (intent === "scan") {
      const includeArchived = formData.get("includeArchived") === "1";
      const report = await scanProductIssues(admin, session.shop, {
        includeArchived,
      });
      return json<ActionResult>({ ok: true, kind: "scan", counts: report.counts });
    }

    if (intent === "setStock") {
      const targets = JSON.parse(
        String(formData.get("targets") ?? "[]"),
      ) as SetStockTarget[];
      const res = await setNegativeStock(admin, session.shop, targets, null);
      return json<ActionResult>({
        ok: true,
        kind: "setStock",
        applied: res.applied,
        skipped: res.skipped,
      });
    }

    if (intent === "archive") {
      const productIds = JSON.parse(
        String(formData.get("productIds") ?? "[]"),
      ) as string[];
      const res = await archiveProducts(admin, session.shop, productIds, null);
      return json<ActionResult>({
        ok: true,
        kind: "archive",
        archived: res.archived,
        failures: res.failures,
      });
    }

    if (intent === "saveCosts") {
      const updates = JSON.parse(String(formData.get("updates") ?? "[]")) as Array<{
        productId: string;
        variantId: string;
        cost: number;
      }>;
      const applyToProduct = formData.get("applyToProduct") === "1";
      const res = await saveMissingCosts(admin, session.shop, updates, {
        applyToProduct,
      });
      return json<ActionResult>({
        ok: true,
        kind: "saveCosts",
        updated: res.updated,
        failures: res.failures,
      });
    }

    if (intent === "fixMissingBarcodes") {
      const targets = JSON.parse(String(formData.get("targets") ?? "[]")) as Array<{
        variantId: string;
        productId: string;
      }>;
      const res = await fixMissingBarcodes(admin, session.shop, targets);
      return json<ActionResult>({ ok: true, kind: "fixMissingBarcodes", ...res });
    }

    if (intent === "fixDuplicateBarcodes") {
      const res = await fixDuplicateBarcodes(admin, session.shop);
      return json<ActionResult>({ ok: true, kind: "fixDuplicateBarcodes", ...res });
    }

    return json<ActionResult>({ ok: false, error: `Unknown action: ${intent}` });
  } catch (error) {
    return json<ActionResult>({ ok: false, error: String(error) });
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────

function numericId(gid: string): string {
  return gid.replace(/^gid:\/\/shopify\/\w+\//, "");
}
function productAdminUrl(productId: string): string {
  return `shopify:admin/products/${numericId(productId)}`;
}
function variantAdminUrl(productId: string, variantId: string): string {
  return `shopify:admin/products/${numericId(productId)}/variants/${numericId(variantId)}`;
}

function AdminLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{ color: "#005bd3", textDecoration: "none", fontWeight: 500 }}
    >
      {children}
    </a>
  );
}

function matchesFilter(v: AuditVariant, q: string): boolean {
  if (!q) return true;
  return (
    v.productTitle.toLowerCase().includes(q) ||
    v.variantTitle.toLowerCase().includes(q) ||
    (v.sku ?? "").toLowerCase().includes(q) ||
    (v.vendor ?? "").toLowerCase().includes(q) ||
    (v.barcode ?? "").toLowerCase().includes(q)
  );
}

const SIZE_TOKENS = new Set([
  "XXS", "XS", "S", "M", "L", "XL", "2XL", "XXL", "3XL", "XXXL", "4XL", "OS", "ONE SIZE",
]);

/**
 * Options for the grid. Reports scanned before `selectedOptions` was
 * added fall back to splitting the variant title on " / " and treating
 * any size-looking segment as the Size option.
 */
function optionsFor(v: AuditVariant): Array<{ name: string; value: string }> {
  if (v.selectedOptions && v.selectedOptions.length > 0) return v.selectedOptions;
  if (!v.variantTitle || v.variantTitle === "Default Title") return [];
  return v.variantTitle.split(" / ").map((seg) => {
    const t = seg.trim();
    const isSize = SIZE_TOKENS.has(t.toUpperCase()) || /^\d{1,2}$/.test(t);
    return { name: isSize ? "Size" : "Option", value: t };
  });
}

function toGridCell(v: AuditVariant, value: number | null): GridCell {
  return {
    variantId: v.variantId,
    productId: v.productId,
    productTitle: v.productTitle,
    variantTitle: v.variantTitle,
    selectedOptions: optionsFor(v),
    sku: v.sku,
    value,
  };
}

function rowKeyOf(cells: GridCell[]): string {
  const first = cells[0];
  if (!first) return "";
  const nonSize = first.selectedOptions
    .filter((o) => o.name.toLowerCase() !== "size")
    .map((o) => o.value)
    .join(" / ");
  return `${first.productId}::${nonSize}`;
}

const GRID_SIZES = ["XS", "S", "M", "L", "XL", "2XL"];
const ROW_LIMIT = 150; // cells per page — keeps the DOM light on big lists

const th: React.CSSProperties = { padding: "6px 8px", textAlign: "left" };
const td: React.CSSProperties = { padding: "6px 8px", verticalAlign: "middle" };

// ─── Page ─────────────────────────────────────────────────────────────

export default function ProductIssues() {
  const { report } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();

  const submittingIntent =
    navigation.state !== "idle"
      ? String(navigation.formData?.get("intent") ?? "")
      : "";
  const isScanning = submittingIntent === "scan";
  const isBusy = navigation.state !== "idle";

  const tabParam = searchParams.get("tab") as TabId | null;
  const selectedTab = Math.max(
    0,
    TAB_IDS.indexOf(tabParam ?? "duplicate-barcodes"),
  );
  const selectTab = useCallback(
    (i: number) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("tab", TAB_IDS[i]);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const [includeArchived, setIncludeArchived] = useState(
    report?.includeArchived ?? false,
  );
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();

  const handleScan = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "scan");
    fd.set("includeArchived", includeArchived ? "1" : "0");
    submit(fd, { method: "post" });
  }, [includeArchived, submit]);

  const counts = report?.counts;
  const tabs = [
    {
      id: "duplicate-barcodes",
      content: `Duplicate barcodes${counts ? ` (${counts.duplicateGroups})` : ""}`,
    },
    {
      id: "missing-barcodes",
      content: `Missing barcodes${counts ? ` (${counts.missingBarcodes})` : ""}`,
    },
    {
      id: "negative-stock",
      content: `Negative stock${counts ? ` (${counts.negativeStock})` : ""}`,
    },
    {
      id: "missing-cost",
      content: `Missing cost${counts ? ` (${counts.missingCost})` : ""}`,
    },
  ];

  return (
    <Page
      title="Product Issues"
      subtitle={
        report
          ? `Last scan ${relativeTime(report.scannedAt)} · ${report.counts.variants} variants${
              report.includeArchived ? " (incl. archived)" : ""
            }`
          : "Find and fix duplicate / missing barcodes, negative stock and missing cost"
      }
      primaryAction={{
        content: report ? "Rescan" : "Run scan",
        onAction: handleScan,
        loading: isScanning,
        disabled: isBusy,
      }}
    >
      <Layout>
        {isScanning && (
          <Layout.Section>
            <Banner tone="info">
              <InlineStack gap="200" blockAlign="center">
                <Spinner size="small" />
                <Text as="span">
                  Scanning the catalog and every location&apos;s inventory — this
                  can take a minute on a large store.
                </Text>
              </InlineStack>
            </Banner>
          </Layout.Section>
        )}
        {!isScanning && actionData && <ResultBanner result={actionData} />}

        {/* Scan options + summary */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center" wrap>
                <Checkbox
                  label="Include archived products in the scan"
                  checked={includeArchived}
                  onChange={setIncludeArchived}
                  disabled={isBusy}
                />
                {report && (
                  <div style={{ minWidth: "260px" }}>
                    <TextField
                      label="Filter"
                      labelHidden
                      value={filter}
                      onChange={setFilter}
                      placeholder="Filter by product, SKU, vendor…"
                      autoComplete="off"
                      prefix={<Icon source={SearchIcon} />}
                      clearButton
                      onClearButtonClick={() => setFilter("")}
                    />
                  </div>
                )}
              </InlineStack>
              {counts && (
                <>
                  <Divider />
                  <InlineStack gap="600" wrap>
                    <SummaryStat label="Variants scanned" value={counts.variants} />
                    <SummaryStat
                      label="Duplicate groups"
                      value={counts.duplicateGroups}
                      tone={counts.duplicateGroups > 0 ? "warning" : "success"}
                    />
                    <SummaryStat
                      label="Missing barcode"
                      value={counts.missingBarcodes}
                      tone={counts.missingBarcodes > 0 ? "critical" : "success"}
                    />
                    <SummaryStat
                      label="Negative stock"
                      value={counts.negativeStock}
                      tone={counts.negativeStock > 0 ? "critical" : "success"}
                    />
                    <SummaryStat
                      label="Missing cost"
                      value={counts.missingCost}
                      tone={counts.missingCost > 0 ? "warning" : "success"}
                    />
                  </InlineStack>
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          {!report ? (
            <Card>
              <EmptyState
                heading="No scan yet"
                image=""
                action={{
                  content: "Run scan",
                  onAction: handleScan,
                  loading: isScanning,
                }}
              >
                <Text as="p">
                  Walks every product and its inventory at each location, then
                  groups the problems so you can fix them one by one.
                </Text>
              </EmptyState>
            </Card>
          ) : (
            <Card padding="0">
              <Tabs tabs={tabs} selected={selectedTab} onSelect={selectTab}>
                <div style={{ padding: "16px" }}>
                  {TAB_IDS[selectedTab] === "duplicate-barcodes" && (
                    <DuplicatesPanel report={report} q={q} isBusy={isBusy} />
                  )}
                  {TAB_IDS[selectedTab] === "missing-barcodes" && (
                    <MissingBarcodesPanel report={report} q={q} isBusy={isBusy} />
                  )}
                  {TAB_IDS[selectedTab] === "negative-stock" && (
                    <NegativeStockPanel report={report} q={q} isBusy={isBusy} />
                  )}
                  {TAB_IDS[selectedTab] === "missing-cost" && (
                    <MissingCostPanel report={report} q={q} isBusy={isBusy} />
                  )}
                </div>
              </Tabs>
            </Card>
          )}
        </Layout.Section>

        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// ─── Result banner ────────────────────────────────────────────────────

function ResultBanner({ result }: { result: ActionResult }) {
  if (!result.ok) {
    return (
      <Layout.Section>
        <Banner tone="critical">{result.error}</Banner>
      </Layout.Section>
    );
  }
  let title = "";
  let body: string | null = null;
  let tone: "success" | "warning" = "success";
  switch (result.kind) {
    case "scan":
      title = `Scan complete — ${result.counts.variants} variants`;
      body = `${result.counts.duplicateGroups} duplicate barcode groups · ${result.counts.missingBarcodes} missing barcodes · ${result.counts.negativeStock} negative stock · ${result.counts.missingCost} missing cost`;
      break;
    case "setStock":
      title = `Adjusted ${result.applied} inventory level${result.applied === 1 ? "" : "s"}`;
      if (result.skipped > 0) {
        body = `${result.skipped} already matched the live number and were skipped.`;
        tone = "warning";
      }
      break;
    case "archive":
      title = `Archived ${result.archived} product${result.archived === 1 ? "" : "s"}`;
      if (result.failures.length > 0) {
        tone = "warning";
        body = `${result.failures.length} failed. First error: ${result.failures[0].error}`;
      }
      break;
    case "saveCosts":
      title = `Saved cost on ${result.updated} variant${result.updated === 1 ? "" : "s"}`;
      if (result.failures.length > 0) {
        tone = "warning";
        body = `${result.failures.length} product${result.failures.length === 1 ? "" : "s"} failed. First error: ${result.failures[0].error}`;
      }
      break;
    case "fixMissingBarcodes":
      title = `Generated ${result.updated} of ${result.requested} barcodes`;
      if (result.failures.length > 0) {
        tone = "warning";
        body = `First error: ${result.failures[0].error}`;
      }
      break;
    case "fixDuplicateBarcodes":
      title = `Regenerated ${result.updated} of ${result.requested} duplicate barcodes`;
      if (result.failures.length > 0) {
        tone = "warning";
        body = `First error: ${result.failures[0].error}`;
      }
      break;
  }
  return (
    <Layout.Section>
      <Banner tone={tone} title={title}>
        {body && <p>{body}</p>}
      </Banner>
    </Layout.Section>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success" | "warning" | "critical";
}) {
  return (
    <BlockStack gap="050">
      <Text as="p" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <Text
        as="p"
        variant="headingLg"
        tone={tone === "critical" ? "critical" : undefined}
      >
        {value}
      </Text>
    </BlockStack>
  );
}

// ─── Duplicate barcodes ───────────────────────────────────────────────

function DuplicatesPanel({
  report,
  q,
  isBusy,
}: {
  report: ProductIssuesReport;
  q: string;
  isBusy: boolean;
}) {
  const submit = useSubmit();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const groups = useMemo(
    () =>
      report.duplicateBarcodes.filter(
        (g) => !q || g.barcode.toLowerCase().includes(q) || g.variants.some((v) => matchesFilter(v, q)),
      ),
    [report.duplicateBarcodes, q],
  );

  if (report.duplicateBarcodes.length === 0) {
    return (
      <EmptyState heading="No duplicate barcodes" image="">
        <Text as="p">Every assigned barcode is unique.</Text>
      </EmptyState>
    );
  }

  return (
    <BlockStack gap="300">
      <InlineStack align="space-between" blockAlign="center" wrap>
        <Text as="p">
          {groups.length} of {report.duplicateBarcodes.length} group
          {report.duplicateBarcodes.length === 1 ? "" : "s"} shown. Fix by hand:
          open the variant in Shopify, give it a new barcode, then print a fresh
          label — or let the app regenerate one per group.
        </Text>
        <Button onClick={() => setConfirmOpen(true)} disabled={isBusy}>
          Auto-fix all duplicates
        </Button>
      </InlineStack>
      <Divider />
      <BlockStack gap="400">
        {groups.map((group) => (
          <Card key={group.barcode} background="bg-surface-secondary">
            <BlockStack gap="200">
              <InlineStack gap="200" blockAlign="center">
                <Badge tone="warning">{`${group.variants.length} variants share`}</Badge>
                <Text as="span" fontWeight="semibold">
                  <span style={{ fontFamily: "monospace" }}>{group.barcode}</span>
                </Text>
              </InlineStack>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                      <th style={th}>Product</th>
                      <th style={th}>Variant</th>
                      <th style={th}>SKU</th>
                      <th style={th}>Vendor</th>
                      <th style={th}>Status</th>
                      <th style={th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.variants.map((v) => (
                      <tr key={v.variantId}>
                        <td style={td}>
                          <AdminLink href={productAdminUrl(v.productId)}>
                            {v.productTitle}
                          </AdminLink>
                        </td>
                        <td style={td}>{v.variantTitle}</td>
                        <td style={td}>{v.sku || "—"}</td>
                        <td style={td}>{v.vendor || "—"}</td>
                        <td style={td}>
                          <Badge tone={v.status === "ACTIVE" ? "success" : "info"}>
                            {v.status.toLowerCase()}
                          </Badge>
                        </td>
                        <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                          <ButtonGroup>
                            <Button
                              size="slim"
                              url={variantAdminUrl(v.productId, v.variantId)}
                              target="_blank"
                            >
                              Open in Shopify
                            </Button>
                            <Button
                              size="slim"
                              url={`/app/print-labels?q=${encodeURIComponent(v.sku || v.barcode || v.productTitle)}`}
                            >
                              Print label
                            </Button>
                          </ButtonGroup>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </BlockStack>
          </Card>
        ))}
      </BlockStack>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Regenerate duplicate barcodes?"
        primaryAction={{
          content: "Fix all duplicates",
          onAction: () => {
            const fd = new FormData();
            fd.set("intent", "fixDuplicateBarcodes");
            submit(fd, { method: "post" });
            setConfirmOpen(false);
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setConfirmOpen(false) }]}
      >
        <Modal.Section>
          <Text as="p">
            In each of the {report.counts.duplicateGroups} groups one variant keeps
            the existing barcode (preferring an FLW-generated one) and the rest get
            fresh unique codes. You&apos;ll need to print new labels for the changed
            variants.
          </Text>
        </Modal.Section>
      </Modal>
    </BlockStack>
  );
}

// ─── Missing barcodes ─────────────────────────────────────────────────

function MissingBarcodesPanel({
  report,
  q,
  isBusy,
}: {
  report: ProductIssuesReport;
  q: string;
  isBusy: boolean;
}) {
  const submit = useSubmit();
  const [confirmAll, setConfirmAll] = useState(false);
  const [limit, setLimit] = useState(ROW_LIMIT);
  const rows = useMemo(
    () => report.missingBarcodes.filter((v) => matchesFilter(v, q)),
    [report.missingBarcodes, q],
  );
  const byId = useMemo(
    () => new Map(report.missingBarcodes.map((v) => [v.variantId, v])),
    [report.missingBarcodes],
  );
  const cells = useMemo(
    () => rows.slice(0, limit).map((v) => toGridCell(v, null)),
    [rows, limit],
  );

  if (report.missingBarcodes.length === 0) {
    return (
      <EmptyState heading="All variants have a barcode" image="">
        <Text as="p">Nothing to generate.</Text>
      </EmptyState>
    );
  }

  const generateAll = () => {
    const fd = new FormData();
    fd.set("intent", "fixMissingBarcodes");
    fd.set(
      "targets",
      JSON.stringify(
        report.missingBarcodes.map((v) => ({ variantId: v.variantId, productId: v.productId })),
      ),
    );
    submit(fd, { method: "post" });
    setConfirmAll(false);
  };

  return (
    <BlockStack gap="300">
      <InlineStack align="space-between" blockAlign="center" wrap>
        <Text as="p">
          {report.counts.missingBarcodes} size
          {report.counts.missingBarcodes === 1 ? "" : "s"} without a barcode.
          Generate per row, or all at once.
        </Text>
        <Button variant="primary" onClick={() => setConfirmAll(true)} disabled={isBusy}>
          {`Generate all ${report.counts.missingBarcodes}`}
        </Button>
      </InlineStack>
      <Divider />
      <ProductGrid
        cells={cells}
        qtyLabel="Barcode"
        readonly
        onCellChange={() => {}}
        showColumns={{ cost: false, retail: false, stock: false, onOrder: false }}
        sizeColumns={GRID_SIZES}
        getCellStyle={() => ({ background: "#fff4e5", boxShadow: "inset 0 0 0 1px #f0b76a" })}
        getCellSubtext={() => <span style={{ color: "#b45309" }}>missing</span>}
        stickyLeadColumn
        maxHeight="70vh"
        trailingLabel="Action"
        renderRowTrailing={({ cells: rowCells }) => (
          <BarcodeRowActions
            targets={rowCells
              .map((c) => byId.get(c.variantId))
              .filter((v): v is AuditVariant => !!v)
              .map((v) => ({ variantId: v.variantId, productId: v.productId }))}
          />
        )}
      />
      {rows.length > limit && (
        <InlineStack align="center">
          <Button onClick={() => setLimit((l) => l + ROW_LIMIT)}>
            {`Show ${Math.min(ROW_LIMIT, rows.length - limit)} more (${rows.length - limit} left)`}
          </Button>
        </InlineStack>
      )}

      <Modal
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        title="Generate barcodes for every missing size?"
        primaryAction={{ content: "Generate all", onAction: generateAll }}
        secondaryActions={[{ content: "Cancel", onAction: () => setConfirmAll(false) }]}
      >
        <Modal.Section>
          <Text as="p">
            {report.counts.missingBarcodes} variants get a fresh FLW barcode written
            to Shopify. You&apos;ll want to print labels for them afterwards.
          </Text>
        </Modal.Section>
      </Modal>
    </BlockStack>
  );
}

function BarcodeRowActions({
  targets,
}: {
  targets: Array<{ variantId: string; productId: string }>;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const run = () => {
    const fd = new FormData();
    fd.set("intent", "fixMissingBarcodes");
    fd.set("targets", JSON.stringify(targets));
    fetcher.submit(fd, { method: "post" });
  };
  return (
    <BlockStack gap="100" inlineAlign="end">
      <Button size="slim" onClick={run} loading={busy} disabled={busy || targets.length === 0}>
        {`Generate ${targets.length}`}
      </Button>
      {fetcher.data && !fetcher.data.ok && (
        <Text as="span" variant="bodySm" tone="critical">
          {fetcher.data.error}
        </Text>
      )}
    </BlockStack>
  );
}

// ─── Negative stock ───────────────────────────────────────────────────

function NegativeStockPanel({
  report,
  q,
  isBusy,
}: {
  report: ProductIssuesReport;
  q: string;
  isBusy: boolean;
}) {
  const submit = useSubmit();
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  // drafts[`${locationId}::${variantId}`] = typed new qty (default 0)
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const rows = useMemo(
    () => report.negativeStock.filter((v) => matchesFilter(v, q)),
    [report.negativeStock, q],
  );
  const byId = useMemo(
    () => new Map(report.negativeStock.map((v) => [v.variantId, v])),
    [report.negativeStock],
  );
  // One grid per location that has any negative level.
  const sections = useMemo(() => {
    const seen = new Map(report.locations.map((l) => [l.id, l.name]));
    for (const row of report.negativeStock) {
      for (const l of row.levels) if (!seen.has(l.locationId)) seen.set(l.locationId, l.locationName);
    }
    return [...seen]
      .map(([id, name]) => ({
        id,
        name,
        rows: rows.filter((r) => r.negativeLevels.some((l) => l.locationId === id)),
      }))
      .filter((s) => s.rows.length > 0);
  }, [report.locations, report.negativeStock, rows]);

  if (report.negativeStock.length === 0) {
    return (
      <EmptyState heading="No negative stock" image="">
        <Text as="p">Every location-level quantity is zero or above.</Text>
      </EmptyState>
    );
  }

  const resetAll = () => {
    const targets: SetStockTarget[] = [];
    for (const row of report.negativeStock) {
      for (const l of row.negativeLevels) {
        targets.push({ variantId: row.variantId, locationId: l.locationId, newQty: 0 });
      }
    }
    const fd = new FormData();
    fd.set("intent", "setStock");
    fd.set("targets", JSON.stringify(targets));
    submit(fd, { method: "post" });
    setConfirmResetAll(false);
  };

  return (
    <BlockStack gap="400">
      <InlineStack align="space-between" blockAlign="center" wrap>
        <Text as="p">
          {report.counts.negativeStock} size
          {report.counts.negativeStock === 1 ? "" : "s"} ·{" "}
          {report.counts.negativeLevels} location level
          {report.counts.negativeLevels === 1 ? "" : "s"} below zero. Cells are
          prefilled with 0 — type a corrected count where you know it, then
          <strong> Save row</strong>. Or archive the product.
        </Text>
        <Button tone="critical" onClick={() => setConfirmResetAll(true)} disabled={isBusy}>
          Reset all to 0
        </Button>
      </InlineStack>
      {sections.map((sec) => {
        const cells = sec.rows.map((v) => {
          const level = v.negativeLevels.find((l) => l.locationId === sec.id)!;
          const cell = toGridCell(v, drafts[`${sec.id}::${v.variantId}`] ?? 0);
          cell.stock = level.available;
          return cell;
        });
        return (
          <BlockStack key={sec.id} gap="200">
            <Divider />
            <Text as="h3" variant="headingSm">
              {sec.name} — {cells.length} size{cells.length === 1 ? "" : "s"} below zero
            </Text>
            <ProductGrid
              cells={cells}
              qtyLabel="New qty"
              onCellChange={(variantId, next) =>
                setDrafts((p) => ({ ...p, [`${sec.id}::${variantId}`]: next }))
              }
              showColumns={{ cost: false, retail: false, stock: false, onOrder: false }}
              sizeColumns={GRID_SIZES}
              getCellStyle={() => ({ background: "#fdecea", boxShadow: "inset 0 0 0 1px #e0b4b4" })}
              getCellSubtext={(cell) => (
                <span style={{ color: "#d72c0d", fontWeight: 600 }}>now {cell.stock}</span>
              )}
              stickyLeadColumn
              maxHeight="60vh"
              trailingLabel="Action"
              renderRowTrailing={({ cells: rowCells }) => {
                const first = byId.get(rowCells[0]?.variantId ?? "");
                return (
                  <NegativeRowActions
                    locationId={sec.id}
                    productId={first?.productId ?? ""}
                    productTitle={first?.productTitle ?? ""}
                    targets={rowCells.map((c) => ({
                      variantId: c.variantId,
                      locationId: sec.id,
                      newQty: drafts[`${sec.id}::${c.variantId}`] ?? 0,
                    }))}
                  />
                );
              }}
            />
          </BlockStack>
        );
      })}

      <Modal
        open={confirmResetAll}
        onClose={() => setConfirmResetAll(false)}
        title="Reset every negative level to 0?"
        primaryAction={{ content: "Reset all", destructive: true, onAction: resetAll }}
        secondaryActions={[{ content: "Cancel", onAction: () => setConfirmResetAll(false) }]}
      >
        <Modal.Section>
          <Text as="p">
            {report.counts.negativeLevels} inventory level
            {report.counts.negativeLevels === 1 ? "" : "s"} on{" "}
            {report.counts.negativeStock} variant
            {report.counts.negativeStock === 1 ? "" : "s"} will be set to 0. Each
            change is recorded as a &quot;correction&quot; adjustment.
          </Text>
        </Modal.Section>
      </Modal>
    </BlockStack>
  );
}

function NegativeRowActions({
  productId,
  productTitle,
  targets,
}: {
  locationId: string;
  productId: string;
  productTitle: string;
  targets: SetStockTarget[];
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const [confirmArchive, setConfirmArchive] = useState(false);
  const typed = targets.some((t) => t.newQty !== 0);

  const save = () => {
    const fd = new FormData();
    fd.set("intent", "setStock");
    fd.set("targets", JSON.stringify(targets));
    fetcher.submit(fd, { method: "post" });
  };
  const archive = () => {
    const fd = new FormData();
    fd.set("intent", "archive");
    fd.set("productIds", JSON.stringify([productId]));
    fetcher.submit(fd, { method: "post" });
    setConfirmArchive(false);
  };

  return (
    <BlockStack gap="100" inlineAlign="end">
      <ButtonGroup>
        <Button size="slim" variant="primary" onClick={save} loading={busy} disabled={busy}>
          {typed ? "Save row" : "Set row to 0"}
        </Button>
        <Button
          size="slim"
          tone="critical"
          variant="plain"
          onClick={() => setConfirmArchive(true)}
          disabled={busy}
        >
          Archive
        </Button>
      </ButtonGroup>
      {fetcher.data && !fetcher.data.ok && (
        <Text as="span" variant="bodySm" tone="critical">
          {fetcher.data.error}
        </Text>
      )}
      <Modal
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        title={`Archive ${productTitle}?`}
        primaryAction={{ content: "Archive product", destructive: true, onAction: archive }}
        secondaryActions={[{ content: "Cancel", onAction: () => setConfirmArchive(false) }]}
      >
        <Modal.Section>
          <Text as="p">
            Shopify archives at the product level, so every variant of{" "}
            <strong>{productTitle}</strong> will be archived and hidden from sales
            channels. Inventory numbers are left as they are.
          </Text>
        </Modal.Section>
      </Modal>
    </BlockStack>
  );
}

// ─── Missing cost ─────────────────────────────────────────────────────

function MissingCostPanel({
  report,
  q,
  isBusy,
}: {
  report: ProductIssuesReport;
  q: string;
  isBusy: boolean;
}) {
  const submit = useSubmit();
  // One cost per grid row (product + colour); applied to every size in
  // the row that's missing a cost. Keyed by row key.
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [limit, setLimit] = useState(ROW_LIMIT);
  const rows = useMemo(
    () => report.missingCost.filter((v) => matchesFilter(v, q)),
    [report.missingCost, q],
  );
  const byId = useMemo(
    () => new Map(report.missingCost.map((v) => [v.variantId, v])),
    [report.missingCost],
  );
  const cells = useMemo(
    () => rows.slice(0, limit).map((v) => toGridCell(v, null)),
    [rows, limit],
  );

  // Drop drafts whose rows no longer exist (fixed).
  useEffect(() => {
    const live = new Set<string>();
    for (const v of report.missingCost) live.add(rowKeyOf([toGridCell(v, null)]));
    setDrafts((prev) => {
      const next: Record<string, number> = {};
      for (const [k, c] of Object.entries(prev)) if (live.has(k)) next[k] = c;
      return next;
    });
  }, [report.missingCost]);

  if (report.missingCost.length === 0) {
    return (
      <EmptyState heading="Every variant has a cost" image="">
        <Text as="p">Nothing to fill in.</Text>
      </EmptyState>
    );
  }

  const editedRowKeys = Object.entries(drafts)
    .filter(([, c]) => c > 0)
    .map(([k]) => k);
  const updatesForRows = (keys: Set<string>) =>
    report.missingCost
      .filter((v) => keys.has(rowKeyOf([toGridCell(v, null)])))
      .map((v) => ({
        productId: v.productId,
        variantId: v.variantId,
        cost: drafts[rowKeyOf([toGridCell(v, null)])],
      }));
  const handleSaveAll = () => {
    const updates = updatesForRows(new Set(editedRowKeys));
    if (updates.length === 0) return;
    const fd = new FormData();
    fd.set("intent", "saveCosts");
    fd.set("updates", JSON.stringify(updates));
    fd.set("applyToProduct", "0");
    submit(fd, { method: "post" });
  };

  return (
    <BlockStack gap="300">
      <InlineStack align="space-between" blockAlign="center" wrap>
        <Text as="p">
          {report.counts.missingCost} size
          {report.counts.missingCost === 1 ? "" : "s"} without a unit cost. Enter
          the cost for a row and <strong>Save row</strong> — it applies to every
          size in that row shown here. Different costs per size? Set them in
          Shopify.
        </Text>
        <Button
          variant="primary"
          onClick={handleSaveAll}
          loading={isBusy}
          disabled={isBusy || editedRowKeys.length === 0}
        >
          {`Save all edited${editedRowKeys.length > 0 ? ` (${editedRowKeys.length})` : ""}`}
        </Button>
      </InlineStack>
      <Divider />
      <ProductGrid
        cells={cells}
        qtyLabel="Cost"
        readonly
        onCellChange={() => {}}
        showColumns={{ cost: false, retail: false, stock: false, onOrder: false }}
        sizeColumns={GRID_SIZES}
        getCellStyle={() => ({ background: "#fff8dc", boxShadow: "inset 0 0 0 1px #e6cf7a" })}
        getCellSubtext={(cell) => {
          const v = byId.get(cell.variantId);
          return (
            <span style={{ color: "#b45309" }}>
              {v?.unitCost === 0 ? "$0.00" : "no cost"}
            </span>
          );
        }}
        stickyLeadColumn
        maxHeight="70vh"
        trailingLabel="Cost for row"
        renderRowTrailing={({ cells: rowCells }) => {
          const key = rowKeyOf(rowCells);
          return (
            <CostRowActions
              draft={drafts[key] ?? 0}
              onDraft={(n) => setDrafts((p) => ({ ...p, [key]: n }))}
              updates={rowCells
                .map((c) => byId.get(c.variantId))
                .filter((v): v is AuditVariant => !!v)
                .map((v) => ({ productId: v.productId, variantId: v.variantId }))}
            />
          );
        }}
      />
      {rows.length > limit && (
        <InlineStack align="center">
          <Button onClick={() => setLimit((l) => l + ROW_LIMIT)}>
            {`Show ${Math.min(ROW_LIMIT, rows.length - limit)} more (${rows.length - limit} left)`}
          </Button>
        </InlineStack>
      )}
    </BlockStack>
  );
}

function CostRowActions({
  draft,
  onDraft,
  updates,
}: {
  draft: number;
  onDraft: (n: number) => void;
  updates: Array<{ productId: string; variantId: string }>;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const save = () => {
    if (!(draft > 0)) return;
    const fd = new FormData();
    fd.set("intent", "saveCosts");
    fd.set("updates", JSON.stringify(updates.map((u) => ({ ...u, cost: draft }))));
    fd.set("applyToProduct", "0");
    fetcher.submit(fd, { method: "post" });
  };
  return (
    <BlockStack gap="100" inlineAlign="end">
      <InlineStack gap="100" blockAlign="center" wrap={false}>
        <div style={{ width: "110px" }}>
          <MoneyField label="Cost" value={draft} onChange={onDraft} disabled={busy} />
        </div>
        <Button
          size="slim"
          variant="primary"
          onClick={save}
          loading={busy}
          disabled={busy || !(draft > 0)}
        >
          Save row
        </Button>
      </InlineStack>
      {fetcher.data && !fetcher.data.ok && (
        <Text as="span" variant="bodySm" tone="critical">
          {fetcher.data.error}
        </Text>
      )}
    </BlockStack>
  );
}
