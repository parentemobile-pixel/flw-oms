import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Button,
  InlineStack,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { AIChat } from "../components/AIChat";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const [poCount, draftPoCount, openPoCount, syncStatus] = await Promise.all([
    db.purchaseOrder.count({ where: { shop: session.shop } }),
    db.purchaseOrder.count({ where: { shop: session.shop, status: "draft" } }),
    db.purchaseOrder.count({ where: { shop: session.shop, status: { in: ["ordered", "partially_received"] } } }),
    db.syncStatus.findUnique({ where: { shop: session.shop } }),
  ]);

  return json({ poCount, draftPoCount, openPoCount, syncStatus });
};

export default function Index() {
  const { poCount, draftPoCount, openPoCount, syncStatus } = useLoaderData<typeof loader>();

  return (
    <Page title="FL Woods - OMS" subtitle="FL Woods Order Management System">
      <Layout>
        <Layout.Section>
          <AIChat />
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Buy Planner</Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Plan inventory purchases based on sales velocity and coverage targets.
              </Text>
              <Text as="p" variant="bodySm">
                Last sync: {syncStatus?.lastSyncAt
                  ? new Date(syncStatus.lastSyncAt).toLocaleDateString()
                  : "Never"}
              </Text>
              <Button url="/app/buy-planner">Open Buy Planner</Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Product Builder</Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Create products with auto-generated size and color variants.
              </Text>
              <Text as="p" variant="bodySm">
                Quick setup for Men's, Women's, and custom products.
              </Text>
              <Button url="/app/product-builder">Create Product</Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Purchase Orders</Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Manage incoming inventory with POs, receiving, and barcode labels.
              </Text>
              <Text as="p" variant="bodySm">
                {draftPoCount} draft, {openPoCount} open, {poCount} total
              </Text>
              <InlineStack gap="200">
                <Button url="/app/purchase-orders">View POs</Button>
                <Button url="/app/purchase-orders/new" variant="primary">New PO</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
