import bwipjs from "bwip-js";
import { jsPDF } from "jspdf";
import { format as formatDate } from "date-fns";

interface POLineForPdf {
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  barcode: string | null;
  unitCost: number;
  retailPrice: number;
  quantityOrdered: number;
  quantityReceived: number;
  selectedOptions?: Array<{ name: string; value: string }>;
}

interface POForPdf {
  poNumber: string;
  poNumberExt: string | null;
  vendor: string | null;
  status: string;
  shippingDate: Date | string | null;
  expectedDate: Date | string | null;
  orderDate: Date | string | null;
  createdAt: Date | string;
  notes: string | null;
  totalCost: number;
  shopifyLocationId: string | null;
  receiveToken: string;
  lineItems: POLineForPdf[];
}

export type POPdfView = "line" | "grid";

/**
 * Generate a printable PDF of a PO in either "line" format (one row per SKU)
 * or "grid" format (products as rows, sizes as columns — apparel-friendly).
 *
 * Includes a QR code linking to the public scan-to-receive page at /r/:token.
 */
export async function generatePOPdf(options: {
  po: POForPdf;
  view: POPdfView;
  locationName: string | null;
  appUrl: string;
}): Promise<Buffer> {
  const { po, view, locationName, appUrl } = options;

  const orientation = view === "grid" ? "landscape" : "portrait";
  const doc = new jsPDF({ unit: "in", format: "letter", orientation });

  const pageWidth = view === "grid" ? 11 : 8.5;
  const margin = 0.5;
  let y = margin;

  // ── Header ─────────────────────────────────────────────────────────
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.text("FL WOODS — Purchase Order", margin, y + 0.15);
  y += 0.4;

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(`PO #: ${po.poNumber}`, margin, y + 0.15);
  if (po.poNumberExt) {
    doc.text(`Vendor PO #: ${po.poNumberExt}`, margin + 2.5, y + 0.15);
  }
  y += 0.25;

  if (po.vendor) {
    doc.text(`Vendor: ${po.vendor}`, margin, y + 0.15);
    y += 0.25;
  }

  // Dates row
  const dateItems: string[] = [];
  dateItems.push(`Created: ${formatDateSafe(po.createdAt)}`);
  if (po.orderDate) dateItems.push(`Ordered: ${formatDateSafe(po.orderDate)}`);
  if (po.shippingDate)
    dateItems.push(`Ship by: ${formatDateSafe(po.shippingDate)}`);
  if (po.expectedDate)
    dateItems.push(`Expected: ${formatDateSafe(po.expectedDate)}`);
  doc.text(dateItems.join("   ·   "), margin, y + 0.15);
  y += 0.25;

  if (locationName) {
    doc.text(`Receive at: ${locationName}`, margin, y + 0.15);
    y += 0.25;
  }

  // ── QR Code (scan-to-receive) ──────────────────────────────────────
  try {
    const receiveUrl = `${appUrl.replace(/\/$/, "")}/r/${po.receiveToken}`;
    const qrPng = await bwipjs.toBuffer({
      bcid: "qrcode",
      text: receiveUrl,
      scale: 3,
      padding: 2,
    });
    const base64 = Buffer.from(qrPng).toString("base64");
    const qrData = `data:image/png;base64,${base64}`;
    const qrSize = 1.1;
    doc.addImage(
      qrData,
      "PNG",
      pageWidth - margin - qrSize,
      margin,
      qrSize,
      qrSize,
    );
    doc.setFontSize(7);
    doc.text(
      "Scan to receive",
      pageWidth - margin - qrSize,
      margin + qrSize + 0.15,
    );
  } catch {
    // Skip QR on failure — not worth failing the PDF for
  }

  y += 0.25;

  // ── Body ───────────────────────────────────────────────────────────
  if (view === "line") {
    y = drawLineTable(doc, po, y, margin, pageWidth);
  } else {
    y = drawGridTable(doc, po, y, margin, pageWidth);
  }

  // ── Totals ─────────────────────────────────────────────────────────
  y += 0.2;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  const totalUnits = po.lineItems.reduce(
    (sum, li) => sum + li.quantityOrdered,
    0,
  );
  doc.text(
    `Total units: ${totalUnits}     Total cost: $${po.totalCost.toFixed(2)}`,
    margin,
    y,
  );

  // Notes
  if (po.notes) {
    y += 0.35;
    doc.setFont("helvetica", "bold");
    doc.text("Notes:", margin, y);
    y += 0.2;
    doc.setFont("helvetica", "normal");
    const lines = doc.splitTextToSize(po.notes, pageWidth - 2 * margin);
    doc.text(lines, margin, y);
  }

  return Buffer.from(doc.output("arraybuffer"));
}

