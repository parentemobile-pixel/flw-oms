import Anthropic from "@anthropic-ai/sdk";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import {
  getProductsByVendor,
  searchProducts,
} from "../shopify-api/products.server";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExtractedLineItem {
  title: string | null;
  sku: string | null;
  color: string | null;
  size: string | null;
  quantity: number | null;
  unitCost: number | null;
  retailPrice: number | null;
}

export interface ExtractedPO {
  vendor: string | null;
  vendorPoNumber: string | null;
  lineItems: ExtractedLineItem[];
}

export interface MatchedVariant {
  shopifyProductId: string;
  shopifyVariantId: string;
  productTitle: string;
  variantTitle: string;
  sku: string;
  barcode: string;
  unitCost: number;
  retailPrice: number;
  currentStock: number;
  selectedOptions: Array<{ name: string; value: string }>;
}

export type MatchConfidence = "sku" | "title+options" | "title" | "none";

export interface MatchedLineItem {
  extracted: ExtractedLineItem;
  match: MatchedVariant | null;
  confidence: MatchConfidence;
  candidates: MatchedVariant[]; // top N ranked candidates for manual pick
}

export interface ImportedPO {
  vendor: string | null;
  vendorPoNumber: string | null;
  lines: MatchedLineItem[];
}

// ─── Claude extraction ───────────────────────────────────────────────────────

// Reuse the same SDK singleton pattern as api.chat.tsx.
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const EXTRACTION_SYSTEM_PROMPT = `You extract structured line items from a vendor purchase order, quote, or order confirmation PDF.

Be conservative. For each field, if the value is NOT clearly present in the document, return null — do NOT guess. Numbers (quantity, unitCost, retailPrice) must be exact; don't round or infer.

Return ONLY a JSON object with this shape (no markdown, no prose, no code fences):
{
  "vendor": string | null,          // the supplier/brand name printed on the document
  "vendorPoNumber": string | null,  // the vendor's PO / order / quote number if printed
  "lineItems": [
    {
      "title": string | null,       // product name / description as printed
      "sku": string | null,         // vendor SKU, style code, or product code
      "color": string | null,       // color / colorway if present
      "size": string | null,        // size (S, M, L, 32, etc.) if present
      "quantity": number | null,    // integer — units being ordered
      "unitCost": number | null,    // wholesale cost per unit in document currency
      "retailPrice": number | null  // MSRP / retail if listed, otherwise null
    }
  ]
}

Rules:
- If a row spans multiple sizes (size grid), emit one lineItem per size with the same title/sku/color.
- "quantity" must be an integer. If you can't read the quantity, emit null (do not emit 0).
- Don't include shipping, tax, discount, or subtotal rows as line items.
- Strip currency symbols from numeric fields. "$12.50" -> 12.5.
- If the PDF is unreadable or empty, return {"vendor": null, "vendorPoNumber": null, "lineItems": []}.`;

export class PDFImportError extends Error {
  code: "too_large" | "rate_limited" | "unreadable" | "api_error";
  constructor(
    code: "too_large" | "rate_limited" | "unreadable" | "api_error",
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

/**
 * Send a PDF to Claude and extract structured PO line items.
 * Throws PDFImportError with a code on failure.
 */
export async function extractPOFromPDF(pdfBuffer: Buffer): Promise<ExtractedPO> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new PDFImportError(
      "api_error",
      "ANTHROPIC_API_KEY is not configured on the server.",
    );
  }

  // Anthropic's PDF support has a soft limit around 32MB / 100 pages.
  // We reject anything over 20MB early to fail fast with a clearer message.
  const MAX_BYTES = 20 * 1024 * 1024;
  if (pdfBuffer.byteLength > MAX_BYTES) {
    throw new PDFImportError(
      "too_large",
      `PDF is ${(pdfBuffer.byteLength / 1024 / 1024).toFixed(1)}MB — too large. Split into smaller files (max 20MB).`,
    );
  }

  const base64 = pdfBuffer.toString("base64");

