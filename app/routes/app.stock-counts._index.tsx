import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useSearchParams } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Badge,
  Banner,
  Checkbox,
  Divider,
  Select,
  Icon,
  Modal,
  Tabs,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import {
  getDefaultLocation,
  getLocations,
  type Location,
} from "../services/shopify-api/locations.server";
import {
  getCycleCountRows,
  saveCycleCounts,
  type CycleSaveEntry,
} from "../services/stock-counts/cycle-count-service.server";
import {
  filterCellsByQuery,
  filterStaleCells,
  findCellByCode,
  isStale,
  sortCells,
  type CycleCell,
  type CycleSort,
} from "../services/stock-counts/cycle-count-utils";
import { relativeTime, relativeTimeShort } from "../utils/relative-time";
import { LocationPicker } from "../components/LocationPicker";
import { BarcodeScanInput } from "../components/BarcodeScanInput";
import { ProductGrid, type GridCell } from "../components/ProductGrid";

type View = "count" | "stale";
const DAY_OPTIONS = [7, 30, 60, 90];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const [locations, defaultLocation] = await Promise.all([
    getLocations(admin, session.shop).catch(() => [] as Location[]),
    getDefaultLocation(admin, session.shop).catch(() => null),
  ]);
  const view: View = url.searchParams.get("view") === "stale" ? "stale" : "count";
  const daysParam = parseInt(url.searchParams.get("days") ?? "", 10);
  const days = DAY_OPTIONS.includes(daysParam) ? daysParam : 30;
  return json({
    locations,
    defaultLocationId: defaultLocation?.id ?? null,
    initialView: view,
    initialDays: days,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const locationId = String(formData.get("locationId") ?? "");

  try {
    if (!locationId) return json({ error: "Pick a location first." });

    if (intent === "load") {
      const includeZeroStock = formData.get("includeZeroStock") === "1";
      const forceRefresh = formData.get("refresh") === "1";
      const result = await getCycleCountRows(admin, session.shop, locationId, {
        includeZeroStock,
        forceRefresh,
      });
      return json({ loaded: { ...result, locationId } });
    }

    if (intent === "save-row") {
      const entries = JSON.parse(
        String(formData.get("entries") ?? "[]"),
      ) as CycleSaveEntry[];
      const result = await saveCycleCounts(
        admin,
        session.shop,
        locationId,
        entries,
        null,
      );
      const label = entries[0]
        ? `${entries[0].productTitle}${
            entries.length === 1 ? ` — ${entries[0].variantTitle}` : ""
          }`
        : "row";
      return json({ saved: { ...result, label } });
    }

    return json({ error: `Unknown action: ${intent}` });
  } catch (error) {
    return json({ error: String(error) });
  }
};

type LoadedPayload = {
  cells: CycleCell[];
  productCount: number;
  variantCount: number;
  totalUnits: number;
  truncated: boolean;
  loadedAt: string;
  locationId: string;
};
type SavedPayload = {
  rows: Array<{
    variantId: string;
    currentQty: number;
    previousQty: number;
    lastCountedAt: string;
  }>;
  missing: string[];
  adjusted: number;
  verified: number;
  sessionId: string | null;
  label: string;
};
type ActionPayload = {
  loaded?: LoadedPayload;
  saved?: SavedPayload;
  error?: string;
};

export default function StockCounts() {
  const { locations, defaultLocationId, initialView, initialDays } =
    useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();

  const loadFetcher = useFetcher<typeof action>();
  const saveFetcher = useFetcher<typeof action>();
  const isLoading = loadFetcher.state !== "idle";
  const isSaving = saveFetcher.state !== "idle";

  // ── Location + load options ─────────────────────────────────────────
  const [locationId, setLocationId] = useState<string | null>(defaultLocationId);
  const [includeZeroStock, setIncludeZeroStock] = useState(false);

  // ── Loaded rows + per-session state ─────────────────────────────────
  const [cells, setCells] = useState<CycleCell[]>([]);
  const [loadMeta, setLoadMeta] = useState<Omit<LoadedPayload, "cells"> | null>(
    null,
  );
  // drafts[variantId] = what's typed in the cell. Absent = showing live qty.
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  // Running tally for scanner input: first scan of a variant = 1, then +1.
  const [scanTally, setScanTally] = useState<Record<string, number>>({});
  const [savedThisSession, setSavedThisSession] = useState<Set<string>>(
    () => new Set(),
  );
  const [highlightVariantId, setHighlightVariantId] = useState<string | null>(
    null,
  );

  // ── View controls ───────────────────────────────────────────────────
  const [view, setView] = useState<View>(initialView);
  const [days, setDays] = useState<number>(initialDays);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<CycleSort>(
    initialView === "stale" ? "stale" : "vendor",
  );
  const [scanFeedback, setScanFeedback] = useState<{
    message: string;
    tone: "success" | "critical" | "subdued";
  } | null>(null);
  const [zeroRow, setZeroRow] = useState<GridCell[] | null>(null);
  const [saveBanner, setSaveBanner] = useState<{
    tone: "success" | "critical" | "warning";
    title: string;
    body: string | null;
  } | null>(null);

  // Keep view/days in the URL so "Not counted in 60 days" is linkable.
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (view === "stale") next.set("view", "stale");
        else next.delete("view");
        if (days !== 30) next.set("days", String(days));
        else next.delete("days");
        return next;
      },
      { replace: true },
    );
  }, [view, days, setSearchParams]);

  // ── Load ────────────────────────────────────────────────────────────
  const handleLoad = useCallback(
    (refresh: boolean) => {
      if (!locationId) return;
      const fd = new FormData();
      fd.set("intent", "load");
      fd.set("locationId", locationId);
      fd.set("includeZeroStock", includeZeroStock ? "1" : "0");
      fd.set("refresh", refresh ? "1" : "0");
      loadFetcher.submit(fd, { method: "post" });
    },
    [locationId, includeZeroStock, loadFetcher],
  );

  useEffect(() => {
    const data = loadFetcher.data as ActionPayload | undefined;
    if (!data || loadFetcher.state !== "idle") return;
    if (data.loaded) {
      const { cells: loadedCells, ...meta } = data.loaded;
      setCells(loadedCells);
      setLoadMeta(meta);
      setDrafts({});
      setScanTally({});
      setSavedThisSession(new Set());
      setHighlightVariantId(null);
      setSaveBanner(null);
      setScanFeedback(null);
    } else if (data.error) {
      setSaveBanner({ tone: "critical", title: "Couldn't load", body: data.error });
    }
  }, [loadFetcher.data, loadFetcher.state]);

  // Changing location clears the grid — the rows belong to the old one.
  const handleLocationChange = useCallback((next: string) => {
    setLocationId(next);
    setCells([]);
    setLoadMeta(null);
    setDrafts({});
    setScanTally({});
    setSavedThisSession(new Set());
    setSaveBanner(null);
  }, []);

  // ── Save row ────────────────────────────────────────────────────────
  const byVariantId = useMemo(() => {
    const m = new Map<string, CycleCell>();
    for (const c of cells) m.set(c.variantId, c);
    return m;
  }, [cells]);

  const submitRow = useCallback(
    (rowCells: GridCell[], forceQty?: number) => {
      if (!locationId) return;
      const entries: CycleSaveEntry[] = [];
      for (const gc of rowCells) {
        const c = byVariantId.get(gc.variantId);
        if (!c) continue;
        entries.push({
          variantId: c.variantId,
          countedQty: forceQty ?? drafts[c.variantId] ?? c.onHand,
          productId: c.productId,
          productTitle: c.productTitle,
          variantTitle: c.variantTitle,
          vendor: c.vendor,
          sku: c.sku,
          barcode: c.barcode,
        });
      }
      if (entries.length === 0) return;
      const fd = new FormData();
      fd.set("intent", "save-row");
      fd.set("locationId", locationId);
      fd.set("entries", JSON.stringify(entries));
      saveFetcher.submit(fd, { method: "post" });
    },
    [locationId, byVariantId, drafts, saveFetcher],
  );

  useEffect(() => {
    const data = saveFetcher.data as ActionPayload | undefined;
    if (!data || saveFetcher.state !== "idle") return;
    if (data.saved) {
      const { rows, missing, adjusted, verified, label } = data.saved;
      const byId = new Map(rows.map((r) => [r.variantId, r]));
      const missingSet = new Set(missing);
      setCells((prev) =>
        prev
          .filter((c) => !missingSet.has(c.variantId))
          .map((c) => {
            const r = byId.get(c.variantId);
            return r
              ? {
                  ...c,
                  onHand: r.currentQty,
                  lastCountedAt: r.lastCountedAt,
                  lastCountedQty: r.currentQty,
                }
              : c;
          }),
      );
      setDrafts((prev) => {
        const next = { ...prev };
        for (const r of rows) delete next[r.variantId];
        for (const id of missing) delete next[id];
        return next;
      });
      setScanTally((prev) => {
        const next = { ...prev };
        for (const r of rows) delete next[r.variantId];
        return next;
      });
      setSavedThisSession((prev) => {
        const next = new Set(prev);
        for (const r of rows) next.add(r.variantId);
        return next;
      });
      const changes = rows
        .filter((r) => r.previousQty !== r.currentQty)
        .map((r) => {
          const c = byVariantId.get(r.variantId);
          const size =
            c?.selectedOptions.find((o) => o.name.toLowerCase() === "size")
              ?.value ?? c?.variantTitle ?? r.variantId;
          return `${size}: ${r.previousQty} → ${r.currentQty}`;
        });
      const parts: string[] = [];
      if (adjusted > 0) parts.push(`${adjusted} adjusted in Shopify (${changes.join(", ")})`);
      if (verified > 0) parts.push(`${verified} verified, no change`);
      if (missing.length > 0) {
        parts.push(`${missing.length} no longer exist in Shopify and were dropped`);
      }
      setSaveBanner({
        tone: missing.length > 0 ? "warning" : "success",
        title: `Saved ${label}`,
        body: parts.join(" · ") || null,
      });
    } else if (data.error) {
      setSaveBanner({ tone: "critical", title: "Save failed", body: data.error });
    }
    // byVariantId intentionally omitted: it's only used for labels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveFetcher.data, saveFetcher.state]);

  // ── Scan ────────────────────────────────────────────────────────────
  const handleScan = useCallback(
    (code: string) => {
      const hit = findCellByCode(cells, code);
      if (!hit) {
        setScanFeedback({
          message: `No loaded variant matches "${code}". ${
            includeZeroStock ? "" : "Try Load with zero-stock items included."
          }`,
          tone: "critical",
        });
        return;
      }
      const nextTally = (scanTally[hit.variantId] ?? 0) + 1;
      setScanTally((prev) => ({ ...prev, [hit.variantId]: nextTally }));
      setDrafts((prev) => ({ ...prev, [hit.variantId]: nextTally }));
      setHighlightVariantId(hit.variantId);
      setSearch(hit.productTitle);
      setView("count");
      setScanFeedback({
        message: `${hit.productTitle} — ${hit.variantTitle}: counted ${nextTally}`,
        tone: "success",
      });
    },
    [cells, scanTally, includeZeroStock],
  );

  // ── Grid data ───────────────────────────────────────────────────────
  const now = Date.now();
  const staleCount = useMemo(
    () => filterStaleCells(cells, days, now).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cells, days],
  );

  const gridCells: GridCell[] = useMemo(() => {
    const base = view === "stale" ? filterStaleCells(cells, days, now) : cells;
    const sorted = sortCells(filterCellsByQuery(base, search), sort);
    return sorted.map((c) => ({
      variantId: c.variantId,
      productId: c.productId,
      productTitle: c.productTitle,
      variantTitle: c.variantTitle,
      selectedOptions: c.selectedOptions,
      sku: c.sku,
      stock: c.onHand,
      value: drafts[c.variantId] ?? c.onHand,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, view, days, search, sort, drafts]);

  const vendorByProduct = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cells) {
      if (!m.has(c.productId)) m.set(c.productId, c.vendor || "Unknown vendor");
    }
    return m;
  }, [cells]);
  const groupBy =
    sort === "vendor"
      ? (row: { productId: string }) =>
          vendorByProduct.get(row.productId) ?? "Unknown vendor"
      : undefined;

  const handleCellChange = useCallback((variantId: string, next: number) => {
    setDrafts((prev) => ({ ...prev, [variantId]: next }));
  }, []);

  // Cell colours:
  //   blue outline = just scanned
  //   yellow       = typed, not saved yet
  //   green        = saved this session, or counted within N days
  //   amber        = stale / never counted
  const getCellStyle = (cell: GridCell) => {
    const c = byVariantId.get(cell.variantId);
    if (!c) return undefined;
    if (cell.variantId === highlightVariantId) {
      return { background: "#eaf4ff", boxShadow: "inset 0 0 0 2px #2c6ecb" };
    }
    const draft = drafts[cell.variantId];
    if (draft !== undefined && draft !== c.onHand) {
      return { background: "#fff8dc", boxShadow: "inset 0 0 0 1px #e6cf7a" };
    }
    if (savedThisSession.has(cell.variantId)) {
      return { background: "#e7f5ec", boxShadow: "inset 0 0 0 1px #8fd19e" };
    }
    if (c.onHand > 0 && isStale(c.lastCountedAt, days, now)) {
      return { background: "#fff4e5", boxShadow: "inset 0 0 0 1px #f0b76a" };
    }
    if (c.lastCountedAt) {
      return { background: "#f1f8f4" };
    }
    return undefined;
  };

  const getCellSubtext = (cell: GridCell) => {
    const c = byVariantId.get(cell.variantId);
    if (!c) return null;
    const short = relativeTimeShort(c.lastCountedAt, now);
    return (
      <span style={{ color: short ? "#6b7280" : "#b45309" }}>
        {short ? `stk ${c.onHand} · ${short}` : `stk ${c.onHand} · never`}
      </span>
    );
  };

  const locationName =
    locations.find((l) => l.id === locationId)?.name ?? "location";

  const tabs = [
    { id: "count", content: "Count" },
    {
      id: "stale",
      content: `Not counted in ${days} days${loadMeta ? ` (${staleCount})` : ""}`,
    },
  ];

  return (
    <Page
      title="Stock Counts"
      subtitle={loadMeta ? `@ ${locationName}` : undefined}
      primaryAction={{
        content: loadMeta ? "Refresh" : "Load",
        onAction: () => handleLoad(!!loadMeta),
        loading: isLoading,
        disabled: !locationId,
      }}
    >
      <Layout>
        {saveBanner && (
          <Layout.Section>
            <Banner
              tone={saveBanner.tone}
              title={saveBanner.title}
              onDismiss={() => setSaveBanner(null)}
            >
              {saveBanner.body && <p>{saveBanner.body}</p>}
            </Banner>
          </Layout.Section>
        )}
        {loadMeta?.truncated && (
          <Layout.Section>
            <Banner tone="warning" title="Catalog truncated">
              The walk hit the internal product cap, so some products are
              missing from this list.
            </Banner>
          </Layout.Section>
        )}

        {/* Location + options */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="300" wrap blockAlign="end">
                <div style={{ flex: "0 0 240px" }}>
                  <LocationPicker
                    locations={locations}
                    value={locationId}
                    onChange={handleLocationChange}
                    persistKey="stock-count-location"
                    disabled={isLoading || isSaving}
                  />
                </div>
                <Checkbox
                  label="Include zero-stock items"
                  checked={includeZeroStock}
                  onChange={setIncludeZeroStock}
                  disabled={isLoading}
                />
                <Button
                  onClick={() => handleLoad(!!loadMeta)}
                  loading={isLoading}
                  disabled={!locationId}
                  variant={loadMeta ? undefined : "primary"}
                >
                  {loadMeta ? "Refresh" : "Load"}
                </Button>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                Counts save row by row. <strong>Save row</strong> updates
                Shopify inventory at {locationName} immediately for any size
                whose count differs from the live number, and stamps every
                size in the row as counted today.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {loadMeta && (
          <>
            {/* Summary + scan + search */}
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" wrap>
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Products / Variants
                      </Text>
                      <Text as="p" variant="headingLg">
                        {loadMeta.productCount} / {loadMeta.variantCount}
                      </Text>
                    </BlockStack>
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Units on hand
                      </Text>
                      <Text as="p" variant="headingLg">
                        {loadMeta.totalUnits.toLocaleString()}
                      </Text>
                    </BlockStack>
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Not counted in {days} days
                      </Text>
                      <Text
                        as="p"
                        variant="headingLg"
                        tone={staleCount > 0 ? "critical" : "success"}
                      >
                        {staleCount}
                      </Text>
                    </BlockStack>
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Saved this session
                      </Text>
                      <Text as="p" variant="headingLg">
                        {savedThisSession.size}
                      </Text>
                    </BlockStack>
                    <BlockStack gap="050">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Loaded
                      </Text>
                      <Text as="p" variant="bodyMd">
                        {relativeTime(loadMeta.loadedAt)}
                      </Text>
                    </BlockStack>
                  </InlineStack>
                  <Divider />
                  <InlineStack gap="300" wrap blockAlign="end">
                    <div style={{ flex: "1 1 240px", minWidth: "240px" }}>
                      <BarcodeScanInput
                        onScan={handleScan}
                        label="Scan"
                        placeholder="Scan SKU or barcode — tallies +1…"
                      />
                    </div>
                    <div style={{ flex: "1 1 240px", minWidth: "240px" }}>
                      <TextField
                        label="Search"
                        value={search}
                        onChange={(v) => {
                          setSearch(v);
                          setHighlightVariantId(null);
                        }}
                        placeholder="Product, variant, SKU, vendor…"
                        autoComplete="off"
                        prefix={<Icon source={SearchIcon} />}
                        clearButton
                        onClearButtonClick={() => setSearch("")}
                      />
                    </div>
                    <div style={{ flex: "0 0 160px" }}>
                      <Select
                        label="Sort"
                        options={[
                          { label: "Vendor", value: "vendor" },
                          { label: "Product", value: "product" },
                          { label: "Oldest count first", value: "stale" },
                        ]}
                        value={sort}
                        onChange={(v) => setSort(v as CycleSort)}
                      />
                    </div>
                    <div style={{ flex: "0 0 160px" }}>
                      <Select
                        label="Stale after"
                        options={DAY_OPTIONS.map((d) => ({
                          label: `${d} days`,
                          value: String(d),
                        }))}
                        value={String(days)}
                        onChange={(v) => setDays(parseInt(v, 10))}
                      />
                    </div>
                  </InlineStack>
                  {scanFeedback && (
                    <Text as="p" variant="bodySm" tone={scanFeedback.tone}>
                      {scanFeedback.message}
                    </Text>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>

            {/* Grid */}
            <Layout.Section>
              <Card padding="0">
                <Tabs
                  tabs={tabs}
                  selected={view === "stale" ? 1 : 0}
                  onSelect={(i) => {
                    const next: View = i === 1 ? "stale" : "count";
                    setView(next);
                    if (next === "stale" && sort === "vendor") setSort("stale");
                  }}
                />
                <div style={{ padding: "16px" }}>
                  {gridCells.length === 0 ? (
                    <Text as="p" tone="subdued">
                      {view === "stale"
                        ? `Everything in stock at ${locationName} has been counted in the last ${days} days.`
                        : "No variants match."}
                    </Text>
                  ) : (
                    <ProductGrid
                      cells={gridCells}
                      qtyLabel="Counted"
                      onCellChange={handleCellChange}
                      showColumns={{
                        cost: false,
                        retail: false,
                        stock: true,
                        onOrder: false,
                      }}
                      sizeColumns={["XS", "S", "M", "L", "XL", "2XL"]}
                      getCellStyle={getCellStyle}
                      getCellSubtext={getCellSubtext}
                      groupBy={groupBy}
                      stickyLeadColumn
                      maxHeight="75vh"
                      trailingLabel="Status"
                      renderRowTrailing={({ cells: rowCells }) => {
                        const rowSrc = rowCells
                          .map((gc) => byVariantId.get(gc.variantId))
                          .filter((c): c is CycleCell => !!c);
                        const dirty = rowSrc.some(
                          (c) =>
                            drafts[c.variantId] !== undefined &&
                            drafts[c.variantId] !== c.onHand,
                        );
                        const allSaved =
                          rowSrc.length > 0 &&
                          rowSrc.every((c) => savedThisSession.has(c.variantId));
                        const anyStale = rowSrc.some(
                          (c) => c.onHand > 0 && isStale(c.lastCountedAt, days, now),
                        );
                        const anyNever = rowSrc.some((c) => !c.lastCountedAt);
                        const freshest = rowSrc
                          .map((c) =>
                            c.lastCountedAt ? new Date(c.lastCountedAt).getTime() : 0,
                          )
                          .reduce((a, b) => Math.max(a, b), 0);

                        let tone:
                          | "success"
                          | "warning"
                          | "attention"
                          | "critical"
                          | undefined;
                        let text: string;
                        if (dirty) {
                          tone = "warning";
                          text = "Unsaved changes";
                        } else if (allSaved) {
                          tone = "success";
                          text = "Counted";
                        } else if (anyNever) {
                          tone = "critical";
                          text = "Never counted";
                        } else if (anyStale) {
                          tone = "attention";
                          text = "Stale";
                        } else {
                          tone = "success";
                          text = "Up to date";
                        }

                        return (
                          <BlockStack gap="100" inlineAlign="end">
                            <Badge tone={tone}>{text}</Badge>
                            {freshest > 0 && (
                              <Text as="span" variant="bodySm" tone="subdued">
                                Last counted {relativeTime(new Date(freshest))}
                              </Text>
                            )}
                            <InlineStack gap="100">
                              {view === "stale" && (
                                <Button
                                  size="slim"
                                  tone="critical"
                                  variant="plain"
                                  onClick={() => setZeroRow(rowCells)}
                                  disabled={isSaving}
                                >
                                  Zero row
                                </Button>
                              )}
                              <Button
                                size="slim"
                                variant={dirty ? "primary" : undefined}
                                onClick={() => submitRow(rowCells)}
                                loading={isSaving}
                              >
                                {dirty ? "Save changes" : "Save row"}
                              </Button>
                            </InlineStack>
                          </BlockStack>
                        );
                      }}
                    />
                  )}
                </div>
              </Card>
            </Layout.Section>
          </>
        )}

        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>

      <Modal
        open={zeroRow !== null}
        onClose={() => setZeroRow(null)}
        title="Zero out this row?"
        primaryAction={{
          content: "Set to 0",
          destructive: true,
          onAction: () => {
            if (zeroRow) submitRow(zeroRow, 0);
            setZeroRow(null);
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setZeroRow(null) }]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">
              Every size in{" "}
              <strong>
                {zeroRow?.[0]?.productTitle}
                {zeroRow?.[0]
                  ? (() => {
                      const ns = zeroRow[0].selectedOptions
                        .filter((o) => o.name.toLowerCase() !== "size")
                        .map((o) => o.value)
                        .join(" / ");
                      return ns ? ` — ${ns}` : "";
                    })()
                  : ""}
              </strong>{" "}
              will be set to 0 at {locationName} and recorded as a cycle-count
              adjustment. Use this for phantom stock that isn't on the shelf.
            </Text>
            <Text as="p" tone="subdued">
              To archive the product itself, open it in Shopify admin.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
