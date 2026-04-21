import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRevalidator,
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
  Badge,
  Banner,
  ButtonGroup,
  Divider,
  Select,
  Icon,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import {
  abandonStockCount,
  completeStockCount,
  findLineByCode,
  getStockCount,
  incrementCount,
  recordCount,
} from "../services/stock-counts/stock-count-service.server";
import { getLocations } from "../services/shopify-api/locations.server";
import { BarcodeScanInput } from "../components/BarcodeScanInput";
import { ProductGrid, type GridCell } from "../components/ProductGrid";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const sc = await getStockCount(session.shop, params.id!);
  if (!sc) throw new Response("Not found", { status: 404 });
  const locations = await getLocations(admin, session.shop).catch(() => []);
  const locationName =
    locations.find((l) => l.id === sc.locationId)?.name ?? sc.locationId;
  return json({ sc, locationName });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));
  const id = params.id!;

  try {
    if (intent === "record") {
      const lineItemId = String(formData.get("lineItemId"));
      const raw = String(formData.get("countedQuantity"));
      // Empty string → clear the count (countedQuantity back to null,
      // i.e. "not counted yet"); a real number → record it.
      if (raw === "") {
        await recordCount(id, lineItemId, null);
      } else {
        const count = parseInt(raw, 10);
        await recordCount(id, lineItemId, Number.isFinite(count) ? count : 0);
      }
      return json({ ok: true as const });
    }
    if (intent === "scan") {
      const code = String(formData.get("code"));
      const lineItemId = await findLineByCode(id, code);
      if (!lineItemId) {
        return json({
          ok: false as const,
          scanResult: { found: false as const, code },
        });
      }
      // Scan-to-line: mark this line as "seen" with quantity 1 if it
      // hasn't been counted yet, otherwise +1 the existing count. Lets
      // a user walk the floor with the scanner and tally multiples.
      await incrementCount(id, lineItemId, 1);
      return json({
        ok: true as const,
        scanResult: { found: true as const, lineItemId, code },
      });
    }
    if (intent === "complete") {
      const result = await completeStockCount(admin, session.shop, id);
      return json({ ok: true as const, completed: result });
    }
    if (intent === "abandon") {
      await abandonStockCount(session.shop, id);
      return json({ ok: true as const });
    }
  } catch (error) {
    return json({ error: String(error) });
  }

  return json({});
};

const STATUS_TONES: Record<
  string,
  "info" | "success" | "warning" | "critical" | "attention"
> = {
  in_progress: "attention",
  completed: "success",
  abandoned: "critical",
};

type Sort = "vendor" | "product";

