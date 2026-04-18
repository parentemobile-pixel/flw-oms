import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Page, Layout, Card, BlockStack, Text, Banner } from "@shopify/polaris";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export default function Planning() {
  return (
    <Page title="Planning" subtitle="Buy planning grounded in YoY sales and OOS-adjusted velocity">
      <Layout>
        <Layout.Section>
          <Banner tone="info" title="Coming in V2">
            This is the biggest feature still to build. A product-by-product
            table showing current stock, YoY sales, days OOS, adjusted
            velocity, and a suggested order quantity — filterable by vendor,
            season, and brand.
          </Banner>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="p" variant="bodyMd">
                Intended workflow: filter the catalog, review suggestions,
                edit order quantities inline, then "Create PO from selection"
                to populate a draft purchase order with everything marked.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
