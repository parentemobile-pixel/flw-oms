import bwipjs from "bwip-js";
import { jsPDF } from "jspdf";
import { format as formatDate } from "date-fns";

import { FLW_COMPANY_INFO } from "../../utils/constants";

interface TransferLineForPdf {
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  quantitySent: number;
  quantityReceived: number;
  selectedOptions?: Array<{ name: string; value: string }>;
  /** Pre-fetched VARIANT image as a data: URL. Null when the variant has
   *  no image (or product has no featuredImage to fall back on) or the
   *  image fetch failed. */
  imageDataUrl?: string | null;
}

interface TransferForPdf {
  transferNumber: string;
  name: string | null;
  status: string;
  notes: string | null;
  createdAt: Date | string;
  sentAt: Date | string | null;
  receivedAt: Date | string | null;
  trackingCarrier: string | null;
  trackingNumber: string | null;
  receiveToken: string;
  lineItems: TransferLineForPdf[];
}

export type TransferPdfView = "line" | "grid";

/**
 * Generate a printable packing slip PDF for an Inventory Transfer.
 * Same two-column header layout as the PO PDF (company branding +
 * metadata on the left, big transfer #/name + scan-to-receive QR on
 * the right) so the visual language stays consistent.
 *
 * Two body views:
 *  - "line": one row per SKU + image thumbnail; default for small transfers
 *  - "grid": products as rows, sizes as columns; apparel-friendly
 *
 * The QR encodes the public `/t/:token` route so the receiving store can
 * scan and confirm without an admin login.
 */
export async function generateTransferPdf(options: {
  transfer: TransferForPdf;
  view: TransferPdfView;
  fromLocationName: string | null;
  toLocationName: string | null;
  appUrl: string;
}): Promise<Buffer> {
  const { transfer, view, fromLocationName, toLocationName, appUrl } = options;

  const orientation = view === "grid" ? "landscape" : "portrait";
  const doc = new jsPDF({ unit: "in", format: "letter", orientation });

  const pageWidth = view === "grid" ? 11 : 8.5;
  const margin = 0.5;

  // ── Title bar ─────────────────────────────────────────────────────
  // Renders above the two-column header so anyone glancing at the
  // sheet knows it's a packing slip before reading anything else.
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text("PACKING SLIP — INVENTORY TRANSFER", margin, margin);

  // ── Header layout ─────────────────────────────────────────────────
  // Two columns: company info + transfer metadata on the left;
  // transfer #, optional name, and the scan-to-receive QR on the
  // right. Track each column's bottom y so the body starts below
  // whichever ran longer.

  // ── Left column: company info → transfer metadata ──
  let leftY = margin + 0.2;
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(FLW_COMPANY_INFO.name, margin, leftY + 0.15);
  leftY += 0.3;

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  for (const line of FLW_COMPANY_INFO.addressLines) {
    doc.text(line, margin, leftY + 0.13);
    leftY += 0.18;
  }
  if (FLW_COMPANY_INFO.phone) {
    doc.text(FLW_COMPANY_INFO.phone, margin, leftY + 0.13);
    leftY += 0.18;
  }
  if (FLW_COMPANY_INFO.email) {
    doc.text(FLW_COMPANY_INFO.email, margin, leftY + 0.13);
    leftY += 0.18;
  }
  leftY += 0.15; // gap before metadata block

  doc.setFontSize(10);
  // From → To. The "→" makes the routing scannable at a glance.
  doc.setFont("helvetica", "bold");
  doc.text(`From: `, margin, leftY + 0.15);
  doc.setFont("helvetica", "normal");
  doc.text(fromLocationName ?? "—", margin + 0.45, leftY + 0.15);
  leftY += 0.22;
  doc.setFont("helvetica", "bold");
  doc.text(`To: `, margin, leftY + 0.15);
  doc.setFont("helvetica", "normal");
  doc.text(toLocationName ?? "—", margin + 0.3, leftY + 0.15);
  leftY += 0.25;

  // Tracking — only when set.
  if (transfer.trackingCarrier || transfer.trackingNumber) {
    const carrier = transfer.trackingCarrier || "";
    const number = transfer.trackingNumber || "";
    const label = [carrier, number].filter(Boolean).join(" · ");
    doc.setFont("helvetica", "bold");
    doc.text(`Tracking: `, margin, leftY + 0.15);
    doc.setFont("helvetica", "normal");
    doc.text(label, margin + 0.75, leftY + 0.15);
    leftY += 0.25;
  }

  // Dates row.
  const dateItems: string[] = [];
  dateItems.push(`Created: ${formatDateSafe(transfer.createdAt)}`);
  if (transfer.sentAt) dateItems.push(`Sent: ${formatDateSafe(transfer.sentAt)}`);
  if (transfer.receivedAt)
    dateItems.push(`Received: ${formatDateSafe(transfer.receivedAt)}`);
  doc.setFont("helvetica", "normal");
  doc.text(dateItems.join("   ·   "), margin, leftY + 0.15);
  leftY += 0.25;

  // ── Right column: Transfer # (huge), name (large), then QR ──
  const rightEdge = pageWidth - margin;
  let rightY = margin + 0.2;
  doc.setFontSize(22);
  doc.setFont("helvetica", "bold");
  doc.text(`#${transfer.transferNumber}`, rightEdge, rightY + 0.25, {
    align: "right",
  });
  rightY += 0.4;
  if (transfer.name) {
    doc.setFontSize(13);
    doc.setFont("helvetica", "normal");
    const nameLines = doc.splitTextToSize(
      transfer.name,
      Math.min(4.5, pageWidth / 2.5),
    );
    for (const line of nameLines) {
      doc.text(line, rightEdge, rightY + 0.18, { align: "right" });
      rightY += 0.22;
    }
  }
  rightY += 0.1;

  // QR code → /t/:token. Receiver scans with their phone, lands on the
  // public scan-to-receive page (no Shopify admin login required).
  const qrSize = 1.1;
  try {
    const receiveUrl = `${appUrl.replace(/\/$/, "")}/t/${transfer.receiveToken}`;
    const qrPng = await bwipjs.toBuffer({
      bcid: "qrcode",
      text: receiveUrl,
      scale: 3,
      padding: 2,
    });
    const base64 = Buffer.from(qrPng).toString("base64");
    const qrData = `data:image/png;base64,${base64}`;
    doc.addImage(
      qrData,
      "PNG",
      rightEdge - qrSize,
      rightY,
      qrSize,
      qrSize,
    );
    doc.setFontSize(7);
    doc.text("Scan to receive", rightEdge - qrSize, rightY + qrSize + 0.15);
    rightY += qrSize + 0.25;
  } catch {
    // Skip QR on failure — not worth failing the PDF for
  }

  // Body starts below the taller column, with the same 0.5" breathing
  // room before the underline rule we use on PO PDFs.
  let y = Math.max(leftY, rightY) + 0.5;

  if (view === "line") {
    y = drawLineTable(doc, transfer, y, margin, pageWidth);
  } else {
    y = drawGridTable(doc, transfer, y, margin, pageWidth);
  }

  // ── Totals ─────────────────────────────────────────────────────────
  y += 0.2;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  const totalSent = transfer.lineItems.reduce(
    (sum, li) => sum + li.quantitySent,
    0,
  );
  const totalReceived = transfer.lineItems.reduce(
    (sum, li) => sum + li.quantityReceived,
    0,
  );
  // Show "received" alongside sent so a partial-receipt reprint reads
  // cleanly. When nothing's been received yet (the common
  // packing-slip case), the second figure is 0.
  doc.text(
    `Total units sent: ${totalSent}     Received: ${totalReceived}`,
    margin,
    y,
  );

  if (transfer.notes) {
    y += 0.35;
    doc.setFont("helvetica", "bold");
    doc.text("Notes:", margin, y);
    y += 0.2;
    doc.setFont("helvetica", "normal");
    const lines = doc.splitTextToSize(
      transfer.notes,
      pageWidth - 2 * margin,
    );
    doc.text(lines, margin, y);
  }

  return Buffer.from(doc.output("arraybuffer"));
}

