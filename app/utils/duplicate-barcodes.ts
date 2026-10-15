/**
 * A duplicate-barcode group made up entirely of these vendors' variants
 * is hidden by default on Product Issues — their shared barcodes are
 * expected. Mixed groups still show. Compared trimmed + lowercased.
 */
export const SUPPRESSED_DUPLICATE_VENDORS = ["colby davis"];

export function isSuppressedDuplicateGroup(group: {
  variants: Array<{ vendor: string | null }>;
}): boolean {
  return group.variants.every((v) =>
    SUPPRESSED_DUPLICATE_VENDORS.includes((v.vendor ?? "").trim().toLowerCase()),
  );
}
