import { BlockStack, InlineStack, Text, Checkbox, Badge } from "@shopify/polaris";

/**
 * Nested product/variant picker shared by PO create and Inventory
 * Transfer create. Renders search-result products as cards; within
 * each card, variants that have BOTH a size and a non-size axis
 * (color / material) are grouped by the non-size value with a
 * group-level "select all" checkbox, then listed by size. Products
 * with only one axis (or none) fall back to a flat checkbox grid.
 *
 * Presentational only — the parent owns selection state and decides
 * what "selecting a variant" means (a PO line, a transfer line, …).
 */

export interface PickerVariant {
  id: string;
  title: string;
  sku: string | null;
  selectedOptions: Array<{ name: string; value: string }>;
  /** Optional stock badge shown next to the variant. */
  inStock?: number | null;
  /** Optional cost badge ($) shown next to the variant. */
  cost?: number | null;
}

export interface PickerProduct {
  id: string;
  title: string;
  variants: PickerVariant[];
}

interface ProductPickerProps {
  products: PickerProduct[];
  /** Set of currently-selected variant ids. */
  selectedVariantIds: Set<string>;
  onToggleVariant: (
    product: PickerProduct,
    variant: PickerVariant,
    checked: boolean,
  ) => void;
  onToggleGroup: (
    product: PickerProduct,
    variants: PickerVariant[],
    checked: boolean,
  ) => void;
}

const SIZE_OPTION_NAMES = new Set(["size", "sizes"]);
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

