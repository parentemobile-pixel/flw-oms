// Short labels for FL Woods stores, for places a full location name
// won't fit (PO grid cells, the PO list's Store column / filter). Known
// stores get their usual abbreviations (matches SRC/DEST labels on
// Replenishment); anything else falls back to the first three letters.
const LOCATION_SHORT_LABELS: Record<string, string> = {
  marblehead: "MHD",
  tiburon: "TB",
};

export function shortLocationLabel(name: string): string {
  const key = name.trim().toLowerCase();
  for (const [needle, label] of Object.entries(LOCATION_SHORT_LABELS)) {
    if (key.includes(needle)) return label;
  }
  return name.trim().slice(0, 3).toUpperCase();
}
