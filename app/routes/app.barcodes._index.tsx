import { useCallback, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  ButtonGroup,
  Banner,
  Checkbox,
  Divider,
  Tabs,
  EmptyState,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import {
  runBarcodeAudit,
  generateBarcodesFor,
  planDuplicateFix,
  type BarcodeAuditReport,
} from "../services/barcodes/barcode-audit.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const report = await runBarcodeAudit(admin);
  return json({ report });
};

type ActionResult =
  | {
      ok: true;
      kind: "fix-missing" | "fix-duplicates";
      requested: number;
      updated: number;
      failures: Array<{ variantId: string; error: string }>;
    }
  | { ok: false; error: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  try {
    if (intent === "fix-missing") {
      // variantIds JSON comes through with productIds so we know how to
      // group mutations (productVariantsBulkUpdate is per-product).
      const targetsJson = String(formData.get("targets") ?? "[]");
      const targets = JSON.parse(targetsJson) as Array<{
        variantId: string;
        productId: string;
      }>;
      const result = await generateBarcodesFor(admin, targets);
      return json<ActionResult>({
        ok: true,
        kind: "fix-missing",
        ...result,
      });
    }

    if (intent === "fix-duplicates") {
      // The full audit was already computed server-side before submit; we
      // re-run a fresh audit so we're acting on up-to-date data, then let
      // planDuplicateFix decide who gets regenerated.
      const report = await runBarcodeAudit(admin);
      const plan = await planDuplicateFix(report.duplicates);
      const result = await generateBarcodesFor(admin, plan.toRegenerate);
      return json<ActionResult>({
        ok: true,
        kind: "fix-duplicates",
        requested: plan.toRegenerate.length,
        updated: result.updated,
        failures: result.failures,
      });
    }
  } catch (error) {
    return json<ActionResult>({ ok: false, error: String(error) });
  }

  return json<ActionResult>({ ok: false, error: "Unknown intent" });
};

