import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  json,
  redirect,
  unstable_createMemoryUploadHandler,
  unstable_parseMultipartFormData,
} from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  DropZone,
  InlineStack,
  Layout,
  Page,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import {
  extractPOFromPDF,
  matchExtractedLines,
  PDFImportError,
  type ImportedPO,
  type MatchedLineItem,
  type MatchedVariant,
} from "../services/purchase-orders/pdf-import.server";
import {
  getDefaultLocation,
  getLocations,
  type Location,
} from "../services/shopify-api/locations.server";
import { createPurchaseOrder } from "../services/purchase-orders/po-service.server";
import { searchProductsByVendor } from "../services/shopify-api/products.server";
import { LocationPicker } from "../components/LocationPicker";

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [locations, defaultLocation] = await Promise.all([
    getLocations(admin, session.shop).catch(() => [] as Location[]),
    getDefaultLocation(admin, session.shop).catch(() => null),
  ]);
  return json({
    locations,
    defaultLocationId: defaultLocation?.id ?? null,
    hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
  });
};

// ─── Action ──────────────────────────────────────────────────────────────────

type ExtractResponse =
  | { intent: "extract"; ok: true; imported: ImportedPO }
  | { intent: "extract"; ok: false; error: string; code?: string };

type SearchResponse = {
  intent: "search";
  ok: true;
  variants: MatchedVariant[];
};

type CreateResponse =
  | { intent: "create"; ok: false; error: string }
  | never; // success → redirect

type ActionResponse = ExtractResponse | SearchResponse | CreateResponse;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  // Multipart (PDF upload) vs regular form. Cheap way to branch: sniff header.
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const uploadHandler = unstable_createMemoryUploadHandler({
      maxPartSize: 25 * 1024 * 1024, // 25MB upload cap
    });
    let formData: FormData;
    try {
      formData = await unstable_parseMultipartFormData(request, uploadHandler);
    } catch (err: any) {
      return json<ExtractResponse>({
        intent: "extract",
        ok: false,
        error: `Upload failed: ${err?.message || err}. Max 25MB.`,
        code: "too_large",
      });
    }

    const file = formData.get("pdf");
    if (!file || typeof file === "string" || !("arrayBuffer" in file)) {
      return json<ExtractResponse>({
        intent: "extract",
        ok: false,
        error: "No PDF received. Please drop a PDF file.",
      });
    }
    if (
      (file as File).type &&
      (file as File).type !== "application/pdf"
    ) {
      return json<ExtractResponse>({
        intent: "extract",
        ok: false,
        error: `Expected a PDF, got ${(file as File).type || "unknown"}.`,
      });
    }

    const buf = Buffer.from(await (file as File).arrayBuffer());
    try {
      const extracted = await extractPOFromPDF(buf);
      const matched = await matchExtractedLines(admin, extracted);
      return json<ExtractResponse>({
        intent: "extract",
        ok: true,
        imported: {
          vendor: extracted.vendor,
          vendorPoNumber: extracted.vendorPoNumber,
          lines: matched,
        },
      });
    } catch (err: any) {
      if (err instanceof PDFImportError) {
        return json<ExtractResponse>({
          intent: "extract",
          ok: false,
          error: err.message,
          code: err.code,
        });
      }
      return json<ExtractResponse>({
        intent: "extract",
        ok: false,
        error: `Extraction failed: ${err?.message || err}`,
      });
    }
  }

  // Non-multipart — regular form actions (search for picker, create PO).
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "search") {
    const vendor = (formData.get("vendor") as string) || "";
    const query = (formData.get("query") as string) || "";
    if (!vendor) {
      return json<SearchResponse>({ intent: "search", ok: true, variants: [] });
    }
    try {
      const result = await searchProductsByVendor(admin, vendor, query);
      const variants: MatchedVariant[] = [];
      for (const edge of result.edges) {
        const p = edge.node;
        for (const ve of p.variants.edges) {
          const v = ve.node;
          const cost = v.inventoryItem?.unitCost?.amount
            ? parseFloat(v.inventoryItem.unitCost.amount)
            : 0;
          variants.push({
            shopifyProductId: p.id,
            shopifyVariantId: v.id,
            productTitle: p.title,
            variantTitle: v.title,
            sku: v.sku || "",
            barcode: v.barcode || "",
            unitCost: cost,
            retailPrice: parseFloat(v.price || "0") || 0,
            currentStock: v.inventoryQuantity || 0,
            selectedOptions: v.selectedOptions || [],
          });
        }
      }
      return json<SearchResponse>({
        intent: "search",
        ok: true,
        variants: variants.slice(0, 50),
      });
    } catch {
      return json<SearchResponse>({ intent: "search", ok: true, variants: [] });
    }
  }

  if (intent === "create") {
    const vendor = (formData.get("vendor") as string) || "";
    const poNumberExt = (formData.get("poNumberExt") as string) || "";
    const shopifyLocationId =
      (formData.get("shopifyLocationId") as string) || null;
    const notes = (formData.get("notes") as string) || "";
    const linesJson = (formData.get("lines") as string) || "[]";
    const lines = JSON.parse(linesJson) as Array<{
      shopifyProductId: string;
      shopifyVariantId: string;
      productTitle: string;
      variantTitle: string;
      sku: string;
      barcode: string;
      unitCost: number;
      retailPrice: number;
      quantityOrdered: number;
    }>;

    const usable = lines.filter(
      (l) => l.shopifyVariantId && l.quantityOrdered > 0,
    );
    if (usable.length === 0) {
      return json<CreateResponse>({
        intent: "create",
        ok: false,
        error: "No matched lines with quantity > 0. Match at least one line before creating.",
      });
    }

    try {
      const po = await createPurchaseOrder(session.shop, {
        vendor: vendor || undefined,
        notes: notes ? `Imported from PDF.\n\n${notes}` : "Imported from PDF.",
        shopifyLocationId,
        poNumberExt: poNumberExt || null,
        lineItems: usable.map((l) => ({
          shopifyProductId: l.shopifyProductId,
          shopifyVariantId: l.shopifyVariantId,
          productTitle: l.productTitle,
          variantTitle: l.variantTitle,
          sku: l.sku || null,
          barcode: l.barcode || null,
          unitCost: l.unitCost,
          retailPrice: l.retailPrice,
          quantityOrdered: l.quantityOrdered,
        })),
      });
      return redirect(`/app/purchase-orders/${po.id}`);
    } catch (err: any) {
      return json<CreateResponse>({
        intent: "create",
        ok: false,
        error: `Failed to create PO: ${err?.message || err}`,
      });
    }
  }

  return json({});
};