function variantBadge(v: PickerVariant): string {
  const parts: string[] = [];
  if (v.inStock != null) parts.push(`${v.inStock} in stock`);
  if (v.cost != null && v.cost > 0) parts.push(`$${v.cost.toFixed(2)}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

export function ProductPicker({
  products,
  selectedVariantIds,
  onToggleVariant,
  onToggleGroup,
}: ProductPickerProps) {
  if (products.length === 0) return null;

  return (
    <BlockStack gap="300">
      {products.map((product) => {
        const allVariantIds = product.variants.map((v) => v.id);
        const selectedCount = allVariantIds.filter((id) =>
          selectedVariantIds.has(id),
        ).length;
        const allSelected =
          selectedCount === product.variants.length &&
          product.variants.length > 0;

        return (
          <div
            key={product.id}
            style={{
              borderRadius: "8px",
              border: "1px solid #e1e3e5",
              padding: "12px",
            }}
          >
            <BlockStack gap="200">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <Checkbox
                    label=""
                    labelHidden
                    checked={allSelected}
                    onChange={(checked) =>
                      onToggleGroup(product, product.variants, checked)
                    }
                  />
                  <Text as="p" variant="bodyMd" fontWeight="bold">
                    {product.title}
                  </Text>
                  {selectedCount > 0 && (
                    <Badge tone="info">{`${selectedCount} selected`}</Badge>
                  )}
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  {product.variants.length} variant
                  {product.variants.length !== 1 ? "s" : ""}
                </Text>
              </InlineStack>
              <ProductVariantPicker
                product={product}
                selectedVariantIds={selectedVariantIds}
                onToggleVariant={onToggleVariant}
                onToggleGroup={onToggleGroup}
              />
            </BlockStack>
          </div>
        );
      })}
    </BlockStack>
  );
}

function ProductVariantPicker({
  product,
  selectedVariantIds,
  onToggleVariant,
  onToggleGroup,
}: {
  product: PickerProduct;
  selectedVariantIds: Set<string>;
  onToggleVariant: ProductPickerProps["onToggleVariant"];
  onToggleGroup: ProductPickerProps["onToggleGroup"];
}) {
  const variants = product.variants;
  const optionNames = new Set<string>();
  for (const v of variants) {
    for (const o of v.selectedOptions ?? []) optionNames.add(o.name);
  }
  const hasSize = [...optionNames].some((n) =>
    SIZE_OPTION_NAMES.has(n.toLowerCase()),
  );
  const hasNonSize = [...optionNames].some(
    (n) => !SIZE_OPTION_NAMES.has(n.toLowerCase()),
  );
  const shouldGroup = hasSize && hasNonSize;

  if (!shouldGroup) {
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: "4px",
          paddingLeft: "28px",
        }}
      >
        {variants.map((variant) => {
          const isSelected = selectedVariantIds.has(variant.id);
          return (
            <div
              key={variant.id}
              style={{
                padding: "4px 8px",
                borderRadius: "6px",
                background: isSelected ? "#f0f7ff" : "transparent",
              }}
            >
              <Checkbox
                label={
                  <Text as="span" variant="bodySm">
                    {variant.title}
                    <Text as="span" variant="bodySm" tone="subdued">
                      {variantBadge(variant)}
                    </Text>
                  </Text>
                }
                checked={isSelected}
                onChange={(checked) =>
                  onToggleVariant(product, variant, checked)
                }
              />
            </div>
          );
        })}
      </div>
    );
  }

  // Group by non-size option values.
  const groupMap = new Map<string, PickerVariant[]>();
  for (const v of variants) {
    const nonSize = (v.selectedOptions ?? [])
      .filter((o) => !SIZE_OPTION_NAMES.has(o.name.toLowerCase()))
      .map((o) => o.value);
    const key = nonSize.join(" / ") || "(default)";
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(v);
  }
  for (const group of groupMap.values()) {
    group.sort((a, b) => {
      const sa =
        a.selectedOptions.find((o) =>
          SIZE_OPTION_NAMES.has(o.name.toLowerCase()),
        )?.value ?? "";
      const sb =
        b.selectedOptions.find((o) =>
          SIZE_OPTION_NAMES.has(o.name.toLowerCase()),
        )?.value ?? "";
      return compareSizes(sa, sb);
    });
  }
  const groups = [...groupMap.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return (
    <BlockStack gap="200">
      {groups.map(([label, groupVariants]) => {
        const totalInGroup = groupVariants.length;
        const selectedInGroup = groupVariants.filter((v) =>
          selectedVariantIds.has(v.id),
        ).length;
        const allSelected = selectedInGroup === totalInGroup;

        return (
          <div
            key={label}
            style={{
              borderRadius: "8px",
              border: "1px solid #e1e3e5",
              padding: "10px 12px",
              background: selectedInGroup > 0 ? "#fafbff" : "transparent",
            }}
          >
            <BlockStack gap="200">
              <InlineStack gap="200" blockAlign="center">
                <Checkbox
                  label=""
                  labelHidden
                  checked={allSelected}
                  onChange={(checked) =>
                    onToggleGroup(product, groupVariants, checked)
                  }
                />
                <Text as="span" variant="bodyMd" fontWeight="semibold">
                  {label}
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  {selectedInGroup} / {totalInGroup} selected
                </Text>
              </InlineStack>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fill, minmax(170px, 1fr))",
                  gap: "4px",
                  paddingLeft: "28px",
                }}
              >
                {groupVariants.map((variant) => {
                  const isSelected = selectedVariantIds.has(variant.id);
                  const sizeVal =
                    variant.selectedOptions.find((o) =>
                      SIZE_OPTION_NAMES.has(o.name.toLowerCase()),
                    )?.value ?? variant.title;
                  return (
                    <div
                      key={variant.id}
                      style={{
                        padding: "4px 8px",
                        borderRadius: "6px",
                        background: isSelected ? "#f0f7ff" : "transparent",
                      }}
                    >
                      <Checkbox
                        label={
                          <Text as="span" variant="bodySm">
                            {sizeVal}
                            <Text
                              as="span"
                              variant="bodySm"
                              tone="subdued"
                            >
                              {variantBadge(variant)}
                            </Text>
                          </Text>
                        }
                        checked={isSelected}
                        onChange={(checked) =>
                          onToggleVariant(product, variant, checked)
                        }
                      />
                    </div>
                  );
                })}
              </div>
            </BlockStack>
          </div>
        );
      })}
    </BlockStack>
  );
}
