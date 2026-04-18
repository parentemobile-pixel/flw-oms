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
  Collapsible,
  Icon,
} from "@shopify/polaris";
import { ChevronDownIcon, ChevronRightIcon } from "@shopify/polaris-icons";

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
      const count = parseInt(String(formData.get("countedQuantity")), 10);
      await recordCount(id, lineItemId, count);
      return json({ ok: true as const });
    }
    if (intent === "increment") {
      const lineItemId = String(formData.get("lineItemId"));
      const delta = parseInt(
        String(formData.get("delta") ?? "1"),
        10,
      );
      await incrementCount(id, lineItemId, delta);
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

export default function StockCountDetail() {
  const { sc, locationName } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const fetcher = useFetcher<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const isBusy = navigation.state === "submitting";

  // Optimistic counted state — UI updates immediately, background saves via fetcher
  const [counts, setCounts] = useState<Record<string, number | null>>(() => {
    const init: Record<string, number | null> = {};
    for (const li of sc.lineItems) init[li.id] = li.countedQuantity;
    return init;
  });

  // Sync counts back from the server after any mutation completes
  useEffect(() => {
    if (navigation.state === "idle" && actionData && "ok" in actionData) {
      // Pick up server truth via revalidation
      revalidator.revalidate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation.state]);

  const [showCounted, setShowCounted] = useState(false);
  const [scanFeedback, setScanFeedback] = useState<string | null>(null);

  const handleRecord = useCallback(
    (lineItemId: string, val: string) => {
      const n = Math.max(0, parseInt(val, 10));
      const safe = Number.isFinite(n) ? n : 0;
      setCounts((prev) => ({ ...prev, [lineItemId]: safe }));
      const fd = new FormData();
      fd.set("intent", "record");
      fd.set("lineItemId", lineItemId);
      fd.set("countedQuantity", String(safe));
      fetcher.submit(fd, { method: "post" });
    },
    [fetcher],
  );

  const handleIncrement = useCallback(
    (lineItemId: string, delta: number) => {
      setCounts((prev) => ({
        ...prev,
        [lineItemId]: Math.max(0, (prev[lineItemId] ?? 0) + delta),
      }));
      const fd = new FormData();
      fd.set("intent", "increment");
      fd.set("lineItemId", lineItemId);
      fd.set("delta", String(delta));
      fetcher.submit(fd, { method: "post" });
    },
    [fetcher],
  );

  const handleScan = useCallback(
    (code: string) => {
      const fd = new FormData();
      fd.set("intent", "scan");
      fd.set("code", code);
      fetcher.submit(fd, { method: "post" });
      setScanFeedback(`Scanning ${code}…`);
    },
    [fetcher],
  );

  // Watch fetcher's scan result for feedback
  useEffect(() => {
    const data = fetcher.data;
    if (!data) return;
    if ("scanResult" in data && data.scanResult) {
      if (data.scanResult.found) {
        const line = sc.lineItems.find(
          (l) => l.id === data.scanResult.lineItemId,
        );
        if (line) {
          const next = (counts[line.id] ?? 0) + 1;
          setCounts((prev) => ({ ...prev, [line.id]: next }));
          setScanFeedback(
            `✓ ${line.productTitle} — ${line.variantTitle}: counted ${next}`,
          );
        }
      } else {
        setScanFeedback(
          `No line matches "${data.scanResult.code}".`,
        );
      }
    }
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

  // Partition into counted / remaining
  const { counted, remaining } = useMemo(() => {
    const c: typeof sc.lineItems = [];
    const r: typeof sc.lineItems = [];
    for (const li of sc.lineItems) {
      if (counts[li.id] !== null && counts[li.id] !== undefined) c.push(li);
      else r.push(li);
    }
    return { counted: c, remaining: r };
  }, [sc.lineItems, counts]);

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
            <Banner tone="success" title={`Count complete`}>
              Applied {completedResult.applied} adjustment
              {completedResult.applied !== 1 ? "s" : ""} to Shopify.
              {completedResult.uncounted > 0 && (
                <> {completedResult.uncounted} line(s) were not counted and were left unchanged (likely dead SKUs).</>
              )}
            </Banner>
          </Layout.Section>
        )}
        {actionData && "error" in actionData && (
          <Layout.Section>
            <Banner tone="critical">{actionData.error as string}</Banner>
          </Layout.Section>
        )}

        {/* Scan + Summary */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" wrap>
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Counted / Remaining
                  </Text>
                  <Text as="p" variant="headingLg">
                    {counted.length} / {remaining.length}
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
                  <BarcodeScanInput
                    onScan={handleScan}
                    label="Scan"
                    placeholder="Scan a SKU or barcode to add +1…"
                  />
                  {scanFeedback && (
                    <Text
                      as="p"
                      variant="bodySm"
                      tone={
                        scanFeedback.startsWith("✓")
                          ? "success"
                          : scanFeedback.startsWith("No")
                            ? "critical"
                            : "subdued"
                      }
                    >
                      {scanFeedback}
                    </Text>
                  )}
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Remaining section */}
        {remaining.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Remaining ({remaining.length})
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    Unmarked — might be dead SKUs
                  </Text>
                </InlineStack>
                <BlockStack gap="200">
                  {remaining.map((li) => (
                    <LineRow
                      key={li.id}
                      line={li}
                      value={counts[li.id]}
                      onRecord={(v) => handleRecord(li.id, v)}
                      onIncrement={(d) => handleIncrement(li.id, d)}
                      disabled={!isActive}
                    />
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Counted section — collapsed by default */}
        {counted.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <div
                  onClick={() => setShowCounted((v) => !v)}
                  style={{ cursor: "pointer" }}
                >
                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="200" blockAlign="center">
                      <Icon
                        source={
                          showCounted ? ChevronDownIcon : ChevronRightIcon
                        }
                      />
                      <Text as="h2" variant="headingMd">
                        Counted ({counted.length})
                      </Text>
                    </InlineStack>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {showCounted ? "Hide" : "Show"}
                    </Text>
                  </InlineStack>
                </div>
                <Collapsible
                  id="counted"
                  open={showCounted}
                  transition={{
                    duration: "150ms",
                    timingFunction: "ease-in-out",
                  }}
                >
                  <BlockStack gap="200">
                    {counted.map((li) => (
                      <LineRow
                        key={li.id}
                        line={li}
                        value={counts[li.id]}
                        onRecord={(v) => handleRecord(li.id, v)}
                        onIncrement={(d) => handleIncrement(li.id, d)}
                        disabled={!isActive}
                        showVariance
                      />
                    ))}
                  </BlockStack>
                </Collapsible>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Complete / Abandon */}
        {isActive && (
          <Layout.Section>
            <Card>
              <InlineStack align="space-between" blockAlign="center">
                <Text as="p" variant="bodyMd">
                  When you're done,{" "}
                  <strong>Complete</strong> syncs counted quantities to
                  Shopify. Uncounted lines are untouched.
                </Text>
                <ButtonGroup>
                  <Button tone="critical" onClick={handleAbandon} loading={isBusy}>
                    Abandon
                  </Button>
                  <Button
                    variant="primary"
                    onClick={handleComplete}
                    loading={isBusy}
                    disabled={counted.length === 0}
                  >
                    Complete ({counted.length} counted)
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

function LineRow({
  line,
  value,
  onRecord,
  onIncrement,
  disabled,
  showVariance = false,
}: {
  line: {
    id: string;
    productTitle: string;
    variantTitle: string;
    sku: string | null;
    expectedQuantity: number;
  };
  value: number | null | undefined;
  onRecord: (v: string) => void;
  onIncrement: (delta: number) => void;
  disabled: boolean;
  showVariance?: boolean;
}) {
  const variance = (value ?? 0) - line.expectedQuantity;
  return (
    <div
      style={{
        padding: "8px 12px",
        borderRadius: "6px",
        border: "1px solid #e1e3e5",
      }}
    >
      <InlineStack align="space-between" blockAlign="center" wrap={false}>
        <BlockStack gap="050">
          <Text as="p" variant="bodyMd" fontWeight="medium">
            {line.productTitle}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {line.variantTitle}
            {line.sku ? ` · ${line.sku}` : ""}
            {` · expected ${line.expectedQuantity}`}
          </Text>
        </BlockStack>
        <InlineStack gap="200" blockAlign="center">
          {showVariance && value !== null && (
            <Text
              as="span"
              variant="bodySm"
              tone={
                variance === 0
                  ? "success"
                  : variance < 0
                    ? "critical"
                    : undefined
              }
            >
              {variance >= 0 ? "+" : ""}
              {variance}
            </Text>
          )}
          <Button
            size="slim"
            onClick={() => onIncrement(-1)}
            disabled={disabled || (value ?? 0) <= 0}
          >
            −
          </Button>
          <div style={{ width: "72px" }}>
            <TextField
              label="Counted"
              labelHidden
              value={value === null || value === undefined ? "" : String(value)}
              onChange={onRecord}
              type="number"
              min={0}
              autoComplete="off"
              disabled={disabled}
            />
          </div>
          <Button
            size="slim"
            onClick={() => onIncrement(1)}
            disabled={disabled}
          >
            +
          </Button>
        </InlineStack>
      </InlineStack>
    </div>
  );
}
