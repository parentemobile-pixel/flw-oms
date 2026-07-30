import type { ActionFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { generateLabelsPDF } from "../services/purchase-orders/label-generator.server";

/**
 * Generate a PDF of labels.
 *
 * Two modes:
 *  1. **Single variant** (used by Standalone Barcode Printer at
 *     `app.print-labels._index.tsx`):
 *       POST: { productTitle, variantTitle, sku, barcode, price, quantity }
 *     → one variant, `quantity` copies.
 *  2. **Multi variant by IDs** (used by Product Builder's post-create
 *     "Print labels" action, where the freshly-created variants are
 *     known by gid):
 *       POST: { variantIds: JSON string[], quantity?: number per variant }
 *     → server fetches each variant's live productTitle / variantTitle /
 *        sku / barcode / price from Shopify, then emits `quantity` (default 1)
 *        copies per variant in one PDF.
 *
 * Returns: PDF file download.
 */
const VARIANT_LABEL_INFO_QUERY = `#graphql
  query LabelVariantInfo($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        sku
        barcode
        price
        product { id title }
      }
    }
  }
`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const formData = await request.formData();
  const quantity = Math.max(
    1,
    Math.min(500, parseInt(String(formData.get("quantity") ?? "1"), 10) || 1),
  );

  // Per-variant-quantity path: caller sends an items JSON array of
  // { variantId, quantity }. Enables the grid-style Print Labels
  // page to print different quantities for each cell in one PDF.
  const itemsRaw = formData.get("items") as string | null;
  if (itemsRaw) {
    let items: Array<{ variantId: string; quantity: number }> = [];
    try {
      const parsed = JSON.parse(itemsRaw);
      if (Array.isArray(parsed)) {
        items = parsed
          .filter(
            (x): x is { variantId: string; quantity: number } =>
              x &&
              typeof x.variantId === "string" &&
              Number.isFinite(x.quantity),
          )
          .map((x) => ({
            variantId: x.variantId,
            // Cap per-variant qty to 500 to match the single/multi paths.
            quantity: Math.max(0, Math.min(500, Math.floor(x.quantity))),
          }))
          .filter((x) => x.quantity > 0);
      }
    } catch {
      return new Response("Bad items JSON", { status: 400 });
    }
    if (items.length === 0) {
      return new Response("No items with quantity > 0", { status: 400 });
    }
    const uniqueVariantIds = [...new Set(items.map((i) => i.variantId))];
    const resp = await admin.graphql(VARIANT_LABEL_INFO_QUERY, {
      variables: { ids: uniqueVariantIds },
    });
    const data = (await resp.json()) as {
      data?: {
        nodes?: Array<
          | {
              id: string;
              title: string;
              sku: string | null;
              barcode: string | null;
              price: string | null;
              product: { id: string; title: string } | null;
            }
          | null
        >;
      };
    };
    const byId = new Map(
      (data.data?.nodes ?? [])
        .filter((n): n is NonNullable<typeof n> => !!n && !!n.id)
        .map((n) => [n.id, n]),
    );
    const labelItems = items
      .map((item) => {
        const v = byId.get(item.variantId);
        if (!v) return null;
        return {
          productTitle: v.product?.title ?? "",
          variantTitle: v.title ?? "",
          sku: v.sku,
          barcode: v.barcode,
          price: v.price ? parseFloat(v.price) : null,
          quantityOrdered: item.quantity,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    if (labelItems.length === 0) {
      return new Response("No valid variants resolved", { status: 400 });
    }
    const pdf = await generateLabelsPDF(labelItems);
    const totalLabels = labelItems.reduce(
      (s, i) => s + i.quantityOrdered,
      0,
    );
    const pdfBytes = new Uint8Array(pdf);
    return new Response(pdfBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="labels-${labelItems.length}-variants-${totalLabels}.pdf"`,
      },
    });
  }

  // Multi-variant path: any caller sending a variantIds JSON array gets
  // server-side metadata resolution. Keeps the client free of an extra
  // round trip to Shopify.
  const variantIdsRaw = formData.get("variantIds") as string | null;
  if (variantIdsRaw) {
    let variantIds: string[] = [];
    try {
      variantIds = JSON.parse(variantIdsRaw);
    } catch {
      return new Response("Bad variantIds JSON", { status: 400 });
    }
    variantIds = variantIds.filter((id) => typeof id === "string" && id);
    if (variantIds.length === 0) {
      return new Response("No variantIds provided", { status: 400 });
    }
    const resp = await admin.graphql(VARIANT_LABEL_INFO_QUERY, {
      variables: { ids: variantIds },
    });
    const data = (await resp.json()) as {
      data?: {
        nodes?: Array<
          | {
              id: string;
              title: string;
              sku: string | null;
              barcode: string | null;
              price: string | null;
              product: { id: string; title: string } | null;
            }
          | null
        >;
      };
    };
    const items = (data.data?.nodes ?? []).filter(
      (n): n is NonNullable<typeof n> => !!n && !!n.id,
    );
    if (items.length === 0) {
      return new Response("No valid variants resolved", { status: 400 });
    }
    const pdf = await generateLabelsPDF(
      items.map((v) => ({
        productTitle: v.product?.title ?? "",
        variantTitle: v.title ?? "",
        sku: v.sku,
        barcode: v.barcode,
        price: v.price ? parseFloat(v.price) : null,
        quantityOrdered: quantity,
      })),
    );
    const pdfBytes = new Uint8Array(pdf);
    return new Response(pdfBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="labels-${items.length}-variants.pdf"`,
      },
    });
  }

  // Single-variant path (unchanged).
  const productTitle = String(formData.get("productTitle") ?? "");
  const variantTitle = String(formData.get("variantTitle") ?? "");
  const sku = (formData.get("sku") as string) || null;
  const barcode = (formData.get("barcode") as string) || null;
  const priceRaw = (formData.get("price") as string) || "";
  const price = priceRaw ? parseFloat(priceRaw) || null : null;

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
