import type { ActionFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import {
  generateReplenishmentPdf,
  type ReplenishmentPdfRow,
} from "../services/replenishment/replenishment-pdf.server";

/**
 * Render the CURRENT replenishment grid (client state: edited transfer
 * quantities, removed rows, promoted sizes, box numbers) as a PDF.
 *
 * POST form fields:
 *   rows            JSON ReplenishmentPdfRow[]
 *   startDate/endDate   ISO dates of the sales window
 *   destinationName / sourceName   full location names for the header
 *   destLabel / srcLabel           short labels used in the cells
 *
 * Returns the PDF with `Content-Disposition: attachment`. The client
 * fetches it and opens a blob URL in a new tab (blob URLs ignore the
 * disposition) — navigating the top frame to this URL directly would
 * lose the embedded-app session.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const fd = await request.formData();

  let rows: ReplenishmentPdfRow[];
  try {
    rows = JSON.parse(String(fd.get("rows") ?? "[]"));
  } catch {
    return new Response("Invalid rows payload", { status: 400 });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return new Response("No rows to print", { status: 400 });
  }

  const startDate = String(fd.get("startDate") ?? "");
  const endDate = String(fd.get("endDate") ?? "");

  const pdf = await generateReplenishmentPdf({
    rows,
    startDate,
    endDate,
    destinationName: String(fd.get("destinationName") ?? "Destination"),
    sourceName: String(fd.get("sourceName") ?? "Source"),
    destLabel: String(fd.get("destLabel") ?? "Dest"),
    srcLabel: String(fd.get("srcLabel") ?? "Src"),
  });

  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="replenishment-${startDate}-to-${endDate}.pdf"`,
    },
  });
};
