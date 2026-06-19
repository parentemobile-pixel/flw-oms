import { Link } from "@remix-run/react";
import { Page, Layout, Card, BlockStack, Text, Button } from "@shopify/polaris";

export default function ReportsIndex() {
  return (
    <Page
      title="Reports"
      subtitle="Inventory snapshots and time-series rollups."
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Inventory Value
              </Text>
              <Text as="p" tone="subdued">
                Total units, cost value, and retail value over time, broken
                out by location and vendor. Nightly snapshot.
              </Text>
              <div>
                <Link to="/app/reports/inventory-value">
                  <Button>Open</Button>
                </Link>
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>
        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
