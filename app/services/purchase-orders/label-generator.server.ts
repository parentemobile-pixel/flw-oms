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
 *   │ M / Navy (9pt b)              $28.00 │  ← variant left, price right
 *   │ ┃┃ ┃┃ ┃┃┃┃ ┃┃ ┃┃ ┃┃ ┃┃ ┃┃┃┃┃       │  ← barcode (centered)
 *   │ FLW12345ABC (6pt)                    │  ← sku readback under barcode
 *   │ Womens Bystander Sweater (7pt)       │  ← product title, full width
 *   └──────────────────────────────────────┘
 *
 * Key choices:
 *  - Product title moved to the BOTTOM so it has the full 2" width
 *    available — no more getting truncated by the price.
 *  - Variant (size/color) takes the prominent top-left spot since
 *    that's what a stocker checks first.
 *  - Price stays in the top-right, 16pt bold.
 *  - Barcode centered at 1.6"×0.3" with scale 5 for ~312 DPI print sharpness.
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

      // ── Top-right: Price (16pt bold) ──
      let priceWidth = 0;
      if (priceStr) {
        doc.setFontSize(16);
        doc.setFont("helvetica", "bold");
        priceWidth = doc.getTextWidth(priceStr);
        doc.text(priceStr, rightEdge, 0.2, { align: "right" });
      }

      // ── Top-left: Variant (9pt bold) — the thing a stocker looks at ──
      const hasVariant =
        item.variantTitle &&
        item.variantTitle.toLowerCase() !== "default title";
      if (hasVariant) {
        doc.setFontSize(9);
        doc.setFont("helvetica", "bold");
        const variantMaxWidth =
          priceStr === ""
            ? labelWidth - 2 * margin
            : rightEdge - priceWidth - 0.1 - margin;
        const fittedVariant = fitText(
          doc,
          item.variantTitle,
          variantMaxWidth,
        );
        doc.text(fittedVariant, margin, 0.18);
      }

      // ── Middle: Barcode (centered, high DPI) ──
      const barcodeW = 1.6;
      const barcodeH = 0.3;
      const barcodeX = (labelWidth - barcodeW) / 2;
      // If there's no variant, pull the barcode up a touch since we have
      // more vertical room.
      const barcodeY = hasVariant ? 0.3 : 0.22;

      if (barcodeText) {
        try {
          const barcodePng = await bwipjs.toBuffer({
            bcid: "code128",
            text: barcodeText,
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
            "NONE",
          );
        } catch {
          doc.setFontSize(12);
          doc.setFont("helvetica", "normal");
          doc.text(barcodeText, labelWidth / 2, barcodeY + 0.2, {
            align: "center",
          });
        }
      }

      // ── Below barcode: SKU / barcode text readback ──
      const skuY = (barcodeY + barcodeH) + 0.1; // 0.1" below barcode
      if (barcodeText) {
        doc.setFontSize(6);
        doc.setFont("helvetica", "normal");
        doc.text(barcodeText, labelWidth / 2, skuY, { align: "center" });
      }

      // ── Bottom: Product Title (full width, truncates only if needed) ──
      doc.setFontSize(7);
      doc.setFont("helvetica", "normal");
      const fittedTitle = fitText(
        doc,
        item.productTitle,
        labelWidth - 2 * margin,
      );
      doc.text(fittedTitle, margin, 0.95);
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
