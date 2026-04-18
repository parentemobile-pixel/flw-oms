import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
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
  Banner,
  Icon,
  Spinner,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import {
  getDefaultLocation,
  getLocations,
  type Location,
} from "../services/shopify-api/locations.server";
import { getVariantsInventory } from "../services/shopify-api/inventory.server";
import { searchProducts } from "../services/shopify-api/products.server";
import { createTransfer } from "../services/transfers/transfer-service.server";
import { LocationPicker } from "../components/LocationPicker";
import { ProductGrid, type GridCell } from "../components/ProductGrid";

interface SearchHit {
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  selectedOptions: Array<{ name: string; value: string }>;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [locations, defaultLocation] = await Promise.all([
    getLocations(admin, session.shop).catch(() => [] as Location[]),
    getDefaultLocation(admin, session.shop).catch(() => null),
  ]);
  return json({
    locations,
    defaultLocationId: defaultLocation?.id ?? null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "search") {
    const query = String(formData.get("query") ?? "").trim();
    if (!query) return json({ hits: [] as SearchHit[] });
    try {
      const result = await searchProducts(admin, query);
      const hits: SearchHit[] = [];
      for (const edge of result.edges as Array<{ node: any }>) {
        const p = edge.node;
        for (const v of p.variants.edges as Array<{ node: any }>) {
          hits.push({
            variantId: v.node.id,
            productId: p.id,
            productTitle: p.title,
            variantTitle: v.node.title,
            sku: v.node.sku ?? null,
            selectedOptions: v.node.selectedOptions ?? [],
          });
        }
      }
      return json({ hits });
    } catch (error) {
      return json({ hits: [] as SearchHit[], error: String(error) });
    }
  }

  if (intent === "loadStock") {
    const variantIds = JSON.parse(
      String(formData.get("variantIds") ?? "[]"),
    ) as string[];
    const locationId = String(formData.get("locationId") ?? "");
    if (variantIds.length === 0 || !locationId) return json({ stock: {} });
    const map = await getVariantsInventory(admin, variantIds);
    const stock: Record<string, number> = {};
    for (const [vid, inv] of map.entries()) {
      const level = inv.levels.find((l) => l.locationId === locationId);
      stock[vid] = level?.quantities.available ?? 0;
    }
    return json({ stock });
  }

  if (intent === "create") {
    const fromLocationId = String(formData.get("fromLocationId") ?? "");
    const toLocationId = String(formData.get("toLocationId") ?? "");
    const notes = String(formData.get("notes") ?? "") || null;
    const lineItems = JSON.parse(
      String(formData.get("lineItems") ?? "[]"),
    ) as Array<{
      shopifyProductId: string;
      shopifyVariantId: string;
      productTitle: string;
      variantTitle: string;
      sku: string | null;
      quantitySent: number;
    }>;

    try {
      const t = await createTransfer(session.shop, {
        fromLocationId,
        toLocationId,
        notes,
        lineItems,
      });
      throw redirect(`/app/transfers/${t.id}`);
    } catch (error) {
      if (error instanceof Response) throw error;
      return json({ error: String(error) });
    }
  }

  return json({});
};

interface TransferRow extends SearchHit {
  fromStock: number;
  quantitySent: number;
}

export default function NewTransfer() {
  const { locations, defaultLocationId } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isBusy = navigation.state === "submitting";

  const [fromLocationId, setFromLocationId] = useState<string | null>(
    defaultLocationId,
  );
  const [toLocationId, setToLocationId] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [rows, setRows] = useState<TransferRow[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    setIsSearching(true);
    const t = setTimeout(() => {
      const fd = new FormData();
      fd.set("intent", "search");
      fd.set("query", query);
      submit(fd, { method: "post" });
    }, 300);
    return () => clearTimeout(t);
  }, [query, submit]);

