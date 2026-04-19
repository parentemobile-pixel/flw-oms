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
 * Thermal label generator: 2" × 1" landscape, one page per unit.
 *
 * Layout (inches, 2w × 1h):
 *
 *   ┌──────────────────────────────────────┐
 *   │ Product Title (8pt b)       $28.00   │  ← price always wins, title
 *   │                                      │     truncates to fit beside it
 *   │ M / Navy (9pt b)                     │  ← variant big + bold
 *   │ ┃┃ ┃┃ ┃┃┃┃ ┃┃ ┃┃ ┃┃ ┃┃ ┃┃┃┃┃       │  ← barcode, more compact
 *   │ FLW12345ABC (6pt)                    │  ← sku readback
 *   └──────────────────────────────────────┘
 *
 * Key choices:
 *  - Price is rendered first, its width is measured, then the product
 *    title is truncated to the remaining width so they never overlap.
 *  - Variant bumped to 9pt bold for legibility from a few feet away —
 *    size/color is the thing a stocker looks at most.
 *  - Barcode scale bumped from 3 → 5 so the output is significantly
 *    higher DPI (about 312 dpi across the 1.6" barcode width).
 *  - Removed the per-copy "N / M" counter that the user didn't want.
 */
export async function generateLabelsPDF(
  lineItems: LabelItem[],
): Promise<Buffer> {
  const labelWidth = 2.0;
  const labelHeight = 1.0;

  // Explicit landscape + format that ends up 2 wide × 1 tall.
  // jsPDF's landscape path swaps format values so wider becomes width.
  const doc = new jsPDF({
    orientation: "landscape",
    unit: "in",
    format: [labelHeight, labelWidth],
  });

  const margin = 0.05;
  const rightEdge = labelWidth - margin;

  let isFirstPage = true;

  for (const item of lineItems) {
    const barcodeText = item.barcode || item.sku || "";
    const priceStr =
      item.price != null && item.price > 0
        ? `$${item.price.toFixed(2)}`
        : "";

    for (let i = 0; i < item.quantityOrdered; i++) {
      if (!isFirstPage) {
        doc.addPage([labelHeight, labelWidth], "landscape");
      }
      isFirstPage = false;

      // ── Price (draw first so we can measure its width) ──
      let priceWidth = 0;
      if (priceStr) {
        doc.setFontSize(16);
        doc.setFont("helvetica", "bold");
        priceWidth = doc.getTextWidth(priceStr);
        doc.text(priceStr, rightEdge, 0.25, { align: "right" });
      }

      // ── Product title (fits in remaining space to the left of price) ──
      doc.setFontSize(8);
      doc.setFont("helvetica", "bold");
      // Reserve a 0.1" gap between title and price.
      const titleMaxWidth =
        priceStr === "" ? labelWidth - 2 * margin : rightEdge - priceWidth - 0.1 - margin;
      const fittedTitle = fitText(doc, item.productTitle, titleMaxWidth);
      doc.text(fittedTitle, margin, 0.16);

      // ── Variant — bigger + bolder so it's readable at a glance ──
      if (item.variantTitle && item.variantTitle.toLowerCase() !== "default title") {
        doc.setFontSize(9);
        doc.setFont("helvetica", "bold");
        const fittedVariant = fitText(
          doc,
          item.variantTitle,
          labelWidth - 2 * margin,
        );
        doc.text(fittedVariant, margin, 0.38);
      }

      // ── Barcode (smaller, centered, higher DPI) ──
      const barcodeW = 1.6;
      const barcodeH = 0.3;
      const barcodeX = (labelWidth - barcodeW) / 2;
      const barcodeY = 0.48;

      if (barcodeText) {
        try {
          const barcodePng = await bwipjs.toBuffer({
            bcid: "code128",
            text: barcodeText,
            // Higher scale → more pixels per bar → sharper print.
            scale: 5,
            height: 10,
            includetext: false,
          });
          const base64 = Buffer.from(barcodePng).toString("base64");
          const imgData = `data:image/png;base64,${base64}`;
          doc.addImage(
            imgData,
            "PNG",
            barcodeX,
            barcodeY,
            barcodeW,
            barcodeH,
            undefined,
            "NONE", // no compression — preserves barcode sharpness
          );
        } catch {
          // Fallback: print the code as plain text if bwip-js can't encode it.
          doc.setFontSize(12);
          doc.setFont("helvetica", "normal");
          doc.text(barcodeText, labelWidth / 2, barcodeY + 0.2, {
            align: "center",
          });
        }
      }

      // ── SKU / barcode text readback ──
      if (barcodeText) {
        doc.setFontSize(6);
        doc.setFont("helvetica", "normal");
        doc.text(barcodeText, labelWidth / 2, 0.9, { align: "center" });
      }
    }
  }

  return Buffer.from(doc.output("arraybuffer"));
}

/**
 * Truncate `text` until its rendered width fits in `maxWidth`. Uses jsPDF's
 * current font metrics, so call this AFTER setFontSize / setFont.
 */
function fitText(doc: jsPDF, text: string, maxWidth: number): string {
  if (!text) return "";
  if (doc.getTextWidth(text) <= maxWidth) return text;
  const ellipsis = "…";
  for (let len = text.length - 1; len > 0; len--) {
    const candidate = text.slice(0, len).trimEnd() + ellipsis;
    if (doc.getTextWidth(candidate) <= maxWidth) return candidate;
  }
  return ellipsis;
}