export default function BarcodeAudit() {
  const { report } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isBusy = navigation.state === "submitting";

  const [selectedTab, setSelectedTab] = useState(0);
  const [selectedMissing, setSelectedMissing] = useState<Set<string>>(
    () => new Set(report.missing.map((v) => v.variantId)),
  );

  const tabs = [
    {
      id: "missing",
      content: `Missing (${report.counts.missing})`,
      accessibilityLabel: "Variants without a barcode",
      panelID: "missing-panel",
    },
    {
      id: "duplicates",
      content: `Duplicates (${report.counts.duplicateGroups})`,
      accessibilityLabel: "Variants sharing a barcode",
      panelID: "duplicates-panel",
    },
    {
      id: "healthy",
      content: `Healthy (${report.counts.healthy})`,
      accessibilityLabel: "Variants with a unique barcode",
      panelID: "healthy-panel",
    },
  ];

  const toggleMissing = useCallback((variantId: string) => {
    setSelectedMissing((prev) => {
      const next = new Set(prev);
      if (next.has(variantId)) next.delete(variantId);
      else next.add(variantId);
      return next;
    });
  }, []);

  const selectAllMissing = useCallback(() => {
    setSelectedMissing(new Set(report.missing.map((v) => v.variantId)));
  }, [report.missing]);

  const clearSelection = useCallback(() => {
    setSelectedMissing(new Set());
  }, []);

  const handleFixMissing = useCallback(() => {
    const targets = report.missing
      .filter((v) => selectedMissing.has(v.variantId))
      .map((v) => ({ variantId: v.variantId, productId: v.productId }));
    if (targets.length === 0) return;
    const fd = new FormData();
    fd.set("intent", "fix-missing");
    fd.set("targets", JSON.stringify(targets));
    submit(fd, { method: "post" });
  }, [report.missing, selectedMissing, submit]);

  const handleFixDuplicates = useCallback(() => {
    if (
      !window.confirm(
        `Fix ${report.counts.duplicateGroups} duplicate group${report.counts.duplicateGroups === 1 ? "" : "s"}? One variant per group keeps the existing barcode, the rest get fresh unique ones.`,
      )
    )
      return;
    const fd = new FormData();
    fd.set("intent", "fix-duplicates");
    submit(fd, { method: "post" });
  }, [report.counts.duplicateGroups, submit]);

  const selectedCount = selectedMissing.size;

  return (
    <Page
      title="Barcode Check"
      subtitle="Find products missing or sharing barcodes, then fix them in bulk"
    >
      <Layout>
        {/* Action result banner */}
        {actionData && actionData.ok && (
          <Layout.Section>
            <Banner
              tone={
                actionData.failures.length > 0 ? "warning" : "success"
              }
              title={
                actionData.kind === "fix-missing"
                  ? `Generated ${actionData.updated} of ${actionData.requested} barcodes`
                  : `Regenerated ${actionData.updated} duplicate barcodes`
              }
            >
              {actionData.failures.length > 0 ? (
                <>
                  {actionData.failures.length} update
                  {actionData.failures.length === 1 ? "" : "s"} failed.
                  First error: {actionData.failures[0].error}
                </>
              ) : (
                <>Re-run the check to confirm everything is healthy.</>
              )}
            </Banner>
          </Layout.Section>
        )}
        {actionData && !actionData.ok && (
          <Layout.Section>
            <Banner tone="critical">{actionData.error}</Banner>
          </Layout.Section>
        )}

        {/* Summary header */}
        <Layout.Section>
          <Card>
            <InlineStack gap="600" wrap>
              <SummaryStat
                label="Total variants"
                value={report.counts.total}
              />
              <SummaryStat
                label="Missing barcode"
                value={report.counts.missing}
                tone={report.counts.missing > 0 ? "critical" : "success"}
              />
              <SummaryStat
                label="Duplicate groups"
                value={report.counts.duplicateGroups}
                tone={
                  report.counts.duplicateGroups > 0 ? "warning" : "success"
                }
              />
              <SummaryStat
                label="Healthy"
                value={report.counts.healthy}
                tone="success"
              />
            </InlineStack>
          </Card>
        </Layout.Section>

        {/* Tabs */}
        <Layout.Section>
          <Card padding="0">
            <Tabs
              tabs={tabs}
              selected={selectedTab}
              onSelect={setSelectedTab}
            >
              <div style={{ padding: "16px" }}>
                {selectedTab === 0 && (
                  <MissingPanel
                    variants={report.missing}
                    selected={selectedMissing}
                    onToggle={toggleMissing}
                    onSelectAll={selectAllMissing}
                    onClear={clearSelection}
                    onFix={handleFixMissing}
                    selectedCount={selectedCount}
                    isBusy={isBusy}
                  />
                )}
                {selectedTab === 1 && (
                  <DuplicatesPanel
                    duplicates={report.duplicates}
                    onFix={handleFixDuplicates}
                    isBusy={isBusy}
                  />
                )}
                {selectedTab === 2 && (
                  <HealthyPanel variants={report.healthy} />
                )}
              </div>
            </Tabs>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

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

function MissingPanel({
  variants,
  selected,
  onToggle,
  onSelectAll,
  onClear,
  onFix,
  selectedCount,
  isBusy,
}: {
  variants: BarcodeAuditReport["missing"];
  selected: Set<string>;
  onToggle: (variantId: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onFix: () => void;
  selectedCount: number;
  isBusy: boolean;
}) {
  if (variants.length === 0) {
    return (
      <EmptyState
        heading="All variants have a barcode"
        image=""
      >
        <Text as="p" variant="bodyMd">
          Nothing to fix in this bucket.
        </Text>
      </EmptyState>
    );
  }

  return (
    <BlockStack gap="300">
      <InlineStack align="space-between" blockAlign="center" wrap>
        <Text as="p" variant="bodyMd">
          {selectedCount} of {variants.length} selected
        </Text>
        <ButtonGroup>
          <Button onClick={onSelectAll} size="slim">
            Select all
          </Button>
          <Button onClick={onClear} size="slim">
            Clear
          </Button>
          <Button
            variant="primary"
            onClick={onFix}
            loading={isBusy}
            disabled={selectedCount === 0 || isBusy}
          >
            Generate {selectedCount || ""} barcode
            {selectedCount !== 1 ? "s" : ""}
          </Button>
        </ButtonGroup>
      </InlineStack>
      <Divider />
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
              <th style={{ padding: "6px 4px", width: "32px" }}></th>
              <th style={{ padding: "6px 8px", textAlign: "left" }}>
                Product
              </th>
              <th style={{ padding: "6px 8px", textAlign: "left" }}>
                Variant
              </th>
              <th style={{ padding: "6px 8px", textAlign: "left" }}>SKU</th>
              <th style={{ padding: "6px 8px", textAlign: "left" }}>
                Vendor
              </th>
              <th style={{ padding: "6px 8px", textAlign: "left" }}>
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => (
              <tr
                key={v.variantId}
                style={{ borderBottom: "1px solid #f1f1f1" }}
              >
                <td style={{ padding: "4px 4px" }}>
                  <Checkbox
                    label=""
                    labelHidden
                    checked={selected.has(v.variantId)}
                    onChange={() => onToggle(v.variantId)}
                  />
                </td>
                <td style={{ padding: "6px 8px" }}>{v.productTitle}</td>
                <td style={{ padding: "6px 8px" }}>{v.variantTitle}</td>
                <td style={{ padding: "6px 8px" }}>{v.sku || "—"}</td>
                <td style={{ padding: "6px 8px" }}>{v.vendor || "—"}</td>
                <td style={{ padding: "6px 8px" }}>
                  <Badge
                    tone={v.status === "ACTIVE" ? "success" : "info"}
                  >
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

function DuplicatesPanel({
  duplicates,
  onFix,
  isBusy,
}: {
  duplicates: BarcodeAuditReport["duplicates"];
  onFix: () => void;
  isBusy: boolean;
}) {
  if (duplicates.length === 0) {
    return (
      <EmptyState heading="No duplicate barcodes" image="">
        <Text as="p" variant="bodyMd">
          Every assigned barcode is unique.
        </Text>
      </EmptyState>
    );
  }

  return (
    <BlockStack gap="300">
      <InlineStack align="space-between" blockAlign="center">
        <Text as="p" variant="bodyMd">
          {duplicates.length} group{duplicates.length === 1 ? "" : "s"} of
          duplicate barcodes. One variant per group keeps the existing
          barcode; the rest get fresh unique ones.
        </Text>
        <Button
          variant="primary"
          onClick={onFix}
          loading={isBusy}
          disabled={isBusy}
        >
          Fix all duplicates
        </Button>
      </InlineStack>
      <Divider />
      <BlockStack gap="400">
        {duplicates.map((group) => (
          <Card key={group.barcode} background="bg-surface-secondary">
            <BlockStack gap="200">
              <InlineStack gap="200" blockAlign="center">
                <Badge tone="warning">
                  {`${group.variants.length} variants share this barcode`}
                </Badge>
                <Text as="span" variant="bodyMd" fontWeight="semibold">
                  {group.barcode}
                </Text>
              </InlineStack>
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "13px",
                  }}
                >
                  <thead>
                    <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                      <th
                        style={{
                          padding: "4px 8px",
                          textAlign: "left",
                        }}
                      >
                        Product
                      </th>
                      <th
                        style={{
                          padding: "4px 8px",
                          textAlign: "left",
                        }}
                      >
                        Variant
                      </th>
                      <th
                        style={{
                          padding: "4px 8px",
                          textAlign: "left",
                        }}
                      >
                        SKU
                      </th>
                      <th
                        style={{
                          padding: "4px 8px",
                          textAlign: "left",
                        }}
                      >
                        Vendor
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.variants.map((v) => (
                      <tr key={v.variantId}>
                        <td style={{ padding: "4px 8px" }}>
                          {v.productTitle}
                        </td>
                        <td style={{ padding: "4px 8px" }}>
                          {v.variantTitle}
                        </td>
                        <td style={{ padding: "4px 8px" }}>
                          {v.sku || "—"}
                        </td>
                        <td style={{ padding: "4px 8px" }}>
                          {v.vendor || "—"}
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
    </BlockStack>
  );
}

function HealthyPanel({
  variants,
}: {
  variants: BarcodeAuditReport["healthy"];
}) {
  if (variants.length === 0) {
    return (
      <EmptyState heading="No healthy variants yet" image="">
        <Text as="p" variant="bodyMd">
          Fix the missing + duplicate issues and they&apos;ll show up
          here.
        </Text>
      </EmptyState>
    );
  }
  return (
    <BlockStack gap="200">
      <Text as="p" variant="bodySm" tone="subdued">
        These variants have a unique, non-empty barcode — nothing to do.
      </Text>
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
              <th style={{ padding: "6px 8px", textAlign: "left" }}>
                Product
              </th>
              <th style={{ padding: "6px 8px", textAlign: "left" }}>
                Variant
              </th>
              <th style={{ padding: "6px 8px", textAlign: "left" }}>SKU</th>
              <th style={{ padding: "6px 8px", textAlign: "left" }}>
                Barcode
              </th>
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => (
              <tr
                key={v.variantId}
                style={{ borderBottom: "1px solid #f1f1f1" }}
              >
                <td style={{ padding: "6px 8px" }}>{v.productTitle}</td>
                <td style={{ padding: "6px 8px" }}>{v.variantTitle}</td>
                <td style={{ padding: "6px 8px" }}>{v.sku || "—"}</td>
                <td style={{ padding: "6px 8px", fontFamily: "monospace" }}>
                  {v.barcode}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </BlockStack>
  );
}
