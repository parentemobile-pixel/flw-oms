import { useState, useCallback, useEffect, useMemo } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useActionData,
  useSubmit,
  useNavigation,
  useFetcher,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  TextField,
  Button,
  Banner,
  BlockStack,
  Text,
  InlineStack,
  Autocomplete,
  Icon,
  Checkbox,
  ButtonGroup,
  Badge,
  Divider,
  Spinner,
  Select,
  Collapsible,
} from "@shopify/polaris";
import {
  SearchIcon,
  DeleteIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import {
  getVendors,
  searchProductsByVendor,
} from "../services/shopify-api/products.server";
import {
  createPurchaseOrder,
  getOnOrderQuantities,
} from "../services/purchase-orders/po-service.server";
import {
  getDefaultLocation,
  getLocations,
  type Location,
} from "../services/shopify-api/locations.server";
import { LocationPicker } from "../components/LocationPicker";

// Types for product/variant data from Shopify
interface ShopifyVariant {
  id: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  inventoryQuantity: number;
  inventoryItem: {
    id: string;
    unitCost: { amount: string; currencyCode: string } | null;
  };
  selectedOptions: Array<{ name: string; value: string }>;
}

interface ShopifyProduct {
  id: string;
  title: string;
  vendor: string;
  featuredImage: { url: string; altText: string | null } | null;
  variants: { edges: Array<{ node: ShopifyVariant }> };
}

interface SelectedVariant {
  shopifyProductId: string;
  shopifyVariantId: string;
  productTitle: string;
  variantTitle: string;
  sku: string;
  barcode: string;
  unitCost: number;
  retailPrice: number;
  quantityOrdered: number;
  currentStock: number;
  onOrder: number;
  // For grid view grouping
  selectedOptions: Array<{ name: string; value: string }>;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const [vendors, onOrderMap, locations, defaultLocation] = await Promise.all([
    getVendors(admin, session.shop).catch(() => [] as string[]),
    getOnOrderQuantities(session.shop).catch(() => ({})),
    getLocations(admin, session.shop).catch(() => [] as Location[]),
    getDefaultLocation(admin, session.shop).catch(() => null),
  ]);

  return json({
    vendors,
    onOrderMap,
    locations,
    defaultLocationId: defaultLocation?.id ?? null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "search") {
    const vendor = formData.get("vendor") as string;
    const query = formData.get("query") as string;
    if (!vendor) return json({ products: [] });
    try {
      const result = await searchProductsByVendor(admin, vendor, query || undefined);
      return json({
        products: result.edges.map((edge: { node: ShopifyProduct }) => edge.node),
      });
    } catch (e) {
      console.error("Product search failed:", e);
      return json({ products: [] });
    }
  }

  if (intent === "create") {
    const vendor = formData.get("vendor") as string;
    const notes = formData.get("notes") as string;
    const shippingDateStr = formData.get("shippingDate") as string;
    const expectedDateStr = formData.get("expectedDate") as string;
    const shopifyLocationId = (formData.get("shopifyLocationId") as string) || null;
    const poNumberExt = (formData.get("poNumberExt") as string) || null;
    const lineItemsJson = formData.get("lineItems") as string;
    const lineItems = JSON.parse(lineItemsJson) as SelectedVariant[];

    if (lineItems.length === 0) {
      return json({ error: "Please add at least one item to the purchase order." });
    }
    if (lineItems.filter((li) => li.quantityOrdered > 0).length === 0) {
      return json({ error: "All line items have zero quantity. Set qty > 0 on at least one." });
    }

    try {
      const po = await createPurchaseOrder(session.shop, {
        vendor: vendor || undefined,
        notes: notes || undefined,
        shippingDate: shippingDateStr ? new Date(shippingDateStr) : null,
        expectedDate: expectedDateStr ? new Date(expectedDateStr) : null,
        shopifyLocationId,
        poNumberExt,
        lineItems: lineItems
          .filter((li) => li.quantityOrdered > 0)
          .map((li) => ({
            shopifyProductId: li.shopifyProductId,
            shopifyVariantId: li.shopifyVariantId,
            productTitle: li.productTitle,
            variantTitle: li.variantTitle,
            sku: li.sku || null,
            barcode: li.barcode || null,
            unitCost: li.unitCost,
            retailPrice: li.retailPrice,
            quantityOrdered: li.quantityOrdered,
          })),
      });

      return redirect(`/app/purchase-orders/${po.id}`);
    } catch (error) {
      return json({ error: `Failed to create PO: ${error}` });
    }
  }

  return json({});
};

export default function NewPurchaseOrder() {
  const { vendors, onOrderMap, locations, defaultLocationId } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const fetcher = useFetcher();

  const [vendor, setVendor] = useState("");
  const [vendorInput, setVendorInput] = useState("");
  const [notes, setNotes] = useState("");
  const [shippingDate, setShippingDate] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [poNumberExt, setPoNumberExt] = useState("");
  const [shopifyLocationId, setShopifyLocationId] = useState<string | null>(
    defaultLocationId,
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ShopifyProduct[]>([]);
  const [selectedItems, setSelectedItems] = useState<SelectedVariant[]>([]);
  const [viewMode, setViewMode] = useState<"line" | "grid">("grid");
  const [isSearching, setIsSearching] = useState(false);
  const [productsCollapsed, setProductsCollapsed] = useState(false);

  // Vendor autocomplete options
  const vendorOptions = vendors
    .filter((v: string) => !vendorInput || v.toLowerCase().includes(vendorInput.toLowerCase()))
    .map((v: string) => ({ value: v, label: v }));

  const handleVendorSelect = useCallback((selected: string[]) => {
    const val = selected[0] || "";
    setVendor(val);
    setVendorInput(val);
    // Clear products when vendor changes
    setSearchResults([]);
    setSelectedItems([]);
  }, []);

  // Auto-load products when vendor is selected
  useEffect(() => {
    if (!vendor) return;
    setIsSearching(true);
    const formData = new FormData();
    formData.set("intent", "search");
    formData.set("vendor", vendor);
    formData.set("query", "");
    submit(formData, { method: "post" });
  }, [vendor]);

  // Update search results from action data
  useEffect(() => {
    if (actionData && "products" in actionData) {
      setSearchResults(actionData.products as ShopifyProduct[]);
      setIsSearching(false);
    }
  }, [actionData]);

  // Typeahead search with debounce
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);

  const handleSearchChange = useCallback(
    (val: string) => {
      setSearchQuery(val);
      if (!vendor) return;

      if (searchTimeout) clearTimeout(searchTimeout);
      const timeout = setTimeout(() => {
        setIsSearching(true);
        const formData = new FormData();
        formData.set("intent", "search");
        formData.set("vendor", vendor);
        formData.set("query", val);
        submit(formData, { method: "post" });
      }, 400);
      setSearchTimeout(timeout);
    },
    [vendor, submit, searchTimeout],
  );

  // Toggle variant selection
  const handleToggleVariant = useCallback(
    (product: ShopifyProduct, variant: ShopifyVariant, checked: boolean) => {
      if (checked) {
        const costAmount = variant.inventoryItem?.unitCost?.amount;
        const cost = costAmount ? parseFloat(costAmount) : 0;
        const onOrder = (onOrderMap as Record<string, number>)[variant.id] || 0;

        setSelectedItems((prev) => [
          ...prev,
          {
            shopifyProductId: product.id,
            shopifyVariantId: variant.id,
            productTitle: product.title,
            variantTitle: variant.title,
            sku: variant.sku || "",
            barcode: variant.barcode || "",
            unitCost: cost,
            retailPrice: parseFloat(variant.price) || 0,
            quantityOrdered: 1,
            currentStock: variant.inventoryQuantity || 0,
            onOrder,
            selectedOptions: variant.selectedOptions || [],
          },
        ]);
      } else {
        setSelectedItems((prev) =>
          prev.filter((item) => item.shopifyVariantId !== variant.id),
        );
      }
    },
    [onOrderMap],
  );

  // Helper: build a SelectedVariant row from a Shopify variant + product
  const toSelectedVariant = useCallback(
    (product: ShopifyProduct, variant: ShopifyVariant): SelectedVariant => {
      const costAmount = variant.inventoryItem?.unitCost?.amount;
      const cost = costAmount ? parseFloat(costAmount) : 0;
      const onOrder =
        (onOrderMap as Record<string, number>)[variant.id] || 0;
      return {
        shopifyProductId: product.id,
        shopifyVariantId: variant.id,
        productTitle: product.title,
        variantTitle: variant.title,
        sku: variant.sku || "",
        barcode: variant.barcode || "",
        unitCost: cost,
        retailPrice: parseFloat(variant.price) || 0,
        quantityOrdered: 1,
        currentStock: variant.inventoryQuantity || 0,
        onOrder,
        selectedOptions: variant.selectedOptions || [],
      };
    },
    [onOrderMap],
  );

  // Select all variants for a product
  const handleSelectAllVariants = useCallback(
    (product: ShopifyProduct, checked: boolean) => {
      if (checked) {
        setSelectedItems((prev) => {
          const existing = new Set(prev.map((p) => p.shopifyVariantId));
          const additions: SelectedVariant[] = [];
          for (const { node: variant } of product.variants.edges) {
            if (!existing.has(variant.id)) {
              additions.push(toSelectedVariant(product, variant));
            }
          }
          return [...prev, ...additions];
        });
      } else {
        const variantIds = new Set(
          product.variants.edges.map(({ node }) => node.id),
        );
        setSelectedItems((prev) =>
          prev.filter((item) => !variantIds.has(item.shopifyVariantId)),
        );
      }
    },
    [toSelectedVariant],
  );

  // Select/deselect every variant in a "color group" (all variants sharing
  // the same non-size option value(s)).
  const handleToggleColorGroup = useCallback(
    (
      product: ShopifyProduct,
      groupVariants: ShopifyVariant[],
      checked: boolean,
    ) => {
      if (checked) {
        setSelectedItems((prev) => {
          const existing = new Set(prev.map((p) => p.shopifyVariantId));
          const additions: SelectedVariant[] = [];
          for (const variant of groupVariants) {
            if (!existing.has(variant.id)) {
              additions.push(toSelectedVariant(product, variant));
            }
          }
          return [...prev, ...additions];
        });
      } else {
        const ids = new Set(groupVariants.map((v) => v.id));
        setSelectedItems((prev) =>
          prev.filter((item) => !ids.has(item.shopifyVariantId)),
        );
      }
    },
    [toSelectedVariant],
  );

  const handleQuantityChange = useCallback((variantId: string, qty: string) => {
    setSelectedItems((prev) =>
      prev.map((item) =>
        item.shopifyVariantId === variantId
          ? { ...item, quantityOrdered: parseInt(qty) || 0 }
          : item,
      ),
    );
  }, []);

  const handleCostChange = useCallback((variantId: string, cost: string) => {
    setSelectedItems((prev) =>
      prev.map((item) =>
        item.shopifyVariantId === variantId
          ? { ...item, unitCost: parseFloat(cost) || 0 }
          : item,
      ),
    );
  }, []);

  // Update cost for many variants at once — used by the grid view where one
  // "row" represents a colorway and cost is typically shared across sizes.
  const handleRowCostChange = useCallback(
    (variantIds: string[], cost: string) => {
      const nextCost = parseFloat(cost) || 0;
      const ids = new Set(variantIds);
      setSelectedItems((prev) =>
        prev.map((item) =>
          ids.has(item.shopifyVariantId)
            ? { ...item, unitCost: nextCost }
            : item,
        ),
      );
    },
    [],
  );

  const handleRemoveItem = useCallback((variantId: string) => {
    setSelectedItems((prev) => prev.filter((item) => item.shopifyVariantId !== variantId));
  }, []);

  const handleCreate = useCallback(() => {
    const formData = new FormData();
    formData.set("intent", "create");
    formData.set("vendor", vendor);
    formData.set("notes", notes);
    formData.set("shippingDate", shippingDate);
    formData.set("expectedDate", expectedDate);
    formData.set("poNumberExt", poNumberExt);
    if (shopifyLocationId) formData.set("shopifyLocationId", shopifyLocationId);
    formData.set("lineItems", JSON.stringify(selectedItems));
    submit(formData, { method: "post" });
  }, [
    vendor,
    notes,
    shippingDate,
    expectedDate,
    poNumberExt,
    shopifyLocationId,
    selectedItems,
    submit,
  ]);

  const totalCost = selectedItems.reduce(
    (sum, item) => sum + item.unitCost * item.quantityOrdered,
    0,
  );
  const totalRetail = selectedItems.reduce(
    (sum, item) => sum + item.retailPrice * item.quantityOrdered,
    0,
  );
  const totalUnits = selectedItems.reduce(
    (sum, item) => sum + item.quantityOrdered,
    0,
  );

  // Grid view: group by (product + non-size options) with sizes as columns.
  // Rows without any detected Size option are marked noSize — they render as
  // a single-cell row that spans the size columns so single-variant products
  // (or products whose axes are something like Material only) don't pollute
  // the sized-product layout.
  const gridData = useMemo(() => {
    if (selectedItems.length === 0) return null;

    const isSizeOption = (name: string) => {
      const n = name.trim().toLowerCase();
      // Shopify's "Title"/"Default Title" placeholder for single-variant
      // products is NOT a size.
      return n !== "title" && n.includes("size");
    };

    const sizeValues = new Set<string>();
    const productGroups: Record<
      string,
      {
        productTitle: string;
        rows: Record<
          string,
          {
            label: string;
            cost: number;
            retail: number;
            onOrder: number;
            noSize: boolean;
            // For sized rows, keys are size values (S/M/L/…).
            // For noSize rows, the one variant lives under "_single".
            bySize: Record<string, SelectedVariant>;
          }
        >;
      }
    > = {};

    for (const item of selectedItems) {
      const opts = item.selectedOptions ?? [];
      const sizeOpt = opts.find((o) => isSizeOption(o.name));
      const nonSizeOpts = opts
        .filter((o) => !isSizeOption(o.name))
        // Hide Shopify's default "Title / Default Title" placeholder so a
        // single-variant product doesn't get a "Default Title" label.
        .filter(
          (o) =>
            !(
              o.name.toLowerCase() === "title" &&
              /^default title$/i.test(o.value)
            ),
        )
        .map((o) => o.value)
        .join(" / ");

      const rowKey = `${item.shopifyProductId}::${nonSizeOpts}`;
      const noSize = !sizeOpt;

      if (!productGroups[item.shopifyProductId]) {
        productGroups[item.shopifyProductId] = {
          productTitle: item.productTitle,
          rows: {},
        };
      }
      const group = productGroups[item.shopifyProductId];
      if (!group.rows[rowKey]) {
        group.rows[rowKey] = {
          label: nonSizeOpts,
          cost: item.unitCost,
          retail: item.retailPrice,
          onOrder: 0,
          noSize,
          bySize: {},
        };
      }
      if (noSize) {
        group.rows[rowKey].bySize["_single"] = item;
      } else {
        const sizeVal = sizeOpt!.value;
        sizeValues.add(sizeVal);
        group.rows[rowKey].bySize[sizeVal] = item;
      }
      group.rows[rowKey].onOrder += item.onOrder;
    }

    const sizeOrder = [
      "XXS", "XS", "S", "M", "L", "XL", "2XL", "XXL", "3XL", "XXXL", "4XL", "OS", "ONE SIZE",
    ];
    const sortedSizes = [...sizeValues].sort((a, b) => {
      const ai = sizeOrder.indexOf(a.toUpperCase());
      const bi = sizeOrder.indexOf(b.toUpperCase());
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b);
    });

    return { productGroups, sortedSizes };
  }, [selectedItems]);

  return (
    <Page
      title="New Purchase Order"
      backAction={{ url: "/app/purchase-orders" }}
    >
      <Layout>
        {actionData && "error" in actionData && (
          <Layout.Section>
            <Banner tone="critical">{actionData.error as string}</Banner>
          </Layout.Section>
        )}

        {/* PO Details */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">PO Details</Text>
              <InlineStack gap="400" wrap={false}>
                <div style={{ flex: 1 }}>
                  <Autocomplete
                    options={vendorOptions}
                    selected={vendor ? [vendor] : []}
                    onSelect={handleVendorSelect}
                    textField={
                      <Autocomplete.TextField
                        label="Vendor"
                        value={vendorInput}
                        onChange={(val: string) => {
                          setVendorInput(val);
                          if (!val) {
                            setVendor("");
                            setSearchResults([]);
                          }
                        }}
                        placeholder="Select a vendor..."
                        autoComplete="off"
                        requiredIndicator
                        prefix={<Icon source={SearchIcon} />}
                      />
                    }
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Vendor's PO #"
                    value={poNumberExt}
                    onChange={setPoNumberExt}
                    autoComplete="off"
                    placeholder="(optional)"
                    helpText="If the vendor has their own PO number"
                  />
                </div>
              </InlineStack>
              <InlineStack gap="400" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Ship by"
                    type="date"
                    value={shippingDate}
                    onChange={setShippingDate}
                    autoComplete="off"
                    helpText="When the vendor should ship this order"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField
                    label="Expected delivery"
                    type="date"
                    value={expectedDate}
                    onChange={setExpectedDate}
                    autoComplete="off"
                    helpText="When we expect this to arrive"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <LocationPicker
                    label="Receive to location"
                    locations={locations}
                    value={shopifyLocationId}
                    onChange={setShopifyLocationId}
                    persistKey="po-create-destination"
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
        </Layout.Section>

        {/* Product Selection */}
        {vendor && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                {/* Header — click to collapse/expand */}
                <div
                  onClick={() => setProductsCollapsed((v) => !v)}
                  style={{
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="200" blockAlign="center">
                      <Button
                        icon={
                          productsCollapsed
                            ? ChevronDownIcon
                            : ChevronUpIcon
                        }
                        variant="plain"
                        accessibilityLabel={
                          productsCollapsed
                            ? "Expand product picker"
                            : "Collapse product picker"
                        }
                        onClick={() =>
                          setProductsCollapsed((v) => !v)
                        }
                      />
                      <Text as="h2" variant="headingMd">
                        Select Products from {vendor}
                      </Text>
                      {selectedItems.length > 0 && (
                        <Badge tone="info">
                          {`${selectedItems.length} selected`}
                        </Badge>
                      )}
                      {isSearching && <Spinner size="small" />}
                    </InlineStack>
                    {productsCollapsed && selectedItems.length > 0 && (
                      <Text as="span" variant="bodySm" tone="subdued">
                        Click to show products
                      </Text>
                    )}
                  </InlineStack>
                </div>

                <Collapsible
                  id="po-product-picker"
                  open={!productsCollapsed}
                  transition={{
                    duration: "150ms",
                    timingFunction: "ease-in-out",
                  }}
                  expandOnPrint
                >
                  <BlockStack gap="400">
                    <TextField
                      label="Filter products"
                      labelHidden
                      value={searchQuery}
                      onChange={handleSearchChange}
                      autoComplete="off"
                      placeholder="Type to filter products..."
                      prefix={<Icon source={SearchIcon} />}
                      clearButton
                      onClearButtonClick={() => {
                        setSearchQuery("");
                        handleSearchChange("");
                      }}
                    />

                    {searchResults.length === 0 && !isSearching && (
                      <Text as="p" tone="subdued">
                        {searchQuery
                          ? "No products found matching your search."
                          : "No products found for this vendor."}
                      </Text>
                    )}

                    {searchResults.map((product) => {
                      const allVariantIds = new Set(
                        product.variants.edges.map(({ node }) => node.id),
                      );
                      const selectedCount = selectedItems.filter((item) =>
                        allVariantIds.has(item.shopifyVariantId),
                      ).length;
                      const allSelected =
                        selectedCount === product.variants.edges.length;

                      return (
                        <Card key={product.id} padding="300">
                          <BlockStack gap="200">
                            <InlineStack
                              align="space-between"
                              blockAlign="center"
                            >
                              <InlineStack gap="200" blockAlign="center">
                                <Checkbox
                                  label=""
                                  labelHidden
                                  checked={allSelected}
                                  onChange={(checked) =>
                                    handleSelectAllVariants(
                                      product,
                                      checked,
                                    )
                                  }
                                />
                                <Text
                                  as="p"
                                  variant="bodyMd"
                                  fontWeight="bold"
                                >
                                  {product.title}
                                </Text>
                                {selectedCount > 0 && (
                                  <Badge tone="info">
                                    {`${selectedCount} selected`}
                                  </Badge>
                                )}
                              </InlineStack>
                              <Text
                                as="p"
                                variant="bodySm"
                                tone="subdued"
                              >
                                {product.variants.edges.length} variant
                                {product.variants.edges.length !== 1 ? "s" : ""}
                              </Text>
                            </InlineStack>

                            <ProductVariantPicker
                              product={product}
                              selectedItems={selectedItems}
                              onToggleVariant={handleToggleVariant}
                              onToggleColorGroup={handleToggleColorGroup}
                            />
                          </BlockStack>
                        </Card>
                      );
                    })}
                  </BlockStack>
                </Collapsible>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Selected Items / Order Table */}
        {selectedItems.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Order Items ({totalUnits} units, ${totalCost.toFixed(2)}{" "}
                    cost, ${totalRetail.toFixed(2)} retail)
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
                  <LineItemView
                    items={selectedItems}
                    onQuantityChange={handleQuantityChange}
                    onCostChange={handleCostChange}
                    onRemove={handleRemoveItem}
                  />
                ) : (
                  gridData && (
                    <GridView
                      gridData={gridData}
                      onQuantityChange={handleQuantityChange}
                      onRowCostChange={handleRowCostChange}
                    />
                  )
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Actions */}
        <Layout.Section>
          <InlineStack align="end" gap="200">
            <Button url="/app/purchase-orders">Cancel</Button>
            <Button
              variant="primary"
              onClick={handleCreate}
              loading={isSubmitting}
              disabled={selectedItems.length === 0 || !vendor}
            >
              Create Purchase Order
            </Button>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// ─── Product Variant Picker ──────────────────────────────────────────────────
// Groups variants by their non-size option values (typically Color) so a user
// can quickly select a whole colorway with one click. Falls back to a flat
// checkbox grid for products that have only one option axis (or no options).

const SIZE_OPTION_NAMES = new Set(["size", "sizes"]);
const SIZE_ORDER = [
  "XXS", "XS", "S", "M", "L", "XL", "2XL", "XXL", "3XL", "XXXL", "4XL", "OS", "ONE SIZE",
];

function compareSizes(a: string, b: string): number {
  const ai = SIZE_ORDER.indexOf(a.toUpperCase());
  const bi = SIZE_ORDER.indexOf(b.toUpperCase());
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return a.localeCompare(b);
}

function ProductVariantPicker({
  product,
  selectedItems,
  onToggleVariant,
  onToggleColorGroup,
}: {
  product: ShopifyProduct;
  selectedItems: SelectedVariant[];
  onToggleVariant: (
    product: ShopifyProduct,
    variant: ShopifyVariant,
    checked: boolean,
  ) => void;
  onToggleColorGroup: (
    product: ShopifyProduct,
    groupVariants: ShopifyVariant[],
    checked: boolean,
  ) => void;
}) {
  const variants = product.variants.edges.map((e) => e.node);

  // Detect the option axes present on these variants.
  const optionNames = new Set<string>();
  for (const v of variants) {
    for (const o of v.selectedOptions ?? []) optionNames.add(o.name);
  }
  const hasSize = [...optionNames].some((n) =>
    SIZE_OPTION_NAMES.has(n.toLowerCase()),
  );
  const hasNonSize = [...optionNames].some(
    (n) => !SIZE_OPTION_NAMES.has(n.toLowerCase()),
  );
  const shouldGroup = hasSize && hasNonSize;

  if (!shouldGroup) {
    // Flat grid — product has only size, or only color, or no options at all.
    return <FlatVariantGrid
      product={product}
      variants={variants}
      selectedItems={selectedItems}
      onToggleVariant={onToggleVariant}
    />;
  }

  // Build groups keyed by non-size option values joined with " / ".
  const groupMap = new Map<string, ShopifyVariant[]>();
  for (const v of variants) {
    const nonSize = (v.selectedOptions ?? [])
      .filter((o) => !SIZE_OPTION_NAMES.has(o.name.toLowerCase()))
      .map((o) => o.value);
    const key = nonSize.join(" / ") || "(default)";
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(v);
  }

  // Sort variants within each group by size.
  for (const group of groupMap.values()) {
    group.sort((a, b) => {
      const sa = a.selectedOptions.find((o) =>
        SIZE_OPTION_NAMES.has(o.name.toLowerCase()),
      )?.value ?? "";
      const sb = b.selectedOptions.find((o) =>
        SIZE_OPTION_NAMES.has(o.name.toLowerCase()),
      )?.value ?? "";
      return compareSizes(sa, sb);
    });
  }

  // Sort groups alphabetically by label for a stable order.
  const groups = [...groupMap.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  const selectedIds = new Set(selectedItems.map((s) => s.shopifyVariantId));

  return (
    <BlockStack gap="200">
      {groups.map(([label, groupVariants]) => {
        const totalInGroup = groupVariants.length;
        const selectedInGroup = groupVariants.filter((v) =>
          selectedIds.has(v.id),
        ).length;
        const allSelected = selectedInGroup === totalInGroup;

        return (
          <div
            key={label}
            style={{
              borderRadius: "8px",
              border: "1px solid #e1e3e5",
              padding: "10px 12px",
              background: selectedInGroup > 0 ? "#fafbff" : "transparent",
            }}
          >
            <BlockStack gap="200">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <Checkbox
                    label=""
                    labelHidden
                    checked={allSelected}
                    onChange={(checked) =>
                      onToggleColorGroup(product, groupVariants, checked)
                    }
                  />
                  <Text as="span" variant="bodyMd" fontWeight="semibold">
                    {label}
                  </Text>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {selectedInGroup} / {totalInGroup} selected
                  </Text>
                </InlineStack>
              </InlineStack>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fill, minmax(170px, 1fr))",
                  gap: "4px",
                  paddingLeft: "28px",
                }}
              >
                {groupVariants.map((variant) => {
                  const isSelected = selectedIds.has(variant.id);
                  const costAmount = variant.inventoryItem?.unitCost?.amount;
                  const cost = costAmount ? parseFloat(costAmount) : 0;
                  const sizeVal =
                    variant.selectedOptions.find((o) =>
                      SIZE_OPTION_NAMES.has(o.name.toLowerCase()),
                    )?.value ?? variant.title;

                  return (
                    <div
                      key={variant.id}
                      style={{
                        padding: "4px 8px",
                        borderRadius: "6px",
                        background: isSelected ? "#f0f7ff" : "transparent",
                      }}
                    >
                      <Checkbox
                        label={
                          <Text as="span" variant="bodySm">
                            {sizeVal}{" "}
                            <Text
                              as="span"
                              variant="bodySm"
                              tone="subdued"
                            >
                              ({variant.inventoryQuantity} in stock
                              {cost > 0 ? `, $${cost.toFixed(2)}` : ""})
                            </Text>
                          </Text>
                        }
                        checked={isSelected}
                        onChange={(checked) =>
                          onToggleVariant(product, variant, checked)
                        }
                      />
                    </div>
                  );
                })}
              </div>
            </BlockStack>
          </div>
        );
      })}
    </BlockStack>
  );
}

function FlatVariantGrid({
  product,
  variants,
  selectedItems,
  onToggleVariant,
}: {
  product: ShopifyProduct;
  variants: ShopifyVariant[];
  selectedItems: SelectedVariant[];
  onToggleVariant: (
    product: ShopifyProduct,
    variant: ShopifyVariant,
    checked: boolean,
  ) => void;
}) {
  const selectedIds = new Set(selectedItems.map((s) => s.shopifyVariantId));
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
        gap: "4px",
        paddingLeft: "28px",
      }}
    >
      {variants.map((variant) => {
        const isSelected = selectedIds.has(variant.id);
        const costAmount = variant.inventoryItem?.unitCost?.amount;
        const cost = costAmount ? parseFloat(costAmount) : 0;
        return (
          <div
            key={variant.id}
            style={{
              padding: "4px 8px",
              borderRadius: "6px",
              background: isSelected ? "#f0f7ff" : "transparent",
            }}
          >
            <Checkbox
              label={
                <Text as="span" variant="bodySm">
                  {variant.title}{" "}
                  <Text as="span" variant="bodySm" tone="subdued">
                    ({variant.inventoryQuantity} in stock
                    {cost > 0 ? `, $${cost.toFixed(2)}` : ""})
                  </Text>
                </Text>
              }
              checked={isSelected}
              onChange={(checked) =>
                onToggleVariant(product, variant, checked)
              }
            />
          </div>
        );
      })}
    </div>
  );
}

// ─── Line Item View ──────────────────────────────────────────────────────────

function LineItemView({
  items,
  onQuantityChange,
  onCostChange,
  onRemove,
}: {
  items: SelectedVariant[];
  onQuantityChange: (id: string, qty: string) => void;
  onCostChange: (id: string, cost: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
            <th style={{ padding: "8px", textAlign: "left" }}>Product</th>
            <th style={{ padding: "8px", textAlign: "left" }}>Variant</th>
            <th style={{ padding: "8px", textAlign: "left" }}>SKU</th>
            <th style={{ padding: "8px", textAlign: "right" }}>Cost</th>
            <th style={{ padding: "8px", textAlign: "right" }}>Retail</th>
            <th style={{ padding: "8px", textAlign: "right" }}>In Stock</th>
            <th style={{ padding: "8px", textAlign: "right" }}>On Order</th>
            <th style={{ padding: "8px", textAlign: "right", width: "90px" }}>Qty</th>
            <th style={{ padding: "8px", textAlign: "right" }}>Line Total</th>
            <th style={{ padding: "8px", width: "40px" }}></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.shopifyVariantId}
              style={{ borderBottom: "1px solid #f1f1f1" }}
            >
              <td style={{ padding: "8px" }}>{item.productTitle}</td>
              <td style={{ padding: "8px" }}>{item.variantTitle}</td>
              <td style={{ padding: "8px" }}>{item.sku || "—"}</td>
              <td
                style={{
                  padding: "2px 4px",
                  textAlign: "right",
                  minWidth: "90px",
                }}
              >
                <TextField
                  label="Cost"
                  labelHidden
                  type="number"
                  prefix="$"
                  value={String(item.unitCost)}
                  onChange={(val) =>
                    onCostChange(item.shopifyVariantId, val)
                  }
                  min={0}
                  step={0.01}
                  autoComplete="off"
                />
              </td>
              <td style={{ padding: "8px", textAlign: "right" }}>
                ${item.retailPrice.toFixed(2)}
              </td>
              <td style={{ padding: "8px", textAlign: "right" }}>
                {item.currentStock}
              </td>
              <td style={{ padding: "8px", textAlign: "right" }}>
                {item.onOrder > 0 ? item.onOrder : "—"}
              </td>
              <td style={{ padding: "4px 8px" }}>
                <TextField
                  label=""
                  labelHidden
                  value={String(item.quantityOrdered)}
                  onChange={(val) =>
                    onQuantityChange(item.shopifyVariantId, val)
                  }
                  type="number"
                  autoComplete="off"
                  min={0}
                />
              </td>
              <td style={{ padding: "8px", textAlign: "right", fontWeight: 600 }}>
                ${(item.unitCost * item.quantityOrdered).toFixed(2)}
              </td>
              <td style={{ padding: "8px" }}>
                <Button
                  icon={DeleteIcon}
                  variant="plain"
                  tone="critical"
                  onClick={() => onRemove(item.shopifyVariantId)}
                  accessibilityLabel="Remove"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Grid View ───────────────────────────────────────────────────────────────

function GridView({
  gridData,
  onQuantityChange,
  onRowCostChange,
}: {
  gridData: {
    productGroups: Record<
      string,
      {
        productTitle: string;
        rows: Record<
          string,
          {
            label: string;
            cost: number;
            retail: number;
            onOrder: number;
            noSize: boolean;
            bySize: Record<string, SelectedVariant>;
          }
        >;
      }
    >;
    sortedSizes: string[];
  };
  onQuantityChange: (id: string, qty: string) => void;
  onRowCostChange: (variantIds: string[], cost: string) => void;
}) {
  const { productGroups, sortedSizes } = gridData;
  const sizeColCount = Math.max(sortedSizes.length, 1);

  // Each cell shows a qty input + "stock: N" beneath. Keeps per-size inventory
  // visible at a glance without cluttering a separate aggregate column.
  const renderSizedCell = (
    item: SelectedVariant | undefined,
    size: string,
  ) => {
    if (!item) {
      return (
        <td
          key={size}
          style={{
            padding: "4px",
            textAlign: "center",
            background: "#f9f9f9",
            color: "#9ca3af",
          }}
        >
          —
        </td>
      );
    }
    return (
      <td
        key={size}
        style={{
          padding: "2px 4px",
          verticalAlign: "top",
        }}
      >
        <div>
          <TextField
            label="Qty"
            labelHidden
            value={String(item.quantityOrdered)}
            onChange={(val) => onQuantityChange(item.shopifyVariantId, val)}
            type="number"
            autoComplete="off"
            min={0}
          />
          <div
            style={{
              fontSize: "11px",
              color: "#6b7280",
              textAlign: "center",
              marginTop: "2px",
            }}
            title={`${item.currentStock} in stock${item.onOrder > 0 ? `, ${item.onOrder} on order` : ""}`}
          >
            stock {item.currentStock}
            {item.onOrder > 0 ? ` · +${item.onOrder}` : ""}
          </div>
        </div>
      </td>
    );
  };

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
            <th style={{ padding: "8px", textAlign: "right" }}>Cost</th>
            <th style={{ padding: "8px", textAlign: "right" }}>Retail</th>
            {sortedSizes.length > 0
              ? sortedSizes.map((size) => (
                  <th
                    key={size}
                    style={{
                      padding: "8px",
                      textAlign: "center",
                      minWidth: "80px",
                    }}
                  >
                    {size}
                  </th>
                ))
              : (
                  <th style={{ padding: "8px", textAlign: "center" }}>Qty</th>
                )}
            <th style={{ padding: "8px", textAlign: "right" }}>Row Total</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(productGroups).map(([productId, group]) =>
            Object.entries(group.rows).map(([rowKey, row]) => {
              const rowTotal = Object.values(row.bySize).reduce(
                (sum, item) => sum + item.unitCost * item.quantityOrdered,
                0,
              );

              return (
                <tr
                  key={rowKey}
                  style={{ borderBottom: "1px solid #f1f1f1" }}
                >
                  <td style={{ padding: "8px", fontWeight: 500, verticalAlign: "top" }}>
                    {group.productTitle}
                    {row.label && (
                      <Text as="span" variant="bodySm" tone="subdued">
                        {" "}
                        — {row.label}
                      </Text>
                    )}
                    {row.onOrder > 0 && (
                      <div style={{ fontSize: "11px", color: "#6b7280" }}>
                        {row.onOrder} on order
                      </div>
                    )}
                  </td>
                  <td
                    style={{
                      padding: "2px 4px",
                      textAlign: "right",
                      verticalAlign: "top",
                      minWidth: "90px",
                    }}
                  >
                    <TextField
                      label="Cost"
                      labelHidden
                      type="number"
                      prefix="$"
                      value={String(row.cost)}
                      onChange={(val) =>
                        onRowCostChange(
                          Object.values(row.bySize).map(
                            (v) => v.shopifyVariantId,
                          ),
                          val,
                        )
                      }
                      min={0}
                      step={0.01}
                      autoComplete="off"
                    />
                  </td>
                  <td style={{ padding: "8px", textAlign: "right", verticalAlign: "top" }}>
                    ${row.retail.toFixed(2)}
                  </td>

                  {row.noSize ? (
                    // Single-variant row — qty input spans all size columns
                    <td
                      colSpan={sizeColCount}
                      style={{ padding: "2px 4px", verticalAlign: "top" }}
                    >
                      {(() => {
                        const item = row.bySize["_single"];
                        if (!item) return <>—</>;
                        return (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "12px",
                            }}
                          >
                            <div style={{ maxWidth: "120px" }}>
                              <TextField
                                label="Qty"
                                labelHidden
                                value={String(item.quantityOrdered)}
                                onChange={(val) =>
                                  onQuantityChange(item.shopifyVariantId, val)
                                }
                                type="number"
                                autoComplete="off"
                                min={0}
                              />
                            </div>
                            <div
                              style={{ fontSize: "12px", color: "#6b7280" }}
                            >
                              {item.currentStock} in stock
                              {item.onOrder > 0
                                ? ` · ${item.onOrder} on order`
                                : ""}
                            </div>
                          </div>
                        );
                      })()}
                    </td>
                  ) : (
                    sortedSizes.map((size) =>
                      renderSizedCell(row.bySize[size], size),
                    )
                  )}

                  <td
                    style={{
                      padding: "8px",
                      textAlign: "right",
                      fontWeight: 600,
                      verticalAlign: "top",
                    }}
                  >
                    ${rowTotal.toFixed(2)}
                  </td>
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
    </div>
  );
}