// ── Line view ────────────────────────────────────────────────────────
function drawLineTable(
  doc: jsPDF,
  transfer: TransferForPdf,
  yStart: number,
  margin: number,
  pageWidth: number,
): number {
  // Small image column on the left so the receiver can match each line
  // to what they're holding without reading SKU codes.
  const imgColW = 0.55;
  const cols = [
    { title: "", width: imgColW }, // image
    { title: "Product", width: 2.8 },
    { title: "Variant", width: 1.4 },
    { title: "SKU", width: 1.6 },
    { title: "Sent", width: 0.55, align: "right" as const },
    { title: "Received", width: 0.75, align: "right" as const },
  ];

  let y = yStart;
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  let x = margin;
  for (const c of cols) {
    if (c.title) {
      doc.text(c.title, c.align === "right" ? x + c.width - 0.05 : x, y, {
        align: c.align,
      });
    }
    x += c.width;
  }
  doc.setLineWidth(0.01);
  doc.line(margin, y + 0.07, pageWidth - margin, y + 0.07);
  y += 0.3;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);

  const rowHeight = 0.55;

  for (const li of transfer.lineItems) {
    if (y > 10.3) {
      doc.addPage();
      y = 0.5;
    }
    const rowTop = y;
    x = margin;

    if (li.imageDataUrl) {
      try {
        const imgSize = 0.45;
        doc.addImage(
          li.imageDataUrl,
          "PNG",
          x + (imgColW - imgSize) / 2,
          rowTop - 0.05,
          imgSize,
          imgSize,
          undefined,
          "FAST",
        );
      } catch {
        // Skip silently
      }
    }
    x += imgColW;

    // Product cell. No cutting-ticket subtitle on transfers — that's a
    // production-side concept that doesn't apply when moving stock
    // store-to-store.
    doc.text(truncate(li.productTitle, 36), x, y);
    x += 2.8;

    const trailing = [
      truncate(li.variantTitle, 28),
      li.sku || "—",
      String(li.quantitySent),
      String(li.quantityReceived),
    ];
    for (let i = 0; i < trailing.length; i++) {
      const c = cols[i + 2];
      doc.text(
        trailing[i],
        c.align === "right" ? x + c.width - 0.05 : x,
        y,
        { align: c.align },
      );
      x += c.width;
    }

    y = rowTop + rowHeight;
  }

  return y;
}

