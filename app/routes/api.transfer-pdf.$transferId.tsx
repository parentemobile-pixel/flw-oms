import type { LoaderFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { getTransfer } from "../services/transfers/transfer-service.server";
import { getLocations } from "../services/shopify-api/locations.server";
import {
  generateTransferPdf,
  type TransferPdfView,
} from "../services/transfers/transfer-pdf.server";

/**
 * Generate a packing-slip PDF for an inventory transfer.
 * Query param: ?view=line | grid (default: line)
 *
 * Mirrors `api.po-pdf.$poId.tsx` end to end. Authed admin route — the
 * download button on the transfer detail page fetches inside the
 * embedded iframe and triggers a blob download (the `Content-Disposition:
 * attachment` header forces the browser to download rather than render
 * inline in a new tab, which would otherwise lose the Shopify admin
 * session cookie).
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const viewParam = url.searchParams.get("view");
  const view: TransferPdfView = viewParam === "grid" ? "grid" : "line";

  const transfer = await getTransfer(session.shop, params.transferId!);
  if (!transfer) throw new Response("Not found", { status: 404 });

  const locations = await getLocations(admin, session.shop).catch(() => []);
  const fromLocationName =
    locations.find((l) => l.id === transfer.fromLocationId)?.name ?? null;
  const toLocationName =
    locations.find((l) => l.id === transfer.toLocationId)?.name ?? null;

  // Fetch per-variant selectedOptions + variant image (preferred over
  // product featuredImage so a multi-color row shows the actual color the
  // line is for). One batched call across distinct variants.
  const variantInfo: Record<
    string,
    {
      selectedOptions: Array<{ name: string; value: string }>;
      imageUrl: string | null;
    }
  > = {};
  if (transfer.lineItems.length > 0) {
    try {
      const ids = [
        ...new Set(transfer.lineItems.map((li) => li.shopifyVariantId)),
      ];
      const q = `#graphql
        query TransferVariantInfo($ids: [ID!]!) {
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
      // Best-effort — variantTitle parsing handles grid fallback.
    }
  }

  // Product-level fallback image when the variant has none.
  const productIds = [
    ...new Set(transfer.lineItems.map((li) => li.shopifyProductId)),
  ];
  const productImageUrl: Record<string, string | null> = {};
  if (productIds.length > 0) {
    try {
      const q = `#graphql
        query TransferProductImages($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              featuredImage { url }
            }
          }
        }
      `;
      const resp = await admin.graphql(q, { variables: { ids: productIds } });
      const data = (await resp.json()) as any;
      for (const node of data.data?.nodes ?? []) {
        if (!node?.id) continue;
        productImageUrl[node.id] = node.featuredImage?.url ?? null;
      }
    } catch (e) {
      console.warn("Transfer PDF: product image fetch failed", e);
    }
  }

  // Resolve each line's effective image URL, then batch-fetch unique
  // URLs as base64 so jsPDF can embed them.
  const lineImageUrlByVariantId: Record<string, string | null> = {};
  for (const li of transfer.lineItems) {
    const variantImg = variantInfo[li.shopifyVariantId]?.imageUrl ?? null;
    const productImg = productImageUrl[li.shopifyProductId] ?? null;
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
        // Skip this image; the row just renders without a thumb.
      }
    }),
  );

  const lineItems = transfer.lineItems.map((li) => {
    let options = variantInfo[li.shopifyVariantId]?.selectedOptions;
    if (!options && view === "grid") {
      // Heuristic fallback when the per-variant fetch failed.
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
    return {
      productTitle: li.productTitle,
      variantTitle: li.variantTitle,
      sku: li.sku,
      quantitySent: li.quantitySent,
      quantityReceived: li.quantityReceived,
      selectedOptions: options,
      imageDataUrl: lineImg ? imageDataUrls[lineImg] ?? null : null,
    };
  });

  const appUrl = process.env.SHOPIFY_APP_URL || url.origin;

  const pdf = await generateTransferPdf({
    transfer: {
      transferNumber: transfer.transferNumber,
      name: transfer.name ?? null,
      status: transfer.status,
      notes: transfer.notes ?? null,
      createdAt: transfer.createdAt,
      sentAt: transfer.sentAt,
      receivedAt: transfer.receivedAt,
      trackingCarrier: transfer.trackingCarrier ?? null,
      trackingNumber: transfer.trackingNumber ?? null,
      receiveToken: transfer.receiveToken,
      lineItems,
    },
    view,
    fromLocationName,
    toLocationName,
    appUrl,
  });

  const pdfBytes = new Uint8Array(pdf);
  return new Response(pdfBytes, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="transfer-${transfer.transferNumber}-${view}.pdf"`,
    },
  });
};
