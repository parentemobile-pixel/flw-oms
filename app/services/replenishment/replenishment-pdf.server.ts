import { jsPDF } from "jspdf";
import { format as formatDate } from "date-fns";

import { FLW_COMPANY_INFO } from "../../utils/constants";

/**
 * One flat row per (product × colorway × size) — the PDF regroups
 * these into product/colorway rows with one column per size, mirroring
 * the on-screen ProductGrid.
 */
export interface ReplenishmentPdfRow {
  productTitle: string;
  /** Non-size option values joined with " / " ("Navy", "Red / Wool"). */
  colorway: string;
  size: string;
  sku: string | null;
  sold: number;
  destinationAvailable: number;
  sourceAvailable: number;
  transferQty: number;
  box: number;
  note: string;
}

export interface ReplenishmentPdfOptions {
  rows: ReplenishmentPdfRow[];
  destinationName: string;
  sourceName: string;
  /** Short labels used inside the cells ("TIB", "MHD"). */
  destLabel: string;
  srcLabel: string;
  startDate: string;
  endDate: string;
}

const SIZE_ORDER = [
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
  "ONE SIZE",
];

function compareSizes(a: string, b: string): number {
  const ai = SIZE_ORDER.indexOf(a.toUpperCase());
  const bi = SIZE_ORDER.indexOf(b.toUpperCase());
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return a.localeCompare(b);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function formatDateSafe(d: string): string {
  try {
    return formatDate(new Date(`${d}T00:00:00`), "MMM d, yyyy");
  } catch {
    return d;
  }
}

/**
 * Landscape-letter snapshot of the replenishment grid: one row per
 * product/colorway, one column per size. Each cell shows the proposed
 * transfer qty in bold with "S sold · TIB n · MHD n" beneath, so the
 * printout carries the same information as the screen.
 */
export async function generateReplenishmentPdf(
  options: ReplenishmentPdfOptions,
): Promise<Buffer> {
  const { rows, destinationName, sourceName, destLabel, srcLabel } = options;

  const doc = new jsPDF({
    unit: "in",
    format: "letter",
    orientation: "landscape",
  });
  const pageWidth = 11;
  const pageHeight = 8.5;
  const margin = 0.5;
  // jsPDF's default line width is in *user units* — with unit "in"
  // that's a 0.2in slab. Hairline everything.
  doc.setLineWidth(0.005);

  // ── Header ─────────────────────────────────────────────────────────
  let y = margin;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("Replenishment", margin, y + 0.2);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(FLW_COMPANY_INFO.name, pageWidth - margin, y + 0.2, {
    align: "right",
  });
  y += 0.45;

  doc.setFontSize(10);
  doc.text(
    `From ${sourceName} (${srcLabel})  to  ${destinationName} (${destLabel})`,
    margin,
    y,
  );
  y += 0.2;
  doc.text(
    `Sales window: ${formatDateSafe(options.startDate)} – ${formatDateSafe(options.endDate)}`,
    margin,
    y,
  );
  const totalProposed = rows.reduce((s, r) => s + (r.transferQty || 0), 0);
  const totalSold = rows.reduce((s, r) => s + (r.sold || 0), 0);
  doc.text(
    `Generated ${formatDate(new Date(), "MMM d, yyyy h:mm a")}  ·  ${totalSold} sold  ·  ${totalProposed} units proposed`,
    pageWidth - margin,
    y,
    { align: "right" },
  );
  y += 0.15;
  doc.setDrawColor(200);
  doc.line(margin, y, pageWidth - margin, y);
  y += 0.2;

  // ── Regroup rows: (product, colorway) → size → row ─────────────────
  const sizeSet = new Set<string>();
  const groups = new Map<
    string,
    {
      productTitle: string;
      colorway: string;
      box: number;
      note: string;
      bySize: Record<string, ReplenishmentPdfRow>;
    }
  >();
  for (const r of rows) {
    const key = `${r.productTitle}::${r.colorway}`;
    sizeSet.add(r.size);
    if (!groups.has(key)) {
      groups.set(key, {
        productTitle: r.productTitle,
        colorway: r.colorway,
        box: r.box,
        note: r.note,
        bySize: {},
      });
    }
    groups.get(key)!.bySize[r.size] = r;
  }
  const sizes = [...sizeSet].sort(compareSizes);
  const groupList = [...groups.values()].sort((a, b) => {
    const p = a.productTitle.localeCompare(b.productTitle);
    return p !== 0 ? p : a.colorway.localeCompare(b.colorway);
  });

  // ── Column layout ──────────────────────────────────────────────────
  const productColW = 2.6;
  const noteColW = 1.7;
  const rowTotalColW = 0.6;
  const sizeColW = Math.max(
    0.55,
    (pageWidth - 2 * margin - productColW - noteColW - rowTotalColW) /
      Math.max(sizes.length, 1),
  );
  const rowH = 0.5;

  const drawHeader = (yy: number): number => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    let x = margin;
    doc.text("Product / Colorway", x, yy);
    x += productColW;
    for (const size of sizes) {
      doc.text(size, x + sizeColW / 2, yy, { align: "center" });
      x += sizeColW;
    }
    doc.text("Total", x + rowTotalColW, yy, { align: "right" });
    x += rowTotalColW;
    doc.text("Note", x + 0.1, yy);
    doc.setDrawColor(180);
    doc.line(margin, yy + 0.05, pageWidth - margin, yy + 0.05);
    doc.setFont("helvetica", "normal");
    return yy + 0.2;
  };

  y = drawHeader(y);

  for (const g of groupList) {
    if (y + rowH > pageHeight - margin) {
      doc.addPage();
      y = margin;
      y = drawHeader(y);
    }

    let x = margin;
    // Product / colorway + box
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text(truncate(g.productTitle, 40), x, y + 0.05);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    const sub = [g.colorway, g.box > 1 || groupList.some((o) => o.box > 1) ? `Box ${g.box}` : ""]
      .filter(Boolean)
      .join("  ·  ");
    if (sub) doc.text(truncate(sub, 48), x, y + 0.2);
    x += productColW;

    // Size cells
    let rowTotal = 0;
    for (const size of sizes) {
      const cell = g.bySize[size];
      const cx = x + sizeColW / 2;
      if (cell) {
        rowTotal += cell.transferQty || 0;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        doc.text(String(cell.transferQty || 0), cx, y + 0.08, {
          align: "center",
        });
        doc.setFont("helvetica", "normal");
        doc.setFontSize(6);
        doc.setTextColor(90);
        doc.text(`Sold ${cell.sold}`, cx, y + 0.2, { align: "center" });
        doc.text(
          `${destLabel} ${cell.destinationAvailable} · ${srcLabel} ${cell.sourceAvailable}`,
          cx,
          y + 0.29,
          { align: "center" },
        );
        doc.setTextColor(0);
      } else {
        doc.setFontSize(9);
        doc.setTextColor(160);
        doc.text("—", cx, y + 0.08, { align: "center" });
        doc.setTextColor(0);
      }
      x += sizeColW;
    }

    // Row total
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.text(String(rowTotal), x + rowTotalColW, y + 0.08, { align: "right" });
    doc.setFont("helvetica", "normal");
    x += rowTotalColW;

    // Note
    doc.setFontSize(7);
    const noteLines = doc.splitTextToSize(g.note || "", noteColW - 0.15);
    doc.text(noteLines.slice(0, 3), x + 0.1, y + 0.05);

    y += rowH - 0.12;
    doc.setDrawColor(230);
    doc.line(margin, y, pageWidth - margin, y);
    y += 0.12;
  }

  // Footer page numbers
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(120);
    doc.text(
      `Page ${i} of ${pageCount}`,
      pageWidth - margin,
      pageHeight - 0.3,
      { align: "right" },
    );
    doc.setTextColor(0);
  }

  return Buffer.from(doc.output("arraybuffer"));
}
