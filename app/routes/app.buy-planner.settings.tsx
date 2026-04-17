import { useState, useCallback } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData, useSubmit, useNavigation } from "@remix-run/react";
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
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { getProducts } from "../services/shopify-api/products.server";
import { updateInventoryConfig } from "../services/buy-planner/buy-recommendations.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const productsData = await getProducts(admin, { first: 50 });
  const products = productsData.edges.map((edge: { node: Record<string, unknown> }) => ({
    id: edge.node.id as string,
    title: edge.node.title as string,
  }));

  const configs = await db.inventoryConfig.findMany({ where: { shop: session.shop } });

  return json({ products, configs, shop: session.shop });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const updates = JSON.parse(formData.get("updates") as string) as Array<{
    productId: string;
    minLevel: number;
    coverageDays: number;
  }>;

  for (const update of updates) {
    await updateInventoryConfig(
      session.shop,
      update.productId,
      null,
      update.minLevel,
      update.coverageDays,
    );
  }

  return json({ success: true });
};

export default function BuyPlannerSettings() {
  const { products, configs } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const configMap = new Map(
    configs.map((c) => [c.shopifyProductId, c]),
  );

  const [settings, setSettings] = useState<Record<string, { minLevel: string; coverageDays: string }>>(() => {
    const initial: Record<string, { minLevel: string; coverageDays: string }> = {};
    for (const product of products) {
      const config = configMap.get(product.id);
      initial[product.id] = {
        minLevel: String(config?.minInventoryLevel || 0),
        coverageDays: String(config?.coverageDays || 90),
      };
    }
    return initial;
  });

  const handleChange = useCallback(
    (productId: string, field: "minLevel" | "coverageDays", value: string) => {
      setSettings((prev) => ({
        ...prev,
        [productId]: { ...prev[productId], [field]: value },
      }));
    },
    [],
  );

  const handleSave = useCallback(() => {
    const updates = Object.entries(settings).map(([productId, config]) => ({
      productId,
      minLevel: parseInt(config.minLevel) || 0,
      coverageDays: parseInt(config.coverageDays) || 90,
    }));

    const formData = new FormData();
    formData.set("updates", JSON.stringify(updates));
    submit(formData, { method: "post" });
  }, [settings, submit]);

  return (
    <Page title="Buy Planner Settings" backAction={{ url: "/app/buy-planner" }}>
      <Layout>
        {actionData && "success" in actionData && (
          <Layout.Section>
            <Banner tone="success">Settings saved successfully.</Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Banner tone="info">
            Set minimum inventory levels and coverage day targets for each product.
            The buy planner will use these to calculate recommended order quantities.
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Product Inventory Targets</Text>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                      <th style={{ padding: "8px", textAlign: "left" }}>Product</th>
                      <th style={{ padding: "8px", textAlign: "right", width: "150px" }}>Min Inventory Level</th>
                      <th style={{ padding: "8px", textAlign: "right", width: "150px" }}>Coverage Days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((product) => (
                      <tr key={product.id} style={{ borderBottom: "1px solid #f1f1f1" }}>
                        <td style={{ padding: "8px" }}>{product.title}</td>
                        <td style={{ padding: "8px" }}>
                          <TextField
                            label=""
                            labelHidden
                            value={settings[product.id]?.minLevel || "0"}
                            onChange={(val) => handleChange(product.id, "minLevel", val)}
                            type="number"
                            autoComplete="off"
                          />
                        </td>
                        <td style={{ padding: "8px" }}>
                          <TextField
                            label=""
                            labelHidden
                            value={settings[product.id]?.coverageDays || "90"}
                            onChange={(val) => handleChange(product.id, "coverageDays", val)}
                            type="number"
                            autoComplete="off"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineStack align="end">
            <Button variant="primary" onClick={handleSave} loading={isSubmitting}>
              Save Settings
            </Button>
          </InlineStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
