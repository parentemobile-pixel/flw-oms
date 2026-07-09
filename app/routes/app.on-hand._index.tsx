import { useCallback, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "@remix-run/node";
import { json } from "@remix-run/node";
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
  Tag,
  Listbox,
  Combobox,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import {
  getDefaultLocation,
  getLocations,
  type Location,
} from "../services/shopify-api/locations.server";
import { getProductTags } from "../services/shopify-api/products.server";
import {
  fetchOnHandAtLocation,
  type OnHandCell as OnHandCellData,
} from "../services/on-hand/on-hand.server";
import { LocationPicker } from "../components/LocationPicker";
import { ProductGrid, type GridCell } from "../components/ProductGrid";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [locations, defaultLocation, tags] = await Promise.all([
    getLocations(admin, session.shop).catch(() => [] as Location[]),
    getDefaultLocation(admin, session.shop).catch(() => null),
    getProductTags(admin, session.shop).catch(() => [] as string[]),
  ]);
  return json({
    locations,
    defaultLocationId: defaultLocation?.id ?? locations[0]?.id ?? null,
    tags,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const locationGid = String(formData.get("locationId") ?? "");
  const search = String(formData.get("search") ?? "");
  const tagsCsv = String(formData.get("tags") ?? "");
  if (!locationGid) return json({ error: "Pick a location first." });
  const tags = tagsCsv ? tagsCsv.split(",").filter(Boolean) : [];
  try {
    const result = await fetchOnHandAtLocation(admin, {
      locationGid,
      search,
      tags,
    });
    return json({ result, locationGid });
  } catch (error) {
    return json({
      error: `Query failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
};

interface ActionPayload {
  result?: {
    cells: OnHandCellData[];
    productCount: number;
    variantCount: number;
    totalUnits: number;
    truncated: boolean;
  };
  locationGid?: string;
  error?: string;
}

export default function OnHand() {
  const { locations, defaultLocationId, tags } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | ActionPayload
    | undefined;
  const submit = useSubmit();
  const navigation = useNavigation();
  const isBusy = navigation.state === "submitting";

  const [locationId, setLocationId] = useState<string | null>(defaultLocationId);
  const [search, setSearch] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagQuery, setTagQuery] = useState("");

  const handleQuery = useCallback(() => {
    if (!locationId) return;
    const fd = new FormData();
    fd.set("locationId", locationId);
    fd.set("search", search);
    fd.set("tags", selectedTags.join(","));
    submit(fd, { method: "post" });
  }, [locationId, search, selectedTags, submit]);

  const filteredTags = useMemo(() => {
    const q = tagQuery.trim().toLowerCase();
    return tags.filter((t) =>
      q === "" ? true : t.toLowerCase().includes(q),
    );
  }, [tags, tagQuery]);

  // Map the fetched cells into ProductGrid GridCells. value=onHand
  // and readonly=true keeps the grid a read-only view — the qty
  // input shows the on-hand number but can't be changed.
  const cells: GridCell[] = useMemo(() => {
    const rows = actionData?.result?.cells ?? [];
    return rows.map((c) => ({
      variantId: c.variantId,
      productId: c.productId,
      productTitle: c.productTitle,
      variantTitle: c.variantTitle,
      selectedOptions: c.selectedOptions,
      sku: c.sku,
      stock: c.onHand,
      value: c.onHand,
    }));
  }, [actionData]);

  const summary = actionData?.result;
  const summaryLine = summary
    ? `${summary.productCount} products · ${summary.variantCount} variants · ${summary.totalUnits.toLocaleString()} units`
    : null;

  return (
    <Page
      title="On Hand"
      subtitle="Grid view of what's in stock at a single location."
    >
      <Layout>
        {actionData?.error && (
          <Layout.Section>
            <Banner tone="critical">{actionData.error}</Banner>
          </Layout.Section>
        )}
        {summary?.truncated && (
          <Layout.Section>
            <Banner tone="warning">
              Result truncated at 5,000 products — if you're hitting
              this, add a tag or search filter to narrow down.
            </Banner>
          </Layout.Section>
        )}

        {/* Filters */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Filters
              </Text>
              <InlineStack gap="400" wrap>
                <div style={{ flex: 1, minWidth: "220px" }}>
                  <LocationPicker
                    label="Location"
                    locations={locations}
                    value={locationId}
                    onChange={setLocationId}
                    persistKey="on-hand-location"
                  />
                </div>
                <div style={{ flex: 2, minWidth: "260px" }}>
                  <TextField
                    label="Search"
                    value={search}
                    onChange={setSearch}
                    placeholder="Product title contains…"
                    autoComplete="off"
                    prefix={<Icon source={SearchIcon} />}
                    clearButton
                    onClearButtonClick={() => setSearch("")}
                  />
                </div>
              </InlineStack>

              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Tags
                </Text>
                <Combobox
                  activator={
                    <Combobox.TextField
                      label=""
                      labelHidden
                      value={tagQuery}
                      onChange={setTagQuery}
                      placeholder="Add tag filter…"
                      autoComplete="off"
                      prefix={<Icon source={SearchIcon} />}
                    />
                  }
                >
                  {filteredTags.length > 0 && (
                    <Listbox
                      onSelect={(value) => {
                        setSelectedTags((prev) =>
                          prev.includes(value)
                            ? prev.filter((t) => t !== value)
                            : [...prev, value],
                        );
                        setTagQuery("");
                      }}
                    >
                      {filteredTags.slice(0, 30).map((t) => (
                        <Listbox.Option
                          key={t}
                          value={t}
                          selected={selectedTags.includes(t)}
                        >
                          {t}
                        </Listbox.Option>
                      ))}
                    </Listbox>
                  )}
                </Combobox>
                {selectedTags.length > 0 && (
                  <InlineStack gap="100" wrap>
                    {selectedTags.map((t) => (
                      <Tag
                        key={t}
                        onRemove={() =>
                          setSelectedTags((prev) =>
                            prev.filter((x) => x !== t),
                          )
                        }
                      >
                        {t}
                      </Tag>
                    ))}
                  </InlineStack>
                )}
              </BlockStack>

              <InlineStack align="end">
                <Button
                  variant="primary"
                  onClick={handleQuery}
                  loading={isBusy}
                  disabled={!locationId}
                >
                  Run query
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Summary */}
        {summaryLine && (
          <Layout.Section>
            <Card>
              <Text as="p" variant="bodyMd">
                {summaryLine}
              </Text>
            </Card>
          </Layout.Section>
        )}

        {/* Grid */}
        {cells.length > 0 && (
          <Layout.Section>
            <Card padding="0">
              <div style={{ padding: "16px" }}>
                <ProductGrid
                  cells={cells}
                  qtyLabel="On hand"
                  onCellChange={() => {}}
                  showColumns={{
                    cost: false,
                    retail: false,
                    stock: false,
                    onOrder: false,
                  }}
                  sizeColumns={["XS", "S", "M", "L", "XL", "2XL", "3XL"]}
                  trailingLabel="Row total"
                  readonly
                />
              </div>
            </Card>
          </Layout.Section>
        )}

        {actionData?.result && cells.length === 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="200" inlineAlign="center">
                <Text as="p" variant="bodyMd">
                  Nothing in stock matching these filters at the selected
                  location.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
