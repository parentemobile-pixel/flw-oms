import { useMemo, useState } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData, useSearchParams } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Badge,
  ButtonGroup,
  Select,
  Divider,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { getCategoryAggregates } from "../services/planning/category-service.server";
import {
  aggregatesToCSV,
  type CategoryAggregate,
  type CategoryAggregates,
} from "../services/planning/category-types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const periodDays = parseInt(url.searchParams.get("periodDays") ?? "365", 10);
  const agg = await getCategoryAggregates(admin, session.shop, {
    periodDays: Number.isFinite(periodDays) ? periodDays : 365,
  });
  return json({ agg });
};

// ============================================
// Helpers
// ============================================

function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtInt(n: number): string {
  return n.toLocaleString();
}

function yoyBadge(pct: number | null): JSX.Element {
  if (pct == null) return <Badge>n/a</Badge>;
  if (pct > 5) return <Badge tone="success">{`+${pct.toFixed(1)}%`}</Badge>;
  if (pct < -5) return <Badge tone="critical">{`${pct.toFixed(1)}%`}</Badge>;
  return <Badge>{`${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`}</Badge>;
}

// ============================================
// Card component — one per dimension
// ============================================

interface GroupCardProps {
  title: string;
  subtitle: string;
  rows: CategoryAggregate[];
  drillParam: "tag" | "vendor"; // query-param name on /app/planning
  emptyLabel: string;
  maxRows?: number;
}

