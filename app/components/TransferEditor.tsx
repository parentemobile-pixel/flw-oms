import { useCallback, useEffect, useMemo, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Icon,
  Spinner,
  Collapsible,
  Badge,
} from "@shopify/polaris";
import {
  SearchIcon,
  ChevronUpIcon,
  ChevronDownIcon,
} from "@shopify/polaris-icons";

import type { Location } from "../services/shopify-api/locations.server";
import type { TransferSearchProduct } from "../services/transfers/transfer-editor.server";
import { LocationPicker } from "./LocationPicker";
import { ProductGrid, type GridCell } from "./ProductGrid";
import {
  ProductPicker,
  type PickerProduct,
  type PickerVariant,
} from "./ProductPicker";

/**
 * One editable transfer line. `fromStock` is the live available qty at
 * the current From location (refreshed whenever From changes).
 */
export interface TransferRow {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  selectedOptions: Array<{ name: string; value: string }>;
  fromStock: number;
  quantitySent: number;
}

export interface TransferEditorInitial {
  name?: string;
  notes?: string;
  fromLocationId?: string | null;
  toLocationId?: string | null;
  rows?: TransferRow[];
}

export interface TransferEditorPayload {
  fromLocationId: string;
  toLocationId: string;
  name: string;
  notes: string;
  lineItems: Array<{
    shopifyProductId: string;
    shopifyVariantId: string;
    productTitle: string;
    variantTitle: string;
    sku: string | null;
    quantitySent: number;
  }>;
}

interface TransferEditorProps {
  locations: Location[];
  initial: TransferEditorInitial;
  /** Called with the assembled payload when the user hits Save. */
  onSave: (payload: TransferEditorPayload) => void;
  saveLabel: string;
  isBusy: boolean;
  /** Either a URL (Transfer create → back to list) or a callback
   *  (Transfer detail → leave edit mode). */
  cancelUrl?: string;
  onCancel?: () => void;
}

/**
 * Shared create / edit form for an inventory transfer: details card
 * (name, From, To, notes), collapsible product search + picker, and
 * the size-grid of quantities to send.
 *
 * The component owns all form state. It talks to the HOST ROUTE's
 * action for product search (`intent=search`) and From-location stock
 * (`intent=loadStock`) through fetchers, so the host route must
 * delegate those intents to `handleTransferEditorIntent` in
 * app/services/transfers/transfer-editor.server.ts. Saving is left to
 * the host via `onSave` — create posts `intent=create`, detail posts
 * `intent=update`.
 */
