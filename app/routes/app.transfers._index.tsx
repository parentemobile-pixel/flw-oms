import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Page, Layout, Card, BlockStack, Text, Banner } from "@shopify/polaris";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export default function Transfers() {
  return (
    <Page title="Transfers" subtitle="Move inventory between locations">
      <Layout>
        <Layout.Section>
          <Banner tone="info" title="Coming in V2">
            Inventory transfers between store locations land here. Create a
            transfer, send from origin, then receive at destination — all with
            the size grid.
          </Banner>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="p" variant="bodyMd">
                Intended workflow: pick from/to locations, choose products,
                enter quantities to send, print a manifest, receive at
                destination — with safe rollback if Shopify adjustments fail
                mid-flow.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
