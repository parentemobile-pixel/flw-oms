import { json } from "@remix-run/node";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

import { getVariantsInventory } from "../shopify-api/inventory.server";
import { searchProducts } from "../shopify-api/products.server";

/**
 * Product shape the TransferEditor's picker consumes. Mirrors
 * `PickerProduct` in app/components/ProductPicker.tsx plus the extra
 * per-variant fields the editor needs to build a TransferRow.
 */
export interface TransferSearchVariant {
  id: string;
  title: string;
  sku: string | null;
  inStock: number;
  selectedOptions: Array<{ name: string; value: string }>;
}
export interface TransferSearchProduct {
  id: string;
  title: string;
  status?: string | null;
  variants: TransferSearchVariant[];
}

/**
 * Server side of the two "helper" intents the TransferEditor component
 * fires from the client (`search` and `loadStock`). Shared by the
 * Transfer create route and the Transfer detail route (edit mode) so
 * both speak exactly the same protocol.
 *
 * Returns a Response for a handled intent, or null when the intent is
 * not one of ours so the caller can keep dispatching.
 */
export async function handleTransferEditorIntent(
  admin: AdminApiContext,
  intent: string,
  formData: FormData,
): Promise<Response | null> {
  if (intent === "search") {
    const query = String(formData.get("query") ?? "").trim();
    if (!query) return json({ products: [] as TransferSearchProduct[] });
    try {
      const result = await searchProducts(admin, query);
      const products: TransferSearchProduct[] = (
        result.edges as Array<{ node: any }>
      ).map((edge) => {
        const p = edge.node;
        return {
          id: p.id,
          title: p.title,
          status: p.status ?? null,
          variants: (p.variants.edges as Array<{ node: any }>).map((v) => ({
            id: v.node.id,
            title: v.node.title,
            sku: v.node.sku ?? null,
            inStock: v.node.inventoryQuantity ?? 0,
            selectedOptions: v.node.selectedOptions ?? [],
          })),
        };
      });
      return json({ products });
    } catch (error) {
      console.error("Transfer product search failed:", error);
      return json({ products: [] as TransferSearchProduct[] });
    }
  }

  if (intent === "loadStock") {
    const variantIds = JSON.parse(
      String(formData.get("variantIds") ?? "[]"),
    ) as string[];
    const locationId = String(formData.get("locationId") ?? "");
    if (variantIds.length === 0 || !locationId) return json({ stock: {} });
    const map = await getVariantsInventory(admin, variantIds);
    const stock: Record<string, number> = {};
    for (const [vid, inv] of map.entries()) {
      const level = inv.levels.find((l) => l.locationId === locationId);
      stock[vid] = level?.quantities.available ?? 0;
    }
    return json({ stock });
  }

  return null;
}
