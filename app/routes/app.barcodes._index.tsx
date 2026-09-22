import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

import { authenticate } from "../shopify.server";

/**
 * Barcode Check was folded into Product Issues (duplicate + missing
 * barcode tabs live there alongside negative stock and missing cost).
 * Keep the old URL working for bookmarks.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  throw redirect("/app/product-issues?tab=missing-barcodes");
};
