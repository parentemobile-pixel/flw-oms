import { useCallback, useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
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
  Box,
  Button,
  ButtonGroup,
  Card,
  Checkbox,
  Divider,
  IndexTable,
  InlineStack,
  Layout,
  Modal,
  Page,
  ProgressBar,
  Select,
  Spinner,
  Tag,
  Text,
  TextField,
  Thumbnail,
  useIndexResourceState,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import {
  getVendors,
  listProducts,
  type ListedProduct,
} from "../services/shopify-api/products.server";
import {
  bulkArchive,
  bulkChangeVendor,
  bulkEditTags,
  bulkSetCogs,
  getRecentBulkSessions,
  type CogsMode,
} from "../services/products/bulk-service.server";

const PAGE_SIZE = 50;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const queryParts: string[] = [];
  const vendorFilter = url.searchParams.get("vendor")?.trim();
  const statusFilter = url.searchParams.get("status")?.trim();
  const tagFilters = url.searchParams.getAll("tag").filter(Boolean);
  const createdAfter = url.searchParams.get("createdAfter")?.trim();
  const createdBefore = url.searchParams.get("createdBefore")?.trim();
  const searchQuery = url.searchParams.get("q")?.trim();
  const after = url.searchParams.get("after") || null;

  if (vendorFilter) queryParts.push(`vendor:"${vendorFilter}"`);
  if (statusFilter) queryParts.push(`status:${statusFilter}`);
  for (const t of tagFilters) queryParts.push(`tag:"${t}"`);
  if (createdAfter) queryParts.push(`created_at:>=${createdAfter}`);
  if (createdBefore) queryParts.push(`created_at:<=${createdBefore}`);
  if (searchQuery) queryParts.push(`title:*${searchQuery}*`);

  const query = queryParts.length > 0 ? queryParts.join(" AND ") : null;

  const [{ products, pageInfo }, vendors, recentSessions] = await Promise.all([
    listProducts(admin, { first: PAGE_SIZE, after, query }),
    getVendors(admin, session.shop).catch(() => [] as string[]),
    getRecentBulkSessions(session.shop, 5).catch(() => []),
  ]);

  // Collect all unique tags from returned products for the tag filter
  const allTagsSet = new Set<string>();
  for (const p of products) for (const t of p.tags) allTagsSet.add(t);
  const allTags = [...allTagsSet].sort();

  return json({
    products,
    pageInfo,
    vendors,
    allTags,
    recentSessions,
    filters: {
      vendor: vendorFilter ?? "",
      status: statusFilter ?? "",
      tags: tagFilters,
      createdAfter: createdAfter ?? "",
      createdBefore: createdBefore ?? "",
      q: searchQuery ?? "",
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));

  const idsJson = String(formData.get("productIds") ?? "[]");
  const productIds = JSON.parse(idsJson) as string[];
  if (productIds.length === 0) {
    return json({ error: "No products selected." });
  }

  try {
    if (intent === "changeVendor") {
      const vendor = String(formData.get("vendor") ?? "").trim();
      if (!vendor) return json({ error: "Vendor is required." });
      const result = await bulkChangeVendor(
        admin,
        session.shop,
        productIds,
        vendor,
      );
      return json({ ok: true as const, result, action: "changeVendor" });
    }
    if (intent === "archive") {
      const result = await bulkArchive(admin, session.shop, productIds);
      return json({ ok: true as const, result, action: "archive" });
    }
    if (intent === "editTags") {
      const addTagsStr = String(formData.get("addTags") ?? "");
      const removeTagsStr = String(formData.get("removeTags") ?? "");
      const toAdd = addTagsStr.split(",").map((t) => t.trim()).filter(Boolean);
      const toRemove = removeTagsStr
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (toAdd.length === 0 && toRemove.length === 0) {
        return json({ error: "Enter at least one tag to add or remove." });
      }
      const result = await bulkEditTags(
        admin,
        session.shop,
        productIds,
        toAdd,
        toRemove,
      );
      return json({ ok: true as const, result, action: "editTags" });
    }
    if (intent === "setCogs") {
      const mode = String(formData.get("mode") ?? "set");
      const value = parseFloat(String(formData.get("value") ?? "0"));
      const onlyWhereZero = formData.get("onlyWhereZero") === "true";
      let cogsMode: CogsMode;
      if (mode === "adjust_percent") {
        if (!Number.isFinite(value))
          return json({ error: "Percent must be a number." });
        cogsMode = { kind: "adjust_percent", percent: value };
      } else {
        if (!Number.isFinite(value) || value < 0)
          return json({ error: "Cost must be a non-negative number." });
        cogsMode = { kind: "set", value };
      }
      const result = await bulkSetCogs(
        admin,
        session.shop,
        productIds,
        cogsMode,
        { onlyWhereZero },
      );
      return json({ ok: true as const, result, action: "setCogs" });
    }
  } catch (error) {
    return json({ error: String(error) });
  }

  return json({ error: "Unknown action." });
};

type ActionKind = "changeVendor" | "setCogs" | "editTags" | "archive";

export default function ProductsIndex() {
  const { products, pageInfo, vendors, allTags, recentSessions, filters } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isBusy = navigation.state === "submitting";

  // Filter state (controlled; submitted via GET form to the loader)
  const [q, setQ] = useState(filters.q);
  const [vendor, setVendor] = useState(filters.vendor);
  const [status, setStatus] = useState(filters.status);
  const [selectedTags, setSelectedTags] = useState<string[]>(filters.tags);
  const [createdAfter, setCreatedAfter] = useState(filters.createdAfter);
  const [createdBefore, setCreatedBefore] = useState(filters.createdBefore);

  // Selection — Polaris IndexTable hook
  const resourceIDResolver = (p: ListedProduct) => p.id;
  const {
    selectedResources,
    allResourcesSelected,
    handleSelectionChange,
    clearSelection,
  } = useIndexResourceState(
    products as unknown as Array<{ [key: string]: unknown; id: string }>,
    { resourceIDResolver: resourceIDResolver as (p: any) => string },
  );

  // Modal state
  const [activeModal, setActiveModal] = useState<ActionKind | null>(null);
  const [modalVendor, setModalVendor] = useState("");
  const [cogsMode, setCogsMode] = useState<"set" | "adjust_percent">("set");
  const [cogsValue, setCogsValue] = useState("");
  const [cogsOnlyZero, setCogsOnlyZero] = useState(false);
  const [tagsToAdd, setTagsToAdd] = useState("");
  const [tagsToRemove, setTagsToRemove] = useState("");

  // Close modal + clear selection after a successful action
  useEffect(() => {
    if (actionData && "ok" in actionData && actionData.ok) {
      setActiveModal(null);
      clearSelection();
      setModalVendor("");
      setCogsValue("");
      setTagsToAdd("");
      setTagsToRemove("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  const applyFilters = useCallback(() => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (vendor) params.set("vendor", vendor);
    if (status) params.set("status", status);
    for (const t of selectedTags) params.append("tag", t);
    if (createdAfter) params.set("createdAfter", createdAfter);
    if (createdBefore) params.set("createdBefore", createdBefore);
    window.location.href = `?${params.toString()}`;
  }, [q, vendor, status, selectedTags, createdAfter, createdBefore]);

  const clearFilters = useCallback(() => {
    window.location.href = window.location.pathname;
  }, []);

  const toggleTagFilter = useCallback((t: string) => {
    setSelectedTags((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
  }, []);

  const submitAction = useCallback(
    (intent: string, extra: Record<string, string> = {}) => {
      if (selectedResources.length === 0) return;
      const fd = new FormData();
      fd.set("intent", intent);
      fd.set("productIds", JSON.stringify(selectedResources));
      for (const [k, v] of Object.entries(extra)) fd.set(k, v);
      submit(fd, { method: "post" });
    },
    [selectedResources, submit],
  );

  const handleChangeVendor = () => {
    if (!modalVendor.trim()) return;
    submitAction("changeVendor", { vendor: modalVendor.trim() });
  };
  const handleSetCogs = () =>
    submitAction("setCogs", {
      mode: cogsMode,
      value: cogsValue,
      onlyWhereZero: String(cogsOnlyZero),
    });
  const handleEditTags = () =>
    submitAction("editTags", {
      addTags: tagsToAdd,
      removeTags: tagsToRemove,
    });
  const handleArchive = () => submitAction("archive");

  const applyResult =
    actionData && "ok" in actionData && actionData.ok
      ? (actionData as {
          ok: true;
          result: {
            sessionId: string;
            totalCount: number;
            okCount: number;
            errorCount: number;
          };
          action: ActionKind;
        })
      : null;

  const rows = useMemo(
    () =>
      products.map((p: ListedProduct, index: number) => (
        <IndexTable.Row
          id={p.id}
          key={p.id}
          position={index}
          selected={selectedResources.includes(p.id)}
        >
          <IndexTable.Cell>
            {p.imageUrl ? (
              <Thumbnail source={p.imageUrl} alt={p.title} size="small" />
            ) : (
              <Box
                minWidth="40px"
                minHeight="40px"
                background="bg-surface-secondary"
                borderRadius="100"
              />
            )}
          </IndexTable.Cell>
          <IndexTable.Cell>
            <BlockStack gap="050">
              <Text as="span" variant="bodyMd" fontWeight="medium">
                {p.title}
              </Text>
              <Text as="span" variant="bodySm" tone="subdued">
                {p.variantCount} variant{p.variantCount === 1 ? "" : "s"}
              </Text>
            </BlockStack>
          </IndexTable.Cell>
          <IndexTable.Cell>{p.vendor ?? "—"}</IndexTable.Cell>
          <IndexTable.Cell>
            <Badge
              tone={
                p.status === "ACTIVE"
                  ? "success"
                  : p.status === "ARCHIVED"
                    ? "critical"
                    : "info"
              }
            >
              {p.status.toLowerCase()}
            </Badge>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <InlineStack gap="100" wrap>
              {p.tags.slice(0, 3).map((t: string) => (
                <Tag key={t}>{t}</Tag>
              ))}
              {p.tags.length > 3 && (
                <Text as="span" variant="bodySm" tone="subdued">
                  +{p.tags.length - 3}
                </Text>
              )}
            </InlineStack>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Text as="span" alignment="end" variant="bodyMd">
              {p.totalInventory}
            </Text>
          </IndexTable.Cell>
          <IndexTable.Cell>
            <Text as="span" alignment="end" variant="bodyMd">
              {p.avgUnitCost !== null ? `$${p.avgUnitCost.toFixed(2)}` : "—"}
            </Text>
          </IndexTable.Cell>
        </IndexTable.Row>
      )),
    [products, selectedResources],
  );

  const selectedCount = selectedResources.length;

  return (
    <Page
      title="Products"
      subtitle="Bulk edit vendor, COGs, tags, or archive across many products at once"
    >
      <Layout>
        {isBusy && selectedCount > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="center">
                  <Spinner size="small" />
                  <Text as="span" variant="bodyMd">
                    Applying to {selectedCount} product
                    {selectedCount === 1 ? "" : "s"}…
                  </Text>
                </InlineStack>
                <ProgressBar progress={60} size="small" />
                <Text as="p" variant="bodySm" tone="subdued">
                  Batched into groups of 25 to stay under Shopify's rate limit.
                  Safe to leave open.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {applyResult && (
          <Layout.Section>
            <Banner
              tone={applyResult.result.errorCount > 0 ? "warning" : "success"}
              title={`${applyResult.result.okCount} of ${applyResult.result.totalCount} update${applyResult.result.totalCount === 1 ? "" : "s"} succeeded`}
            >
              {applyResult.result.errorCount > 0
                ? `${applyResult.result.errorCount} failed — audit session ${applyResult.result.sessionId} has the details.`
                : `Audit session ${applyResult.result.sessionId}. Changes are reversible via the audit log.`}
            </Banner>
          </Layout.Section>
        )}
        {actionData && "error" in actionData && (
          <Layout.Section>
            <Banner tone="critical">{actionData.error as string}</Banner>
          </Layout.Section>
        )}

        {/* Filters */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="300" wrap>
                <div style={{ flex: 1, minWidth: "260px" }}>
                  <TextField
                    label="Title search"
                    labelHidden
                    value={q}
                    onChange={setQ}
                    placeholder="Search product title…"
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={() => setQ("")}
                  />
                </div>
                <div style={{ minWidth: "200px" }}>
                  <Select
                    label="Vendor"
                    labelInline
                    options={[
                      { label: "All vendors", value: "" },
                      ...vendors.map((v: string) => ({ label: v, value: v })),
                    ]}
                    value={vendor}
                    onChange={setVendor}
                  />
                </div>
                <div style={{ minWidth: "180px" }}>
                  <Select
                    label="Status"
                    labelInline
                    options={[
                      { label: "Any status", value: "" },
                      { label: "Active", value: "active" },
                      { label: "Draft", value: "draft" },
                      { label: "Archived", value: "archived" },
                    ]}
                    value={status}
                    onChange={setStatus}
                  />
                </div>
              </InlineStack>
              <InlineStack gap="300" wrap>
                <div style={{ minWidth: "180px" }}>
                  <TextField
                    label="Created after"
                    type="date"
                    value={createdAfter}
                    onChange={setCreatedAfter}
                    autoComplete="off"
                  />
                </div>
                <div style={{ minWidth: "180px" }}>
                  <TextField
                    label="Created before"
                    type="date"
                    value={createdBefore}
                    onChange={setCreatedBefore}
                    autoComplete="off"
                  />
                </div>
                <BlockStack gap="100">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Tags (multi)
                  </Text>
                  <InlineStack gap="100" wrap>
                    {allTags.length === 0 && (
                      <Text as="span" variant="bodySm" tone="subdued">
                        No tags on this page — load more products.
                      </Text>
                    )}
                    {allTags.map((t: string) => {
                      const on = selectedTags.includes(t);
                      return (
                        <Button
                          key={t}
                          size="micro"
                          pressed={on}
                          onClick={() => toggleTagFilter(t)}
                        >
                          {t}
                        </Button>
                      );
                    })}
                  </InlineStack>
                </BlockStack>
              </InlineStack>
              <InlineStack align="end" gap="200">
                <Button onClick={clearFilters}>Clear filters</Button>
                <Button variant="primary" onClick={applyFilters}>
                  Apply filters
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Action bar (sticky-feeling card above table) */}
        {selectedCount > 0 && (
          <Layout.Section>
            <Card>
              <InlineStack align="space-between" blockAlign="center" wrap>
                <Text as="p" variant="bodyMd" fontWeight="medium">
                  {selectedCount} product{selectedCount === 1 ? "" : "s"} selected
                </Text>
                <ButtonGroup>
                  <Button onClick={() => setActiveModal("changeVendor")}>
                    Change vendor
                  </Button>
                  <Button onClick={() => setActiveModal("setCogs")}>
                    Set COGs
                  </Button>
                  <Button onClick={() => setActiveModal("editTags")}>
                    Edit tags
                  </Button>
                  <Button
                    tone="critical"
                    onClick={() => setActiveModal("archive")}
                  >
                    Archive
                  </Button>
                  <Button onClick={clearSelection}>Clear</Button>
                </ButtonGroup>
              </InlineStack>
            </Card>
          </Layout.Section>
        )}

        {/* Table */}
        <Layout.Section>
          <Card padding="0">
            <IndexTable
              resourceName={{ singular: "product", plural: "products" }}
              itemCount={products.length}
              selectedItemsCount={
                allResourcesSelected ? "All" : selectedResources.length
              }
              onSelectionChange={handleSelectionChange}
              headings={[
                { title: "" },
                { title: "Product" },
                { title: "Vendor" },
                { title: "Status" },
                { title: "Tags" },
                { title: "Inventory", alignment: "end" },
                { title: "COGs avg", alignment: "end" },
              ]}
            >
              {rows}
            </IndexTable>
            {pageInfo.hasNextPage && (
              <Box padding="400">
                <InlineStack align="end">
                  <Button
                    url={`?${new URLSearchParams({ after: pageInfo.endCursor ?? "" }).toString()}`}
                  >
                    Next page →
                  </Button>
                </InlineStack>
              </Box>
            )}
          </Card>
        </Layout.Section>

        {/* Recent sessions */}
        {recentSessions.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  Recent bulk actions
                </Text>
                <Divider />
                {recentSessions.map((s: any) => (
                  <InlineStack key={s.id} align="space-between" blockAlign="center">
                    <BlockStack gap="050">
                      <Text as="p" variant="bodyMd">
                        {s.action.replace(/_/g, " ")} ·{" "}
                        <Text as="span" tone="subdued">
                          {s.okCount}/{s.totalCount} ok
                          {s.errorCount > 0 ? `, ${s.errorCount} err` : ""}
                        </Text>
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {new Date(s.createdAt).toLocaleString()}
                      </Text>
                    </BlockStack>
                  </InlineStack>
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>

      {/* Modals */}
      <Modal
        open={activeModal === "changeVendor"}
        onClose={() => setActiveModal(null)}
        title={`Change vendor for ${selectedCount} product${selectedCount === 1 ? "" : "s"}`}
        primaryAction={{
          content: "Apply",
          onAction: handleChangeVendor,
          disabled: !modalVendor.trim() || isBusy,
          loading: isBusy,
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setActiveModal(null) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Select
              label="Existing vendor"
              options={[
                { label: "— select —", value: "" },
                ...vendors.map((v: string) => ({ label: v, value: v })),
              ]}
              value={modalVendor}
              onChange={setModalVendor}
            />
            <TextField
              label="Or type a new vendor name"
              value={modalVendor}
              onChange={setModalVendor}
              autoComplete="off"
              placeholder="e.g. Acme Co."
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={activeModal === "setCogs"}
        onClose={() => setActiveModal(null)}
        title={`Set COGs for ${selectedCount} product${selectedCount === 1 ? "" : "s"}`}
        primaryAction={{
          content: "Apply",
          onAction: handleSetCogs,
          disabled: !cogsValue.trim() || isBusy,
          loading: isBusy,
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setActiveModal(null) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Select
              label="Mode"
              options={[
                { label: "Set to $X (absolute)", value: "set" },
                { label: "Adjust by ±% of current cost", value: "adjust_percent" },
              ]}
              value={cogsMode}
              onChange={(v) => setCogsMode(v as "set" | "adjust_percent")}
            />
            <TextField
              label={cogsMode === "set" ? "Cost ($)" : "Percent (e.g. 10 for +10%, -5 for -5%)"}
              type="number"
              value={cogsValue}
              onChange={setCogsValue}
              autoComplete="off"
              step={0.01}
            />
            <Checkbox
              label="Only update variants where cost is currently $0 or unset"
              checked={cogsOnlyZero}
              onChange={setCogsOnlyZero}
              helpText="Prevents stomping manual cost overrides — recommended for vendor-wide price imports."
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={activeModal === "editTags"}
        onClose={() => setActiveModal(null)}
        title={`Edit tags on ${selectedCount} product${selectedCount === 1 ? "" : "s"}`}
        primaryAction={{
          content: "Apply",
          onAction: handleEditTags,
          disabled: (!tagsToAdd.trim() && !tagsToRemove.trim()) || isBusy,
          loading: isBusy,
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setActiveModal(null) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <TextField
              label="Add these tags"
              value={tagsToAdd}
              onChange={setTagsToAdd}
              autoComplete="off"
              placeholder="FW26, FLW Core"
              helpText="Comma-separated. Already-present tags are skipped."
            />
            <TextField
              label="Remove these tags"
              value={tagsToRemove}
              onChange={setTagsToRemove}
              autoComplete="off"
              placeholder="SS24"
              helpText="Comma-separated. Missing tags are skipped."
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={activeModal === "archive"}
        onClose={() => setActiveModal(null)}
        title={`Archive ${selectedCount} product${selectedCount === 1 ? "" : "s"}?`}
        primaryAction={{
          content: "Archive",
          destructive: true,
          onAction: handleArchive,
          loading: isBusy,
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setActiveModal(null) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">
              Archived products are hidden from sales channels but their
              inventory remains intact.
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              Reversible — the audit log records the previous status per product.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
