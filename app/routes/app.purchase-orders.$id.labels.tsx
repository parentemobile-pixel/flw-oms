import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Button,
  BlockStack,
  Text,
  InlineStack,
  DataTable,
  Banner,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { getPurchaseOrder } from "../services/purchase-orders/po-service.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const po = await getPurchaseOrder(session.shop, params.id!);
  if (!po) throw new Response("Not found", { status: 404 });
  return json({ po });
};

export default function PrintLabels() {
  const { po } = useLoaderData<typeof loader>();

  const totalLabels = po.lineItems.reduce((sum, li) => sum + li.quantityOrdered, 0);

  const rows = po.lineItems.map((li) => [
    li.productTitle,
    li.variantTitle,
    li.sku || "—",
    li.barcode || li.sku || "NO-BARCODE",
    String(li.quantityOrdered),
  ]);

  const handlePrintLabels = async () => {
    try {
      const response = await fetch(`/api/labels/${po.id}`);
      if (!response.ok) throw new Error("Failed to generate labels");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `labels-${po.poNumber}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Failed to print labels:", error);
    }
  };

  return (
    <Page title={`Labels: ${po.poNumber}`} backAction={{ url: `/app/purchase-orders/${po.id}` }}>
      <Layout>
        <Layout.Section>
          <Banner tone="info">
            This will generate {totalLabels} thermal labels (2.25" x 1.25") — one per unit ordered.
            Print using your Dymo or Zebra thermal printer.
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Label Summary</Text>
              <DataTable
                columnContentTypes={["text", "text", "text", "text", "numeric"]}
                headings={["Product", "Variant", "SKU", "Barcode Value", "Labels"]}
                rows={rows}
                totals={["", "", "", "", String(totalLabels)]}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineStack align="end">
            <Button variant="primary" onClick={handlePrintLabels}>
              Download Label PDF ({totalLabels} labels)
            </Button>
          </InlineStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
