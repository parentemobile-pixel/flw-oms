import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getPurchaseOrder } from "../services/purchase-orders/po-service.server";
import { generateLabelsPDF } from "../services/purchase-orders/label-generator.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const po = await getPurchaseOrder(session.shop, params.poId!);
  if (!po) throw new Response("Not found", { status: 404 });

  // Pull fresh variant data from Shopify each time labels are printed.
  // The PO line item's barcode / sku / price are snapshots from when the
  // PO was created — if the merchandiser added a barcode to a variant
  // after creating the PO (common: auto-barcode runs at product create
  // but the variant existed before), the snapshot is empty and the
  // printed label would have no barcode. Refreshing here means a click
  // of "Print Labels" always reflects the current Shopify truth.
  const variantIds = [
    ...new Set(po.lineItems.map((li) => li.shopifyVariantId)),
  ];
  const liveByVariantId = new Map<
    string,
    { barcode: string | null; sku: string | null; price: number | null }
  >();
  if (variantIds.length > 0) {
    try {
      const q = `#graphql
        query POLabelVariants($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              barcode
              sku
              price
            }
          }
        }
      `;
      const resp = await admin.graphql(q, { variables: { ids: variantIds } });
      const data = (await resp.json()) as {
        data?: {
          nodes?: Array<
            | {
                id: string;
                barcode: string | null;
                sku: string | null;
                price: string | null;
              }
            | null
          >;
        };
      };
      for (const node of data.data?.nodes ?? []) {
        if (!node?.id) continue;
        liveByVariantId.set(node.id, {
          barcode: node.barcode || null,
          sku: node.sku || null,
          price: node.price ? parseFloat(node.price) : null,
        });
      }
    } catch (err) {
      // Best-effort — if the Shopify fetch fails we fall back to the
      // stored snapshot per-line below, which matches the old behavior.
      console.warn("Label PDF: live variant refresh failed", err);
    }
  }

  const pdfBuffer = await generateLabelsPDF(
    po.lineItems.map((li) => {
      const live = liveByVariantId.get(li.shopifyVariantId);
      return {
        productTitle: li.productTitle,
        variantTitle: li.variantTitle,
        // Prefer the live values; only fall through to the DB snapshot
        // when the Shopify fetch failed or returned nothing for this variant.
        sku: live?.sku ?? li.sku,
        barcode: live?.barcode ?? li.barcode,
        price: live?.price ?? (li.retailPrice || null),
        quantityOrdered: li.quantityOrdered,
      };
    }),
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