  useEffect(() => {
    if (!actionData) return;
    if ("hits" in actionData) {
      setHits(actionData.hits);
      setIsSearching(false);
    }
    if ("stock" in actionData) {
      const stock = actionData.stock as Record<string, number>;
      setRows((prev) =>
        prev.map((r) => ({
          ...r,
          fromStock: stock[r.variantId] ?? r.fromStock,
        })),
      );
    }
  }, [actionData]);

  const handleAdd = useCallback(
    (hit: SearchHit) => {
      if (rows.some((r) => r.variantId === hit.variantId)) return;
      setRows((prev) => [
        ...prev,
        { ...hit, fromStock: 0, quantitySent: 0 },
      ]);
      if (fromLocationId) {
        const fd = new FormData();
        fd.set("intent", "loadStock");
        fd.set("locationId", fromLocationId);
        fd.set("variantIds", JSON.stringify([hit.variantId]));
        submit(fd, { method: "post" });
      }
    },
    [rows, fromLocationId, submit],
  );

  // Reload stock when from-location changes
  useEffect(() => {
    if (!fromLocationId || rows.length === 0) return;
    const fd = new FormData();
    fd.set("intent", "loadStock");
    fd.set("locationId", fromLocationId);
    fd.set("variantIds", JSON.stringify(rows.map((r) => r.variantId)));
    submit(fd, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromLocationId]);

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

  const canCreate =
    fromLocationId &&
    toLocationId &&
    fromLocationId !== toLocationId &&
    rows.some((r) => r.quantitySent > 0);

  const handleCreate = useCallback(() => {
    if (!canCreate || !fromLocationId || !toLocationId) return;
    const fd = new FormData();
    fd.set("intent", "create");
    fd.set("fromLocationId", fromLocationId);
    fd.set("toLocationId", toLocationId);
    fd.set("notes", notes);
    fd.set(
      "lineItems",
      JSON.stringify(
        rows
          .filter((r) => r.quantitySent > 0)
          .map((r) => ({
            shopifyProductId: r.productId,
            shopifyVariantId: r.variantId,
            productTitle: r.productTitle,
            variantTitle: r.variantTitle,
            sku: r.sku,
            quantitySent: r.quantitySent,
          })),
      ),
    );
    submit(fd, { method: "post" });
  }, [canCreate, fromLocationId, toLocationId, notes, rows, submit]);

  const totalUnits = rows.reduce((s, r) => s + r.quantitySent, 0);

  return (
    <Page
      title="New Transfer"
      backAction={{ url: "/app/transfers" }}
    >
      <Layout>
        {actionData && "error" in actionData && (
          <Layout.Section>
            <Banner tone="critical">{actionData.error as string}</Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Locations
              </Text>
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
                    locations={locations.filter(
                      (l) => l.id !== fromLocationId,
                    )}
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
              <Text as="h2" variant="headingMd">
                Add products
              </Text>
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
                  setHits([]);
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
              {hits.length > 0 && (
                <BlockStack gap="100">
                  {hits.map((h) => {
                    const added = rows.some(
                      (r) => r.variantId === h.variantId,
                    );
                    return (
                      <InlineStack
                        key={h.variantId}
                        align="space-between"
                        blockAlign="center"
                      >
                        <Text as="p" variant="bodyMd">
                          {h.productTitle} —{" "}
                          <Text as="span" tone="subdued">
                            {h.variantTitle}
                          </Text>
                          {h.sku && (
                            <Text as="span" variant="bodySm" tone="subdued">
                              {" "}
                              ({h.sku})
                            </Text>
                          )}
                        </Text>
                        <Button
                          size="slim"
                          disabled={added}
                          onClick={() => handleAdd(h)}
                        >
                          {added ? "Added" : "Add"}
                        </Button>
                      </InlineStack>
                    );
                  })}
                </BlockStack>
              )}
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
                />
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <InlineStack align="end" gap="200">
            <Button url="/app/transfers">Cancel</Button>
            <Button
              variant="primary"
              onClick={handleCreate}
              loading={isBusy}
              disabled={!canCreate}
            >
              Create draft transfer
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
