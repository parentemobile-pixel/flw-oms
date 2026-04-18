/**
 * Deterministic barcode generation for SKUs.
 *
 * Design goals:
 *  - Unique per variant, short enough to fit a 2.25" × 1.25" thermal label
 *  - Scannable on CODE128 (our label format via bwip-js)
 *  - Non-colliding with Shopify's auto-assigned GTINs (prefix with "FLW")
 *  - Deterministic from variant ID so reruns give the same code
 *
 * Format: `FLW` + 10 base36 chars derived from hashing the variant ID.
 * Example: `FLW9K2X4Z7A3B1Q`  (total 13 chars — fits comfortably on a thermal label)
 *
 * This is NOT a real EAN/UPC. Retailers who need EAN-compliant codes would buy
 * a GS1 prefix, but for internal inventory tracking (our stores, our labels,
 * our scanners) FLW-prefixed CODE128 is the standard and what we already use
 * on existing inventory.
 */

import { createHash } from "node:crypto";

const PREFIX = "FLW";
const HASH_LENGTH = 10;

/**
 * Generate a deterministic barcode for a Shopify variant ID.
 * Same variant always produces the same barcode.
 */
export function generateBarcodeForVariant(variantGid: string): string {
  // variantGid looks like "gid://shopify/ProductVariant/123456789"
  // Hash the full gid to get a stable fingerprint.
  const hash = createHash("sha256").update(variantGid).digest("hex");
  // Convert hex to base36 using BigInt for larger, friendlier chars.
  const bigNum = BigInt("0x" + hash.slice(0, 24));
  const code = bigNum.toString(36).toUpperCase().slice(0, HASH_LENGTH);
  return `${PREFIX}${code.padStart(HASH_LENGTH, "0")}`;
}

/**
 * Generate a unique barcode not tied to a variant — used when we need to
 * print extra labels or mint a barcode before a variant exists.
 * Format: FLW + timestamp + random.
 */
export function generateRandomBarcode(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${PREFIX}${ts}${rand}`;
}

/**
 * Validate that a string looks like one of our generated barcodes.
 * Useful for filter/search UIs.
 */
export function isFLWBarcode(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.startsWith(PREFIX) && value.length >= PREFIX.length + 6;
}
