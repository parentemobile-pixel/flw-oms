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
  const rows = useMemo(
    () => report.missingBarcodes.filter((v) => matchesFilter(v, q)),
    [report.missingBarcodes, q],
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(report.missingBarcodes.map((v) => v.variantId)),
  );
  // Keep selection in sync when the report shrinks after a fix.
  useEffect(() => {
    const ids = new Set(report.missingBarcodes.map((v) => v.variantId));
    setSelected((prev) => new Set([...prev].filter((id) => ids.has(id))));
  }, [report.missingBarcodes]);

  if (report.missingBarcodes.length === 0) {
    return (
      <EmptyState heading="All variants have a barcode" image="">
        <Text as="p">Nothing to generate.</Text>
      </EmptyState>
    );
  }

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const handleFix = () => {
    const targets = report.missingBarcodes
      .filter((v) => selected.has(v.variantId))
      .map((v) => ({ variantId: v.variantId, productId: v.productId }));
    if (targets.length === 0) return;
    const fd = new FormData();
    fd.set("intent", "fixMissingBarcodes");
    fd.set("targets", JSON.stringify(targets));
    submit(fd, { method: "post" });
  };

  return (
    <BlockStack gap="300">
      <InlineStack align="space-between" blockAlign="center" wrap>
        <Text as="p">
          {selected.size} of {report.missingBarcodes.length} selected
        </Text>
        <ButtonGroup>
          <Button
            size="slim"
            onClick={() => setSelected(new Set(report.missingBarcodes.map((v) => v.variantId)))}
          >
            Select all
          </Button>
          <Button size="slim" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <Button
            variant="primary"
            onClick={handleFix}
            loading={isBusy}
            disabled={selected.size === 0 || isBusy}
          >
            {`Generate ${selected.size || ""} barcode${selected.size !== 1 ? "s" : ""}`}
          </Button>
        </ButtonGroup>
      </InlineStack>
      <Divider />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
              <th style={{ ...th, width: "32px" }}></th>
              <th style={th}>Product</th>
              <th style={th}>Variant</th>
              <th style={th}>SKU</th>
              <th style={th}>Vendor</th>
              <th style={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.variantId} style={{ borderBottom: "1px solid #f1f1f1" }}>
                <td style={{ padding: "4px" }}>
                  <Checkbox
                    label=""
                    labelHidden
                    checked={selected.has(v.variantId)}
                    onChange={() => toggle(v.variantId)}
                  />
                </td>
                <td style={td}>
                  <AdminLink href={productAdminUrl(v.productId)}>{v.productTitle}</AdminLink>
                </td>
                <td style={td}>{v.variantTitle}</td>
                <td style={td}>{v.sku || "—"}</td>
                <td style={td}>{v.vendor || "—"}</td>
                <td style={td}>
                  <Badge tone={v.status === "ACTIVE" ? "success" : "info"}>
                    {v.status.toLowerCase()}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
  const rows = useMemo(
    () => report.negativeStock.filter((v) => matchesFilter(v, q)),
    [report.negativeStock, q],
  );
  // Location columns: the report's location list, falling back to
  // whatever the rows reference (covers a location deactivated mid-way).
  const locations = useMemo(() => {
    const seen = new Map(report.locations.map((l) => [l.id, l.name]));
    for (const row of report.negativeStock) {
      for (const l of row.levels) if (!seen.has(l.locationId)) seen.set(l.locationId, l.locationName);
    }
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [report.locations, report.negativeStock]);

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
    <BlockStack gap="300">
      <InlineStack align="space-between" blockAlign="center" wrap>
        <Text as="p">
          {report.counts.negativeStock} variant
          {report.counts.negativeStock === 1 ? "" : "s"} ·{" "}
          {report.counts.negativeLevels} location level
          {report.counts.negativeLevels === 1 ? "" : "s"} below zero. Type a
          corrected quantity and Save, reset to 0, or archive the product.
        </Text>
        <Button tone="critical" onClick={() => setConfirmResetAll(true)} disabled={isBusy}>
          Reset all to 0
        </Button>
      </InlineStack>
      <Divider />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
              <th style={th}>Product</th>
              <th style={th}>Variant</th>
              <th style={th}>SKU</th>
              {locations.map((l) => (
                <th key={l.id} style={{ ...th, textAlign: "center" }}>
                  {l.name}
                </th>
              ))}
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <NegativeRow key={row.variantId} row={row} locations={locations} />
            ))}
          </tbody>
        </table>
      </div>

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

