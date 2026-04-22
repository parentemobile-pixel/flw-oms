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
  saveRowCounts,
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
    if (intent === "save-row") {
      // Batch save a whole row's counted quantities. Payload is a JSON
      // array of { lineItemId, countedQuantity } matching each cell in
      // the row (including overflow sizes). Goes through in a single
      // transaction so the row flips to "counted" atomically.
      const raw = String(formData.get("entries") ?? "[]");
      type Entry = { lineItemId: string; countedQuantity: number };
      let entries: Entry[] = [];
      try {
        entries = JSON.parse(raw) as Entry[];
      } catch {
        return json({ error: "Bad save-row payload" }, { status: 400 });
      }
      await saveRowCounts(id, entries);
      return json({ ok: true as const, savedRow: true as const });
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

  // Drafts vs saved — core of the "count row-by-row" UX.
  //   drafts[id] = what's currently shown in the cell. Always a number;
  //     seeded from countedQuantity ?? expectedQuantity so the user
  //     starts with Shopify's current stock as the baseline.
  //   saved[id]  = countedQuantity from the server. null = not saved
  //     yet (row still "to be counted"); number = row was confirmed.
  const [drafts, setDrafts] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const li of sc.lineItems) {
      init[li.id] = li.countedQuantity ?? li.expectedQuantity;
    }
    return init;
  });
  const saved: Record<string, number | null> = useMemo(() => {
    const m: Record<string, number | null> = {};
    for (const li of sc.lineItems) m[li.id] = li.countedQuantity;
    return m;
  }, [sc.lineItems]);

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

  // Pull server-saved counts into drafts whenever lineItems change
  // (revalidation after a save or scan). Only overrides cells whose
  // saved value differs from the current draft — lets the user keep
  // editing in other cells without losing what they typed.
  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const li of sc.lineItems) {
        const serverVal = li.countedQuantity;
        if (serverVal !== null && next[li.id] !== serverVal) {
          next[li.id] = serverVal;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sc.lineItems]);

  const handleCellChange = useCallback(
    (variantId: string, raw: number) => {
      const li = byVariantId.get(variantId);
      if (!li) return;
      const safe = Math.max(0, Math.floor(raw));
      // Update draft only — nothing hits the DB until the user clicks
      // "Save row" (or scans, which is treated as implicit confirm).
      setDrafts((prev) => ({ ...prev, [li.id]: safe }));
    },
    [byVariantId],
  );

  // Row confirm: walk every cell in the row (including overflow sizes)
  // and persist the current draft as countedQuantity. Done in one batch
  // so the row flips "counted" atomically.
  const saveRowFetcher = useFetcher<typeof action>();
  const handleSaveRow = useCallback(
    (rowCells: GridCell[]) => {
      const entries = rowCells
        .map((c) => {
          const li = byVariantId.get(c.variantId);
          if (!li) return null;
          return {
            lineItemId: li.id,
            countedQuantity: drafts[li.id] ?? li.expectedQuantity,
          };
        })
        .filter((e): e is NonNullable<typeof e> => e !== null);
      if (entries.length === 0) return;
      const fd = new FormData();
      fd.set("intent", "save-row");
      fd.set("entries", JSON.stringify(entries));
      saveRowFetcher.submit(fd, { method: "post" });
    },
    [byVariantId, drafts, saveRowFetcher],
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
        // Scan = implicit confirm for that single variant. The server
        // already bumped countedQuantity via incrementCount; reflect the
        // new value locally so the user sees the green tick before the
        // revalidator catches up.
        const serverNext = (li.countedQuantity ?? 0) + 1;
        setDrafts((prev) => ({ ...prev, [li.id]: serverNext }));
        setScanFeedback({
          message: `✓ ${li.productTitle} — ${li.variantTitle}: counted ${serverNext}`,
          tone: "success",
        });
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

  // saveRowFetcher finishes → trigger revalidation so `saved` reflects
  // the new countedQuantity values (and the row flips to "Counted").
  useEffect(() => {
    if (
      saveRowFetcher.state === "idle" &&
      saveRowFetcher.data &&
      "ok" in saveRowFetcher.data
    ) {
      revalidator.revalidate();
    }
  }, [saveRowFetcher.state, saveRowFetcher.data, revalidator]);

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
        // Draft value — always a number. Cell is "empty"/pre-count if
        // nothing has been saved yet; saved rows show their stored qty.
        value: drafts[li.id] ?? li.expectedQuantity,
      };
    });
  }, [sc.lineItems, drafts, sort, search]);

  // Totals reflect the whole count (ignoring search filter) — the header
  // should show overall progress even while the grid is narrowed down.
  // "Counted" = saved, confirmed rows (saved[id] !== null). Drafts that
  // haven't been saved yet don't count toward progress.
  const counted = sc.lineItems.filter((li) => saved[li.id] !== null).length;
  const remaining = sc.lineItems.length - counted;
  const totalExpected = sc.lineItems.reduce(
    (s, li) => s + li.expectedQuantity,
    0,
  );
  const totalCounted = sc.lineItems.reduce(
    (s, li) => s + (saved[li.id] ?? 0),
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

  // Cells are green once their row has been saved. Drafts (edits the
  // user has typed but not confirmed yet) show neutral — nothing is
  // "counted" until Save row.
  const variantIdToLineItem = useMemo(() => byVariantId, [byVariantId]);
  const getCellStyle = (cell: GridCell) => {
    const li = variantIdToLineItem.get(cell.variantId);
    if (li && saved[li.id] !== null) {
      return { background: "#e7f5ec", boxShadow: "inset 0 0 0 1px #8fd19e" };
    }
    return undefined;
  };

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
                  // Stock column dropped — expected qty is now the default
                  // value inside each cell, shown as the pre-count baseline.
                  stock: false,
                  onOrder: false,
                }}
                // Keep the column set to the common apparel sizes — rarer
                // sizes (OS, 3XL, numeric) render inline in the row label
                // so one odd variant doesn't widen every row.
                sizeColumns={["XS", "S", "M", "L", "XL", "2XL"]}
                getCellStyle={getCellStyle}
                groupBy={groupBy}
                readonly={!isActive}
                trailingLabel="Status"
                renderRowTrailing={({ cells: rowCells }) => {
                  // Row state: all cells saved → Counted; none → Not
                  // counted; mixed → Partial (rare, only if saved data
                  // came from an older partial-save flow).
                  const rowLineItems = rowCells
                    .map((c) => byVariantId.get(c.variantId))
                    .filter((li): li is NonNullable<typeof li> => !!li);
                  const total = rowLineItems.length;
                  const savedCount = rowLineItems.filter(
                    (li) => saved[li.id] !== null,
                  ).length;
                  const allSaved = total > 0 && savedCount === total;
                  // Row is "dirty" if any draft differs from its saved
                  // value — user has edits they haven't confirmed yet.
                  const dirty = rowLineItems.some(
                    (li) =>
                      saved[li.id] !== null &&
                      drafts[li.id] !== saved[li.id],
                  );
                  // A global "any row saving" flag is fine here — users
                  // save one row at a time, so per-row busy tracking isn't
                  // worth the fragile formData comparison.
                  const isRowBusy = saveRowFetcher.state !== "idle";
                  return (
                    <BlockStack gap="100" inlineAlign="end">
                      {allSaved && !dirty ? (
                        <Badge tone="success">Counted</Badge>
                      ) : savedCount > 0 ? (
                        <Badge tone="attention">
                          {`${savedCount} of ${total} saved`}
                        </Badge>
                      ) : (
                        <Badge>Not counted</Badge>
                      )}
                      {isActive && (
                        <Button
                          size="slim"
                          onClick={() => handleSaveRow(rowCells)}
                          loading={isRowBusy}
                          variant={allSaved && !dirty ? undefined : "primary"}
                        >
                          {allSaved && !dirty
                            ? "Re-save"
                            : dirty
                              ? "Save changes"
                              : "Save row"}
                        </Button>
                      )}
                    </BlockStack>
                  );
                }}
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
