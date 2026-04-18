import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Page, Layout, Card, BlockStack, Text, Banner } from "@shopify/polaris";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export default function InventoryAdjust() {
  return (
    <Page title="Inventory Adjust" subtitle="Quickly adjust stock at a location via the size grid">
      <Layout>
        <Layout.Section>
          <Banner tone="info" title="Coming in V2">
            This module is part of the V2 build. Grid-based inventory adjustments
            at a selected location will appear here.
          </Banner>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="p" variant="bodyMd">
                Intended workflow: pick a location, search products, enter new
                quantities in a grid, apply — with an audit log of every
                adjustment session.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