// ── Line view ────────────────────────────────────────────────────────
function drawLineTable(
  doc: jsPDF,
  po: POForPdf,
  yStart: number,
  margin: number,
  pageWidth: number,
): number {
  const cols = [
    { title: "Product", width: 2.8 },
    { title: "Variant", width: 1.4 },
    { title: "SKU", width: 1.4 },
    { title: "Qty", width: 0.6, align: "right" as const },
    { title: "Cost", width: 0.8, align: "right" as const },
    { title: "Line Total", width: 0.9, align: "right" as const },
  ];

  let y = yStart + 0.2;
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  let x = margin;
  for (const c of cols) {
    doc.text(c.title, c.align === "right" ? x + c.width - 0.05 : x, y, {
      align: c.align,
    });
    x += c.width;
  }
  doc.setLineWidth(0.01);
  doc.line(margin, y + 0.07, pageWidth - margin, y + 0.07);
  y += 0.2;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  for (const li of po.lineItems) {
    if (y > 10.5) {
      doc.addPage();
      y = 0.5;
    }
    x = margin;
    const vals = [
      truncate(li.productTitle, 34),
      truncate(li.variantTitle, 22),
      li.sku || "—",
      String(li.quantityOrdered),
      `$${li.unitCost.toFixed(2)}`,
      `$${(li.unitCost * li.quantityOrdered).toFixed(2)}`,
    ];
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      doc.text(
        vals[i],
        c.align === "right" ? x + c.width - 0.05 : x,
        y,
        { align: c.align },
      );
      x += c.width;
    }
    y += 0.18;
  }

  return y;
}

// ── Grid view (sizes as columns) ─────────────────────────────────────
function drawGridTable(
  doc: jsPDF,
  po: POForPdf,
  yStart: number,
  margin: number,
  pageWidth: number,
): number {
  // Build grid: collect sizes, group by (product + non-size options)
  const sizeSet = new Set<string>();
  const rowMap = new Map<
    string,
    {
      label: string;
      cost: number;
      retail: number;
      bySize: Record<string, { ordered: number; received: number }>;
    }
  >();

  for (const li of po.lineItems) {
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
    const key = label;
    if (!rowMap.has(key)) {
      rowMap.set(key, {
        label,
        cost: li.unitCost,
        retail: li.retailPrice,
        bySize: {},
      });
    }
    rowMap.get(key)!.bySize[size] = {
      ordered: li.quantityOrdered,
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

  const productColWidth = 3.2;
  const priceColWidth = 0.8;
  const totalColWidth = 0.8;
  const sizeColWidth = Math.max(
    0.5,
    (pageWidth -
      2 * margin -
      productColWidth -
      priceColWidth -
      totalColWidth) /
      Math.max(sizes.length, 1),
  );

  let y = yStart + 0.2;

  // Header
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  let x = margin;
  doc.text("Product", x, y);
  x += productColWidth;
  doc.text("Cost", x + priceColWidth - 0.05, y, { align: "right" });
  x += priceColWidth;
  for (const size of sizes) {
    doc.text(size, x + sizeColWidth / 2, y, { align: "center" });
    x += sizeColWidth;
  }
  doc.text("Total", x + totalColWidth - 0.05, y, { align: "right" });
  doc.setLineWidth(0.01);
  doc.line(margin, y + 0.07, pageWidth - margin, y + 0.07);
  y += 0.2;

  // Rows
  doc.setFont("helvetica", "normal");
  for (const row of rowMap.values()) {
    if (y > 7.5) {
      doc.addPage();
      y = 0.5;
    }
    x = margin;
    doc.text(truncate(row.label, 44), x, y);
    x += productColWidth;
    doc.text(`$${row.cost.toFixed(2)}`, x + priceColWidth - 0.05, y, {
      align: "right",
    });
    x += priceColWidth;

    let rowTotal = 0;
    for (const size of sizes) {
      const cell = row.bySize[size];
      if (cell) {
        const label =
          cell.received > 0
            ? `${cell.ordered} (${cell.received})`
            : `${cell.ordered}`;
        doc.text(label, x + sizeColWidth / 2, y, { align: "center" });
        rowTotal += cell.ordered;
      } else {
        doc.text("—", x + sizeColWidth / 2, y, { align: "center" });
      }
      x += sizeColWidth;
    }
    doc.setFont("helvetica", "bold");
    doc.text(String(rowTotal), x + totalColWidth - 0.05, y, {
      align: "right",
    });
    doc.setFont("helvetica", "normal");
    y += 0.18;
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
