import { useCallback, useState, useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Badge,
  Text,
  BlockStack,
  InlineStack,
  DataTable,
  Button,
  Divider,
  ButtonGroup,
  TextField,
  Autocomplete,
  Icon,
  Banner,
  Spinner,
} from "@shopify/polaris";
import { SearchIcon, DeleteIcon } from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import {
  getPurchaseOrder,
  updatePurchaseOrder,
  updatePurchaseOrderStatus,
  deletePurchaseOrder,
} from "../services/purchase-orders/po-service.server";
import {
  getLocations,
  type Location,
} from "../services/shopify-api/locations.server";
import {
  getVendors,
  searchProducts,
  searchProductsByVendor,
} from "../services/shopify-api/products.server";
import { LocationPicker } from "../components/LocationPicker";
import { PO_STATUS_LABELS, PO_STATUS_TONES } from "../utils/constants";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const po = await getPurchaseOrder(session.shop, params.id!);
  if (!po) throw new Response("Not found", { status: 404 });

  const [locations, vendors] = await Promise.all([
    getLocations(admin, session.shop).catch(() => [] as Location[]),
    getVendors(admin, session.shop).catch(() => [] as string[]),
  ]);

  const locationName =
    locations.find((l) => l.id === po.shopifyLocationId)?.name ?? null;
  return json({ po, locations, locationName, vendors });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "search") {
    const query = String(formData.get("query") ?? "").trim();
    const vendor = String(formData.get("vendor") ?? "").trim();
    if (!query && !vendor) return json({ hits: [] as SearchHit[] });
    try {
      const result = vendor
        ? await searchProductsByVendor(admin, vendor, query || undefined)
        : await searchProducts(admin, query);
      const hits: SearchHit[] = [];
      for (const edge of result.edges as Array<{ node: any }>) {
        const p = edge.node;
        for (const v of p.variants.edges as Array<{ node: any }>) {
          const costAmount = v.node.inventoryItem?.unitCost?.amount;
          hits.push({
            variantId: v.node.id,
            productId: p.id,
            productTitle: p.title,
            variantTitle: v.node.title,
            sku: v.node.sku ?? null,
            barcode: v.node.barcode ?? null,
            unitCost: costAmount ? parseFloat(costAmount) : 0,
            retailPrice: v.node.price ? parseFloat(v.node.price) : 0,
          });
        }
      }
      return json({ hits });
    } catch (error) {
      return json({ hits: [] as SearchHit[], error: String(error) });
    }
  }

  if (intent === "updateStatus") {
    const status = formData.get("status") as string;
    await updatePurchaseOrderStatus(session.shop, params.id!, status);
    return json({ ok: true as const });
  }

  if (intent === "delete") {
    await deletePurchaseOrder(session.shop, params.id!);
    throw redirect("/app/purchase-orders");
  }

  if (intent === "update") {
    try {
      const lineItemsRaw = formData.get("lineItems") as string | null;
      const lineItems = lineItemsRaw ? JSON.parse(lineItemsRaw) : undefined;

      await updatePurchaseOrder(session.shop, params.id!, {
        vendor: (formData.get("vendor") as string) || null,
        poNumberExt: (formData.get("poNumberExt") as string) || null,
        notes: (formData.get("notes") as string) || null,
        shippingDate:
          (formData.get("shippingDate") as string)
            ? new Date(formData.get("shippingDate") as string)
            : null,
        expectedDate:
          (formData.get("expectedDate") as string)
            ? new Date(formData.get("expectedDate") as string)
            : null,
        shopifyLocationId:
          (formData.get("shopifyLocationId") as string) || null,
        lineItems,
      });
      return json({ ok: true as const });
    } catch (error) {
      return json({ error: String(error) });
    }
  }

  return json({});
};

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
}

// Convert a Date or ISO string to the yyyy-mm-dd form `<input type="date">` wants.
function dateInputValue(
  value: Date | string | null | undefined,
): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Convert a Shopify product gid to the App Bridge admin URL. Clicking
// `shopify:admin/products/...` inside an embedded app opens the Shopify
// admin in a new tab (or deeplinks inside the admin iframe).
function productAdminUrl(shopifyProductId: string): string {
  const numericId = shopifyProductId.replace("gid://shopify/Product/", "");
  return `shopify:admin/products/${numericId}`;
}

// Styled anchor that matches the default Polaris link look. Renders an
// external-safe link — App Bridge picks up the `shopify:` scheme.
function ProductLink({
  productId,
  title,
  nonSize,
}: {
  productId: string;
  title: string;
  nonSize?: string;
}) {
  return (
    <a
      href={productAdminUrl(productId)}
      target="_blank"
      rel="noreferrer"
      style={{
        color: "#005bd3",
        textDecoration: "none",
        fontWeight: 500,
      }}
    >
      {title}
      {nonSize && (
        <span
          style={{ color: "#616161", fontWeight: 400 }}
        >{` — ${nonSize}`}</span>
      )}
    </a>
  );
}

interface EditableLine {
  id: string;
  shopifyProductId: string;
  shopifyVariantId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  barcode: string | null;
  unitCost: number;
  retailPrice: number;
  quantityOrdered: number;
  quantityReceived: number;
}

interface SearchHit {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  barcode: string | null;
  unitCost: number;
  retailPrice: number;
}

