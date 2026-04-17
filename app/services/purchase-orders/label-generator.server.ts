import bwipjs from "bwip-js";
import { jsPDF } from "jspdf";

interface LabelItem {
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  barcode: string | null;
  quantityOrdered: number;
}

export async function generateLabelsPDF(lineItems: LabelItem[]): Promise<Buffer> {
  // Label dimensions: 2.25" x 1.25" for thermal printers (Dymo/Zebra)
  const labelWidth = 2.25;
  const labelHeight = 1.25;
  const doc = new jsPDF({ unit: "in", format: [labelWidth, labelHeight] });

  let isFirstPage = true;

  for (const item of lineItems) {
    const barcodeText = item.barcode || item.sku || "NO-BARCODE";

    // One label per unit ordered
    for (let i = 0; i < item.quantityOrdered; i++) {
      if (!isFirstPage) {
        doc.addPage([labelWidth, labelHeight]);
      }
      isFirstPage = false;

      // Product title (truncated)
      doc.setFontSize(8);
      doc.setFont("helvetica", "bold");
      const title = item.productTitle.length > 35
        ? item.productTitle.substring(0, 35) + "..."
        : item.productTitle;
      doc.text(title, 0.1, 0.2);

      // Variant info (color / size)
      doc.setFontSize(7);
      doc.setFont("helvetica", "normal");
      doc.text(item.variantTitle, 0.1, 0.35);

      // Barcode
      try {
        const barcodePng = await bwipjs.toBuffer({
          bcid: "code128",
          text: barcodeText,
          scale: 3,
          height: 8,
          includetext: false,
        });

        // Convert buffer to base64 for jsPDF
        const base64 = Buffer.from(barcodePng).toString("base64");
        const imgData = `data:image/png;base64,${base64}`;
        doc.addImage(imgData, "PNG", 0.15, 0.45, 1.95, 0.4);
      } catch {
        // If barcode generation fails, just print the text
        doc.setFontSize(10);
        doc.text(barcodeText, 0.1, 0.7);
      }

      // SKU text below barcode
      doc.setFontSize(6);
      doc.text(barcodeText, 0.1, 1.0);

      // Quantity indicator (e.g., "3 of 10")
      if (item.quantityOrdered > 1) {
        doc.text(`${i + 1} of ${item.quantityOrdered}`, 1.6, 1.0);
      }
    }
  }

  return Buffer.from(doc.output("arraybuffer"));
}