export default function StockCountDetail() {
  const { sc, locationName } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const fetcher = useFetcher<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const isBusy = navigation.state === "submitting";

  // Optimistic counts — UI updates immediately; background saves via fetcher.
  // `null` = not counted yet (shows empty input + no green tick);
  // `number` = counted (shows the value + green background).
  const [counts, setCounts] = useState<Record<string, number | null>>(() => {
    const init: Record<string, number | null> = {};
    for (const li of sc.lineItems) init[li.id] = li.countedQuantity;
    return init;
  });

  useEffect(() => {
    if (navigation.state === "idle" && actionData && "ok" in actionData) {
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation.state]);

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("vendor");
  type FeedbackTone = "success" | "critical" | "subdued";
  const [scanFeedback, setScanFeedback] = useState<{
    message: string;
    tone: FeedbackTone;
  } | null>(null);

  const { byVariantId, byLineItemId } = useMemo(() => {
    const byV = new Map<string, (typeof sc.lineItems)[number]>();
    const byL = new Map<string, (typeof sc.lineItems)[number]>();
    for (const li of sc.lineItems) {
      byV.set(li.shopifyVariantId, li);
      byL.set(li.id, li);
    }
    return { byVariantId: byV, byLineItemId: byL };
  }, [sc.lineItems]);

  // After the server revalidates (e.g. scan incremented), sync counts
  // with whatever the DB now holds. Without this, a second scan that
  // races the first's revalidate would see stale client state.
  useEffect(() => {
    setCounts((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const li of sc.lineItems) {
        if (next[li.id] !== li.countedQuantity) {
          next[li.id] = li.countedQuantity;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sc.lineItems]);

  const persistCount = useCallback(
    (lineItemId: string, next: number | null) => {
      const fd = new FormData();
      fd.set("intent", "record");
      fd.set("lineItemId", lineItemId);
      // Empty string means "clear the count"; we distinguish null from 0
      // because a user who counted zero is a signal ("nothing here") not
      // the absence of a count.
      fd.set("countedQuantity", next === null ? "" : String(next));
      fetcher.submit(fd, { method: "post" });
    },
    [fetcher],
  );

  const handleCellChange = useCallback(
    (variantId: string, raw: number) => {
      const li = byVariantId.get(variantId);
      if (!li) return;
      const safe = Math.max(0, Math.floor(raw));
      setCounts((prev) => ({ ...prev, [li.id]: safe }));
      persistCount(li.id, safe);
    },
    [byVariantId, persistCount],
  );

  const handleScan = useCallback(
    (code: string) => {
      const fd = new FormData();
      fd.set("intent", "scan");
      fd.set("code", code);
      fetcher.submit(fd, { method: "post" });
      setScanFeedback({ message: `Scanning ${code}…`, tone: "subdued" });
    },
    [fetcher],
  );

  useEffect(() => {
    const data = fetcher.data;
    if (!data || !("scanResult" in data) || !data.scanResult) return;
    const res = data.scanResult as
      | { found: true; lineItemId: string; code: string }
      | { found: false; code: string };
    if (res.found) {
      const li = byLineItemId.get(res.lineItemId);
      if (li) {
        const next = (counts[li.id] ?? 0) + 1;
        setCounts((prev) => ({ ...prev, [li.id]: next }));
        setScanFeedback({
          message: `✓ ${li.productTitle} — ${li.variantTitle}: counted ${next}`,
          tone: "success",
        });
        // Auto-filter to the scanned product so the grid scrolls / narrows
        // to show it — walking the floor with the scanner, you want
        // confirmation the counted item actually showed up.
        setSearch(li.productTitle);
      }
    } else {
      setScanFeedback({
        message: `No line matches "${res.code}".`,
        tone: "critical",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  const handleComplete = useCallback(() => {
    if (
      !window.confirm(
        "Complete this count? This will reconcile Shopify inventory with your counts.",
      )
    )
      return;
    const fd = new FormData();
    fd.set("intent", "complete");
    submit(fd, { method: "post" });
  }, [submit]);

  const handleAbandon = useCallback(() => {
    if (!window.confirm("Abandon this count? No inventory changes.")) return;
    const fd = new FormData();
    fd.set("intent", "abandon");
    submit(fd, { method: "post" });
  }, [submit]);

  // ProductGrid preserves input order within each row group, so the
  // sort choice is applied here on the lineItems list.
  const cells: GridCell[] = useMemo(() => {
    const sorted = [...sc.lineItems].sort((a, b) => {
      if (sort === "vendor") {
        const va = (a.vendor ?? "zzz").toLowerCase();
        const vb = (b.vendor ?? "zzz").toLowerCase();
        if (va !== vb) return va.localeCompare(vb);
      }
      // Fallback: product title, then variant title
      const pa = a.productTitle.toLowerCase();
      const pb = b.productTitle.toLowerCase();
      if (pa !== pb) return pa.localeCompare(pb);
      return a.variantTitle.localeCompare(b.variantTitle);
    });

    const q = search.trim().toLowerCase();
    const filtered = q
      ? sorted.filter(
          (li) =>
            li.productTitle.toLowerCase().includes(q) ||
            li.variantTitle.toLowerCase().includes(q) ||
            (li.vendor ?? "").toLowerCase().includes(q) ||
            (li.sku ?? "").toLowerCase().includes(q) ||
            (li.barcode ?? "").toLowerCase().includes(q),
        )
      : sorted;

    return filtered.map((li) => {
      let selectedOptions: Array<{ name: string; value: string }> = [];
      if (li.variantOptions) {
        try {
          selectedOptions = JSON.parse(li.variantOptions);
        } catch {
          // Old rows pre-schema-change; fall back to variantTitle as a
          // single unnamed option so the grid can still group them.
          selectedOptions = [{ name: "Variant", value: li.variantTitle }];
        }
      }
      return {
        variantId: li.shopifyVariantId,
        productId: li.shopifyProductId,
        productTitle: li.productTitle,
        variantTitle: li.variantTitle,
        selectedOptions,
        sku: li.sku,
        stock: li.expectedQuantity,
        value: counts[li.id] ?? null,
      };
    });
  }, [sc.lineItems, counts, sort, search]);

  // Totals reflect the whole count (ignoring search filter) — the header
  // should show overall progress even while the grid is narrowed down.
  const counted = sc.lineItems.filter(
    (li) => counts[li.id] !== null && counts[li.id] !== undefined,
  ).length;
  const remaining = sc.lineItems.length - counted;
  const totalExpected = sc.lineItems.reduce(
    (s, li) => s + li.expectedQuantity,
    0,
  );
  const totalCounted = sc.lineItems.reduce(
    (s, li) => s + (counts[li.id] ?? 0),
    0,
  );

  const isActive = sc.status === "in_progress";
  const completedResult =
    actionData && "completed" in actionData
      ? (actionData.completed as {
          sessionId: string;
          applied: number;
          uncounted: number;
        })
      : null;

  // Vendor grouping header for the grid. Only active when sort=vendor.
  // Memoize the productId → vendor map so ProductGrid's groupBy stays
  // O(1) per row instead of O(N) (scanning sc.lineItems each call).
  const vendorByProduct = useMemo(() => {
    const m = new Map<string, string>();
    for (const li of sc.lineItems) {
      if (!m.has(li.shopifyProductId)) {
        m.set(li.shopifyProductId, li.vendor || "Unknown vendor");
      }
    }
    return m;
  }, [sc.lineItems]);
  const groupBy =
    sort === "vendor"
      ? (row: { productId: string }) =>
          vendorByProduct.get(row.productId) ?? "Unknown vendor"
      : undefined;

  // Counted cells get a green tint — zero still counts as counted (null
  // is "not counted yet"). Uses inset shadow so it's visible even inside
  // the TextField's padding.
  const getCellStyle = (cell: GridCell) =>
    cell.value !== null
      ? { background: "#e7f5ec", boxShadow: "inset 0 0 0 1px #8fd19e" }
      : undefined;

  return (
    <Page
      title={sc.name}
      backAction={{ url: "/app/stock-counts" }}
      titleMetadata={
        <InlineStack gap="200">
          <Badge tone={STATUS_TONES[sc.status] ?? "info"}>
            {sc.status.replace(/_/g, " ")}
          </Badge>
          <Text as="span" variant="bodySm" tone="subdued">
            @ {locationName}
          </Text>
        </InlineStack>
      }
    >
      <Layout>
        {completedResult && (
          <Layout.Section>
            <Banner tone="success" title="Count complete">
              Applied {completedResult.applied} adjustment
              {completedResult.applied !== 1 ? "s" : ""} to Shopify.
              {completedResult.uncounted > 0 && (
                <>
                  {" "}
                  {completedResult.uncounted} line(s) were not counted and
                  were left unchanged (likely dead SKUs).
                </>
              )}
            </Banner>
          </Layout.Section>
        )}
        {actionData && "error" in actionData && (
          <Layout.Section>
            <Banner tone="critical">{actionData.error as string}</Banner>
          </Layout.Section>
        )}
        {isActive && (
          <Layout.Section>
            <Banner tone="info" title="Draft — Shopify is not updated yet">
              Counts are saved here as you go, but Shopify inventory stays
              put until you click <strong>Complete</strong>. You can pause
              and come back later; nothing is applied until you finalize.
            </Banner>
          </Layout.Section>
        )}

        {/* Summary + scan + search */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" wrap>
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Counted / Remaining
                  </Text>
                  <Text as="p" variant="headingLg">
                    {counted} / {remaining}
                  </Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Units — counted / expected
                  </Text>
                  <Text as="p" variant="headingLg">
                    {totalCounted} / {totalExpected}
                  </Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Variance
                  </Text>
                  <Text
                    as="p"
                    variant="headingLg"
                    tone={
                      totalCounted - totalExpected === 0
                        ? "success"
                        : totalCounted - totalExpected < 0
                          ? "critical"
                          : undefined
                    }
                  >
                    {totalCounted - totalExpected >= 0 ? "+" : ""}
                    {totalCounted - totalExpected}
                  </Text>
                </BlockStack>
              </InlineStack>
              {isActive && (
                <>
                  <Divider />
                  <InlineStack gap="300" wrap blockAlign="end">
                    <div style={{ flex: "1 1 240px", minWidth: "240px" }}>
                      <BarcodeScanInput
                        onScan={handleScan}
                        label="Scan"
                        placeholder="Scan SKU or barcode — +1 to counted…"
                      />
                    </div>
                    <div style={{ flex: "1 1 240px", minWidth: "240px" }}>
                      <TextField
                        label="Search"
                        value={search}
                        onChange={setSearch}
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
                        ]}
                        value={sort}
                        onChange={(v) => setSort(v as Sort)}
                      />
                    </div>
                  </InlineStack>
                  {scanFeedback && (
                    <Text as="p" variant="bodySm" tone={scanFeedback.tone}>
                      {scanFeedback.message}
                    </Text>
                  )}
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Grid */}
        <Layout.Section>
          <Card padding="0">
            <div style={{ padding: "16px" }}>
              <ProductGrid
                cells={cells}
                qtyLabel="Counted"
                onCellChange={handleCellChange}
                showColumns={{
                  cost: false,
                  retail: false,
                  stock: true,
                  onOrder: false,
                }}
                // Keep the column set to the common apparel sizes — rarer
                // sizes (OS, 3XL, numeric) render inline in the row label
                // so one odd variant doesn't widen every row.
                sizeColumns={["XS", "S", "M", "L", "XL", "2XL"]}
                getCellStyle={getCellStyle}
                groupBy={groupBy}
                readonly={!isActive}
              />
            </div>
          </Card>
        </Layout.Section>

        {/* Complete / Abandon */}
        {isActive && (
          <Layout.Section>
            <Card>
              <InlineStack align="space-between" blockAlign="center">
                <Text as="p" variant="bodyMd">
                  When you're done, <strong>Complete</strong> syncs counted
                  quantities to Shopify. Uncounted lines are untouched.
                </Text>
                <ButtonGroup>
                  <Button
                    tone="critical"
                    onClick={handleAbandon}
                    loading={isBusy}
                  >
                    Abandon
                  </Button>
                  <Button
                    variant="primary"
                    onClick={handleComplete}
                    loading={isBusy}
                    disabled={counted === 0}
                  >
                    Complete ({counted} counted)
                  </Button>
                </ButtonGroup>
              </InlineStack>
            </Card>
          </Layout.Section>
        )}
        <Layout.Section>
          <div style={{ height: "3rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
