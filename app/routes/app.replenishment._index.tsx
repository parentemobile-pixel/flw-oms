import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigate,
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
  TextField,
  Button,
  Banner,
  Badge,
  ButtonGroup,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import {
  getDefaultLocation,
  getLocations,
  type Location,
} from "../services/shopify-api/locations.server";
import {
  buildReplenishmentReport,
  type ReplenishmentReport,
  type ReplenishmentRow,
} from "../services/replenishment/replenishment.server";
import { LocationPicker } from "../components/LocationPicker";
import {
  ProductGrid,
  type GridCell,
} from "../components/ProductGrid";

const MAX_RANGE_DAYS = 60;

// Where the report stashes the transfer prefill before navigating to
// /app/transfers/new. Kept in sync with the consumer in that route.
const PREFILL_STORAGE_KEY = "flw-oms.transfer-prefill";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(startIso: string, endIso: string): number {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
}

/**
 * Resolve sensible defaults from the shop's locations:
 *  - destination = the location matching "Tiburon" (fallback to the
 *    non-default location, then any location)
 *  - source      = the default / online-fulfilling location (typically
 *    Marblehead, fallback to anything that isn't the destination)
 *
 * Both fall back to null when only one location exists, in which case
 * the page renders an empty-state explaining the report needs two.
 */