function NegativeRow({
  row,
  locations,
}: {
  row: NegativeStockRow;
  locations: Array<{ id: string; name: string }>;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [confirmArchive, setConfirmArchive] = useState(false);

  const levelAt = (locationId: string) =>
    row.levels.find((l) => l.locationId === locationId);

  const submitTargets = (targets: SetStockTarget[]) => {
    if (targets.length === 0) return;
    const fd = new FormData();
    fd.set("intent", "setStock");
    fd.set("targets", JSON.stringify(targets));
    fetcher.submit(fd, { method: "post" });
  };
  const handleReset = () =>
    submitTargets(
      row.negativeLevels.map((l) => ({
        variantId: row.variantId,
        locationId: l.locationId,
        newQty: 0,
      })),
    );
  const parsedDrafts = row.negativeLevels
    .map((l) => {
      const raw = drafts[l.locationId];
      if (raw === undefined || raw.trim() === "") return null;
      const n = parseInt(raw, 10);
      if (!Number.isInteger(n) || n < 0) return null;
      return { locationId: l.locationId, newQty: n };
    })
    .filter((d): d is { locationId: string; newQty: number } => d !== null);
  const handleSave = () =>
    submitTargets(
      parsedDrafts.map((d) => ({ variantId: row.variantId, ...d })),
    );
  const handleArchive = () => {
    const fd = new FormData();
    fd.set("intent", "archive");
    fd.set("productIds", JSON.stringify([row.productId]));
    fetcher.submit(fd, { method: "post" });
    setConfirmArchive(false);
  };

  return (
    <tr style={{ borderBottom: "1px solid #f1f1f1" }}>
      <td style={td}>
        <AdminLink href={productAdminUrl(row.productId)}>{row.productTitle}</AdminLink>
        {row.vendor && (
          <div style={{ fontSize: "11px", color: "#6b7280" }}>{row.vendor}</div>
        )}
      </td>
      <td style={td}>{row.variantTitle}</td>
      <td style={td}>{row.sku || "—"}</td>
      {locations.map((loc) => {
        const level = levelAt(loc.id);
        if (!level) {
          return (
            <td key={loc.id} style={{ ...td, textAlign: "center", color: "#9ca3af" }}>
              —
            </td>
          );
        }
        if (level.available >= 0) {
          return (
            <td key={loc.id} style={{ ...td, textAlign: "center" }}>
              {level.available}
            </td>
          );
        }
        return (
          <td key={loc.id} style={{ ...td, textAlign: "center" }}>
            <div style={{ color: "#d72c0d", fontWeight: 600 }}>{level.available}</div>
            <div style={{ maxWidth: "90px", margin: "2px auto 0" }}>
              <TextField
                label="New qty"
                labelHidden
                type="number"
                min={0}
                size="slim"
                value={drafts[loc.id] ?? ""}
                placeholder="new qty"
                onChange={(v) => setDrafts((p) => ({ ...p, [loc.id]: v }))}
                autoComplete="off"
                disabled={busy}
              />
            </div>
          </td>
        );
      })}
      <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
        <ButtonGroup>
          <Button
            size="slim"
            variant="primary"
            onClick={handleSave}
            loading={busy}
            disabled={busy || parsedDrafts.length === 0}
          >
            Save
          </Button>
          <Button size="slim" onClick={handleReset} loading={busy} disabled={busy}>
            Reset to 0
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
          <div style={{ color: "#d72c0d", fontSize: "11px", marginTop: "4px" }}>
            {fetcher.data.error}
          </div>
        )}
        <Modal
          open={confirmArchive}
          onClose={() => setConfirmArchive(false)}
          title={`Archive ${row.productTitle}?`}
          primaryAction={{ content: "Archive product", destructive: true, onAction: handleArchive }}
          secondaryActions={[{ content: "Cancel", onAction: () => setConfirmArchive(false) }]}
        >
          <Modal.Section>
            <Text as="p">
              Shopify archives at the product level, so every variant of{" "}
              <strong>{row.productTitle}</strong> will be archived and hidden from
              sales channels. Inventory numbers are left as they are.
            </Text>
          </Modal.Section>
        </Modal>
      </td>
    </tr>
  );
}

// ─── Missing cost ─────────────────────────────────────────────────────

