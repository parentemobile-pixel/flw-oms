import type { ActionFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { generateLabelsPDF } from "../services/purchase-orders/label-generator.server";

/**
 * Generate a PDF of labels for a single variant + quantity. Used by the
 * Standalone Barcode Printer module (`app.print-labels._index.tsx`).
 *
 * POST body: { variantId, quantity, productTitle, variantTitle, sku, barcode }
 * Returns: PDF file download.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const productTitle = String(formData.get("productTitle") ?? "");
  const variantTitle = String(formData.get("variantTitle") ?? "");
  const sku = (formData.get("sku") as string) || null;
  const barcode = (formData.get("barcode") as string) || null;
  const priceRaw = (formData.get("price") as string) || "";
  const price = priceRaw ? parseFloat(priceRaw) || null : null;
  const quantity = Math.max(
    1,
    Math.min(500, parseInt(String(formData.get("quantity") ?? "1"), 10) || 1),
  );

  if (!productTitle) {
    return new Response("Missing productTitle", { status: 400 });
  }

  const pdf = await generateLabelsPDF([
    {
      productTitle,
      variantTitle,
      sku,
      barcode,
      price,
      quantityOrdered: quantity,
    },
  ]);

  const pdfBytes = new Uint8Array(pdf);
  const safeSku = (sku ?? "labels").replace(/[^a-zA-Z0-9-_]/g, "_");
  return new Response(pdfBytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="labels-${safeSku}-${quantity}.pdf"`,
    },
  });
};
