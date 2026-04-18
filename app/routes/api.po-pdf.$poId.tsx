import type { LoaderFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { getPurchaseOrder } from "../services/purchase-orders/po-service.server";
import { getLocations } from "../services/shopify-api/locations.server";
import {
  generatePOPdf,
  type POPdfView,
} from "../services/purchase-orders/po-pdf.server";

/**
 * Generate a PDF for a purchase order.
 * Query param: ?view=line | grid (default: line)
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const viewParam = url.searchParams.get("view");
  const view: POPdfView = viewParam === "grid" ? "grid" : "line";

  const po = await getPurchaseOrder(session.shop, params.poId!);
  if (!po) throw new Response("Not found", { status: 404 });

  const locations = await getLocations(admin, session.shop).catch(() => []);
  const locationName =
    locations.find((l) => l.id === po.shopifyLocationId)?.name ?? null;

  // For grid view, try to fetch selectedOptions per variant (not stored in DB).
  // Fall back to parsing from variantTitle ("M / Red") if Shopify fetch fails.
  let variantOptions: Record<
    string,
    Array<{ name: string; value: string }>
  > = {};
  if (view === "grid" && po.lineItems.length > 0) {
    try {
      const ids = [...new Set(po.lineItems.map((li) => li.shopifyVariantId))];
      const q = `#graphql
        query POVariantOptions($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant { id selectedOptions { name value } }
          }
        }
      `;
      const resp = await admin.graphql(q, { variables: { ids } });
      const data = (await resp.json()) as any;
      for (const node of data.data?.nodes ?? []) {
        if (node?.id) variantOptions[node.id] = node.selectedOptions ?? [];
      }
    } catch {
      // Best-effort — grid view falls back to variantTitle parsing below
    }
  }

  const lineItems = po.lineItems.map((li) => {
    let options = variantOptions[li.shopifyVariantId];
    if (!options && view === "grid") {
      // Fallback: parse "M / Red" → [{name:"Size",value:"M"},{name:"Color",value:"Red"}]
      // Heuristic only — we don't know the real option names, so we guess
      // based on well-known size tokens.
      const parts = li.variantTitle.split(" / ").map((p) => p.trim());
      const sizeTokens = new Set([
        "XXS",
        "XS",
        "S",
        "M",
        "L",
        "XL",
        "2XL",
        "XXL",
        "3XL",
        "OS",
      ]);
      options = parts.map((p) => ({
        name: sizeTokens.has(p.toUpperCase()) ? "Size" : "Option",
        value: p,
      }));
    }
    return {
      ...li,
      selectedOptions: options,
    };
  });

  const appUrl = process.env.SHOPIFY_APP_URL || url.origin;

  const pdf = await generatePOPdf({
    po: {
      poNumber: po.poNumber,
      poNumberExt: po.poNumberExt ?? null,
      vendor: po.vendor ?? null,
      status: po.status,
      shippingDate: po.shippingDate,
      expectedDate: po.expectedDate,
      orderDate: po.orderDate,
      createdAt: po.createdAt,
      notes: po.notes ?? null,
      totalCost: po.totalCost,
      shopifyLocationId: po.shopifyLocationId ?? null,
      receiveToken: po.receiveToken,
      lineItems,
    },
    view,
    locationName,
    appUrl,
  });

  const pdfBytes = new Uint8Array(pdf);
  return new Response(pdfBytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${po.poNumber}-${view}.pdf"`,
    },
  });
};
