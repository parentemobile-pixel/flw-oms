import bwipjs from "bwip-js";
import { jsPDF } from "jspdf";

interface LabelItem {
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  barcode: string | null;
  /** Retail price in dollars. Rendered large as the most prominent element. */
  price?: number | null;
  /** Number of copies of this label to generate. */
  quantityOrdered: number;
}

/**
 * Generate a PDF of thermal labels at 2" × 1" (landscape). One page per unit
 * ordered.
 *
 * Layout (inches, 2w × 1h):
 *
 *  ┌──────────────────────────────────┐
 *  │ Product Title (bold 7pt)  $28    │  <- title left, price right (14pt bold)
 *  │ Variant (6pt)                    │
 *  │ ||||||barcode|||||||||||||||     │
 *  │ FLW12345ABC (5pt)                │
 *  └──────────────────────────────────┘
 *
 * Previously this defaulted to portrait, which swapped dimensions to 1.25×2.25
 * making the content look 90° rotated relative to the physical label stock.
 * Now explicitly landscape and passing [height, width] so jsPDF produces a
 * 2-wide × 1-tall page.
 */
export async function generateLabelsPDF(
  lineItems: LabelItem[],
): Promise<Buffer> {
  // Inches. Width > height, landscape.
  const labelWidth = 2.0;
  const labelHeight = 1.0;

  // jsPDF custom format: pass dimensions and orientation explicitly.
  // format: [width, height] with orientation: 'landscape' is the safest way
  // to get consistent page dimensions regardless of jsPDF's short/long edge
  // sorting behavior.
  const doc = new jsPDF({
    orientation: "landscape",
    unit: "in",
    format: [labelHeight, labelWidth],
  });

  let isFirstPage = true;

  for (const item of lineItems) {
    const barcodeText = item.barcode || item.sku || "";
    const priceStr =
      item.price != null && item.price > 0
        ? `$${item.price.toFixed(2)}`
        : "";

    // One label per unit ordered.
    for (let i = 0; i < item.quantityOrdered; i++) {
      if (!isFirstPage) {
        doc.addPage([labelHeight, labelWidth], "landscape");
      }
      isFirstPage = false;

      // ── Top row: product title (left) + price (right, largest element) ──
      doc.setFontSize(7);
      doc.setFont("helvetica", "bold");
      const titleMax = priceStr ? 22 : 30;
      const title =
        item.productTitle.length > titleMax
          ? item.productTitle.slice(0, titleMax) + "…"
          : item.productTitle;
      doc.text(title, 0.05, 0.13);

      if (priceStr) {
        doc.setFontSize(14);
        doc.setFont("helvetica", "bold");
        // Right-align the price. jsPDF's align option needs the x value to
        // equal the right edge of the text.
        doc.text(priceStr, labelWidth - 0.05, 0.2, { align: "right" });
      }

      // ── Variant info (color / size) ─────────────────────────────────────
      doc.setFontSize(6);
      doc.setFont("helvetica", "normal");
      const variantMax = priceStr ? 26 : 34;
      const variantText =
        item.variantTitle.length > variantMax
          ? item.variantTitle.slice(0, variantMax) + "…"
          : item.variantTitle;
      doc.text(variantText, 0.05, 0.26);

      // ── Barcode (full width) ─────────────────────────────────────────────
      const barcodeX = 0.05;
      const barcodeY = 0.32;
      const barcodeW = labelWidth - 0.1; // 1.9"
      const barcodeH = 0.42;

      if (barcodeText) {
        try {
          const barcodePng = await bwipjs.toBuffer({
            bcid: "code128",
            text: barcodeText,
            scale: 3,
            height: 8,
            includetext: false,
          });
          const base64 = Buffer.from(barcodePng).toString("base64");
          const imgData = `data:image/png;base64,${base64}`;
          doc.addImage(imgData, "PNG", barcodeX, barcodeY, barcodeW, barcodeH);
        } catch {
          // If bwip-js can't encode the text (unusual chars), fall back to
          // plain large text so the label is still scannable by SKU readout.
          doc.setFontSize(12);
          doc.setFont("helvetica", "normal");
          doc.text(barcodeText, labelWidth / 2, 0.55, { align: "center" });
        }
      }

      // ── SKU / barcode text below the barcode ───────────────────────────
      if (barcodeText) {
        doc.setFontSize(5);
        doc.setFont("helvetica", "normal");
        doc.text(barcodeText, labelWidth / 2, 0.88, { align: "center" });
      }

      // ── "N of M" indicator when printing multiple copies ───────────────
      if (item.quantityOrdered > 1) {
        doc.setFontSize(5);
        doc.setFont("helvetica", "normal");
        doc.text(
          `${i + 1} / ${item.quantityOrdered}`,
          labelWidth - 0.05,
          0.96,
          { align: "right" },
        );
      }
    }
  }

  return Buffer.from(doc.output("arraybuffer"));
}