function resolveDefaultLocations(
  locations: Location[],
  defaultLocationId: string | null,
): { sourceId: string | null; destId: string | null } {
  if (locations.length === 0) return { sourceId: null, destId: null };

  const tiburon = locations.find((l) => /tiburon|\btb\b/i.test(l.name));
  const marblehead = locations.find((l) => /marblehead|\bmhd\b/i.test(l.name));

  const sourceId =
    marblehead?.id ??
    defaultLocationId ??
    locations.find((l) => l.id !== tiburon?.id)?.id ??
    locations[0].id;
  const destId =
    tiburon?.id ??
    locations.find((l) => l.id !== sourceId)?.id ??
    null;

  return { sourceId, destId };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [locations, defaultLocation] = await Promise.all([
    getLocations(admin, session.shop).catch(() => [] as Location[]),
    getDefaultLocation(admin, session.shop).catch(() => null),
  ]);
  const { sourceId, destId } = resolveDefaultLocations(
    locations,
    defaultLocation?.id ?? null,
  );
  return json({
    locations,
    defaultSourceId: sourceId,
    defaultDestId: destId,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const sourceLocationGid = String(formData.get("sourceLocationId") ?? "");
  const destLocationGid = String(formData.get("destLocationId") ?? "");
  const startDate = String(formData.get("startDate") ?? "");
  const endDate = String(formData.get("endDate") ?? "");

  if (!sourceLocationGid || !destLocationGid) {
    return json({ error: "Pick both a source and destination location." });
  }
  if (sourceLocationGid === destLocationGid) {
    return json({ error: "Source and destination must be different." });
  }
  if (!startDate || !endDate) {
    return json({ error: "Pick a date range." });
  }
  const span = daysBetween(startDate, endDate);
  if (span <= 0) {
    return json({ error: "End date must be on or after start date." });
  }
  if (span > MAX_RANGE_DAYS) {
    return json({
      error: `Date range is ${span} days — please keep it to ${MAX_RANGE_DAYS} or fewer.`,
    });
  }

  // Tell the shop GraphQL endpoint we want the rest of the day; the
  // orders search's processed_at is timestamp-aware so endDate alone
  // would exclude same-day sales after midnight UTC.
  const startStr = `${startDate}T00:00:00Z`;
  const endStr = `${endDate}T23:59:59Z`;

  try {
    const report = await buildReplenishmentReport(admin, {
      sourceLocationGid,
      destLocationGid,
      startDate: startStr,
      endDate: endStr,
    });
    return json({
      report,
      sourceLocationGid,
      destLocationGid,
      startDate,
      endDate,
    });
  } catch (error) {
    console.error("Replenishment report failed", error);
    return json({
      error: `Couldn't build report: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
};

// ── Note flag logic ─────────────────────────────────────────────────
// Mirrors the user's CLI per-row note semantics. A "row" here is a
// product × non-size variant (e.g. "Crewneck — Navy"); the size cells
// underneath are what the note inspects.

type RowNote =
  | { kind: "restockable" }
  | { kind: "lastUnit"; sizes: string[] }
  | { kind: "partialOOS"; sizes: string[] }
  | { kind: "oos" };

function classifyRow(
  rowCells: Array<{ size: string; sold: number; available: number }>,
): RowNote {
  const soldSizes = rowCells.filter((c) => c.sold > 0);
  if (soldSizes.length === 0) return { kind: "restockable" };

  const oosSizes = soldSizes
    .filter((c) => c.available === 0)
    .map((c) => c.size);
  if (oosSizes.length === soldSizes.length) return { kind: "oos" };
  if (oosSizes.length > 0)
    return { kind: "partialOOS", sizes: oosSizes };

  const lastUnit = soldSizes
    .filter((c) => c.available - c.sold === 0 && c.sold > 0)
    .map((c) => c.size);
  if (lastUnit.length > 0) return { kind: "lastUnit", sizes: lastUnit };

  return { kind: "restockable" };
}

function NoteBadge({ note }: { note: RowNote }) {
  switch (note.kind) {
    case "restockable":
      return <Badge tone="success">Restockable</Badge>;
    case "lastUnit":
      return (
        <Badge tone="attention">
          {`Last unit at source · ${note.sizes.join(", ")}`}
        </Badge>
      );
    case "partialOOS":
      return (
        <Badge tone="warning">
          {`Partial · ${note.sizes.join(", ")} OOS`}
        </Badge>
      );
    case "oos":
      return <Badge tone="critical">OOS at source</Badge>;
  }
}

interface SavedActionData {
  report?: ReplenishmentReport;
  sourceLocationGid?: string;
  destLocationGid?: string;
  startDate?: string;
  endDate?: string;
  error?: string;
}

export default function Replenishment() {
  const { locations, defaultSourceId, defaultDestId } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as SavedActionData | undefined;
  const submit = useSubmit();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isBusy = navigation.state === "submitting";

  const [sourceLocationId, setSourceLocationId] = useState<string | null>(
    defaultSourceId,
  );
  const [destLocationId, setDestLocationId] = useState<string | null>(
    defaultDestId,
  );
  // Lazy initializers for the date defaults so `new Date()` runs once
  // per mount instead of on every render — avoids server / client
  // hydration mismatches when SSR's `now` differs from the client's.
  const [startDate, setStartDate] = useState(() =>
    isoDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
  );
  const [endDate, setEndDate] = useState(() => isoDate(new Date()));

  // The grid's editable cell = transfer qty. Seeded from
  // min(sold, sourceAvailable) so the typical "send what they sold"
  // case takes one click.
  const [transferQty, setTransferQty] = useState<Record<string, number>>({});

  const reportRows = actionData?.report?.rows ?? [];
  const reportSummary = actionData?.report?.summary;

  // Stable key identifying which report is in view; we re-seed
  // transferQty whenever it changes.
  const reportKey = useMemo(
    () => reportRows.map((r) => r.variantId).join(","),
    [reportRows],
  );

  // Seed transferQty in a clean effect, not during render. The earlier
  // "setState during render with a guard" pattern was technically legal
  // but trips up React's strict-mode double-invoke check and is a
  // known source of flaky behavior.
  useEffect(() => {
    if (reportRows.length === 0) return;
    const seed: Record<string, number> = {};
    for (const row of reportRows) {
      seed[row.variantId] = Math.max(
        0,
        Math.min(row.sold, row.sourceAvailable),
      );
    }
    setTransferQty(seed);
    // reportKey is a stable scalar derived from reportRows; using it
    // as the dep keeps this from re-running on every render that
    // re-creates an empty array literal for actionData.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportKey]);

  const handleCellChange = useCallback((variantId: string, next: number) => {
    setTransferQty((prev) => ({ ...prev, [variantId]: Math.max(0, next) }));
  }, []);

  // Build GridCells from the report rows. `stock` shows source-side
  // available so the column total is meaningful; `value` is the
  // editable transfer qty.
  const rowByVariantId = useMemo(() => {
    const m = new Map<string, ReplenishmentRow>();
    for (const r of reportRows) m.set(r.variantId, r);
    return m;
  }, [reportRows]);

  const cells: GridCell[] = useMemo(
    () =>
      reportRows.map((r) => ({
        variantId: r.variantId,
        productId: r.productId,
        productTitle: r.productTitle,
        variantTitle: r.variantTitle,
        selectedOptions: r.selectedOptions,
        sku: r.sku,
        stock: r.sourceAvailable,
        value: transferQty[r.variantId] ?? 0,
      })),
    [reportRows, transferQty],
  );

  // Per-cell subtext: "Sold N · Src M" so the user sees both the
  // demand (what TB sold) and the supply (what MHD has) without
  // leaving the cell.
  const getCellSubtext = useCallback(
    (cell: GridCell) => {
      const row = rowByVariantId.get(cell.variantId);
      if (!row) return null;
      return (
        <>
          Sold {row.sold} · Src {row.sourceAvailable}
        </>
      );
    },
    [rowByVariantId],
  );

  // Color cells by urgency: red = source has 0 (can't ship), amber =
  // sending the proposed qty drains source to 0, green = fully covered.
  const getCellStyle = useCallback(
    (cell: GridCell) => {
      const row = rowByVariantId.get(cell.variantId);
      if (!row) return undefined;
      if (row.sourceAvailable === 0) {
        return { background: "#fdecea", boxShadow: "inset 0 0 0 1px #f5b5b0" };
      }
      const proposed = cell.value ?? 0;
      if (proposed > 0 && row.sourceAvailable - proposed <= 0) {
        return { background: "#fff4d6", boxShadow: "inset 0 0 0 1px #f0c674" };
      }
      if (row.sold > 0 && row.sourceAvailable >= row.sold) {
        return { background: "#eaf6ee" };
      }
      return undefined;
    },
    [rowByVariantId],
  );

  // Per-row trailing column: the note badge classifying the row.
  const renderRowTrailing = useCallback(
    ({ cells: rowCells }: { cells: GridCell[] }) => {
      const sizeCells = rowCells.map((c) => {
        const row = rowByVariantId.get(c.variantId);
        const sizeOpt = c.selectedOptions.find(
          (o) => o.name.toLowerCase() === "size",
        );
        return {
          size: sizeOpt?.value ?? c.variantTitle,
          sold: row?.sold ?? 0,
          available: row?.sourceAvailable ?? 0,
        };
      });
      const note = classifyRow(sizeCells);
      return <NoteBadge note={note} />;
    },
    [rowByVariantId],
  );

  const handleRunReport = useCallback(() => {
    const fd = new FormData();
    if (sourceLocationId) fd.set("sourceLocationId", sourceLocationId);
    if (destLocationId) fd.set("destLocationId", destLocationId);
    fd.set("startDate", startDate);
    fd.set("endDate", endDate);
    submit(fd, { method: "post" });
  }, [sourceLocationId, destLocationId, startDate, endDate, submit]);

  const applyPreset = useCallback((days: number) => {
    const now = new Date();
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    setStartDate(isoDate(start));
    setEndDate(isoDate(now));
  }, []);

  // "Create transfer" — stash prefill in localStorage, then navigate to
  // /app/transfers/new. The new-transfer page reads the key on mount,
  // applies the rows + locations, and clears the key so a refresh
  // doesn't re-apply. Same-tab navigation keeps localStorage scoped
  // correctly.
  const handleCreateTransfer = useCallback(() => {
    if (!sourceLocationId || !destLocationId) return;
    const rows = reportRows
      .map((r) => ({
        variantId: r.variantId,
        productId: r.productId,
        productTitle: r.productTitle,
        variantTitle: r.variantTitle,
        sku: r.sku,
        selectedOptions: r.selectedOptions,
        quantitySent: transferQty[r.variantId] ?? 0,
      }))
      .filter((r) => r.quantitySent > 0);
    if (rows.length === 0) {
      window.alert(
        "Nothing to transfer — add a quantity to at least one row first.",
      );
      return;
    }
    const payload = {
      ts: Date.now(),
      fromLocationId: sourceLocationId,
      toLocationId: destLocationId,
      rows,
    };
    try {
      window.localStorage.setItem(PREFILL_STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
      console.error("Couldn't write transfer prefill", err);
      window.alert("Couldn't stash the prefill — proceeding without it.");
    }
    navigate("/app/transfers/new");
  }, [sourceLocationId, destLocationId, reportRows, transferQty, navigate]);

  const totalProposed = Object.values(transferQty).reduce(
    (s, n) => s + (n || 0),
    0,
  );

  const span = daysBetween(startDate, endDate);
  const spanLabel = span > 0 ? `${span} day${span !== 1 ? "s" : ""}` : "—";

  return (
    <Page
      title="Replenishment"
      subtitle="What sold at the destination, what's available at the source, and what to transfer."
    >
      <Layout>
        {actionData && "error" in actionData && actionData.error && (
          <Layout.Section>
            <Banner tone="critical">{actionData.error}</Banner>
          </Layout.Section>
        )}

        {/* Filters */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Filters
              </Text>
              <InlineStack gap="400" wrap>
                <div style={{ flex: 1, minWidth: "220px" }}>
                  <LocationPicker
                    label="Source (ships from)"
                    locations={locations}
                    value={sourceLocationId}
                    onChange={setSourceLocationId}
                    persistKey="replenishment-source"
                  />
                </div>
                <div style={{ flex: 1, minWidth: "220px" }}>
                  <LocationPicker
                    label="Destination (sells / receives)"
                    locations={locations.filter(
                      (l) => l.id !== sourceLocationId,
                    )}
                    value={destLocationId}
                    onChange={setDestLocationId}
                    persistKey="replenishment-dest"
                  />
                </div>
                <div style={{ flex: 1, minWidth: "180px" }}>
                  <TextField
                    label="Start date"
                    type="date"
                    value={startDate}
                    onChange={setStartDate}
                    autoComplete="off"
                  />
                </div>
                <div style={{ flex: 1, minWidth: "180px" }}>
                  <TextField
                    label="End date"
                    type="date"
                    value={endDate}
                    onChange={setEndDate}
                    autoComplete="off"
                  />
                </div>
              </InlineStack>
              <InlineStack gap="200" wrap blockAlign="center">
                <Text as="span" variant="bodySm" tone="subdued">
                  Range: {spanLabel}
                </Text>
                <ButtonGroup>
                  <Button onClick={() => applyPreset(7)}>Last 7 days</Button>
                  <Button onClick={() => applyPreset(14)}>Last 14 days</Button>
                  <Button onClick={() => applyPreset(30)}>Last 30 days</Button>
                </ButtonGroup>
                <div style={{ flex: 1 }} />
                <Button
                  variant="primary"
                  loading={isBusy}
                  onClick={handleRunReport}
                  disabled={
                    !sourceLocationId ||
                    !destLocationId ||
                    sourceLocationId === destLocationId
                  }
                >
                  Run report
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Summary */}
        {reportSummary && (
          <Layout.Section>
            <Card>
              <InlineStack align="space-between" wrap>
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Units sold (net of refunds)
                  </Text>
                  <Text as="p" variant="headingLg">
                    {reportSummary.totalUnitsSold}
                  </Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm" tone="subdued">
                    SKUs sold
                  </Text>
                  <Text as="p" variant="headingLg">
                    {reportSummary.variantsSold}
                  </Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Fully restockable
                  </Text>
                  <Text as="p" variant="headingLg" tone="success">
                    {reportSummary.fullyRestockable}
                  </Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Short or OOS at source
                  </Text>
                  <Text
                    as="p"
                    variant="headingLg"
                    tone={
                      reportSummary.shortOrOOS > 0 ? "critical" : "subdued"
                    }
                  >
                    {reportSummary.shortOrOOS}
                  </Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Proposed to transfer
                  </Text>
                  <Text as="p" variant="headingLg">
                    {totalProposed}
                  </Text>
                </BlockStack>
              </InlineStack>
            </Card>
          </Layout.Section>
        )}

        {/* Grid */}
        {reportRows.length > 0 && (
          <Layout.Section>
            <Card padding="0">
              <div style={{ padding: "16px" }}>
                <ProductGrid
                  cells={cells}
                  qtyLabel="Transfer"
                  onCellChange={handleCellChange}
                  showColumns={{
                    cost: false,
                    retail: false,
                    stock: true,
                    onOrder: false,
                  }}
                  sizeColumns={["XS", "S", "M", "L", "XL", "2XL", "3XL"]}
                  getCellStyle={getCellStyle}
                  getCellSubtext={getCellSubtext}
                  trailingLabel="Note"
                  renderRowTrailing={renderRowTrailing}
                />
              </div>
            </Card>
          </Layout.Section>
        )}

        {/* Empty state — only after a successful run with zero rows */}
        {actionData?.report &&
          reportRows.length === 0 &&
          !("error" in actionData && actionData.error) && (
            <Layout.Section>
              <Card>
                <BlockStack gap="200" inlineAlign="center">
                  <Text as="p" variant="bodyMd">
                    No POS sales found at the destination in this window.
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Try widening the date range or confirming the destination
                    has POS activity.
                  </Text>
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

        {/* Create transfer */}
        {reportRows.length > 0 && (
          <Layout.Section>
            <InlineStack align="end" gap="200">
              <Button
                variant="primary"
                onClick={handleCreateTransfer}
                disabled={totalProposed === 0}
              >
                {`Create transfer (${totalProposed} units)`}
              </Button>
            </InlineStack>
          </Layout.Section>
        )}
        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