export default function PurchaseOrderDetail() {
  const { po, locations, locationName, vendors } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";

  const [isEditing, setIsEditing] = useState(false);
  const [viewMode, setViewMode] = useState<"line" | "grid">("grid");
  const [editViewMode, setEditViewMode] = useState<"line" | "grid">("grid");

  // Editable state (only used in edit mode; otherwise ignored)
  const [vendor, setVendor] = useState(po.vendor ?? "");
  const [vendorInput, setVendorInput] = useState(po.vendor ?? "");
  const [poNumberExt, setPoNumberExt] = useState(po.poNumberExt ?? "");
  const [shippingDate, setShippingDate] = useState(
    dateInputValue(po.shippingDate),
  );
  const [expectedDate, setExpectedDate] = useState(
    dateInputValue(po.expectedDate),
  );
  const [shopifyLocationId, setShopifyLocationId] = useState<string | null>(
    po.shopifyLocationId,
  );
  const [notes, setNotes] = useState(po.notes ?? "");
  const [editLines, setEditLines] = useState<EditableLine[]>(() =>
    po.lineItems.map((li) => ({
      id: li.id,
      shopifyProductId: li.shopifyProductId,
      shopifyVariantId: li.shopifyVariantId,
      productTitle: li.productTitle,
      variantTitle: li.variantTitle,
      sku: li.sku,
      barcode: li.barcode,
      unitCost: li.unitCost,
      retailPrice: li.retailPrice,
      quantityOrdered: li.quantityOrdered,
      quantityReceived: li.quantityReceived,
    })),
  );

  // ── Product search (edit mode only) ─────────────────────────────────────
  // Declared AFTER `vendor` + `editLines` so the useEffect deps array doesn't
  // hit a temporal-dead-zone reference during render. Uses a separate
  // fetcher so the search doesn't conflict with the main form submission.
  const searchFetcher = useFetcher<typeof action>();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const isSearching = searchFetcher.state === "submitting";

  // Debounced search: wait 300ms after typing stops, then POST the query.
  useEffect(() => {
    if (!isEditing) return;
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(() => {
      const fd = new FormData();
      fd.set("intent", "search");
      fd.set("query", searchQuery);
      // Limit to this PO's vendor by default to match the create flow.
      if (vendor) fd.set("vendor", vendor);
      searchFetcher.submit(fd, { method: "post" });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, isEditing, vendor]);

  useEffect(() => {
    const data = searchFetcher.data;
    if (data && "hits" in data) {
      setSearchResults((data.hits as SearchHit[]) ?? []);
    }
  }, [searchFetcher.data]);

  // Add a search hit as a new editable line. Synthetic "new-<variantId>-<ts>"
  // id — never hits the DB (updatePurchaseOrder wipes and recreates all
  // lines on save) but keeps local React keys unique.
  const handleAddFromSearch = useCallback((hit: SearchHit) => {
    setEditLines((prev) => {
      const existing = prev.find(
        (l) => l.shopifyVariantId === hit.variantId,
      );
      if (existing) {
        return prev.map((l) =>
          l.shopifyVariantId === hit.variantId
            ? { ...l, quantityOrdered: l.quantityOrdered + 1 }
            : l,
        );
      }
      return [
        ...prev,
        {
          id: `new-${hit.variantId}-${Date.now()}`,
          shopifyProductId: hit.productId,
          shopifyVariantId: hit.variantId,
          productTitle: hit.productTitle,
          variantTitle: hit.variantTitle,
          sku: hit.sku,
          barcode: hit.barcode,
          unitCost: hit.unitCost,
          retailPrice: hit.retailPrice,
          quantityOrdered: 1,
          quantityReceived: 0,
        },
      ];
    });
  }, []);

  // On successful save, exit edit mode. Revalidation re-fetches the PO so
  // the read-only view shows the new values.
  useEffect(() => {
    if (actionData && "ok" in actionData && actionData.ok) {
      setIsEditing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  // If the loader re-fires with a new PO snapshot, resync local edit state.
  useEffect(() => {
    setVendor(po.vendor ?? "");
    setVendorInput(po.vendor ?? "");
    setPoNumberExt(po.poNumberExt ?? "");
    setShippingDate(dateInputValue(po.shippingDate));
    setExpectedDate(dateInputValue(po.expectedDate));
    setShopifyLocationId(po.shopifyLocationId);
    setNotes(po.notes ?? "");
    setEditLines(
      po.lineItems.map((li) => ({
        id: li.id,
        shopifyProductId: li.shopifyProductId,
        shopifyVariantId: li.shopifyVariantId,
        productTitle: li.productTitle,
        variantTitle: li.variantTitle,
        sku: li.sku,
        barcode: li.barcode,
        unitCost: li.unitCost,
        retailPrice: li.retailPrice,
        quantityOrdered: li.quantityOrdered,
        quantityReceived: li.quantityReceived,
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [po.id, po.updatedAt]);

  const canEditLines = po.status === "draft";
  const canEdit = po.status !== "cancelled";

  const handleStatusChange = useCallback(
    (status: string) => {
      const fd = new FormData();
      fd.set("intent", "updateStatus");
      fd.set("status", status);
      submit(fd, { method: "post" });
    },
    [submit],
  );

  const handleDelete = useCallback(() => {
    // Stronger copy when the PO has already been acted on. Deleting a
    // received PO doesn't roll back the Shopify inventory that was added
    // when receipts were processed — it just removes the PO record and
    // its audit trail from our DB.
    const hasActivity =
      po.status !== "draft" &&
      po.status !== "cancelled";
    const msg = hasActivity
      ? `Delete PO ${po.poNumber}? Status is "${po.status.replace(/_/g, " ")}" — any inventory already adjusted from receipts will NOT be rolled back. This only removes the PO and its audit trail. Continue?`
      : `Delete PO ${po.poNumber}? This can't be undone. Inventory is unaffected.`;
    if (!window.confirm(msg)) return;
    const fd = new FormData();
    fd.set("intent", "delete");
    submit(fd, { method: "post" });
  }, [submit, po.poNumber, po.status]);

  const handleSave = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "update");
    fd.set("vendor", vendor || vendorInput);
    fd.set("poNumberExt", poNumberExt);
    fd.set("shippingDate", shippingDate);
    fd.set("expectedDate", expectedDate);
    fd.set("notes", notes);
    if (shopifyLocationId) fd.set("shopifyLocationId", shopifyLocationId);
    if (canEditLines) {
      fd.set(
        "lineItems",
        JSON.stringify(
          editLines
            .filter((l) => l.quantityOrdered > 0)
            .map((l) => ({
              shopifyProductId: l.shopifyProductId,
              shopifyVariantId: l.shopifyVariantId,
              productTitle: l.productTitle,
              variantTitle: l.variantTitle,
              sku: l.sku,
              barcode: l.barcode,
              unitCost: l.unitCost,
              retailPrice: l.retailPrice,
              quantityOrdered: l.quantityOrdered,
            })),
        ),
      );
    }
    submit(fd, { method: "post" });
  }, [
    vendor,
    vendorInput,
    poNumberExt,
    shippingDate,
    expectedDate,
    notes,
    shopifyLocationId,
    editLines,
    canEditLines,
    submit,
  ]);

  // ── PDF / label downloads ────────────────────────────────────────────
  // All PDF downloads fetch inside the authenticated iframe and trigger a
  // blob download. A top-level navigation to the API endpoint (what we used
  // to do via secondary action urls) opens a new tab without the Shopify
  // admin session token, which is why users were seeing "opens a new page
  // and nothing happens" or "have to refresh after generating."
  const [isGenerating, setIsGenerating] = useState<
    null | "labels" | "pdf-line" | "pdf-grid"
  >(null);
  const [lastDownload, setLastDownload] = useState<{
    label: string;
    filename: string;
  } | null>(null);

  const downloadBlob = useCallback(
    async (opts: {
      url: string;
      filename: string;
      label: string;
      kind: "labels" | "pdf-line" | "pdf-grid";
      emptyMessage?: string;
    }) => {
      if (isGenerating !== null) return;
      setIsGenerating(opts.kind);
      try {
        const response = await fetch(opts.url);
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(
            `${opts.label} endpoint returned ${response.status}. ${body.slice(0, 200)}`,
          );
        }
        const blob = await response.blob();
        if (blob.size === 0) {
          throw new Error(
            opts.emptyMessage ?? "Generated PDF was empty.",
          );
        }
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objUrl;
        a.download = opts.filename;
        a.rel = "noreferrer";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
        setLastDownload({ label: opts.label, filename: opts.filename });
      } catch (error) {
        console.error(`${opts.label} failed:`, error);
        window.alert(
          `Couldn't generate ${opts.label.toLowerCase()}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        setIsGenerating(null);
      }
    },
    [isGenerating],
  );

  const handlePrintLabels = useCallback(
    () =>
      downloadBlob({
        url: `/api/labels/${po.id}`,
        filename: `labels-${po.poNumber}.pdf`,
        label: "Labels",
        kind: "labels",
        emptyMessage:
          "Generated PDF was empty. Check that line items have SKUs or barcodes.",
      }),
    [downloadBlob, po.id, po.poNumber],
  );

  const handleDownloadPdfLine = useCallback(
    () =>
      downloadBlob({
        url: `/api/po-pdf/${po.id}?view=line`,
        filename: `${po.poNumber}-line.pdf`,
        label: "PO PDF (Line)",
        kind: "pdf-line",
      }),
    [downloadBlob, po.id, po.poNumber],
  );

  const handleDownloadPdfGrid = useCallback(
    () =>
      downloadBlob({
        url: `/api/po-pdf/${po.id}?view=grid`,
        filename: `${po.poNumber}-grid.pdf`,
        label: "PO PDF (Grid)",
        kind: "pdf-grid",
      }),
    [downloadBlob, po.id, po.poNumber],
  );

  const isGeneratingLabels = isGenerating === "labels";

  const handleCancelEdit = useCallback(() => {
    // Reset back to PO values
    setVendor(po.vendor ?? "");
    setVendorInput(po.vendor ?? "");
    setPoNumberExt(po.poNumberExt ?? "");
    setShippingDate(dateInputValue(po.shippingDate));
    setExpectedDate(dateInputValue(po.expectedDate));
    setShopifyLocationId(po.shopifyLocationId);
    setNotes(po.notes ?? "");
    setEditLines(
      po.lineItems.map((li) => ({
        id: li.id,
        shopifyProductId: li.shopifyProductId,
        shopifyVariantId: li.shopifyVariantId,
        productTitle: li.productTitle,
        variantTitle: li.variantTitle,
        sku: li.sku,
        barcode: li.barcode,
        unitCost: li.unitCost,
        retailPrice: li.retailPrice,
        quantityOrdered: li.quantityOrdered,
        quantityReceived: li.quantityReceived,
      })),
    );
    setIsEditing(false);
  }, [po]);

  // Totals (use edit state when editing, saved state otherwise)
  const lines = isEditing ? editLines : po.lineItems;
  const totalOrdered = lines.reduce(
    (sum, li) => sum + li.quantityOrdered,
    0,
  );
  const totalReceived = lines.reduce(
    (sum, li) => sum + (li as any).quantityReceived ?? 0,
    0,
  );
  const totalCost = lines.reduce(
    (sum, li) => sum + li.unitCost * li.quantityOrdered,
    0,
  );
  const totalRetail = lines.reduce(
    (sum, li) => sum + (li.retailPrice ?? 0) * li.quantityOrdered,
    0,
  );

  const readOnlyRows = po.lineItems.map((li) => [
    (
      <ProductLink
        key={li.id}
        productId={li.shopifyProductId}
        title={li.productTitle}
      />
    ),
    li.variantTitle,
    li.sku || "—",
    li.barcode || "—",
    `$${li.unitCost.toFixed(2)}`,
    `$${(li.retailPrice || 0).toFixed(2)}`,
    String(li.quantityOrdered),
    `${li.quantityReceived} / ${li.quantityOrdered}`,
    `$${(li.unitCost * li.quantityOrdered).toFixed(2)}`,
  ]);

  const statusActions = () => {
    if (isEditing) return null;
    switch (po.status) {
      case "draft":
        return (
          <ButtonGroup>
            <Button onClick={() => handleStatusChange("ordered")}>
              Mark as Ordered
            </Button>
            <Button
              tone="critical"
              onClick={() => handleStatusChange("cancelled")}
            >
              Cancel PO
            </Button>
            <Button tone="critical" variant="plain" onClick={handleDelete}>
              Delete
            </Button>
          </ButtonGroup>
        );
      // ordered / partially_received / received / cancelled all get their
      // "next step" button via the Page.primaryAction slot in the header —
      // no inline action needed here.
      default:
        return null;
    }
  };

  const vendorOptions = vendors
    .filter(
      (v) =>
        !vendorInput || v.toLowerCase().includes(vendorInput.toLowerCase()),
    )
    .map((v) => ({ value: v, label: v }));

  // Primary action — branches on status so the most useful next step is
  // always one click away. Uses the Page.primaryAction `url` prop for the
  // Receive flow; that routes through App Bridge and navigates reliably
  // inside the embedded iframe (plain Polaris Button `url` and useNavigate()
  // both had issues from the iframe).
  const primaryAction = isEditing
    ? { content: "Save changes", onAction: handleSave, loading: isSaving }
    : po.status === "ordered"
      ? {
          content: "Receive Items",
          url: `/app/purchase-orders/${po.id}/receive`,
        }
      : po.status === "partially_received"
        ? {
            content: "Continue Receiving",
            url: `/app/purchase-orders/${po.id}/receive`,
          }
        : canEdit
          ? { content: "Edit", onAction: () => setIsEditing(true) }
          : undefined;

  // In edit mode we still want Edit/Save; outside edit mode if the primary
  // action is Receive we keep Edit accessible via secondary actions.
  const extraSecondaryActions =
    !isEditing &&
    canEdit &&
    (po.status === "ordered" || po.status === "partially_received")
      ? [
          {
            content: "Edit",
            onAction: () => setIsEditing(true),
          },
        ]
      : [];

  return (
    <Page
      title={po.poNumber}
      backAction={{ url: "/app/purchase-orders" }}
      titleMetadata={
        <Badge tone={PO_STATUS_TONES[po.status] || "info"}>
          {PO_STATUS_LABELS[po.status] || po.status}
        </Badge>
      }
      primaryAction={primaryAction}
      secondaryActions={
        isEditing
          ? [{ content: "Cancel", onAction: handleCancelEdit }]
          : [
              ...extraSecondaryActions,
              {
                content:
                  isGenerating === "labels" ? "Generating…" : "Print Labels",
                onAction: handlePrintLabels,
                loading: isGenerating === "labels",
                disabled: isGenerating !== null,
              },
              {
                content:
                  isGenerating === "pdf-line"
                    ? "Generating…"
                    : "Download PDF (Line)",
                onAction: handleDownloadPdfLine,
                loading: isGenerating === "pdf-line",
                disabled: isGenerating !== null,
              },
              {
                content:
                  isGenerating === "pdf-grid"
                    ? "Generating…"
                    : "Download PDF (Grid)",
                onAction: handleDownloadPdfGrid,
                loading: isGenerating === "pdf-grid",
                disabled: isGenerating !== null,
              },
              // Delete is always available (except when already cancelled)
              // so users can clean up test POs or mistakes regardless of
              // status. Stronger confirmation kicks in for non-draft POs.
              ...(po.status !== "cancelled"
                ? [
                    {
                      content: "Delete",
                      destructive: true,
                      onAction: handleDelete,
                    },
                  ]
                : []),
            ]
      }
    >
      <Layout>
        {lastDownload && (
          <Layout.Section>
            <Banner
              tone="success"
              title={`${lastDownload.label} downloaded`}
              onDismiss={() => setLastDownload(null)}
              action={{
                content: "Back to Purchase Orders",
                url: "/app/purchase-orders",
              }}
            >
              <p>
                Saved to your browser downloads as{" "}
                <strong>{lastDownload.filename}</strong>.
              </p>
            </Banner>
          </Layout.Section>
        )}
        {actionData && "error" in actionData && (
          <Layout.Section>
            <Banner tone="critical">{String(actionData.error)}</Banner>
          </Layout.Section>
        )}
        {actionData && "ok" in actionData && actionData.ok && !isEditing && (
          <Layout.Section>
            <Banner tone="success" onDismiss={() => {}}>
              Changes saved.
            </Banner>
          </Layout.Section>
        )}

        {/* Header card — either read-only or edit form */}
        <Layout.Section>
          {isEditing ? (
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Edit PO details
                </Text>
                {!canEditLines && (
                  <Banner tone="info">
                    Line items are locked on {PO_STATUS_LABELS[po.status]?.toLowerCase() ?? po.status} POs — you can edit dates, notes, vendor PO #, vendor name, and receive location.
                  </Banner>
                )}
                <InlineStack gap="400" wrap>
                  <div style={{ flex: 1, minWidth: "240px" }}>
                    <Autocomplete
                      options={vendorOptions}
                      selected={vendor ? [vendor] : []}
                      onSelect={(sel) => {
                        const v = sel[0] ?? "";
                        setVendor(v);
                        setVendorInput(v);
                      }}
                      textField={
                        <Autocomplete.TextField
                          label="Vendor"
                          value={vendorInput}
                          onChange={(v) => {
                            setVendorInput(v);
                            if (!v) setVendor("");
                          }}
                          autoComplete="off"
                          prefix={<Icon source={SearchIcon} />}
                        />
                      }
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: "240px" }}>
                    <TextField
                      label="Vendor's PO #"
                      value={poNumberExt}
                      onChange={setPoNumberExt}
                      autoComplete="off"
                      placeholder="(optional)"
                    />
                  </div>
                </InlineStack>
                <InlineStack gap="400" wrap>
                  <div style={{ flex: 1, minWidth: "200px" }}>
                    <TextField
                      label="Ship by"
                      type="date"
                      value={shippingDate}
                      onChange={setShippingDate}
                      autoComplete="off"
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: "200px" }}>
                    <TextField
                      label="Expected delivery"
                      type="date"
                      value={expectedDate}
                      onChange={setExpectedDate}
                      autoComplete="off"
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: "240px" }}>
                    <LocationPicker
                      label="Receive to location"
                      locations={locations}
                      value={shopifyLocationId}
                      onChange={setShopifyLocationId}
                      persistKey="po-edit-destination"
                    />
                  </div>
                </InlineStack>
                <TextField
                  label="Notes"
                  value={notes}
                  onChange={setNotes}
                  autoComplete="off"
                  multiline={3}
                />
              </BlockStack>
            </Card>
          ) : (
            <Card>
              <BlockStack gap="400">
                <InlineStack gap="600" wrap>
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Vendor
                    </Text>
                    <Text as="p" variant="bodyMd">
                      {po.vendor || "—"}
                    </Text>
                  </BlockStack>
                  {po.poNumberExt && (
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Vendor PO #
                      </Text>
                      <Text as="p" variant="bodyMd">
                        {po.poNumberExt}
                      </Text>
                    </BlockStack>
                  )}
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Receive at
                    </Text>
                    <Text as="p" variant="bodyMd">
                      {locationName ?? "—"}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Ship by
                    </Text>
                    <Text as="p" variant="bodyMd">
                      {formatDate(po.shippingDate)}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Expected
                    </Text>
                    <Text as="p" variant="bodyMd">
                      {formatDate(po.expectedDate)}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Created
                    </Text>
                    <Text as="p" variant="bodyMd">
                      {formatDate(po.createdAt)}
                    </Text>
                  </BlockStack>
                  {po.orderDate && (
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Ordered
                      </Text>
                      <Text as="p" variant="bodyMd">
                        {formatDate(po.orderDate)}
                      </Text>
                    </BlockStack>
                  )}
                </InlineStack>
                <Divider />
                <InlineStack gap="600" wrap>
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Total Cost
                    </Text>
                    <Text as="p" variant="headingMd">
                      ${totalCost.toFixed(2)}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Total Retail
                    </Text>
                    <Text as="p" variant="headingMd">
                      ${totalRetail.toFixed(2)}
                    </Text>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Progress
                    </Text>
                    <Text as="p" variant="headingMd">
                      {totalReceived} / {totalOrdered}
                    </Text>
                  </BlockStack>
                </InlineStack>
                {po.notes && (
                  <>
                    <Divider />
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Notes
                      </Text>
                      <Text as="p" variant="bodyMd">
                        {po.notes}
                      </Text>
                    </BlockStack>
                  </>
                )}
              </BlockStack>
            </Card>
          )}
        </Layout.Section>

        {/* Add products — only in edit mode on drafts */}
        {isEditing && canEditLines && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Add products
                </Text>
                <TextField
                  label={
                    vendor
                      ? `Search ${vendor}'s products`
                      : "Search all products"
                  }
                  labelHidden
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder={
                    vendor
                      ? `Search ${vendor}'s products by title or SKU…`
                      : "Search by title, SKU, or vendor…"
                  }
                  autoComplete="off"
                  prefix={<Icon source={SearchIcon} />}
                  clearButton
                  onClearButtonClick={() => {
                    setSearchQuery("");
                    setSearchResults([]);
                  }}
                />
                {isSearching && (
                  <InlineStack gap="200" blockAlign="center">
                    <Spinner size="small" />
                    <Text as="span" variant="bodySm" tone="subdued">
                      Searching…
                    </Text>
                  </InlineStack>
                )}
                {searchResults.length > 0 && (
                  <BlockStack gap="100">
                    {searchResults.map((h) => {
                      const alreadyAdded = editLines.some(
                        (l) => l.shopifyVariantId === h.variantId,
                      );
                      return (
                        <div
                          key={h.variantId}
                          style={{
                            padding: "6px 10px",
                            borderRadius: "6px",
                            border: "1px solid #e1e3e5",
                          }}
                        >
                          <InlineStack
                            align="space-between"
                            blockAlign="center"
                            wrap={false}
                          >
                            <div style={{ minWidth: 0 }}>
                              <Text as="p" variant="bodyMd">
                                {h.productTitle} —{" "}
                                <Text as="span" tone="subdued">
                                  {h.variantTitle}
                                </Text>
                              </Text>
                              <Text as="p" variant="bodySm" tone="subdued">
                                {h.sku || "no SKU"}
                                {h.unitCost > 0
                                  ? ` · cost $${h.unitCost.toFixed(2)}`
                                  : ""}
                                {h.retailPrice > 0
                                  ? ` · retail $${h.retailPrice.toFixed(2)}`
                                  : ""}
                              </Text>
                            </div>
                            <Button
                              size="slim"
                              onClick={() => handleAddFromSearch(h)}
                            >
                              {alreadyAdded ? "+1 more" : "Add"}
                            </Button>
                          </InlineStack>
                        </div>
                      );
                    })}
                  </BlockStack>
                )}
                {!isSearching &&
                  searchQuery.trim() &&
                  searchResults.length === 0 && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      No variants match "{searchQuery}".
                    </Text>
                  )}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Line items — editable on drafts when editing, otherwise DataTable */}
        <Layout.Section>
          {isEditing && canEditLines ? (
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Line items
                  </Text>
                  <ButtonGroup variant="segmented">
                    <Button
                      pressed={editViewMode === "line"}
                      onClick={() => setEditViewMode("line")}
                      size="slim"
                    >
                      Line Items
                    </Button>
                    <Button
                      pressed={editViewMode === "grid"}
                      onClick={() => setEditViewMode("grid")}
                      size="slim"
                    >
                      Size Grid
                    </Button>
                  </ButtonGroup>
                </InlineStack>
                {editViewMode === "grid" ? (
                  <PODetailGrid
                    lineItems={editLines}
                    editable
                    onCellQtyChange={(lineItemId, qty) =>
                      setEditLines((prev) =>
                        prev.map((l) =>
                          l.id === lineItemId
                            ? {
                                ...l,
                                quantityOrdered: Math.max(0, qty),
                              }
                            : l,
                        ),
                      )
                    }
                    onRowCostChange={(lineItemIds, cost) => {
                      const ids = new Set(lineItemIds);
                      setEditLines((prev) =>
                        prev.map((l) =>
                          ids.has(l.id) ? { ...l, unitCost: cost } : l,
                        ),
                      );
                    }}
                    onRowRetailChange={(lineItemIds, retail) => {
                      const ids = new Set(lineItemIds);
                      setEditLines((prev) =>
                        prev.map((l) =>
                          ids.has(l.id) ? { ...l, retailPrice: retail } : l,
                        ),
                      );
                    }}
                    onRemoveLine={(lineItemId) =>
                      setEditLines((prev) =>
                        prev.filter((l) => l.id !== lineItemId),
                      )
                    }
                  />
                ) : (
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
                          Product
                        </th>
                        <th style={{ padding: "8px", textAlign: "left" }}>
                          Variant
                        </th>
                        <th style={{ padding: "8px", textAlign: "left" }}>
                          SKU
                        </th>
                        <th
                          style={{
                            padding: "8px",
                            textAlign: "right",
                            minWidth: "100px",
                          }}
                        >
                          Cost
                        </th>
                        <th
                          style={{
                            padding: "8px",
                            textAlign: "right",
                            minWidth: "100px",
                          }}
                        >
                          Retail
                        </th>
                        <th
                          style={{
                            padding: "8px",
                            textAlign: "right",
                            minWidth: "90px",
                          }}
                        >
                          Qty
                        </th>
                        <th style={{ padding: "8px", textAlign: "right" }}>
                          Line Total
                        </th>
                        <th style={{ padding: "8px", width: "40px" }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {editLines.map((line, idx) => (
                        <tr
                          key={line.id}
                          style={{ borderBottom: "1px solid #f1f1f1" }}
                        >
                          <td style={{ padding: "8px" }}>
                            <ProductLink
                              productId={line.shopifyProductId}
                              title={line.productTitle}
                            />
                          </td>
                          <td style={{ padding: "8px" }}>
                            {line.variantTitle}
                          </td>
                          <td style={{ padding: "8px" }}>
                            {line.sku || "—"}
                          </td>
                          <td style={{ padding: "2px 4px" }}>
                            <TextField
                              label="Cost"
                              labelHidden
                              type="number"
                              prefix="$"
                              value={String(line.unitCost)}
                              onChange={(val) =>
                                setEditLines((prev) =>
                                  prev.map((l, i) =>
                                    i === idx
                                      ? {
                                          ...l,
                                          unitCost: parseFloat(val) || 0,
                                        }
                                      : l,
                                  ),
                                )
                              }
                              min={0}
                              step={0.01}
                              autoComplete="off"
                            />
                          </td>
                          <td style={{ padding: "2px 4px" }}>
                            <TextField
                              label="Retail"
                              labelHidden
                              type="number"
                              prefix="$"
                              value={String(line.retailPrice)}
                              onChange={(val) =>
                                setEditLines((prev) =>
                                  prev.map((l, i) =>
                                    i === idx
                                      ? {
                                          ...l,
                                          retailPrice: parseFloat(val) || 0,
                                        }
                                      : l,
                                  ),
                                )
                              }
                              min={0}
                              step={0.01}
                              autoComplete="off"
                            />
                          </td>
                          <td style={{ padding: "2px 4px" }}>
                            <TextField
                              label="Qty"
                              labelHidden
                              type="number"
                              value={String(line.quantityOrdered)}
                              onChange={(val) =>
                                setEditLines((prev) =>
                                  prev.map((l, i) =>
                                    i === idx
                                      ? {
                                          ...l,
                                          quantityOrdered:
                                            Math.max(
                                              0,
                                              parseInt(val, 10) || 0,
                                            ),
                                        }
                                      : l,
                                  ),
                                )
                              }
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
                            $
                            {(
                              line.unitCost * line.quantityOrdered
                            ).toFixed(2)}
                          </td>
                          <td style={{ padding: "8px" }}>
                            <Button
                              icon={DeleteIcon}
                              variant="plain"
                              tone="critical"
                              accessibilityLabel="Remove line"
                              onClick={() =>
                                setEditLines((prev) =>
                                  prev.filter((_, i) => i !== idx),
                                )
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                )}
                <Text as="p" variant="bodySm" tone="subdued">
                  Use the &ldquo;Add products&rdquo; panel above to search and
                  add more variants. Removed lines are deleted on save.
                </Text>
              </BlockStack>
            </Card>
          ) : (
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Line items
                  </Text>
                  <ButtonGroup variant="segmented">
                    <Button
                      pressed={viewMode === "line"}
                      onClick={() => setViewMode("line")}
                      size="slim"
                    >
                      Line Items
                    </Button>
                    <Button
                      pressed={viewMode === "grid"}
                      onClick={() => setViewMode("grid")}
                      size="slim"
                    >
                      Size Grid
                    </Button>
                  </ButtonGroup>
                </InlineStack>
                {viewMode === "line" ? (
                  <div style={{ margin: "0 -16px -16px" }}>
                    <DataTable
                      columnContentTypes={[
                        "text",
                        "text",
                        "text",
                        "text",
                        "numeric",
                        "numeric",
                        "numeric",
                        "text",
                        "numeric",
                      ]}
                      headings={[
                        "Product",
                        "Variant",
                        "SKU",
                        "Barcode",
                        "Cost",
                        "Retail",
                        "Ordered",
                        "Received",
                        "Line Total",
                      ]}
                      rows={readOnlyRows}
                      totals={[
                        "",
                        "",
                        "",
                        "",
                        "",
                        "",
                        String(totalOrdered),
                        `${totalReceived} / ${totalOrdered}`,
                        `$${po.totalCost.toFixed(2)}`,
                      ]}
                    />
                  </div>
                ) : (
                  <PODetailGrid lineItems={po.lineItems} />
                )}
              </BlockStack>
            </Card>
          )}
        </Layout.Section>

        {/* Action bar */}
        <Layout.Section>
          <InlineStack align="end" gap="200">
            {isEditing ? (
              <ButtonGroup>
                <Button onClick={handleCancelEdit}>Cancel</Button>
                <Button
                  variant="primary"
                  onClick={handleSave}
                  loading={isSaving}
                >
                  Save changes
                </Button>
              </ButtonGroup>
            ) : (
              statusActions()
            )}
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// ─── PODetailGrid ────────────────────────────────────────────────────────────
// Read-only grid view of a PO's line items. Rows are (product + non-size
// variant parts), columns are sizes. Each cell shows ordered qty (and
// received inline when partial).
//
// We don't store `selectedOptions` on PurchaseOrderLineItem so we heuristically
// parse the variant title: split on " / " and classify parts as sizes if they
// match a known apparel size token, otherwise treat them as the row label
// (color, material, etc.).

const SIZE_TOKENS = new Set([
  "XXS", "XS", "S", "M", "L", "XL", "2XL", "XXL", "3XL", "XXXL", "4XL",
  "OS", "ONE SIZE",
]);
const SIZE_SORT_ORDER = [
  "XXS", "XS", "S", "M", "L", "XL", "2XL", "XXL", "3XL", "XXXL", "4XL",
  "OS", "ONE SIZE",
];

function classifyVariantTitle(variantTitle: string): {
  size: string | null;
  nonSize: string;
} {
  // Shopify's default single-variant title; not a size/color.
  if (/^default title$/i.test(variantTitle.trim())) {
    return { size: null, nonSize: "" };
  }
  const parts = variantTitle.split(" / ").map((p) => p.trim()).filter(Boolean);
  let size: string | null = null;
  const nonSizeParts: string[] = [];
  for (const part of parts) {
    if (!size && SIZE_TOKENS.has(part.toUpperCase())) {
      size = part;
    } else {
      nonSizeParts.push(part);
    }
  }
  return { size, nonSize: nonSizeParts.join(" / ") };
}

function compareSizesForDetail(a: string, b: string): number {
  const ai = SIZE_SORT_ORDER.indexOf(a.toUpperCase());
  const bi = SIZE_SORT_ORDER.indexOf(b.toUpperCase());
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return a.localeCompare(b);
}

interface PODetailLine {
  id: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  unitCost: number;
  retailPrice: number;
  quantityOrdered: number;
  quantityReceived: number;
  shopifyProductId: string;
}

interface PODetailCell {
  lineItemId: string;
  ordered: number;
  received: number;
}

function PODetailGrid({
  lineItems,
  editable = false,
  onCellQtyChange,
  onRowCostChange,
  onRowRetailChange,
  onRemoveLine,
}: {
  lineItems: PODetailLine[];
  editable?: boolean;
  onCellQtyChange?: (lineItemId: string, qty: number) => void;
  onRowCostChange?: (lineItemIds: string[], cost: number) => void;
  onRowRetailChange?: (lineItemIds: string[], retail: number) => void;
  onRemoveLine?: (lineItemId: string) => void;
}) {
  // Group line items by (productId + nonSize label). Track lineItemId per cell
  // so edit callbacks know which line to mutate.
  const sizeSet = new Set<string>();
  const groups = new Map<
    string,
    {
      productId: string;
      productTitle: string;
      nonSize: string;
      cost: number;
      retail: number;
      noSize: boolean;
      bySize: Record<string, PODetailCell>;
      lineItemIds: string[]; // all lines in this row (for row-level edits)
    }
  >();

  for (const li of lineItems) {
    const { size, nonSize } = classifyVariantTitle(li.variantTitle);
    const key = `${li.shopifyProductId}::${nonSize}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        productId: li.shopifyProductId,
        productTitle: li.productTitle,
        nonSize,
        cost: li.unitCost,
        retail: li.retailPrice,
        noSize: !size,
        bySize: {},
        lineItemIds: [],
      });
    }
    const group = groups.get(key)!;
    group.lineItemIds.push(li.id);
    const cell: PODetailCell = {
      lineItemId: li.id,
      ordered: li.quantityOrdered,
      received: li.quantityReceived,
    };
    if (size) {
      sizeSet.add(size);
      group.bySize[size] = cell;
    } else {
      group.bySize["_single"] = cell;
    }
  }

  const sortedSizes = [...sizeSet].sort(compareSizesForDetail);
  const sizeColCount = Math.max(sortedSizes.length, 1);

  if (groups.size === 0) {
    return (
      <Text as="p" tone="subdued">
        No line items.
      </Text>
    );
  }

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
            <th style={{ padding: "8px", textAlign: "left" }}>
              Product / Variant
            </th>
            <th
              style={{
                padding: "8px",
                textAlign: "right",
                minWidth: editable ? "100px" : undefined,
              }}
            >
              Cost
            </th>
            <th
              style={{
                padding: "8px",
                textAlign: "right",
                minWidth: editable ? "100px" : undefined,
              }}
            >
              Retail
            </th>
            {sortedSizes.length > 0 ? (
              sortedSizes.map((size) => (
                <th
                  key={size}
                  style={{
                    padding: "8px",
                    textAlign: "center",
                    minWidth: editable ? "80px" : "70px",
                  }}
                >
                  {size}
                </th>
              ))
            ) : (
              <th style={{ padding: "8px", textAlign: "center" }}>Qty</th>
            )}
            <th style={{ padding: "8px", textAlign: "right" }}>Row Total</th>
            {editable && onRemoveLine && (
              <th style={{ padding: "8px", width: "40px" }}></th>
            )}
          </tr>
        </thead>
        <tbody>
          {[...groups.entries()].map(([key, g]) => {
            const rowTotal = Object.values(g.bySize).reduce(
              (s, c) => s + c.ordered,
              0,
            );
            const rowCostTotal = rowTotal * g.cost;
            return (
              <tr
                key={key}
                style={{ borderBottom: "1px solid #f1f1f1" }}
              >
                <td
                  style={{
                    padding: "8px",
                    verticalAlign: "top",
                  }}
                >
                  <ProductLink
                    productId={g.productId}
                    title={g.productTitle}
                    nonSize={g.nonSize}
                  />
                </td>
                <td
                  style={{
                    padding: editable ? "2px 4px" : "8px",
                    textAlign: "right",
                    verticalAlign: "top",
                  }}
                >
                  {editable && onRowCostChange ? (
                    <TextField
                      label="Cost"
                      labelHidden
                      type="number"
                      prefix="$"
                      value={String(g.cost)}
                      onChange={(val) =>
                        onRowCostChange(g.lineItemIds, parseFloat(val) || 0)
                      }
                      min={0}
                      step={0.01}
                      autoComplete="off"
                    />
                  ) : (
                    `$${g.cost.toFixed(2)}`
                  )}
                </td>
                <td
                  style={{
                    padding: editable ? "2px 4px" : "8px",
                    textAlign: "right",
                    verticalAlign: "top",
                  }}
                >
                  {editable && onRowRetailChange ? (
                    <TextField
                      label="Retail"
                      labelHidden
                      type="number"
                      prefix="$"
                      value={String(g.retail)}
                      onChange={(val) =>
                        onRowRetailChange(
                          g.lineItemIds,
                          parseFloat(val) || 0,
                        )
                      }
                      min={0}
                      step={0.01}
                      autoComplete="off"
                    />
                  ) : (
                    `$${g.retail.toFixed(2)}`
                  )}
                </td>

                {g.noSize ? (
                  <td
                    colSpan={sizeColCount}
                    style={{
                      padding: editable ? "2px 4px" : "8px",
                      textAlign: "center",
                      verticalAlign: "top",
                    }}
                  >
                    {(() => {
                      const cell = g.bySize["_single"];
                      if (!cell) return "—";
                      if (editable && onCellQtyChange) {
                        return (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "12px",
                              justifyContent: "center",
                            }}
                          >
                            <div style={{ maxWidth: "120px" }}>
                              <TextField
                                label="Qty"
                                labelHidden
                                type="number"
                                value={String(cell.ordered)}
                                onChange={(val) =>
                                  onCellQtyChange(
                                    cell.lineItemId,
                                    parseInt(val, 10) || 0,
                                  )
                                }
                                min={0}
                                autoComplete="off"
                              />
                            </div>
                            {cell.received > 0 && (
                              <div
                                style={{
                                  fontSize: "11px",
                                  color: "#6b7280",
                                }}
                              >
                                {cell.received} received
                              </div>
                            )}
                          </div>
                        );
                      }
                      return (
                        <>
                          {cell.ordered}
                          {cell.received > 0 && (
                            <Text
                              as="span"
                              variant="bodySm"
                              tone="subdued"
                            >
                              {" "}
                              ({cell.received} received)
                            </Text>
                          )}
                        </>
                      );
                    })()}
                  </td>
                ) : (
                  sortedSizes.map((size) => {
                    const cell = g.bySize[size];
                    if (!cell) {
                      return (
                        <td
                          key={size}
                          style={{
                            padding: "8px",
                            textAlign: "center",
                            background: "#f9f9f9",
                            color: "#9ca3af",
                          }}
                        >
                          —
                        </td>
                      );
                    }
                    const isComplete = cell.received >= cell.ordered;
                    const isPartial =
                      cell.received > 0 && cell.received < cell.ordered;

                    if (editable && onCellQtyChange) {
                      return (
                        <td
                          key={size}
                          style={{
                            padding: "2px 4px",
                            verticalAlign: "top",
                          }}
                        >
                          <TextField
                            label="Qty"
                            labelHidden
                            type="number"
                            value={String(cell.ordered)}
                            onChange={(val) =>
                              onCellQtyChange(
                                cell.lineItemId,
                                parseInt(val, 10) || 0,
                              )
                            }
                            min={0}
                            autoComplete="off"
                          />
                          {cell.received > 0 && (
                            <div
                              style={{
                                fontSize: "11px",
                                color: "#6b7280",
                                textAlign: "center",
                                marginTop: "2px",
                              }}
                            >
                              {cell.received} received
                            </div>
                          )}
                        </td>
                      );
                    }

                    return (
                      <td
                        key={size}
                        style={{
                          padding: "8px",
                          textAlign: "center",
                          verticalAlign: "top",
                          background: isComplete
                            ? "#f1f8f4"
                            : isPartial
                              ? "#fff8e6"
                              : undefined,
                        }}
                      >
                        <div style={{ fontWeight: 500 }}>{cell.ordered}</div>
                        {cell.received > 0 && (
                          <div
                            style={{ fontSize: "11px", color: "#6b7280" }}
                          >
                            {cell.received} received
                          </div>
                        )}
                      </td>
                    );
                  })
                )}
                <td
                  style={{
                    padding: "8px",
                    textAlign: "right",
                    fontWeight: 600,
                    verticalAlign: "top",
                  }}
                >
                  ${rowCostTotal.toFixed(2)}
                  <div style={{ fontSize: "11px", color: "#6b7280" }}>
                    {rowTotal} unit{rowTotal !== 1 ? "s" : ""}
                  </div>
                </td>
                {editable && onRemoveLine && (
                  <td style={{ padding: "8px", verticalAlign: "top" }}>
                    <Button
                      icon={DeleteIcon}
                      variant="plain"
                      tone="critical"
                      accessibilityLabel="Remove row"
                      onClick={() => {
                        for (const lid of g.lineItemIds) onRemoveLine(lid);
                      }}
                    />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
