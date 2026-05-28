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

  // Fetch per-variant info: selectedOptions (used by grid view) + the
  // variant's own image (preferred over the product's featuredImage so a
  // multi-color row shows the actual color the line is for). One batched
  // call across every distinct variant on the PO.
  const variantInfo: Record<
    string,
    {
      selectedOptions: Array<{ name: string; value: string }>;
      imageUrl: string | null;
    }
  > = {};
  if (po.lineItems.length > 0) {
    try {
      const ids = [...new Set(po.lineItems.map((li) => li.shopifyVariantId))];
      const q = `#graphql
        query POVariantInfo($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              selectedOptions { name value }
              image { url }
            }
          }
        }
      `;
      const resp = await admin.graphql(q, { variables: { ids } });
      const data = (await resp.json()) as any;
      for (const node of data.data?.nodes ?? []) {
        if (!node?.id) continue;
        variantInfo[node.id] = {
          selectedOptions: node.selectedOptions ?? [],
          imageUrl: node.image?.url ?? null,
        };
      }
    } catch {
      // Best-effort — fall back to variantTitle parsing for options and
      // product featuredImage for the thumbnail below.
    }
  }

  // Fetch product-level fallback image (featuredImage) + cutting-ticket
  // metafield for every unique product on the PO. The image is only used
  // when the variant has no image of its own.
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

  // Each line resolves its image URL: variant.image first, product
  // featuredImage as fallback. Then we batch-fetch unique URLs as base64.
  const lineImageUrlByVariantId: Record<string, string | null> = {};
  for (const li of po.lineItems) {
    const variantImg = variantInfo[li.shopifyVariantId]?.imageUrl ?? null;
    const productImg = productMeta[li.shopifyProductId]?.imageUrl ?? null;
    lineImageUrlByVariantId[li.shopifyVariantId] = variantImg ?? productImg;
  }
  const uniqueImageUrls = [
    ...new Set(
      Object.values(lineImageUrlByVariantId).filter(
        (u): u is string => !!u,
      ),
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
    let options = variantInfo[li.shopifyVariantId]?.selectedOptions;
    if (!options && view === "grid") {
      // Fallback: parse "M / Red" → [{name:"Size",value:"M"},{name:"Color",value:"Red"}]
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
    const lineImg = lineImageUrlByVariantId[li.shopifyVariantId];
    const meta = productMeta[li.shopifyProductId];
    return {
      ...li,
      selectedOptions: options,
      imageDataUrl: lineImg ? imageDataUrls[lineImg] ?? null : null,
      cuttingTicket: meta?.cuttingTicket ?? null,
    };
  });

  const appUrl = process.env.SHOPIFY_APP_URL || url.origin;

  const pdf = await generatePOPdf({
    po: {
      poNumber: po.poNumber,
      poNumberExt: po.poNumberExt ?? null,
      designId: po.designId ?? null,
      name: po.name ?? null,
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
