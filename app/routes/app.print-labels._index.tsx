import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Page, Layout, Card, BlockStack, Text, Banner } from "@shopify/polaris";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export default function PrintLabels() {
  return (
    <Page title="Print Labels" subtitle="Print extra barcode labels for any variant">
      <Layout>
        <Layout.Section>
          <Banner tone="info" title="Coming in V2">
            Standalone label printing for cases when a tag is lost or damaged
            — without needing a full PO. Search a product, pick the variant,
            enter a quantity, download a thermal-printer-ready PDF.
          </Banner>
        </Layout.Section>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="p" variant="bodyMd">
                Uses the same 2.25" × 1.25" thermal label format already
                working in the Purchase Orders module.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
