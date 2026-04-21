import { Fragment, useMemo, type CSSProperties } from "react";
import { TextField, Text, InlineStack, Badge } from "@shopify/polaris";

/**
 * Shared "sizes-as-columns" grid used across PO create, PO receive, Inventory
 * Adjust, Stock Count, and Inventory Transfer.
 *
 * Input: a flat list of "cells" (one per variant). The component groups them
 *   into rows by (productId + non-size option values) and columns by size.
 *
 * Output: a table with editable qty inputs per cell. Cells that don't exist
 *   for a row render as "—".
 *
 * Design principles:
 *  - Presentational only. Parent owns the data + dispatches changes.
 *  - Non-size variants (Color, Material) join the row label.
 *  - Sizes sort in apparel order (XS, S, M, L, XL, 2XL, 3XL) then alphabetical.
 *  - Per-row info columns (cost, retail, stock, onOrder) are configurable.
 *  - Works for "qty to order", "qty to receive", "qty to count", "new qty" —
 *    parent labels the editable column.
 */

export interface GridCell {
  /** Unique variant identifier (Shopify variant gid or equivalent). */
  variantId: string;
  /** Stable product identifier — rows group by this + non-size options. */
  productId: string;
  productTitle: string;
  /** The full variant title — fallback label if no options set. */
  variantTitle: string;
  /** All variant options (name + value). Size is extracted; rest become row label. */
  selectedOptions: Array<{ name: string; value: string }>;
  sku?: string | null;

  /** Display-only per-row info (summed across sizes in a row). */
  cost?: number;
  retail?: number;
  stock?: number;
  onOrder?: number;

  /**
   * Current editable value for this cell. `null` renders an empty input —
   * stock count uses this to distinguish "not counted yet" from "counted
   * zero". For everything else pass a number.
   */
  value: number | null;
}

