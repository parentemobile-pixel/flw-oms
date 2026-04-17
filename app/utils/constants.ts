export const MENS_SIZES = ["S", "M", "L", "XL", "2XL"];
export const WOMENS_SIZES = ["XS", "S", "M", "L", "XL"];

export const SIZE_MAP: Record<string, string[]> = {
  mens: MENS_SIZES,
  womens: WOMENS_SIZES,
  other: [],
};

export const PO_STATUSES = {
  DRAFT: "draft",
  ORDERED: "ordered",
  PARTIALLY_RECEIVED: "partially_received",
  RECEIVED: "received",
  CANCELLED: "cancelled",
} as const;

export const PO_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  ordered: "Ordered",
  partially_received: "Partially Received",
  received: "Received",
  cancelled: "Cancelled",
};

export const PO_STATUS_TONES: Record<string, "info" | "success" | "warning" | "critical" | "attention"> = {
  draft: "info",
  ordered: "attention",
  partially_received: "warning",
  received: "success",
  cancelled: "critical",
};