// ─── Component ───────────────────────────────────────────────────────────────

interface DraftLine {
  key: string; // stable react key
  extracted: MatchedLineItem["extracted"];
  confidence: MatchedLineItem["confidence"];
  candidates: MatchedVariant[];
  // Chosen variant — starts as the auto-matched one (if any), user can change.
  variant: MatchedVariant | null;
  quantityOrdered: number;
  unitCost: number;
  retailPrice: number;
}

export default function ImportPO() {
  const { locations, defaultLocationId, hasApiKey } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ActionResponse | undefined;
  const submit = useSubmit();
  const navigation = useNavigation();
  const isBusy = navigation.state !== "idle";

  // ── Step state
  const [file, setFile] = useState<File | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);

  const [vendor, setVendor] = useState("");
  const [vendorPoNumber, setVendorPoNumber] = useState("");
  const [shopifyLocationId, setShopifyLocationId] = useState<string | null>(
    defaultLocationId,
  );
  const [notes, setNotes] = useState("");
  const [draft, setDraft] = useState<DraftLine[] | null>(null);

  // ── Handle extraction response from server
  useEffect(() => {
    if (!actionData) return;
    if ("intent" in actionData && actionData.intent === "extract" && actionData.ok) {
      const imported = actionData.imported;
      setVendor(imported.vendor || "");
      setVendorPoNumber(imported.vendorPoNumber || "");
      setDraft(
        imported.lines.map((l, idx) => ({
          key: `line-${idx}`,
          extracted: l.extracted,
          confidence: l.confidence,
          candidates: l.candidates,
          variant: l.match,
          quantityOrdered: l.extracted.quantity ?? 0,
          unitCost: l.extracted.unitCost ?? l.match?.unitCost ?? 0,
          retailPrice: l.extracted.retailPrice ?? l.match?.retailPrice ?? 0,
        })),
      );
    }
  }, [actionData]);

  const extractError =
    actionData &&
    "intent" in actionData &&
    actionData.intent === "extract" &&
    actionData.ok === false
      ? actionData
      : null;
  const createError =
    actionData &&
    "intent" in actionData &&
    actionData.intent === "create" &&
    (actionData as { ok?: boolean }).ok === false
      ? (actionData as { error: string })
      : null;

  const handleDrop = useCallback((_files: File[], acceptedFiles: File[]) => {
    setDropError(null);
    const pdf = acceptedFiles[0];
    if (!pdf) {
      setDropError("That doesn't look like a PDF.");
      return;
    }
    setFile(pdf);
  }, []);

  const handleUpload = useCallback(() => {
    if (!file) return;
    const fd = new FormData();
    fd.set("pdf", file);
    submit(fd, {
      method: "post",
      encType: "multipart/form-data",
    });
  }, [file, submit]);

  const handleReset = useCallback(() => {
    setFile(null);
    setDraft(null);
    setVendor("");
    setVendorPoNumber("");
    setNotes("");
    setDropError(null);
  }, []);

  const matchedCount = useMemo(
    () => (draft ? draft.filter((l) => l.variant).length : 0),
    [draft],
  );

  const totalCost = useMemo(
    () =>
      draft
        ? draft.reduce(
            (sum, l) =>
              l.variant ? sum + l.unitCost * l.quantityOrdered : sum,
            0,
          )
        : 0,
    [draft],
  );

  const handleCreate = useCallback(() => {
    if (!draft) return;
    const lines = draft
      .filter((l) => l.variant && l.quantityOrdered > 0)
      .map((l) => ({
        shopifyProductId: l.variant!.shopifyProductId,
        shopifyVariantId: l.variant!.shopifyVariantId,
        productTitle: l.variant!.productTitle,
        variantTitle: l.variant!.variantTitle,
        sku: l.variant!.sku,
        barcode: l.variant!.barcode,
        unitCost: l.unitCost,
        retailPrice: l.retailPrice,
        quantityOrdered: l.quantityOrdered,
      }));
    const fd = new FormData();
    fd.set("intent", "create");
    fd.set("vendor", vendor);
    fd.set("poNumberExt", vendorPoNumber);
    if (shopifyLocationId) fd.set("shopifyLocationId", shopifyLocationId);
    fd.set("notes", notes);
    fd.set("lines", JSON.stringify(lines));
    submit(fd, { method: "post" });
  }, [draft, vendor, vendorPoNumber, shopifyLocationId, notes, submit]);

  // ── UI
  return (
    <Page
      title="Import PO from PDF"
      backAction={{ url: "/app/purchase-orders" }}
      subtitle="Drop a vendor PDF and Claude will extract line items"
    >
      <Layout>
        {!hasApiKey && (
          <Layout.Section>
            <Banner tone="critical">
              <p>
                <strong>ANTHROPIC_API_KEY</strong> is not set on the server.
                Set it as a Fly secret before using this page.
              </p>
            </Banner>
          </Layout.Section>
        )}

        {extractError && (
          <Layout.Section>
            <Banner tone="critical" title="Couldn't read that PDF">
              <p>{extractError.error}</p>
              <InlineStack gap="200">
                <Button url="/app/purchase-orders/new" variant="primary">
                  Start manually instead
                </Button>
                <Button onClick={handleReset}>Try another PDF</Button>
              </InlineStack>
            </Banner>
          </Layout.Section>
        )}

        {createError && (
          <Layout.Section>
            <Banner tone="critical">{createError.error}</Banner>
          </Layout.Section>
        )}

        {/* Step 1: upload */}
        {!draft && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  1. Upload vendor PDF
                </Text>
                <DropZone
                  accept="application/pdf"
                  type="file"
                  allowMultiple={false}
                  onDrop={handleDrop}
                  errorOverlayText="Please drop a PDF"
                >
                  {file ? (
                    <div style={{ padding: "24px", textAlign: "center" }}>
                      <Text as="p" variant="bodyMd" fontWeight="semibold">
                        {file.name}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {(file.size / 1024).toFixed(0)} KB — PDF ready
                      </Text>
                    </div>
                  ) : (
                    <DropZone.FileUpload
                      actionTitle="Drop a PDF"
                      actionHint="Vendor quote, order confirmation, or wholesale PO"
                    />
                  )}
                </DropZone>

                {dropError && (
                  <Banner tone="warning">{dropError}</Banner>
                )}

                <InlineStack align="end" gap="200">
                  <Button url="/app/purchase-orders/new">Start manually</Button>
                  <Button
                    variant="primary"
                    disabled={!file || isBusy || !hasApiKey}
                    loading={isBusy}
                    onClick={handleUpload}
                  >
                    Extract line items with Claude
                  </Button>
                </InlineStack>

                {isBusy && (
                  <InlineStack gap="200" blockAlign="center">
                    <Spinner size="small" />
                    <Text as="span" variant="bodySm" tone="subdued">
                      Claude is reading your PDF — this usually takes 5-20s.
                    </Text>
                  </InlineStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Step 2: review */}
        {draft && (
          <>
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      2. Review extracted details
                    </Text>
                    <InlineStack gap="200">
                      <Badge tone={matchedCount === draft.length ? "success" : "attention"}>
                        {`${matchedCount} / ${draft.length} matched`}
                      </Badge>
                    </InlineStack>
                  </InlineStack>

                  <InlineStack gap="400" wrap={false}>
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="Vendor"
                        value={vendor}
                        onChange={setVendor}
                        autoComplete="off"
                        helpText="Extracted from the PDF — edit if wrong"
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="Vendor's PO #"
                        value={vendorPoNumber}
                        onChange={setVendorPoNumber}
                        autoComplete="off"
                        placeholder="(optional)"
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <LocationPicker
                        label="Receive to location"
                        locations={locations}
                        value={shopifyLocationId}
                        onChange={setShopifyLocationId}
                        persistKey="po-import-destination"
                      />
                    </div>
                  </InlineStack>
                </BlockStack>
              </Card>
            </Layout.Section>

            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    3. Line items
                  </Text>

                  <LineTable
                    draft={draft}
                    vendor={vendor}
                    onChange={setDraft}
                  />

                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" variant="bodyMd" tone="subdued">
                      {matchedCount} of {draft.length} lines matched ·{" "}
                      Total cost: ${totalCost.toFixed(2)}
                    </Text>
                    <InlineStack gap="200">
                      <Button onClick={handleReset}>Start over</Button>
                      <Button
                        variant="primary"
                        onClick={handleCreate}
                        disabled={matchedCount === 0 || isBusy}
                        loading={isBusy}
                      >
                        Create draft PO
                      </Button>
                    </InlineStack>
                  </InlineStack>
                </BlockStack>
              </Card>
            </Layout.Section>
          </>
        )}

        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// ─── Line table ──────────────────────────────────────────────────────────────

function LineTable({
  draft,
  vendor,
  onChange,
}: {
  draft: DraftLine[];
  vendor: string;
  onChange: (next: DraftLine[]) => void;
}) {
  const setLine = useCallback(
    (key: string, patch: Partial<DraftLine>) => {
      onChange(
        draft.map((l) => (l.key === key ? { ...l, ...patch } : l)),
      );
    },
    [draft, onChange],
  );

  return (
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
            <th style={{ padding: "8px", textAlign: "left" }}>Extracted</th>
            <th style={{ padding: "8px", textAlign: "left" }}>Matched variant</th>
            <th style={{ padding: "8px", textAlign: "right" }}>Cost</th>
            <th style={{ padding: "8px", textAlign: "right" }}>Retail</th>
            <th style={{ padding: "8px", textAlign: "right", width: "90px" }}>
              Qty
            </th>
            <th style={{ padding: "8px", textAlign: "right" }}>Line total</th>
          </tr>
        </thead>
        <tbody>
          {draft.map((line) => (
            <LineRow
              key={line.key}
              line={line}
              vendor={vendor}
              onChange={(patch) => setLine(line.key, patch)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LineRow({
  line,
  vendor,
  onChange,
}: {
  line: DraftLine;
  vendor: string;
  onChange: (patch: Partial<DraftLine>) => void;
}) {
  const submit = useSubmit();
  const actionData = useActionData<typeof action>() as ActionResponse | undefined;

  const [searching, setSearching] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<MatchedVariant[]>([]);

  // Capture search results directed at this row. Keyed by the current search term.
  useEffect(() => {
    if (
      actionData &&
      "intent" in actionData &&
      actionData.intent === "search" &&
      pickerOpen &&
      searching
    ) {
      setSearchResults(actionData.variants);
      setSearching(false);
    }
  }, [actionData, pickerOpen, searching]);

  const extractedLabel = [
    line.extracted.title,
    line.extracted.color,
    line.extracted.size,
  ]
    .filter(Boolean)
    .join(" · ");

  const candidateOptions = useMemo(() => {
    const pool = [...line.candidates, ...searchResults];
    const seen = new Set<string>();
    const unique: MatchedVariant[] = [];
    for (const v of pool) {
      if (seen.has(v.shopifyVariantId)) continue;
      seen.add(v.shopifyVariantId);
      unique.push(v);
    }
    return unique;
  }, [line.candidates, searchResults]);

  const selectOptions = [
    { label: "— Skip (don't import) —", value: "" },
    ...candidateOptions.map((v) => ({
      label: `${v.productTitle} · ${v.variantTitle}${v.sku ? ` · ${v.sku}` : ""}`,
      value: v.shopifyVariantId,
    })),
  ];

  const handleSelect = (vid: string) => {
    if (!vid) {
      onChange({ variant: null });
      return;
    }
    const picked = candidateOptions.find((c) => c.shopifyVariantId === vid);
    if (picked) {
      onChange({
        variant: picked,
        unitCost:
          line.extracted.unitCost != null ? line.extracted.unitCost : picked.unitCost,
        retailPrice:
          line.extracted.retailPrice != null
            ? line.extracted.retailPrice
            : picked.retailPrice,
      });
    }
  };

  const runSearch = () => {
    if (!vendor) return;
    setSearching(true);
    setPickerOpen(true);
    const fd = new FormData();
    fd.set("intent", "search");
    fd.set("vendor", vendor);
    fd.set("query", searchTerm);
    submit(fd, { method: "post" });
  };

  const confidenceBadge = (() => {
    switch (line.confidence) {
      case "sku":
        return <Badge tone="success">SKU match</Badge>;
      case "title+options":
        return <Badge tone="success">Good match</Badge>;
      case "title":
        return <Badge tone="attention">Check match</Badge>;
      default:
        return <Badge tone="critical">No match</Badge>;
    }
  })();

  return (
    <tr style={{ borderBottom: "1px solid #f1f1f1", verticalAlign: "top" }}>
      <td style={{ padding: "8px", maxWidth: "260px" }}>
        <BlockStack gap="100">
          <Text as="p" variant="bodyMd" fontWeight="semibold">
            {line.extracted.title || "(untitled)"}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {extractedLabel || "—"}
            {line.extracted.sku ? ` · SKU ${line.extracted.sku}` : ""}
          </Text>
        </BlockStack>
      </td>

      <td style={{ padding: "8px", minWidth: "280px" }}>
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            {confidenceBadge}
            {line.variant && (
              <Text as="span" variant="bodySm" tone="subdued">
                {line.variant.sku || "no SKU"}
              </Text>
            )}
          </InlineStack>
          <Select
            label=""
            labelHidden
            options={selectOptions}
            value={line.variant?.shopifyVariantId ?? ""}
            onChange={handleSelect}
          />
          <InlineStack gap="100">
            <TextField
              label=""
              labelHidden
              value={searchTerm}
              onChange={setSearchTerm}
              placeholder="Search this vendor's products…"
              autoComplete="off"
            />
            <Button onClick={runSearch} disabled={searching || !vendor}>
              {searching ? "Searching…" : "Search"}
            </Button>
          </InlineStack>
        </BlockStack>
      </td>

      <td style={{ padding: "4px 8px", textAlign: "right", minWidth: "90px" }}>
        <TextField
          label=""
          labelHidden
          type="number"
          prefix="$"
          value={String(line.unitCost)}
          onChange={(v) => onChange({ unitCost: parseFloat(v) || 0 })}
          min={0}
          step={0.01}
          autoComplete="off"
        />
      </td>
      <td style={{ padding: "4px 8px", textAlign: "right", minWidth: "90px" }}>
        <TextField
          label=""
          labelHidden
          type="number"
          prefix="$"
          value={String(line.retailPrice)}
          onChange={(v) => onChange({ retailPrice: parseFloat(v) || 0 })}
          min={0}
          step={0.01}
          autoComplete="off"
        />
      </td>
      <td style={{ padding: "4px 8px", textAlign: "right" }}>
        <TextField
          label=""
          labelHidden
          type="number"
          value={String(line.quantityOrdered)}
          onChange={(v) => onChange({ quantityOrdered: parseInt(v) || 0 })}
          min={0}
          autoComplete="off"
        />
      </td>
      <td
        style={{
          padding: "8px",
          textAlign: "right",
          fontWeight: 600,
        }}
      >
        {line.variant
          ? `$${(line.unitCost * line.quantityOrdered).toFixed(2)}`
          : "—"}
      </td>
    </tr>
  );
}
