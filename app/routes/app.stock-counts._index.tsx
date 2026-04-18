import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Page, Layout, Card, BlockStack, Text, Banner } from "@shopify/polaris";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export default function StockCounts() {
  return (
    <Page title="Stock Counts" subtitle="Cycle counts at any location, pause and resume">
      <Layout>
        <Layout.Section>
          <Banner tone="info" title="Coming in V2">
            Start a stock count at a location, walk the store scanning SKUs,
            and the app keeps track of what's counted and what's still
            remaining — across breaks and sessions.
          </Banner>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="p" variant="bodyMd">
                Intended workflow: name the count + pick location, scan or
                search items, auto-save progress, see a running "counted vs
                remaining" split, finalize with a variance report that
                optionally flags long-dead SKUs for archiving.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
