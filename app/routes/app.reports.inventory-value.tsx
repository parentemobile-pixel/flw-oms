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
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { buildVariantDaySnapshot } from "../services/forecast/variant-day-snapshot.server";

const STOCKY_TOTAL_LOCATION_ID = "stocky-total";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [productTypes, variantDayCount] = await Promise.all([
    db.variantDaySnapshot.findMany({
      where: { shop: session.shop, productType: { not: "" } },
      select: { productType: true },
      distinct: ["productType"],
    }),
    db.variantDaySnapshot.count({ where: { shop: session.shop } }),
  ]);
  return json({
    productTypes: productTypes.map((r) => r.productType).sort(),
    variantDayCount,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "query");

  if (intent === "rebuild") {
    try {
      const result = await buildVariantDaySnapshot(admin, session.shop);
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
  const productTypesCsv = String(formData.get("productTypes") ?? "");
  if (!startDate || !endDate) {
    return json({ error: "Pick a date range." });
  }
  const startTs = new Date(`${startDate}T00:00:00Z`);
  const endTs = new Date(`${endDate}T23:59:59Z`);
  const selectedTypes = productTypesCsv
    ? productTypesCsv.split(",").filter(Boolean)
    : [];

  // Per-date sums from variant_day. Clip negative on_hand to zero
  // (oversold units don't count toward valuation — you don't own what
  // you owe). Group at DATE granularity for the chart.
  const dailyRows = await db.variantDaySnapshot.findMany({
    where: {
      shop: session.shop,
      date: { gte: startTs, lte: endTs },
      ...(selectedTypes.length > 0 ? { productType: { in: selectedTypes } } : {}),
    },
    select: {
      date: true,
      onHand: true,
      unitCost: true,
      price: true,
      productType: true,
    },
  });

  // Roll up per calendar date (client-side — SQLite groupBy on a
  // computed date-string isn't first-class in Prisma).
  const byDate = new Map<
    string,
    { units: number; cost: number; retail: number }
  >();
  for (const row of dailyRows) {
    const onHandPositive = Math.max(0, row.onHand);
    if (onHandPositive === 0) continue;
    const key = row.date.toISOString().slice(0, 10);
    const entry = byDate.get(key) ?? { units: 0, cost: 0, retail: 0 };
    entry.units += onHandPositive;
    entry.cost += onHandPositive * row.unitCost;
    entry.retail += onHandPositive * row.price;
    byDate.set(key, entry);
  }
  const variantDaySeries = Array.from(byDate.entries())
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Latest-day per-category breakdown (only when types aren't filtered
  // — surface a snapshot of the mix). Aggregates the same dailyRows
  // for whichever the newest date is.
  const latestDate = variantDaySeries.length > 0
    ? variantDaySeries[variantDaySeries.length - 1].date
    : null;
  const byCategoryLatest = new Map<
    string,
    { units: number; cost: number; retail: number }
  >();
  if (latestDate) {
    for (const row of dailyRows) {
      const dateKey = row.date.toISOString().slice(0, 10);
      if (dateKey !== latestDate) continue;
      const onHandPositive = Math.max(0, row.onHand);
      if (onHandPositive === 0) continue;
      const cat = row.productType || "(uncategorized)";
      const entry = byCategoryLatest.get(cat) ?? { units: 0, cost: 0, retail: 0 };
      entry.units += onHandPositive;
      entry.cost += onHandPositive * row.unitCost;
      entry.retail += onHandPositive * row.price;
      byCategoryLatest.set(cat, entry);
    }
  }
  const categoryBreakdown = Array.from(byCategoryLatest.entries())
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.cost - a.cost);

  // Pre-cutover Stocky sentinel rows for shop-total fallback. Only
  // included when no product-type filter is active — Stocky data
  // doesn't have a category breakdown.
  let stockySeries: Array<{ date: string; cost: number; retail: number }> = [];
  if (selectedTypes.length === 0) {
    const cutover = variantDaySeries.length > 0
      ? new Date(variantDaySeries[0].date + "T00:00:00Z")
      : endTs;
    const stockyRows = await db.inventoryValueSnapshot.findMany({
      where: {
        shop: session.shop,
        locationId: STOCKY_TOTAL_LOCATION_ID,
        periodEnd: { gte: startTs, lt: cutover },
      },
      select: {
        periodEnd: true,
        totalCostValue: true,
        totalRetailValue: true,
      },
      orderBy: { periodEnd: "asc" },
    });
    stockySeries = stockyRows.map((r) => ({
      date: r.periodEnd.toISOString().slice(0, 10),
      cost: r.totalCostValue,
      retail: r.totalRetailValue,
    }));
  }

  return json({
    variantDaySeries,
    stockySeries,
    categoryBreakdown,
    queriedAt: new Date().toISOString(),
  });
};

interface ChartPoint {
  date: string;
  cost: number;
  retail: number;
}

interface CategoryRow {
  category: string;
  units: number;
  cost: number;
  retail: number;
}

interface ActionPayload {
  variantDaySeries?: Array<{
    date: string;
    units: number;
    cost: number;
    retail: number;
  }>;
  stockySeries?: ChartPoint[];
  categoryBreakdown?: CategoryRow[];
  rebuiltAt?: string;
  result?: {
    date: string;
    variantsWritten: number;
    productsSeen: number;
    totalOnHand: number;
    totalUnitsSold: number;
  };
  error?: string;
}

export default function InventoryValueReport() {
  const { productTypes, variantDayCount } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ActionPayload | undefined;
  const submit = useSubmit();
  const navigation = useNavigation();
  const isBusy = navigation.state === "submitting";

  const [startDate, setStartDate] = useState(() =>
    isoDate(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)),
  );
  const [endDate, setEndDate] = useState(() => isoDate(new Date()));
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);

  const handleQuery = useCallback(() => {
    const fd = new FormData();
    fd.set("startDate", startDate);
    fd.set("endDate", endDate);
    fd.set("productTypes", selectedTypes.join(","));
    submit(fd, { method: "post" });
  }, [startDate, endDate, selectedTypes, submit]);

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

  // Merge Stocky pre-cutover into the same chart series. Two-tone
  // legend distinguishes the sources.
  const chartPoints: ChartPoint[] = useMemo(() => {
    const stocky = actionData?.stockySeries ?? [];
    const variant = (actionData?.variantDaySeries ?? []).map((p) => ({
      date: p.date,
      cost: p.cost,
      retail: p.retail,
    }));
    // Dedup by date (variant_day wins over Stocky sentinel).
    const seen = new Set(variant.map((p) => p.date));
    return [...stocky.filter((p) => !seen.has(p.date)), ...variant].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  }, [actionData]);

  const cutoverDate = actionData?.variantDaySeries?.[0]?.date ?? null;
  const categoryBreakdown = actionData?.categoryBreakdown ?? [];

  const csvEscape = (v: unknown): string => {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const handleExportCsv = useCallback(() => {
    if (chartPoints.length === 0) return;
    const header = ["Date", "Cost value", "Retail value"];
    const rows = chartPoints.map((p) => [
      p.date,
      p.cost.toFixed(2),
      p.retail.toFixed(2),
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
  }, [chartPoints, startDate, endDate]);

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
              Rebuilt today's snapshot: {actionData.result.variantsWritten}{" "}
              variants across {actionData.result.productsSeen} products —{" "}
              {actionData.result.totalOnHand.toLocaleString()} units on hand.
            </Banner>
          </Layout.Section>
        )}
        {variantDayCount === 0 && (
          <Layout.Section>
            <Banner tone="info" title="No per-variant snapshots yet">
              <Text as="p" variant="bodyMd">
                Nightly snapshots kick in on the next cron tick (fires every
                3 hours after boot). Click <strong>Rebuild today's snapshot</strong>{" "}
                to populate now. Pre-cutover history comes from the Stocky
                backfill.
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

              {productTypes.length > 0 && (
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Category (product type)
                  </Text>
                  <InlineStack gap="200" wrap>
                    {productTypes.map((t) => {
                      const checked = selectedTypes.includes(t);
                      return (
                        <Button
                          key={t}
                          size="slim"
                          pressed={checked}
                          onClick={() =>
                            setSelectedTypes((prev) =>
                              prev.includes(t)
                                ? prev.filter((x) => x !== t)
                                : [...prev, t],
                            )
                          }
                        >
                          {t}
                        </Button>
                      );
                    })}
                  </InlineStack>
                  {selectedTypes.length === 0 && (
                    <Text as="span" variant="bodySm" tone="subdued">
                      No categories selected = include all. Filtering by
                      category drops the Stocky pre-cutover trend since
                      Stocky data has no category breakdown.
                    </Text>
                  )}
                </BlockStack>
              )}

              <InlineStack align="end" gap="200">
                <Button onClick={handleRebuild} loading={isBusy}>
                  Rebuild today's snapshot
                </Button>
                <Button variant="primary" onClick={handleQuery} loading={isBusy}>
                  Run query
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Chart */}
        {chartPoints.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    Time series
                  </Text>
                  <Button onClick={handleExportCsv} size="slim">
                    Export CSV
                  </Button>
                </InlineStack>
                <LineChart series={chartPoints} cutoverDate={cutoverDate} />
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Category breakdown for the latest day */}
        {categoryBreakdown.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Most recent breakdown by category
                  {actionData?.variantDaySeries?.length
                    ? ` — ${actionData.variantDaySeries[actionData.variantDaySeries.length - 1].date}`
                    : ""}
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
                        <th style={{ padding: "8px", textAlign: "left" }}>
                          Category
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
                      {categoryBreakdown.map((row) => (
                        <tr
                          key={row.category}
                          style={{ borderBottom: "1px solid #f1f1f1" }}
                        >
                          <td style={{ padding: "8px" }}>{row.category}</td>
                          <td style={{ padding: "8px", textAlign: "right" }}>
                            {row.units.toLocaleString()}
                          </td>
                          <td style={{ padding: "8px", textAlign: "right" }}>
                            ${row.cost.toFixed(2)}
                          </td>
                          <td style={{ padding: "8px", textAlign: "right" }}>
                            ${row.retail.toFixed(2)}
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

        {actionData?.variantDaySeries && chartPoints.length === 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="200" inlineAlign="center">
                <Text as="p" variant="bodyMd">
                  No data in the selected date range and filters.
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

// ─── Lightweight SVG line chart with a cutover marker ─────────────────
function LineChart({
  series,
  cutoverDate,
}: {
  series: Array<{ date: string; cost: number; retail: number }>;
  cutoverDate: string | null;
}) {
  const W = 720;
  const H = 240;
  const PAD = { l: 56, r: 16, t: 16, b: 32 };
  const inner = { w: W - PAD.l - PAD.r, h: H - PAD.t - PAD.b };
  const maxY = Math.max(1, ...series.map((s) => Math.max(s.cost, s.retail)));
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

  const cutoverIdx = cutoverDate
    ? series.findIndex((s) => s.date === cutoverDate)
    : -1;

  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
        {tickValues.map((tv, i) => {
          const y = yScale(tv);
          return (
            <g key={i}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y} y2={y} stroke="#eef0f2" />
              <text x={PAD.l - 8} y={y + 4} fontSize={11} fill="#637381" textAnchor="end">
                ${Math.round(tv).toLocaleString()}
              </text>
            </g>
          );
        })}
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
        {cutoverIdx > 0 && (
          <>
            <line
              x1={xScale(cutoverIdx)}
              x2={xScale(cutoverIdx)}
              y1={PAD.t}
              y2={PAD.t + inner.h}
              stroke="#c9184a"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
            <text
              x={xScale(cutoverIdx) + 4}
              y={PAD.t + 12}
              fontSize={10}
              fill="#c9184a"
            >
              variant_day starts
            </text>
          </>
        )}
        <path d={path("retail")} fill="none" stroke="#1e88e5" strokeWidth={2} />
        <path
          d={path("cost")}
          fill="none"
          stroke="#5c6ac4"
          strokeWidth={2}
          strokeDasharray="4 3"
        />
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
