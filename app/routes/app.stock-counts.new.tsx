import { useState } from "react";
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
  Text,
  TextField,
  Button,
  Banner,
  InlineStack,
  Autocomplete,
  Icon,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import {
  getDefaultLocation,
  getLocations,
  type Location,
} from "../services/shopify-api/locations.server";
import { getVendors } from "../services/shopify-api/products.server";
import { createStockCount } from "../services/stock-counts/stock-count-service.server";
import { LocationPicker } from "../components/LocationPicker";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [locations, defaultLocation, vendors] = await Promise.all([
    getLocations(admin, session.shop).catch(() => [] as Location[]),
    getDefaultLocation(admin, session.shop).catch(() => null),
    getVendors(admin, session.shop).catch(() => [] as string[]),
  ]);
  return json({
    locations,
    defaultLocationId: defaultLocation?.id ?? null,
    vendors,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const locationId = String(formData.get("locationId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const vendorFilter =
    (formData.get("vendorFilter") as string | null) || null;

  if (!locationId || !name) {
    return json({ error: "Location and name are required." });
  }

  try {
    const sc = await createStockCount(admin, session.shop, {
      locationId,
      name,
      vendorFilter: vendorFilter || null,
    });
    throw redirect(`/app/stock-counts/${sc.id}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    return json({ error: String(error) });
  }
};

export default function NewStockCount() {
  const { locations, defaultLocationId, vendors } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isBusy = navigation.state === "submitting";

  const [locationId, setLocationId] = useState<string | null>(
    defaultLocationId,
  );
  const [name, setName] = useState(
    `Count — ${new Date().toLocaleDateString()}`,
  );
  const [vendorInput, setVendorInput] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");

  const vendorOptions = vendors
    .filter(
      (v) =>
        !vendorInput || v.toLowerCase().includes(vendorInput.toLowerCase()),
    )
    .map((v) => ({ value: v, label: v }));

  const handleCreate = () => {
    const fd = new FormData();
    if (locationId) fd.set("locationId", locationId);
    fd.set("name", name);
    if (vendorFilter) fd.set("vendorFilter", vendorFilter);
    submit(fd, { method: "post" });
  };

  return (
    <Page
      title="New stock count"
      backAction={{ url: "/app/stock-counts" }}
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
              <Text as="p" variant="bodyMd" tone="subdued">
                This seeds a count with every variant at the selected
                location. Expected quantities are snapshotted now. You can
                count any subset — anything you don't count is left alone in
                Shopify.
              </Text>
              <TextField
                label="Count name"
                value={name}
                onChange={setName}
                autoComplete="off"
                placeholder="FW25 pre-Thanksgiving count"
                requiredIndicator
              />
              <LocationPicker
                label="Location to count"
                locations={locations}
                value={locationId}
                onChange={setLocationId}
                persistKey="stock-count-location"
              />
              <Autocomplete
                options={vendorOptions}
                selected={vendorFilter ? [vendorFilter] : []}
                onSelect={(sel) => {
                  const v = sel[0] ?? "";
                  setVendorFilter(v);
                  setVendorInput(v);
                }}
                textField={
                  <Autocomplete.TextField
                    label="Limit to vendor (optional)"
                    value={vendorInput}
                    onChange={(v) => {
                      setVendorInput(v);
                      if (!v) setVendorFilter("");
                    }}
                    placeholder="Leave blank to count everything at this location"
                    autoComplete="off"
                    prefix={<Icon source={SearchIcon} />}
                  />
                }
              />
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <InlineStack align="end" gap="200">
            <Button url="/app/stock-counts">Cancel</Button>
            <Button
              variant="primary"
              onClick={handleCreate}
              loading={isBusy}
              disabled={!name.trim() || !locationId}
            >
              Start count
            </Button>
          </InlineStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