// ── Grid view (sizes as columns) ─────────────────────────────────────
function drawGridTable(
  doc: jsPDF,
  transfer: TransferForPdf,
  yStart: number,
  margin: number,
  pageWidth: number,
): number {
  // Build grid: collect sizes, group rows by (product + non-size options).
  const sizeSet = new Set<string>();
  const rowMap = new Map<
    string,
    {
      label: string;
      imageDataUrl: string | null;
      bySize: Record<string, { sent: number; received: number }>;
    }
  >();

  for (const li of transfer.lineItems) {
    const opts = li.selectedOptions ?? [];
    const sizeOpt = opts.find((o) => o.name.toLowerCase() === "size");
    const size = sizeOpt?.value || "—";
    sizeSet.add(size);
    const nonSize = opts
      .filter((o) => o.name.toLowerCase() !== "size")
      .map((o) => o.value)
      .join(" / ");
    const label = nonSize
      ? `${li.productTitle} — ${nonSize}`
      : li.productTitle;
    if (!rowMap.has(label)) {
      rowMap.set(label, {
        label,
        imageDataUrl: li.imageDataUrl ?? null,
        bySize: {},
      });
    }
    rowMap.get(label)!.bySize[size] = {
      sent: li.quantitySent,
      received: li.quantityReceived,
    };
  }

  const sizeOrder = [
    "XXS",
    "XS",
    "S",
    "M",
    "L",
    "XL",
    "2XL",
    "XXL",
    "3XL",
    "XXXL",
    "4XL",
    "OS",
    "—",
  ];
  const sizes = [...sizeSet].sort((a, b) => {
    const ai = sizeOrder.indexOf(a.toUpperCase());
    const bi = sizeOrder.indexOf(b.toUpperCase());
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  const imgColW = 0.55;
  const productColWidth = 3.0;
  const unitsColWidth = 0.6;
  const sizeColWidth = Math.max(
    0.5,
    (pageWidth - 2 * margin - imgColW - productColWidth - unitsColWidth) /
      Math.max(sizes.length, 1),
  );

  let y = yStart;

  // Header
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  let x = margin + imgColW; // leave the image column blank in the header
  doc.text("Product", x, y);
  x += productColWidth;
  for (const size of sizes) {
    doc.text(size, x + sizeColWidth / 2, y, { align: "center" });
    x += sizeColWidth;
  }
  doc.text("Units", x + unitsColWidth - 0.05, y, { align: "right" });
  doc.setLineWidth(0.01);
  doc.line(margin, y + 0.07, pageWidth - margin, y + 0.07);
  y += 0.3;

  doc.setFont("helvetica", "normal");
  const rowHeight = 0.55;

  for (const row of rowMap.values()) {
    if (y > 7.2) {
      doc.addPage();
      y = 0.5;
    }
    const rowTop = y;
    x = margin;

    if (row.imageDataUrl) {
      try {
        const imgSize = 0.45;
        doc.addImage(
          row.imageDataUrl,
          "PNG",
          x + (imgColW - imgSize) / 2,
          rowTop - 0.05,
          imgSize,
          imgSize,
          undefined,
          "FAST",
        );
      } catch {
        // Skip on failure
      }
    }
    x += imgColW;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text(truncate(row.label, 42), x, y);
    x += productColWidth;

    let rowUnits = 0;
    for (const size of sizes) {
      const cell = row.bySize[size];
      if (cell) {
        // Show sent qty primarily; received in parens when > 0.
        const label =
          cell.received > 0
            ? `${cell.sent} (${cell.received})`
            : `${cell.sent}`;
        doc.text(label, x + sizeColWidth / 2, y, { align: "center" });
        rowUnits += cell.sent;
      } else {
        doc.text("—", x + sizeColWidth / 2, y, { align: "center" });
      }
      x += sizeColWidth;
    }

    doc.setFont("helvetica", "bold");
    doc.text(String(rowUnits), x + unitsColWidth - 0.05, y, {
      align: "right",
    });
    doc.setFont("helvetica", "normal");

    y = rowTop + rowHeight;
  }

  return y;
}

// ── Helpers ──────────────────────────────────────────────────────────
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function formatDateSafe(d: Date | string | null | undefined): string {
  if (!d) return "—";
  try {
    return formatDate(new Date(d), "MMM d, yyyy");
  } catch {
    return String(d);
  }
}
