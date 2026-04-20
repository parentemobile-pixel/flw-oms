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

  // Fetch product featuredImage + metafields (for the "cutting ticket" field)
  // for every unique product on the PO, in one batched GraphQL call.
  const productIds = [
    ...new Set(po.lineItems.map((li) => li.shopifyProductId)),
  ];
  const productMeta: Record<
    string,
    { imageUrl: string | null; cuttingTicket: string | null }
  > = {};
  if (productIds.length > 0) {
    try {
      const q = `#graphql
        query POProductMeta($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              featuredImage { url }
              metafields(first: 50) {
                edges {
                  node { namespace key value type }
                }
              }
            }
          }
        }
      `;
      const resp = await admin.graphql(q, { variables: { ids: productIds } });
      const data = (await resp.json()) as any;
      for (const node of data.data?.nodes ?? []) {
        if (!node?.id) continue;
        // Cutting ticket: any metafield whose namespace or key contains
        // "cutting". First match wins. Supports various merchant naming.
        let cuttingTicket: string | null = null;
        for (const edge of node.metafields?.edges ?? []) {
          const { namespace, key, value } = edge.node;
          const hay = `${namespace}.${key}`.toLowerCase();
          if (hay.includes("cutting")) {
            cuttingTicket = value ?? null;
            break;
          }
        }
        productMeta[node.id] = {
          imageUrl: node.featuredImage?.url ?? null,
          cuttingTicket,
        };
      }
    } catch (e) {
      console.warn("PO PDF: product metadata fetch failed", e);
    }
  }

  // Fetch each unique image as base64 so jsPDF can embed it. Best-effort —
  // a missing/slow image just means the row renders without a thumbnail.
  const uniqueImageUrls = [
    ...new Set(
      Object.values(productMeta)
        .map((m) => m.imageUrl)
        .filter((u): u is string => !!u),
    ),
  ];
  const imageDataUrls: Record<string, string> = {};
  await Promise.all(
    uniqueImageUrls.map(async (imgUrl) => {
      try {
        const r = await fetch(imgUrl);
        if (!r.ok) return;
        const buf = Buffer.from(await r.arrayBuffer());
        const contentType = r.headers.get("content-type") || "image/png";
        const mime = contentType.split(";")[0].trim();
        imageDataUrls[imgUrl] = `data:${mime};base64,${buf.toString("base64")}`;
      } catch {
        // Skip this image; the row will just render without a thumb.
      }
    }),
  );

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
    const meta = productMeta[li.shopifyProductId];
    return {
      ...li,
      selectedOptions: options,
      imageDataUrl: meta?.imageUrl
        ? imageDataUrls[meta.imageUrl] ?? null
        : null,
      cuttingTicket: meta?.cuttingTicket ?? null,
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
      // attachment so the browser downloads rather than tries to render inline
      // in a new tab (which loses the Shopify admin session and produces the
      // "requires refresh" weirdness users were hitting).
      "Content-Disposition": `attachment; filename="${po.poNumber}-${view}.pdf"`,
    },
  });
};
