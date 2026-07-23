import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Modal,
  Checkbox,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import {
  abandonStockCount,
  completeStockCount,
  findLineByCode,
  getPreviouslyCountedAtMap,
  getStockCount,
  incrementCount,
  recordCount,
  saveDraftQuantities,
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

  // Location-scoped prior-count history for every variant in this
  // count. Powers the "Last counted N days ago" row subtext.
  const variantIds = sc.lineItems.map((li) => li.shopifyVariantId);
  const priorMap = await getPreviouslyCountedAtMap(
    session.shop,
    sc.locationId,
    variantIds,
    sc.id,
  );
  const previouslyCountedAt: Record<
    string,
    { countedAt: string; countName: string }
  > = {};
  for (const [variantId, entry] of priorMap.entries()) {
    previouslyCountedAt[variantId] = {
      countedAt: entry.countedAt.toISOString(),
      countName: entry.countName,
    };
  }

  return json({ sc, locationName, previouslyCountedAt });
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
    if (intent === "save-draft") {
      // Debounced autosave of typed values. Persists to draftQuantity
      // (NOT countedQuantity) so navigation-away doesn't lose them,
      // but the count itself isn't committed until Save Row.
      const raw = String(formData.get("entries") ?? "[]");
      type DraftEntry = {
        lineItemId: string;
        draftQuantity: number | null;
        clientEditedAt: number;
      };
      let entries: DraftEntry[] = [];
      try {
        entries = JSON.parse(raw) as DraftEntry[];
      } catch {
        return json({ error: "Bad save-draft payload" }, { status: 400 });
      }
      await saveDraftQuantities(id, entries);
      return json({ ok: true as const, savedDraft: true as const });
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
      // Optional zeroOutIds — checked lines from the Complete modal
      // whose "uncounted" state should apply as countedQuantity=0.
      const zeroRaw = String(formData.get("zeroOutIds") ?? "[]");
      let zeroOutLineItemIds: string[] = [];
      try {
        const parsed = JSON.parse(zeroRaw);
        if (Array.isArray(parsed)) {
          zeroOutLineItemIds = parsed.filter(
            (x): x is string => typeof x === "string",
          );
        }
      } catch {
        // Bad payload → treat as no zero-out (silent, safer than throwing)
      }
      const result = await completeStockCount(admin, session.shop, id, {
        zeroOutLineItemIds,
      });
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
  const { sc, locationName, previouslyCountedAt } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const fetcher = useFetcher<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const isBusy = navigation.state === "submitting";

  // Three-tier value model:
  //   drafts[id] = what's currently shown in the cell. Autosaved to
  //     server on debounce, so navigation-away doesn't lose it.
  //   saved[id]  = countedQuantity — the OFFICIAL count, only written
  //     by Save Row. Null = row still "to be counted".
  //   Persisted draftQuantity (from li.draftQuantity) hydrates drafts
  //     on mount so a user can leave and come back to their typing.
  const [drafts, setDrafts] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const li of sc.lineItems) {
      init[li.id] =
        li.draftQuantity ?? li.countedQuantity ?? li.expectedQuantity;
    }
    return init;
  });
  const saved: Record<string, number | null> = useMemo(() => {
    const m: Record<string, number | null> = {};
    for (const li of sc.lineItems) m[li.id] = li.countedQuantity;
    return m;
  }, [sc.lineItems]);
  // Map of DB draftQuantity per line, used by the visual-state helpers
  // (row is in "Draft" state when a draftQuantity exists but no count).
  const persistedDrafts: Record<string, number | null> = useMemo(() => {
    const m: Record<string, number | null> = {};
    for (const li of sc.lineItems) m[li.id] = li.draftQuantity;
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

  // No blind-sync effect here on purpose — it used to overwrite user
  // edits (type a new number after saving a row → revalidator fires →
  // draft snapped back to saved value). The scan handler updates drafts
  // optimistically, and Save row already uses the current draft as the
  // value to persist, so drafts don't need to track the server after
  // first load. Only new line items (added after initial mount, which
  // we don't actually support) would need seeding.
  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      let added = false;
      for (const li of sc.lineItems) {
        if (!(li.id in next)) {
          next[li.id] =
            li.draftQuantity ?? li.countedQuantity ?? li.expectedQuantity;
          added = true;
        }
      }
      return added ? next : prev;
    });
  }, [sc.lineItems]);

  // Debounced autosave of typed drafts to server draftQuantity so they
  // survive navigation away. pendingRef holds line-items awaiting a
  // flush; timerRef holds the debounce timeout. flush() is safe to
  // call at any time — it clears the timer and POSTs whatever's pending.
  const draftFetcher = useFetcher<typeof action>();
  const pendingRef = useRef<Map<string, number | null>>(new Map());
  const timerRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingRef.current.size === 0) return;
    const entries = Array.from(pendingRef.current.entries()).map(
      ([lineItemId, draftQuantity]) => ({
        lineItemId,
        draftQuantity,
        clientEditedAt: Date.now(),
      }),
    );
    pendingRef.current.clear();
    const fd = new FormData();
    fd.set("intent", "save-draft");
    fd.set("entries", JSON.stringify(entries));
    draftFetcher.submit(fd, { method: "post" });
  }, [draftFetcher]);

  const scheduleFlush = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(flush, 500);
  }, [flush]);

  // Unmount: fire any pending draft POST so a tab-close mid-typing
  // doesn't lose the last edits.
  useEffect(() => {
    return () => {
      flush();
    };
  }, [flush]);

  // Tab close / hard refresh path — debounce timer would otherwise
  // never fire. The browser gives us one last shot in beforeunload.
  useEffect(() => {
    const onBeforeUnload = () => flush();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [flush]);

  const handleCellChange = useCallback(
    (variantId: string, raw: number) => {
      const li = byVariantId.get(variantId);
      if (!li) return;
      const safe = Math.max(0, Math.floor(raw));
      setDrafts((prev) => ({ ...prev, [li.id]: safe }));
      pendingRef.current.set(li.id, safe);
      scheduleFlush();
    },
    [byVariantId, scheduleFlush],
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
      // Drop any pending draft POSTs for these lines — Save Row will
      // clear draftQuantity server-side, and a slow in-flight draft
      // POST arriving after Save Row would leave a ghost draft.
      for (const e of entries) pendingRef.current.delete(e.lineItemId);
      if (timerRef.current !== null && pendingRef.current.size === 0) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
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
        // Discard any pending draft for this line — a slow draft POST
        // could otherwise stomp the scan-committed count.
        pendingRef.current.delete(li.id);
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

  // Complete modal — replaces the old window.confirm gate. Opens a
  // scrollable checklist of uncounted lines so the user can decide
  // which to reconcile as phantom stock (adjust to 0) as part of the
  // apply. Reuses the same "complete" server intent with an optional
  // zeroOutIds payload.
  const [completeOpen, setCompleteOpen] = useState(false);
  const [zeroChecked, setZeroChecked] = useState<Set<string>>(() => new Set());
  const completeFetcher = useFetcher<typeof action>();

  const handleComplete = useCallback(() => {
    // Force-flush pending drafts synchronously so the "uncounted" list
    // in the modal reflects the latest saved state.
    flush();
    setZeroChecked(new Set());
    setCompleteOpen(true);
  }, [flush]);

  const handleSubmitComplete = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "complete");
    fd.set("zeroOutIds", JSON.stringify(Array.from(zeroChecked)));
    completeFetcher.submit(fd, { method: "post" });
  }, [zeroChecked, completeFetcher]);

  // Close modal on successful complete.
  useEffect(() => {
    if (
      completeFetcher.state === "idle" &&
      completeFetcher.data &&
      "completed" in completeFetcher.data
    ) {
      setCompleteOpen(false);
      revalidator.revalidate();
    }
  }, [completeFetcher.state, completeFetcher.data, revalidator]);

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
          zeroed: number;
          uncounted: number;
        })
      : null;

  // Small relative-time helper for the row subtext. No dependency — a
  // ~5-line implementation covers the useful ranges (min / hour / day
  // / week / month / year). Renders "just now" for < 1 min.
  const relativeTime = useCallback((isoOrDate: string | Date): string => {
    const t = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
    const diffSec = Math.max(0, (Date.now() - t.getTime()) / 1000);
    if (diffSec < 60) return "just now";
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
    const years = Math.floor(days / 365);
    return `${years} year${years === 1 ? "" : "s"} ago`;
  }, []);

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

  // Cell coloring reflects state:
  //   green   = saved (countedQuantity written)
  //   yellow  = draft only (draftQuantity present, no count yet)
  //   neutral = untouched
  const variantIdToLineItem = useMemo(() => byVariantId, [byVariantId]);
  const getCellStyle = (cell: GridCell) => {
    const li = variantIdToLineItem.get(cell.variantId);
    if (!li) return undefined;
    if (saved[li.id] !== null) {
      return { background: "#e7f5ec", boxShadow: "inset 0 0 0 1px #8fd19e" };
    }
    // Draft-only if we have a value that's not the initial expected qty
    // OR the DB persisted a draftQuantity for the line.
    const draft = drafts[li.id];
    const isDraft =
      persistedDrafts[li.id] !== null ||
      (draft !== undefined && draft !== li.expectedQuantity);
    if (isDraft) {
      return { background: "#fff8dc", boxShadow: "inset 0 0 0 1px #e6cf7a" };
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
              {completedResult.zeroed > 0 && (
                <>
                  {" "}
                  Zeroed out {completedResult.zeroed} uncounted line
                  {completedResult.zeroed !== 1 ? "s" : ""} as phantom stock.
                </>
              )}
              {completedResult.uncounted > 0 && (
                <>
                  {" "}
                  {completedResult.uncounted} line
                  {completedResult.uncounted !== 1 ? "s" : ""} were not
                  counted and were left unchanged.
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
                  const rowLineItems = rowCells
                    .map((c) => byVariantId.get(c.variantId))
                    .filter((li): li is NonNullable<typeof li> => !!li);
                  const total = rowLineItems.length;
                  const savedCount = rowLineItems.filter(
                    (li) => saved[li.id] !== null,
                  ).length;
                  // dirty = at least one saved line has a draft that
                  // differs from its committed count (user typed after
                  // saving and hasn't re-saved).
                  const dirty = rowLineItems.some(
                    (li) =>
                      saved[li.id] !== null &&
                      drafts[li.id] !== saved[li.id],
                  );
                  // anyDraftNoSave = at least one unsaved line has a
                  // non-baseline draft (typed but never Save-Row'd).
                  const anyDraftNoSave = rowLineItems.some(
                    (li) =>
                      saved[li.id] === null &&
                      (persistedDrafts[li.id] !== null ||
                        drafts[li.id] !== li.expectedQuantity),
                  );
                  const isRowBusy = saveRowFetcher.state !== "idle";

                  // 5-state badge + button matrix.
                  let badgeTone:
                    | "success"
                    | "warning"
                    | "info"
                    | "attention"
                    | undefined = undefined;
                  let badgeText = "Not counted";
                  let buttonLabel = "Save row";
                  let buttonVariant: "primary" | undefined = undefined;

                  if (dirty && savedCount > 0) {
                    badgeTone = "warning";
                    badgeText = "Unsaved changes";
                    buttonLabel = "Save changes";
                    buttonVariant = "primary";
                  } else if (!dirty && savedCount === total && total > 0) {
                    badgeTone = "success";
                    badgeText = "Counted";
                    buttonLabel = "Re-save";
                    buttonVariant = undefined;
                  } else if (
                    !dirty &&
                    savedCount === 0 &&
                    anyDraftNoSave
                  ) {
                    badgeTone = "info";
                    badgeText = "Draft";
                    buttonLabel = "Save row";
                    buttonVariant = "primary";
                  } else if (!dirty && savedCount > 0 && savedCount < total) {
                    badgeTone = "attention";
                    badgeText = `${savedCount} of ${total} saved`;
                    buttonLabel = "Save row";
                    buttonVariant = "primary";
                  }

                  // Subtext: freshest counted timestamp in this row, or
                  // else the freshest prior-count history across the
                  // variants in this row.
                  const freshestCountedAt = rowLineItems
                    .map((li) => li.countedAt)
                    .filter((d): d is Date | string => !!d)
                    .map((d) => new Date(d as string | Date).getTime())
                    .reduce<number | null>(
                      (acc, t) => (acc === null || t > acc ? t : acc),
                      null,
                    );
                  let subtext: string | null = null;
                  if (freshestCountedAt !== null) {
                    subtext = `Counted ${relativeTime(new Date(freshestCountedAt))}`;
                  } else {
                    // Find the freshest previouslyCountedAt across the
                    // variants in this row.
                    let bestT = 0;
                    let bestName = "";
                    for (const li of rowLineItems) {
                      const prev = previouslyCountedAt[li.shopifyVariantId];
                      if (!prev) continue;
                      const t = new Date(prev.countedAt).getTime();
                      if (t > bestT) {
                        bestT = t;
                        bestName = prev.countName;
                      }
                    }
                    if (bestT > 0) {
                      subtext = `Last counted ${relativeTime(
                        new Date(bestT),
                      )}${bestName ? ` in ${bestName}` : ""}`;
                    }
                  }

                  return (
                    <BlockStack gap="100" inlineAlign="end">
                      <Badge tone={badgeTone}>{badgeText}</Badge>
                      {subtext && (
                        <Text as="span" variant="bodySm" tone="subdued">
                          {subtext}
                        </Text>
                      )}
                      {isActive && (
                        <Button
                          size="slim"
                          onClick={() => handleSaveRow(rowCells)}
                          loading={isRowBusy}
                          variant={buttonVariant}
                        >
                          {buttonLabel}
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
                  When you're done, <strong>Complete</strong> reconciles
                  Shopify with your counts. You'll get a chance to
                  review uncounted lines (phantom stock) first.
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
                    disabled={sc.lineItems.length === 0}
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

      {/* Complete modal — selective phantom-stock reconciliation */}
      <Modal
        open={completeOpen}
        onClose={() => setCompleteOpen(false)}
        title="Complete stock count"
        primaryAction={{
          content: `Apply — count ${counted}, zero out ${zeroChecked.size}`,
          onAction: handleSubmitComplete,
          loading: completeFetcher.state !== "idle",
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => setCompleteOpen(false),
            disabled: completeFetcher.state !== "idle",
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd">
              <strong>{counted}</strong> of {sc.lineItems.length} lines
              counted. <strong>{sc.lineItems.length - counted}</strong>{" "}
              line{sc.lineItems.length - counted === 1 ? "" : "s"} were
              not counted.
            </Text>
            {sc.lineItems.length - counted > 0 && (
              <>
                <Banner tone="info">
                  Uncounted lines are variants Shopify thinks you have here
                  that nobody found. Check any you want to reconcile as
                  phantom stock — checked lines will be adjusted to 0 in
                  Shopify as part of applying the count.
                </Banner>
                <InlineStack gap="200">
                  <Button
                    size="slim"
                    onClick={() =>
                      setZeroChecked(
                        new Set(
                          sc.lineItems
                            .filter((li) => saved[li.id] === null)
                            .map((li) => li.id),
                        ),
                      )
                    }
                  >
                    Select all uncounted
                  </Button>
                  <Button
                    size="slim"
                    onClick={() => setZeroChecked(new Set())}
                    disabled={zeroChecked.size === 0}
                  >
                    Clear
                  </Button>
                </InlineStack>
                <div
                  style={{
                    maxHeight: "360px",
                    overflowY: "auto",
                    border: "1px solid #e1e3e5",
                    borderRadius: "6px",
                    padding: "8px 12px",
                  }}
                >
                  <BlockStack gap="150">
                    {sc.lineItems
                      .filter((li) => saved[li.id] === null)
                      .sort((a, b) => {
                        const va = (a.vendor ?? "zzz").toLowerCase();
                        const vb = (b.vendor ?? "zzz").toLowerCase();
                        if (va !== vb) return va.localeCompare(vb);
                        const pa = a.productTitle.toLowerCase();
                        const pb = b.productTitle.toLowerCase();
                        if (pa !== pb) return pa.localeCompare(pb);
                        return a.variantTitle.localeCompare(b.variantTitle);
                      })
                      .map((li) => {
                        const draft = li.draftQuantity;
                        return (
                          <InlineStack
                            key={li.id}
                            gap="200"
                            blockAlign="start"
                            wrap={false}
                          >
                            <Checkbox
                              label=""
                              labelHidden
                              checked={zeroChecked.has(li.id)}
                              onChange={(next) => {
                                setZeroChecked((prev) => {
                                  const s = new Set(prev);
                                  if (next) s.add(li.id);
                                  else s.delete(li.id);
                                  return s;
                                });
                              }}
                            />
                            <BlockStack gap="050">
                              <Text as="span" variant="bodyMd">
                                {li.productTitle}
                                {" — "}
                                <Text as="span" tone="subdued">
                                  {li.variantTitle}
                                </Text>
                              </Text>
                              <Text
                                as="span"
                                variant="bodySm"
                                tone="subdued"
                              >
                                Expected: {li.expectedQuantity}
                                {draft != null && (
                                  <>
                                    {" · "}Draft was: {draft} (will be
                                    discarded)
                                  </>
                                )}
                                {li.vendor && <> · {li.vendor}</>}
                              </Text>
                            </BlockStack>
                          </InlineStack>
                        );
                      })}
                  </BlockStack>
                </div>
              </>
            )}
            {completeFetcher.data &&
              "error" in completeFetcher.data && (
                <Banner tone="critical">
                  {String(completeFetcher.data.error)}
                </Banner>
              )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