  let response: Anthropic.Message;
  try {
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: base64,
              },
            },
            {
              type: "text",
              text: "Extract the vendor PO line items from this document. Return only the JSON object described in the system prompt.",
            },
          ],
        },
      ],
    });
  } catch (err: any) {
    const status = err?.status;
    if (status === 429) {
      throw new PDFImportError(
        "rate_limited",
        "Claude rate-limited the extraction. Wait a minute and try again, or start the PO manually.",
      );
    }
    if (status === 400 || status === 413) {
      throw new PDFImportError(
        "too_large",
        "PDF couldn't be processed (too large or unsupported). Try splitting it into pages.",
      );
    }
    throw new PDFImportError(
      "api_error",
      `Claude extraction failed: ${err?.message || err}`,
    );
  }

  const textBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  if (!textBlock) {
    throw new PDFImportError(
      "unreadable",
      "Claude returned no text — the PDF may be image-only or unreadable.",
    );
  }

  // Tolerate stray markdown fences just in case.
  const raw = textBlock.text.trim();
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new PDFImportError(
      "unreadable",
      "Claude's response wasn't valid JSON — the PDF may be unreadable.",
    );
  }

  return normalizeExtracted(parsed);
}

function normalizeExtracted(raw: unknown): ExtractedPO {
  if (!raw || typeof raw !== "object") {
    return { vendor: null, vendorPoNumber: null, lineItems: [] };
  }
  const obj = raw as Record<string, unknown>;
  const vendor = typeof obj.vendor === "string" ? obj.vendor.trim() : null;
  const vendorPoNumber =
    typeof obj.vendorPoNumber === "string" ? obj.vendorPoNumber.trim() : null;
  const items = Array.isArray(obj.lineItems) ? obj.lineItems : [];
  const lineItems: ExtractedLineItem[] = items.map((it) => {
    const row = (it ?? {}) as Record<string, unknown>;
    return {
      title: asString(row.title),
      sku: asString(row.sku),
      color: asString(row.color),
      size: asString(row.size),
      quantity: asInt(row.quantity),
      unitCost: asNumber(row.unitCost),
      retailPrice: asNumber(row.retailPrice),
    };
  });
  return { vendor, vendorPoNumber, lineItems };
}

function asString(v: unknown): string | null {
  if (typeof v === "string") {
    const s = v.trim();
    return s.length > 0 ? s : null;
  }
  return null;
}
function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function asInt(v: unknown): number | null {
  const n = asNumber(v);
  return n === null ? null : Math.round(n);
}

// ─── Variant matching ────────────────────────────────────────────────────────

/**
 * Match each extracted line to a real Shopify variant.
 * Strategy (best -> worst):
 *   1. Exact SKU match (via top-level product search by SKU)
 *   2. Fuzzy title + color + size match within the vendor's catalog
 *   3. Fuzzy title only within the vendor's catalog
 * The top 8 candidates are always returned so the user can override.
 */