const COST_PAGE = 200;

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
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [limit, setLimit] = useState(COST_PAGE);
  const rows = useMemo(
    () => report.missingCost.filter((v) => matchesFilter(v, q)),
    [report.missingCost, q],
  );
  const visible = rows.slice(0, limit);

  // Drop drafts for rows that have been fixed (report shrank).
  useEffect(() => {
    const ids = new Set(report.missingCost.map((v) => v.variantId));
    setDrafts((prev) => {
      const next: Record<string, number> = {};
      for (const [id, cost] of Object.entries(prev)) if (ids.has(id)) next[id] = cost;
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

  const edited = report.missingCost.filter(
    (v) => (drafts[v.variantId] ?? 0) > 0,
  );
  const handleSaveAll = () => {
    if (edited.length === 0) return;
    const fd = new FormData();
    fd.set("intent", "saveCosts");
    fd.set(
      "updates",
      JSON.stringify(
        edited.map((v) => ({
          productId: v.productId,
          variantId: v.variantId,
          cost: drafts[v.variantId],
        })),
      ),
    );
    fd.set("applyToProduct", "0");
    submit(fd, { method: "post" });
  };

  return (
    <BlockStack gap="300">
      <InlineStack align="space-between" blockAlign="center" wrap>
        <Text as="p">
          {report.counts.missingCost} variant
          {report.counts.missingCost === 1 ? "" : "s"} without a unit cost. Enter a
          cost and Save per row, or use &quot;All sizes&quot; to apply one cost to
          every size of that product still missing one.
        </Text>
        <Button
          variant="primary"
          onClick={handleSaveAll}
          loading={isBusy}
          disabled={isBusy || edited.length === 0}
        >
          Save all edited{edited.length > 0 ? ` (${edited.length})` : ""}
        </Button>
      </InlineStack>
      <Divider />
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
              <th style={th}>Product</th>
              <th style={th}>Variant</th>
              <th style={th}>SKU</th>
              <th style={th}>Vendor</th>
              <th style={{ ...th, textAlign: "right" }}>Current</th>
              <th style={th}>New cost</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((v) => (
              <CostRow
                key={v.variantId}
                v={v}
                draft={drafts[v.variantId] ?? 0}
                onDraft={(n) => setDrafts((p) => ({ ...p, [v.variantId]: n }))}
              />
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > limit && (
        <InlineStack align="center">
          <Button onClick={() => setLimit((l) => l + COST_PAGE)}>
            {`Show ${Math.min(COST_PAGE, rows.length - limit)} more (${rows.length - limit} left)`}
          </Button>
        </InlineStack>
      )}
    </BlockStack>
  );
}

function CostRow({
  v,
  draft,
  onDraft,
}: {
  v: AuditVariant;
  draft: number;
  onDraft: (n: number) => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const save = (applyToProduct: boolean) => {
    if (!(draft > 0)) return;
    const fd = new FormData();
    fd.set("intent", "saveCosts");
    fd.set(
      "updates",
      JSON.stringify([{ productId: v.productId, variantId: v.variantId, cost: draft }]),
    );
    fd.set("applyToProduct", applyToProduct ? "1" : "0");
    fetcher.submit(fd, { method: "post" });
  };
  return (
    <tr style={{ borderBottom: "1px solid #f1f1f1" }}>
      <td style={td}>
        <AdminLink href={productAdminUrl(v.productId)}>{v.productTitle}</AdminLink>
      </td>
      <td style={td}>{v.variantTitle}</td>
      <td style={td}>{v.sku || "—"}</td>
      <td style={td}>{v.vendor || "—"}</td>
      <td style={{ ...td, textAlign: "right", color: "#6b7280" }}>
        {v.unitCost === null ? "—" : `$${v.unitCost.toFixed(2)}`}
      </td>
      <td style={{ ...td, width: "130px" }}>
        <MoneyField label="Cost" value={draft} onChange={onDraft} disabled={busy} />
      </td>
      <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
        <ButtonGroup>
          <Button
            size="slim"
            variant="primary"
            onClick={() => save(false)}
            loading={busy}
            disabled={busy || !(draft > 0)}
          >
            Save
          </Button>
          <Button size="slim" onClick={() => save(true)} disabled={busy || !(draft > 0)}>
            All sizes
          </Button>
        </ButtonGroup>
        {fetcher.data && !fetcher.data.ok && (
          <div style={{ color: "#d72c0d", fontSize: "11px", marginTop: "4px" }}>
            {fetcher.data.error}
          </div>
        )}
      </td>
    </tr>
  );
}
