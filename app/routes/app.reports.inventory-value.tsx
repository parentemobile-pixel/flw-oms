import { useCallback, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "@remix-run/node";
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
  TextField,
  Button,
  ButtonGroup,
  Banner,
  Tag,
  Listbox,
  Combobox,
  Icon,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getLocations, type Location } from "../services/shopify-api/locations.server";
import { getVendors } from "../services/shopify-api/products.server";
import { buildInventoryValueSnapshot } from "../services/reports/inventory-value-snapshot.server";

const DEFAULT_EXCLUDED_VENDORS = ["Colby Davis"];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [locations, vendors, snapshotCount] = await Promise.all([
    getLocations(admin, session.shop).catch(() => [] as Location[]),
    getVendors(admin, session.shop).catch(() => [] as string[]),
    db.inventoryValueSnapshot.count({ where: { shop: session.shop } }),
  ]);
  return json({ locations, vendors, snapshotCount });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "query");

  if (intent === "rebuild") {
    try {
      const result = await buildInventoryValueSnapshot(admin, session.shop);
      return json({ rebuiltAt: new Date().toISOString(), result });
    } catch (error) {
      return json({
        error: `Rebuild failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  const startDate = String(formData.get("startDate") ?? "");
  const endDate = String(formData.get("endDate") ?? "");
  const locationsCsv = String(formData.get("locations") ?? "");
  const vendorsCsv = String(formData.get("vendors") ?? "");
  const excludeVendorsCsv = String(formData.get("excludeVendors") ?? "");

  if (!startDate || !endDate) {
    return json({ error: "Pick a date range." });
  }

  const startTs = new Date(`${startDate}T00:00:00Z`);
  const endTs = new Date(`${endDate}T23:59:59Z`);
  const selectedLocations = locationsCsv ? locationsCsv.split(",").filter(Boolean) : [];
  const selectedVendors = vendorsCsv ? vendorsCsv.split(",").filter(Boolean) : [];
  const excludedVendors = excludeVendorsCsv
    ? excludeVendorsCsv.split(",").filter(Boolean)
    : [];

  const where: Parameters<typeof db.inventoryValueSnapshot.findMany>[0] = {
    where: {
      shop: session.shop,
      periodEnd: { gte: startTs, lte: endTs },
      ...(selectedLocations.length > 0
        ? { locationId: { in: selectedLocations } }
        : {}),
      ...(selectedVendors.length > 0
        ? { vendor: { in: selectedVendors } }
        : excludedVendors.length > 0
          ? { vendor: { notIn: excludedVendors } }
          : {}),
    },
    orderBy: [{ periodEnd: "asc" }, { locationId: "asc" }, { vendor: "asc" }],
  };

  const snapshots = await db.inventoryValueSnapshot.findMany(where);
  return json({ snapshots, queriedAt: new Date().toISOString() });
};

type SnapshotRow = {
  id: string;
  shop: string;
  locationId: string;
  vendor: string | null;
  periodEnd: string;
  totalUnits: number;
  totalCostValue: number;
  totalRetailValue: number;
  generatedAt: string;
};

interface ActionPayload {
  snapshots?: SnapshotRow[];
  rebuiltAt?: string;
  result?: { rowsWritten: number; productCount: number };
  error?: string;
}

export default function InventoryValueReport() {
  const { locations, vendors, snapshotCount } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ActionPayload | undefined;
  const submit = useSubmit();
  const navigation = useNavigation();
  const isBusy = navigation.state === "submitting";

  const [startDate, setStartDate] = useState(() =>
    isoDate(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)),
  );
  const [endDate, setEndDate] = useState(() => isoDate(new Date()));
  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);
  const [selectedVendors, setSelectedVendors] = useState<string[]>([]);
  const [excludeDefault, setExcludeDefault] = useState(true);
  const [vendorQuery, setVendorQuery] = useState("");

  const handleQuery = useCallback(() => {
    const fd = new FormData();
    fd.set("startDate", startDate);
    fd.set("endDate", endDate);
    fd.set("locations", selectedLocations.join(","));
    fd.set("vendors", selectedVendors.join(","));
    if (excludeDefault && selectedVendors.length === 0) {
      fd.set("excludeVendors", DEFAULT_EXCLUDED_VENDORS.join(","));
    }
    submit(fd, { method: "post" });
  }, [
    startDate,
    endDate,
    selectedLocations,
    selectedVendors,
    excludeDefault,
    submit,
  ]);

  const handleRebuild = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "rebuild");
    submit(fd, { method: "post" });
  }, [submit]);

  const applyPreset = useCallback((days: number) => {
    const now = new Date();
    setStartDate(isoDate(new Date(now.getTime() - days * 24 * 60 * 60 * 1000)));
    setEndDate(isoDate(now));
  }, []);

  const locationName = useCallback(
    (id: string) => locations.find((l) => l.id === id)?.name ?? id,
    [locations],
  );

  const snapshots = actionData?.snapshots ?? [];

  // Roll up the time series — sum across all returned snapshots per
  // date so the chart shows total cost-value and retail-value per day.
  const series = useMemo(() => {
    const byDate = new Map<
      string,
      { cost: number; retail: number; units: number }
    >();
    for (const s of snapshots) {
      const date = s.periodEnd.slice(0, 10);
      // Filter out per-vendor rows when no vendor filter is set — the
      // location-rollup rows (vendor=null) already cover the total.
      const isRollup = s.vendor == null;
      if (selectedVendors.length === 0 && !isRollup) continue;
      // When a vendor filter is set, drop the rollup rows and aggregate
      // the per-vendor rows for the selected vendors only.
      if (selectedVendors.length > 0 && isRollup) continue;
      const entry = byDate.get(date) ?? { cost: 0, retail: 0, units: 0 };
      entry.cost += s.totalCostValue;
      entry.retail += s.totalRetailValue;
      entry.units += s.totalUnits;
      byDate.set(date, entry);
    }
    return Array.from(byDate.entries())
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [snapshots, selectedVendors]);

  // Latest-day table — one row per (location, vendor) in the most
  // recent snapshot date returned.
  const latestRows = useMemo(() => {
    if (snapshots.length === 0) return [];
    const latestDate = snapshots[snapshots.length - 1].periodEnd.slice(0, 10);
    return snapshots.filter(
      (s) => s.periodEnd.slice(0, 10) === latestDate && s.vendor != null,
    );
  }, [snapshots]);

  const csvEscape = (v: unknown): string => {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const handleExportCsv = useCallback(() => {
    if (snapshots.length === 0) return;
    const header = [
      "Date",
      "Location",
      "Vendor",
      "Units",
      "Cost value",
      "Retail value",
    ];
    const rows = snapshots.map((s) => [
      s.periodEnd.slice(0, 10),
      locationName(s.locationId),
      s.vendor ?? "(all)",
      s.totalUnits,
      s.totalCostValue.toFixed(2),
      s.totalRetailValue.toFixed(2),
    ]);
    const csv = [header, ...rows]
      .map((r) => r.map(csvEscape).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inventory-value-${startDate}-to-${endDate}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [snapshots, locationName, startDate, endDate]);

  // Vendor multi-select Combobox (Polaris pattern). Filtered by query.
  const filteredVendors = useMemo(() => {
    const q = vendorQuery.trim().toLowerCase();
    return vendors.filter((v) =>
      q === "" ? true : v.toLowerCase().includes(q),
    );
  }, [vendors, vendorQuery]);

  return (
    <Page
      title="Inventory Value"
      subtitle="Cost and retail value of on-hand inventory over time."
      backAction={{ url: "/app/reports" }}
    >
      <Layout>
        {actionData?.error && (
          <Layout.Section>
            <Banner tone="critical">{actionData.error}</Banner>
          </Layout.Section>
        )}
        {actionData?.rebuiltAt && actionData.result && (
          <Layout.Section>
            <Banner tone="success">
              Rebuilt today&rsquo;s snapshot: {actionData.result.rowsWritten}{" "}
              rows across {actionData.result.productCount} products.
            </Banner>
          </Layout.Section>
        )}
        {snapshotCount === 0 && (
          <Layout.Section>
            <Banner tone="info" title="No snapshots yet">
              <Text as="p" variant="bodyMd">
                The nightly snapshot will fire automatically. To see data
                right now, click <strong>Rebuild today&rsquo;s snapshot</strong>.
              </Text>
            </Banner>
          </Layout.Section>
        )}
        {excludeDefault && selectedVendors.length === 0 && (
          <Layout.Section>
            <Banner
              tone="info"
              onDismiss={() => setExcludeDefault(false)}
              title="Default exclusions in effect"
            >
              <Text as="p" variant="bodyMd">
                Hiding vendor <strong>Colby Davis</strong> by default.
                Dismiss this banner to include them.
              </Text>
            </Banner>
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
                <div style={{ minWidth: "160px" }}>
                  <TextField
                    label="Start"
                    type="date"
                    value={startDate}
                    onChange={setStartDate}
                    autoComplete="off"
                  />
                </div>
                <div style={{ minWidth: "160px" }}>
                  <TextField
                    label="End"
                    type="date"
                    value={endDate}
                    onChange={setEndDate}
                    autoComplete="off"
                  />
                </div>
                <BlockStack gap="100">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Quick range
                  </Text>
                  <ButtonGroup>
                    <Button size="slim" onClick={() => applyPreset(30)}>
                      30 days
                    </Button>
                    <Button size="slim" onClick={() => applyPreset(90)}>
                      90 days
                    </Button>
                    <Button size="slim" onClick={() => applyPreset(365)}>
                      365 days
                    </Button>
                  </ButtonGroup>
                </BlockStack>
              </InlineStack>

              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Locations
                </Text>
                <InlineStack gap="200" wrap>
                  {locations.map((loc) => {
                    const checked = selectedLocations.includes(loc.id);
                    return (
                      <Button
                        key={loc.id}
                        size="slim"
                        pressed={checked}
                        onClick={() =>
                          setSelectedLocations((prev) =>
                            prev.includes(loc.id)
                              ? prev.filter((id) => id !== loc.id)
                              : [...prev, loc.id],
                          )
                        }
                      >
                        {loc.name}
                      </Button>
                    );
                  })}
                </InlineStack>
                {selectedLocations.length === 0 && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    No locations selected = include all.
                  </Text>
                )}
              </BlockStack>

              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Vendors
                </Text>
                <Combobox
                  activator={
                    <Combobox.TextField
                      label=""
                      labelHidden
                      value={vendorQuery}
                      onChange={setVendorQuery}
                      placeholder="Search and pick vendors…"
                      autoComplete="off"
                      prefix={<Icon source={SearchIcon} />}
                    />
                  }
                >
                  {filteredVendors.length > 0 && (
                    <Listbox
                      onSelect={(value) => {
                        setSelectedVendors((prev) =>
                          prev.includes(value)
                            ? prev.filter((v) => v !== value)
                            : [...prev, value],
                        );
                      }}
                    >
                      {filteredVendors.slice(0, 30).map((v) => (
                        <Listbox.Option
                          key={v}
                          value={v}
                          selected={selectedVendors.includes(v)}
                        >
                          {v}
                        </Listbox.Option>
                      ))}
                    </Listbox>
                  )}
                </Combobox>
                {selectedVendors.length > 0 && (
                  <InlineStack gap="100" wrap>
                    {selectedVendors.map((v) => (
                      <Tag
                        key={v}
                        onRemove={() =>
                          setSelectedVendors((prev) =>
                            prev.filter((x) => x !== v),
                          )
                        }
                      >
                        {v}
                      </Tag>
                    ))}
                  </InlineStack>
                )}
              </BlockStack>

              <InlineStack align="end" gap="200">
                <Button onClick={handleRebuild} loading={isBusy}>
                  Rebuild today&rsquo;s snapshot
                </Button>
                <Button variant="primary" onClick={handleQuery} loading={isBusy}>
                  Run query
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Chart */}
        {series.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Time series
                </Text>
                <LineChart series={series} />
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Snapshot table */}
        {latestRows.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    Most recent snapshot
                    {latestRows[0]
                      ? ` — ${latestRows[0].periodEnd.slice(0, 10)}`
                      : ""}
                  </Text>
                  <Button onClick={handleExportCsv} size="slim">
                    Export CSV
                  </Button>
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
                      <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                        <th style={{ padding: "8px", textAlign: "left" }}>
                          Location
                        </th>
                        <th style={{ padding: "8px", textAlign: "left" }}>
                          Vendor
                        </th>
                        <th style={{ padding: "8px", textAlign: "right" }}>
                          Units
                        </th>
                        <th style={{ padding: "8px", textAlign: "right" }}>
                          Cost value
                        </th>
                        <th style={{ padding: "8px", textAlign: "right" }}>
                          Retail value
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {latestRows.map((row) => (
                        <tr
                          key={row.id}
                          style={{ borderBottom: "1px solid #f1f1f1" }}
                        >
                          <td style={{ padding: "8px" }}>
                            {locationName(row.locationId)}
                          </td>
                          <td style={{ padding: "8px" }}>
                            {row.vendor ?? "(all)"}
                          </td>
                          <td style={{ padding: "8px", textAlign: "right" }}>
                            {row.totalUnits}
                          </td>
                          <td style={{ padding: "8px", textAlign: "right" }}>
                            ${row.totalCostValue.toFixed(2)}
                          </td>
                          <td style={{ padding: "8px", textAlign: "right" }}>
                            ${row.totalRetailValue.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {actionData?.snapshots && snapshots.length === 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="200" inlineAlign="center">
                <Text as="p" variant="bodyMd">
                  No snapshots match the selected filters in this date
                  range.
                </Text>
              </BlockStack>
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

// ─── Lightweight SVG line chart ────────────────────────────────────────
// Two lines (cost + retail) on a shared y-axis. Deliberately vanilla
// SVG — no chart-library dep needed for two curves.
function LineChart({
  series,
}: {
  series: Array<{ date: string; cost: number; retail: number }>;
}) {
  const W = 720;
  const H = 240;
  const PAD = { l: 56, r: 16, t: 16, b: 32 };
  const inner = {
    w: W - PAD.l - PAD.r,
    h: H - PAD.t - PAD.b,
  };
  const maxY = Math.max(
    1,
    ...series.map((s) => Math.max(s.cost, s.retail)),
  );
  const xStep = series.length > 1 ? inner.w / (series.length - 1) : 0;
  const yScale = (v: number) => PAD.t + inner.h - (v / maxY) * inner.h;
  const xScale = (i: number) => PAD.l + i * xStep;
  const path = (key: "cost" | "retail") =>
    series
      .map((s, i) => `${i === 0 ? "M" : "L"}${xScale(i)} ${yScale(s[key])}`)
      .join(" ");

  const yTicks = 4;
  const tickValues = Array.from({ length: yTicks + 1 }, (_, i) =>
    (maxY * i) / yTicks,
  );

  return (
    <div style={{ overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label="Inventory value over time"
      >
        {/* y-axis grid + labels */}
        {tickValues.map((tv, i) => {
          const y = yScale(tv);
          return (
            <g key={i}>
              <line
                x1={PAD.l}
                x2={W - PAD.r}
                y1={y}
                y2={y}
                stroke="#eef0f2"
              />
              <text
                x={PAD.l - 8}
                y={y + 4}
                fontSize={11}
                fill="#637381"
                textAnchor="end"
              >
                ${Math.round(tv).toLocaleString()}
              </text>
            </g>
          );
        })}
        {/* x-axis labels — first, middle, last */}
        {series.length > 0 &&
          [0, Math.floor(series.length / 2), series.length - 1]
            .filter((i, idx, arr) => arr.indexOf(i) === idx)
            .map((i) => (
              <text
                key={i}
                x={xScale(i)}
                y={H - 8}
                fontSize={11}
                fill="#637381"
                textAnchor="middle"
              >
                {series[i].date.slice(5)}
              </text>
            ))}
        {/* Lines */}
        <path
          d={path("retail")}
          fill="none"
          stroke="#1e88e5"
          strokeWidth={2}
        />
        <path
          d={path("cost")}
          fill="none"
          stroke="#5c6ac4"
          strokeWidth={2}
          strokeDasharray="4 3"
        />
        {/* Legend */}
        <g transform={`translate(${PAD.l}, ${PAD.t - 2})`}>
          <rect width={12} height={2} y={5} fill="#1e88e5" />
          <text x={18} y={9} fontSize={11} fill="#212b36">
            Retail value
          </text>
          <rect width={12} height={2} y={5} x={110} fill="#5c6ac4" />
          <text x={128} y={9} fontSize={11} fill="#212b36">
            Cost value
          </text>
        </g>
      </svg>
    </div>
  );
}