export function TransferEditor({
  locations,
  initial,
  onSave,
  saveLabel,
  isBusy,
  cancelUrl,
  onCancel,
}: TransferEditorProps) {
  const [fromLocationId, setFromLocationId] = useState<string | null>(
    initial.fromLocationId ?? null,
  );
  const [toLocationId, setToLocationId] = useState<string | null>(
    initial.toLocationId ?? null,
  );
  const [name, setName] = useState(initial.name ?? "");
  const [notes, setNotes] = useState(initial.notes ?? "");
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<TransferSearchProduct[]>([]);
  const [rows, setRows] = useState<TransferRow[]>(initial.rows ?? []);
  const [pickerCollapsed, setPickerCollapsed] = useState(
    (initial.rows?.length ?? 0) > 0,
  );

  const searchFetcher = useFetcher<{ products?: TransferSearchProduct[] }>();
  const stockFetcher = useFetcher<{ stock?: Record<string, number> }>();
  const isSearching =
    searchFetcher.state !== "idle" && query.trim() !== "";

  // Keep "To" valid relative to "From". If the user picks a From that
  // equals the current To, reset To to the first remaining location so
  // the Save button doesn't silently stay disabled.
  useEffect(() => {
    if (!fromLocationId) return;
    const available = locations.filter((l) => l.id !== fromLocationId);
    const toIsValid =
      toLocationId != null &&
      toLocationId !== fromLocationId &&
      available.some((l) => l.id === toLocationId);
    if (!toIsValid) {
      setToLocationId(available[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromLocationId, locations]);

  // Debounced product search.
  useEffect(() => {
    if (!query.trim()) {
      setProducts([]);
      return;
    }
    const t = setTimeout(() => {
      const fd = new FormData();
      fd.set("intent", "search");
      fd.set("query", query);
      searchFetcher.submit(fd, { method: "post" });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    if (searchFetcher.data?.products) {
      setProducts(searchFetcher.data.products);
    }
  }, [searchFetcher.data]);

  useEffect(() => {
    const stock = stockFetcher.data?.stock;
    if (!stock) return;
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        fromStock: stock[r.variantId] ?? r.fromStock,
      })),
    );
  }, [stockFetcher.data]);

  const selectedVariantIds = useMemo(
    () => new Set(rows.map((r) => r.variantId)),
    [rows],
  );

  // Pull From-location stock for a set of variant ids.
  const loadStockFor = useCallback(
    (variantIds: string[]) => {
      if (!fromLocationId || variantIds.length === 0) return;
      const fd = new FormData();
      fd.set("intent", "loadStock");
      fd.set("locationId", fromLocationId);
      fd.set("variantIds", JSON.stringify(variantIds));
      stockFetcher.submit(fd, { method: "post" });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fromLocationId],
  );

  // Reload stock for every row when From changes — also fires the
  // first time rows arrive (covers the prefilled / edit-existing case).
  useEffect(() => {
    if (!fromLocationId || rows.length === 0) return;
    loadStockFor(rows.map((r) => r.variantId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromLocationId, rows.length]);

  const handleToggleVariant = useCallback(
    (product: PickerProduct, variant: PickerVariant, checked: boolean) => {
      if (checked) {
        setRows((prev) =>
          prev.some((r) => r.variantId === variant.id)
            ? prev
            : [
                ...prev,
                {
                  variantId: variant.id,
                  productId: product.id,
                  productTitle: product.title,
                  variantTitle: variant.title,
                  sku: variant.sku,
                  selectedOptions: variant.selectedOptions,
                  fromStock: variant.inStock ?? 0,
                  quantitySent: 0,
                },
              ],
        );
        loadStockFor([variant.id]);
      } else {
        setRows((prev) => prev.filter((r) => r.variantId !== variant.id));
      }
    },
    [loadStockFor],
  );

  const handleToggleGroup = useCallback(
    (
      product: PickerProduct,
      groupVariants: PickerVariant[],
      checked: boolean,
    ) => {
      if (checked) {
        const toAdd = groupVariants.filter(
          (v) => !rows.some((r) => r.variantId === v.id),
        );
        if (toAdd.length === 0) return;
        setRows((prev) => [
          ...prev,
          ...toAdd.map((variant) => ({
            variantId: variant.id,
            productId: product.id,
            productTitle: product.title,
            variantTitle: variant.title,
            sku: variant.sku,
            selectedOptions: variant.selectedOptions,
            fromStock: variant.inStock ?? 0,
            quantitySent: 0,
          })),
        ]);
        loadStockFor(toAdd.map((v) => v.id));
      } else {
        const ids = new Set(groupVariants.map((v) => v.id));
        setRows((prev) => prev.filter((r) => !ids.has(r.variantId)));
      }
    },
    [rows, loadStockFor],
  );

  const cells: GridCell[] = useMemo(
    () =>
      rows.map((r) => ({
        variantId: r.variantId,
        productId: r.productId,
        productTitle: r.productTitle,
        variantTitle: r.variantTitle,
        selectedOptions: r.selectedOptions,
        sku: r.sku,
        stock: r.fromStock,
        value: r.quantitySent,
      })),
    [rows],
  );

  const handleCellChange = useCallback((variantId: string, next: number) => {
    setRows((prev) =>
      prev.map((r) =>
        r.variantId === variantId ? { ...r, quantitySent: next } : r,
      ),
    );
  }, []);

  const canSave =
    !!fromLocationId &&
    !!toLocationId &&
    fromLocationId !== toLocationId &&
    rows.some((r) => r.quantitySent > 0);

  const handleSave = useCallback(() => {
    if (!canSave || !fromLocationId || !toLocationId) return;
    onSave({
      fromLocationId,
      toLocationId,
      name,
      notes,
      lineItems: rows
        .filter((r) => r.quantitySent > 0)
        .map((r) => ({
          shopifyProductId: r.productId,
          shopifyVariantId: r.variantId,
          productTitle: r.productTitle,
          variantTitle: r.variantTitle,
          sku: r.sku,
          quantitySent: r.quantitySent,
        })),
    });
  }, [canSave, fromLocationId, toLocationId, name, notes, rows, onSave]);

  const totalUnits = rows.reduce((s, r) => s + r.quantitySent, 0);

  return (
    <>
      <Layout.Section>
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">
              Transfer details
            </Text>
            <TextField
              label="Transfer name"
              value={name}
              onChange={setName}
              autoComplete="off"
              placeholder="e.g. FW25 Marblehead initial stock"
              helpText="A short label to recognize this transfer at a glance — shown as the primary title in the list view."
            />
            <InlineStack gap="400" wrap>
              <div style={{ flex: 1, minWidth: "240px" }}>
                <LocationPicker
                  label="From"
                  locations={locations}
                  value={fromLocationId}
                  onChange={setFromLocationId}
                  persistKey="transfer-from"
                />
              </div>
              <div style={{ flex: 1, minWidth: "240px" }}>
                <LocationPicker
                  label="To"
                  locations={locations.filter((l) => l.id !== fromLocationId)}
                  value={toLocationId}
                  onChange={setToLocationId}
                  persistKey="transfer-to"
                />
              </div>
            </InlineStack>
            <TextField
              label="Notes"
              value={notes}
              onChange={setNotes}
              autoComplete="off"
              multiline={2}
            />
          </BlockStack>
        </Card>
      </Layout.Section>

      <Layout.Section>
        <Card>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <InlineStack gap="200" blockAlign="center">
                <button
                  type="button"
                  onClick={() => setPickerCollapsed((v) => !v)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <Text as="h2" variant="headingMd">
                    Add products
                  </Text>
                </button>
                {rows.length > 0 && (
                  <Badge tone="info">{`${rows.length} selected`}</Badge>
                )}
                {isSearching && <Spinner size="small" />}
              </InlineStack>
              <Button
                icon={pickerCollapsed ? ChevronDownIcon : ChevronUpIcon}
                onClick={() => setPickerCollapsed((v) => !v)}
              >
                {pickerCollapsed ? "Expand section" : "Collapse section"}
              </Button>
            </InlineStack>

            <Collapsible
              id="transfer-product-picker"
              open={!pickerCollapsed}
              transition={{
                duration: "150ms",
                timingFunction: "ease-in-out",
              }}
              expandOnPrint
            >
              <BlockStack gap="400">
                <TextField
                  label="Search"
                  labelHidden
                  value={query}
                  onChange={setQuery}
                  placeholder="Search by product, SKU, or vendor…"
                  autoComplete="off"
                  prefix={<Icon source={SearchIcon} />}
                  clearButton
                  onClearButtonClick={() => {
                    setQuery("");
                    setProducts([]);
                  }}
                />
                {!isSearching &&
                  query.trim() !== "" &&
                  products.length === 0 && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      No products match “{query}”.
                    </Text>
                  )}
                <ProductPicker
                  products={products as PickerProduct[]}
                  selectedVariantIds={selectedVariantIds}
                  onToggleVariant={handleToggleVariant}
                  onToggleGroup={handleToggleGroup}
                />
              </BlockStack>
            </Collapsible>
          </BlockStack>
        </Card>
      </Layout.Section>

      {rows.length > 0 && (
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Enter quantities to send
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  {totalUnits} unit{totalUnits !== 1 ? "s" : ""} across{" "}
                  {rows.length} line{rows.length !== 1 ? "s" : ""}
                </Text>
              </InlineStack>
              <ProductGrid
                cells={cells}
                qtyLabel="Send"
                onCellChange={handleCellChange}
                showColumns={{
                  stock: true,
                  cost: false,
                  retail: false,
                  onOrder: false,
                }}
                onRemoveRow={(variantIds) => {
                  const drop = new Set(variantIds);
                  setRows((prev) => prev.filter((r) => !drop.has(r.variantId)));
                }}
              />
            </BlockStack>
          </Card>
        </Layout.Section>
      )}

      <Layout.Section>
        <InlineStack align="end" gap="200">
          {cancelUrl ? (
            <Button url={cancelUrl}>Cancel</Button>
          ) : (
            <Button onClick={onCancel}>Cancel</Button>
          )}
          <Button
            variant="primary"
            onClick={handleSave}
            loading={isBusy}
            disabled={!canSave}
          >
            {saveLabel}
          </Button>
        </InlineStack>
      </Layout.Section>
    </>
  );
}