export async function matchExtractedLines(
  admin: AdminApiContext,
  extracted: ExtractedPO,
): Promise<MatchedLineItem[]> {
  const vendor = extracted.vendor;

  // Preload the vendor's catalog once. Cheap for small vendors, bounded in size
  // because getProductsByVendor paginates internally.
  let catalog: Array<Record<string, any>> = [];
  if (vendor) {
    try {
      catalog = (await getProductsByVendor(admin, vendor)) as any[];
    } catch {
      catalog = [];
    }
  }
  const catalogVariants = flattenVariants(catalog);

  const results: MatchedLineItem[] = [];
  for (const line of extracted.lineItems) {
    const candidates: MatchedVariant[] = [];
    let match: MatchedVariant | null = null;
    let confidence: MatchConfidence = "none";

    // 1. SKU lookup — do an authoritative search first.
    if (line.sku) {
      try {
        const byShopSearch = await searchProducts(
          admin,
          `sku:${JSON.stringify(line.sku)}`,
        );
        const edges = (byShopSearch?.edges ?? []) as any[];
        const skuVariants = flattenVariants(edges.map((e) => e.node));
        const exact = skuVariants.find(
          (v) => (v.sku || "").toLowerCase() === line.sku!.toLowerCase(),
        );
        if (exact) {
          match = exact;
          confidence = "sku";
          candidates.push(exact);
        }
      } catch {
        /* fall through */
      }
    }

    // Also consider SKU match inside the vendor catalog (covers exact-dupe SKUs).
    if (!match && line.sku) {
      const byCatalogSku = catalogVariants.find(
        (v) =>
          (v.sku || "").toLowerCase() === (line.sku || "").toLowerCase() &&
          line.sku,
      );
      if (byCatalogSku) {
        match = byCatalogSku;
        confidence = "sku";
        candidates.push(byCatalogSku);
      }
    }

    // 2. Title + options fuzzy match within the vendor catalog.
    if (catalogVariants.length > 0) {
      const ranked = rankByFuzzy(catalogVariants, line);
      for (const r of ranked.slice(0, 8)) {
        if (!candidates.some((c) => c.shopifyVariantId === r.variant.shopifyVariantId)) {
          candidates.push(r.variant);
        }
      }
      if (!match && ranked.length > 0 && ranked[0].score >= 3) {
        match = ranked[0].variant;
        confidence = ranked[0].matchedOptions ? "title+options" : "title";
      }
    }

    results.push({
      extracted: line,
      match,
      confidence,
      candidates: candidates.slice(0, 8),
    });
  }
  return results;
}

function flattenVariants(products: any[]): MatchedVariant[] {
  const out: MatchedVariant[] = [];
  for (const p of products) {
    const pId = p?.id;
    const pTitle = p?.title ?? "";
    const edges =
      p?.variants?.edges ?? // searchProducts shape
      (p?.variants ? p.variants.edges ?? [] : []);
    for (const e of edges) {
      const v = e?.node ?? e;
      if (!v) continue;
      const cost = v?.inventoryItem?.unitCost?.amount
        ? parseFloat(v.inventoryItem.unitCost.amount)
        : 0;
      out.push({
        shopifyProductId: pId,
        shopifyVariantId: v.id,
        productTitle: pTitle,
        variantTitle: v.title ?? "",
        sku: v.sku ?? "",
        barcode: v.barcode ?? "",
        unitCost: cost,
        retailPrice: parseFloat(v.price ?? "0") || 0,
        currentStock: v.inventoryQuantity ?? 0,
        selectedOptions: v.selectedOptions ?? [],
      });
    }
  }
  return out;
}

function rankByFuzzy(
  variants: MatchedVariant[],
  line: ExtractedLineItem,
): Array<{ variant: MatchedVariant; score: number; matchedOptions: boolean }> {
  const titleTokens = tokenize(line.title);
  const color = (line.color || "").toLowerCase();
  const size = (line.size || "").toLowerCase();
  if (titleTokens.length === 0 && !color && !size) return [];

  const ranked = variants.map((v) => {
    const haystack = `${v.productTitle} ${v.variantTitle}`.toLowerCase();
    let score = 0;
    for (const tok of titleTokens) {
      if (haystack.includes(tok)) score += 1;
    }
    const options = (v.selectedOptions || []).map((o) => ({
      name: (o.name || "").toLowerCase(),
      value: (o.value || "").toLowerCase(),
    }));
    let matchedOptions = false;
    if (color) {
      const hasColor = options.some((o) => o.value === color) ||
        haystack.includes(color);
      if (hasColor) {
        score += 2;
        matchedOptions = true;
      }
    }
    if (size) {
      const hasSize = options.some(
        (o) => o.name.includes("size") && o.value === size,
      );
      if (hasSize) {
        score += 2;
        matchedOptions = matchedOptions || true;
      }
    }
    return { variant: v, score, matchedOptions };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked.filter((r) => r.score > 0);
}

function tokenize(text: string | null): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 12);
}
