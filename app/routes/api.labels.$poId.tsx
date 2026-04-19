import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getPurchaseOrder } from "../services/purchase-orders/po-service.server";
import { generateLabelsPDF } from "../services/purchase-orders/label-generator.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const po = await getPurchaseOrder(session.shop, params.poId!);
  if (!po) throw new Response("Not found", { status: 404 });

  const pdfBuffer = await generateLabelsPDF(
    po.lineItems.map((li) => ({
      productTitle: li.productTitle,
      variantTitle: li.variantTitle,
      sku: li.sku,
      barcode: li.barcode,
      price: li.retailPrice || null,
      quantityOrdered: li.quantityOrdered,
    })),
  );

  // Convert Node Buffer -> Uint8Array so the web-standard Response body
  // accepts it. Passing a raw Buffer can silently fail in Remix's runtime.
  const pdfBytes = new Uint8Array(pdfBuffer);

  return new Response(pdfBytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="labels-${po.poNumber}.pdf"`,
    },
  });
};