interface ProductGridProps {
  cells: GridCell[];
  /** Column header for the editable number input (e.g. "Order Qty", "Counted"). */
  qtyLabel?: string;
  /** Optional suffix for row totals (e.g. "$" for PO cost). */
  rowTotalPrefix?: string;
  /** Compute the per-row total from a cell's value and info. Defaults to sum of values. */
  computeRowTotal?: (rowCells: GridCell[]) => number;
  /** Called when any cell value changes. */
  onCellChange: (variantId: string, nextValue: number) => void;
  /** Which display columns to show. Default: all. */
  showColumns?: {
    cost?: boolean;
    retail?: boolean;
    stock?: boolean;
    onOrder?: boolean;
  };
  /** Min for the qty inputs. Default 0. */
  min?: number;
  /** Allow negative values (for "New Qty" adjustments where user wants to set lower). Default false. */
  allowNegative?: boolean;
  /** Readonly mode — disables all inputs (viewing an already-received PO). */
  readonly?: boolean;
  /**
   * Optional per-cell style override. Stock count uses this to paint
   * counted cells (countedQuantity !== null) green so the user can see
   * at a glance what's done and what remains.
   */
  getCellStyle?: (cell: GridCell) => CSSProperties | undefined;
  /**
   * Optional right-side group-by header. Stock count uses this to group
   * rows by vendor. Callers return the header string for each row; rows
   * with the same header get grouped (rendered with a section divider).
   * Return null to include the row without a group header.
   */
  groupBy?: (row: {
    productId: string;
    productTitle: string;
    cells: GridCell[];
  }) => string | null;
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

interface GroupedRow {
  key: string;
  productId: string;
  productTitle: string;
  nonSizeLabel: string;
  bySize: Record<string, GridCell>;
  // Summed across all cells in the row for display
  cost: number;
  retail: number;
  stock: number;
  onOrder: number;
}

export function ProductGrid({
  cells,
  qtyLabel = "Qty",
  rowTotalPrefix = "",
  computeRowTotal,
  onCellChange,
  showColumns = { cost: true, retail: true, stock: true, onOrder: true },
  min = 0,
  allowNegative = false,
  readonly = false,
  getCellStyle,
  groupBy,
}: ProductGridProps) {
  const { rows, sizes } = useMemo(() => {
    const sizeSet = new Set<string>();
    const groups: Record<string, GroupedRow> = {};

    for (const cell of cells) {
      const sizeOpt = cell.selectedOptions.find(
        (o) => o.name.toLowerCase() === "size",
      );
      const sizeVal = sizeOpt?.value || "Default";
      sizeSet.add(sizeVal);

      const nonSizeLabel = cell.selectedOptions
        .filter((o) => o.name.toLowerCase() !== "size")
        .map((o) => o.value)
        .join(" / ");

      const rowKey = `${cell.productId}::${nonSizeLabel}`;

      if (!groups[rowKey]) {
        groups[rowKey] = {
          key: rowKey,
          productId: cell.productId,
          productTitle: cell.productTitle,
          nonSizeLabel,
          bySize: {},
          cost: 0,
          retail: 0,
          stock: 0,
          onOrder: 0,
        };
      }
      groups[rowKey].bySize[sizeVal] = cell;
      // Aggregate row info — sum where it makes sense (stock), take max/first for price
      const r = groups[rowKey];
      r.stock += cell.stock ?? 0;
      r.onOrder += cell.onOrder ?? 0;
      if (cell.cost && !r.cost) r.cost = cell.cost;
      if (cell.retail && !r.retail) r.retail = cell.retail;
    }

    return {
      rows: Object.values(groups),
      sizes: [...sizeSet].sort(compareSizes),
    };
  }, [cells]);

  if (cells.length === 0) {
    return (
      <Text as="p" tone="subdued">
        No products selected yet.
      </Text>
    );
  }

  const minAttr = allowNegative ? undefined : min;

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: "13px",
        }}
      >
        <thead>
          <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
            <th style={{ padding: "8px", textAlign: "left", minWidth: "200px" }}>
              Product / Variant
            </th>
            {showColumns.cost && (
              <th style={{ padding: "8px", textAlign: "right" }}>Cost</th>
            )}
            {showColumns.retail && (
              <th style={{ padding: "8px", textAlign: "right" }}>Retail</th>
            )}
            {showColumns.stock && (
              <th style={{ padding: "8px", textAlign: "right" }}>Stock</th>
            )}
            {showColumns.onOrder && (
              <th style={{ padding: "8px", textAlign: "right" }}>On Order</th>
            )}
            {sizes.map((size) => (
              <th
                key={size}
                style={{
                  padding: "8px",
                  textAlign: "center",
                  minWidth: "64px",
                }}
              >
                {size}
              </th>
            ))}
            <th style={{ padding: "8px", textAlign: "right" }}>
              Row Total
            </th>
          </tr>
        </thead>
        <tbody>
          {(() => {
            // Compute group labels once per row (avoids O(N^2) when the
            // caller's groupBy is itself linear, as the stock count's
            // vendor lookup is) and detect header transitions inline.
            const groupLabels = groupBy
              ? rows.map((row) =>
                  groupBy({
                    productId: row.productId,
                    productTitle: row.productTitle,
                    cells: Object.values(row.bySize),
                  }),
                )
              : null;

            return rows.map((row, rowIdx) => {
            const rowCells = Object.values(row.bySize);
            const rowTotal = computeRowTotal
              ? computeRowTotal(rowCells)
              : rowCells.reduce((sum, c) => sum + (c.value ?? 0), 0);

            const groupLabel = groupLabels ? groupLabels[rowIdx] : null;
            const prevGroupLabel =
              groupLabels && rowIdx > 0 ? groupLabels[rowIdx - 1] : null;
            const showGroupHeader =
              groupLabel != null && groupLabel !== prevGroupLabel;
            const colSpan =
              1 +
              (showColumns.cost ? 1 : 0) +
              (showColumns.retail ? 1 : 0) +
              (showColumns.stock ? 1 : 0) +
              (showColumns.onOrder ? 1 : 0) +
              sizes.length +
              1;

            return (
              <Fragment key={row.key}>
              {showGroupHeader && (
                <tr style={{ background: "#f6f6f7" }}>
                  <td
                    colSpan={colSpan}
                    style={{
                      padding: "8px 12px",
                      fontSize: "12px",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: "#4a4a4a",
                    }}
                  >
                    {groupLabel}
                  </td>
                </tr>
              )}
              <tr style={{ borderBottom: "1px solid #f1f1f1" }}>
                <td style={{ padding: "8px", fontWeight: 500 }}>
                  <InlineStack gap="100" blockAlign="center">
                    <Text as="span" variant="bodyMd">
                      {row.productTitle}
                    </Text>
                    {row.nonSizeLabel && (
                      <Badge tone="info">{row.nonSizeLabel}</Badge>
                    )}
                  </InlineStack>
                </td>
                {showColumns.cost && (
                  <td style={{ padding: "8px", textAlign: "right" }}>
                    {row.cost ? `$${row.cost.toFixed(2)}` : "—"}
                  </td>
                )}
                {showColumns.retail && (
                  <td style={{ padding: "8px", textAlign: "right" }}>
                    {row.retail ? `$${row.retail.toFixed(2)}` : "—"}
                  </td>
                )}
                {showColumns.stock && (
                  <td style={{ padding: "8px", textAlign: "right" }}>
                    {row.stock}
                  </td>
                )}
                {showColumns.onOrder && (
                  <td style={{ padding: "8px", textAlign: "right" }}>
                    {row.onOrder > 0 ? row.onOrder : "—"}
                  </td>
                )}
                {sizes.map((size) => {
                  const cell = row.bySize[size];
                  if (!cell) {
                    return (
                      <td
                        key={size}
                        style={{
                          padding: "4px",
                          textAlign: "center",
                          background: "#fafafa",
                          color: "#9ca3af",
                        }}
                      >
                        —
                      </td>
                    );
                  }
                  const cellStyle = getCellStyle?.(cell);
                  return (
                    <td
                      key={size}
                      style={{ padding: "2px 4px", ...(cellStyle ?? {}) }}
                    >
                      <TextField
                        label={qtyLabel}
                        labelHidden
                        value={cell.value === null ? "" : String(cell.value)}
                        onChange={(val) => {
                          const parsed = allowNegative
                            ? parseInt(val, 10)
                            : Math.max(min, parseInt(val, 10) || 0);
                          onCellChange(
                            cell.variantId,
                            Number.isFinite(parsed) ? parsed : 0,
                          );
                        }}
                        type="number"
                        min={minAttr}
                        autoComplete="off"
                        disabled={readonly}
                      />
                    </td>
                  );
                })}
                <td
                  style={{
                    padding: "8px",
                    textAlign: "right",
                    fontWeight: 600,
                  }}
                >
                  {rowTotalPrefix}
                  {rowTotal.toFixed(rowTotalPrefix === "$" ? 2 : 0)}
                </td>
              </tr>
              </Fragment>
            );
            });
          })()}
        </tbody>
      </table>
    </div>
  );
}