function GroupCard({
  title,
  subtitle,
  rows,
  drillParam,
  emptyLabel,
  maxRows,
}: GroupCardProps) {
  const [showAll, setShowAll] = useState(false);
  const limit = maxRows ?? 8;
  const visible = showAll ? rows : rows.slice(0, limit);
  const hasMore = rows.length > limit;

  return (
    <Card>
      <BlockStack gap="300">
        <BlockStack gap="050">
          <Text as="h2" variant="headingMd">
            {title}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {subtitle}
          </Text>
        </BlockStack>

        {rows.length === 0 ? (
          <Banner tone="info">{emptyLabel}</Banner>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "12.5px",
              }}
            >
              <thead>
                <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                  <th style={{ padding: "6px", textAlign: "left" }}>Bucket</th>
                  <th style={{ padding: "6px", textAlign: "right" }}>
                    Units in stock
                  </th>
                  <th style={{ padding: "6px", textAlign: "right" }}>
                    Stock $
                  </th>
                  <th style={{ padding: "6px", textAlign: "right" }}>Sold</th>
                  <th style={{ padding: "6px", textAlign: "right" }}>
                    Sold $
                  </th>
                  <th style={{ padding: "6px", textAlign: "right" }}>YoY</th>
                  <th style={{ padding: "6px", textAlign: "right" }}>ST%</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const isUntagged =
                    r.key === "__untagged__" || r.key === "__unknown__";
                  const drillHref = isUntagged
                    ? null
                    : `/app/planning?${drillParam}=${encodeURIComponent(
                        r.key,
                      )}`;
                  return (
                    <tr
                      key={r.key}
                      style={{ borderBottom: "1px solid #f4f4f4" }}
                    >
                      <td style={{ padding: "6px" }}>
                        {drillHref ? (
                          <Link
                            to={drillHref}
                            style={{
                              color: "#005bd3",
                              textDecoration: "none",
                              fontWeight: 500,
                            }}
                            title={`Drill into ${r.label}`}
                          >
                            {r.label}
                          </Link>
                        ) : (
                          <Text as="span" variant="bodySm" tone="subdued">
                            {r.label}
                          </Text>
                        )}
                        <div style={{ marginTop: "2px" }}>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {r.productCount} products · {r.variantCount}{" "}
                            variants
                            {r.onOrder > 0 ? ` · ${r.onOrder} on order` : ""}
                          </Text>
                        </div>
                      </td>
                      <td
                        style={{ padding: "6px", textAlign: "right" }}
                      >
                        {fmtInt(r.unitsInStock)}
                      </td>
                      <td style={{ padding: "6px", textAlign: "right" }}>
                        {fmtUsd(r.stockCostValue)}
                      </td>
                      <td style={{ padding: "6px", textAlign: "right" }}>
                        {fmtInt(r.unitsSold)}
                      </td>
                      <td style={{ padding: "6px", textAlign: "right" }}>
                        {fmtUsd(r.revenueSold)}
                      </td>
                      <td style={{ padding: "6px", textAlign: "right" }}>
                        {yoyBadge(r.yoyUnitsPct)}
                      </td>
                      <td style={{ padding: "6px", textAlign: "right" }}>
                        {r.sellThroughPct.toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {hasMore && (
          <InlineStack align="end">
            <Button
              variant="plain"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll
                ? `Show top ${limit}`
                : `Show all ${rows.length}`}
            </Button>
          </InlineStack>
        )}
      </BlockStack>
    </Card>
  );
}

// ============================================
// Page
// ============================================

export default function PlanningCategories() {
  const { agg } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const periodDays = parseInt(
    searchParams.get("periodDays") ?? String(agg.periodDays ?? 365),
    10,
  );

  const csv = useMemo(
    () => aggregatesToCSV(agg as CategoryAggregates),
    [agg],
  );

  const handleExport = () => {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `planning-categories-${
      new Date().toISOString().slice(0, 10)
    }.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const setPeriod = (v: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("periodDays", v);
    setSearchParams(next);
  };

  const empty =
    agg.seasons.length === 0 &&
    agg.brandTiers.length === 0 &&
    agg.vendors.length === 0;

  return (
    <Page
      title="Planning"
      subtitle="Category, season, and vendor roll-ups over the selected window"
    >
      <Layout>
        {/* Lens toggle */}
        <Layout.Section>
          <InlineStack gap="200">
            <Button url="/app/planning">Products</Button>
            <Button pressed variant="primary">
              Categories &amp; Seasons
            </Button>
          </InlineStack>
        </Layout.Section>

        {/* Controls */}
        <Layout.Section>
          <Card>
            <InlineStack align="space-between" blockAlign="center" wrap>
              <InlineStack gap="300" blockAlign="center">
                <Select
                  label="Window"
                  labelInline
                  options={[
                    { label: "Last 30 days", value: "30" },
                    { label: "Last 90 days", value: "90" },
                    { label: "Last 180 days", value: "180" },
                    { label: "Last 365 days", value: "365" },
                  ]}
                  value={String(periodDays)}
                  onChange={setPeriod}
                />
                <Text as="span" variant="bodySm" tone="subdued">
                  YoY compares to the same window one year earlier. ST% = sold /
                  (sold + in stock).
                </Text>
              </InlineStack>
              <ButtonGroup>
                <Button onClick={handleExport}>Export CSV</Button>
              </ButtonGroup>
            </InlineStack>
          </Card>
        </Layout.Section>

        {/* Totals strip */}
        <Layout.Section>
          <Card>
            <InlineStack gap="600" wrap>
              <Metric label="Products" value={fmtInt(agg.totals.products)} />
              <Metric label="Variants" value={fmtInt(agg.totals.variants)} />
              <Metric
                label="Units in stock"
                value={fmtInt(agg.totals.unitsInStock)}
              />
              <Metric
                label="Stock $ at cost"
                value={fmtUsd(agg.totals.stockCostValue)}
              />
              <Metric
                label={`Units sold · ${agg.periodDays}d`}
                value={fmtInt(agg.totals.unitsSold)}
              />
              <Metric
                label={`Revenue · ${agg.periodDays}d`}
                value={fmtUsd(agg.totals.revenueSold)}
              />
            </InlineStack>
          </Card>
        </Layout.Section>

        {empty && (
          <Layout.Section>
            <Banner tone="info" title="No data yet">
              Head back to the Products lens and run Sync / Rebuild snapshots
              first.
            </Banner>
          </Layout.Section>
        )}

        {/* Three side-by-side cards */}
        <Layout.Section variant="oneThird">
          <GroupCard
            title="Seasons"
            subtitle="By season tag (FW25, SS26, …). Click to drill in."
            rows={agg.seasons}
            drillParam="tag"
            emptyLabel="No season-tagged products found."
          />
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <GroupCard
            title="Brand tiers"
            subtitle="FLW Brand / Private Label / Partner Brand."
            rows={agg.brandTiers}
            drillParam="tag"
            emptyLabel="No brand-tier-tagged products found."
          />
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <GroupCard
            title="Vendors"
            subtitle="Sorted by revenue in window."
            rows={agg.vendors}
            drillParam="vendor"
            emptyLabel="No vendor data."
            maxRows={12}
          />
        </Layout.Section>

        <Layout.Section>
          <Divider />
          <div style={{ height: "1.5rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <BlockStack gap="050">
      <Text as="p" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <Text as="p" variant="headingLg">
        {value}
      </Text>
    </BlockStack>
  );
}
