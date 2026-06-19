import { useState, useCallback, useEffect } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Card,
  BlockStack,
  Text,
  TextField,
  Button,
  Banner,
  InlineStack,
  Icon,
  Spinner,
  Badge,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";

interface VariantHit {
  variantId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  barcode: string | null;
  price: number | null;
}

/**
 * Home-page label-printing widget. Search → pick variant → print N
 * labels. Reuses the search action on /app/print-labels via a fetcher
 * so the home loader stays untouched.
 */
export function LabelQuickPrint() {
  const fetcher = useFetcher<{ variants?: VariantHit[]; error?: string }>();
  const isSearching = fetcher.state !== "idle";

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VariantHit[]>([]);
  const [selected, setSelected] = useState<VariantHit | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      const fd = new FormData();
      fd.set("query", query);
      fetcher.submit(fd, { method: "post", action: "/app/print-labels" });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    if (fetcher.data?.variants) {
      setResults(fetcher.data.variants);
    }
  }, [fetcher.data]);

  const handlePrint = useCallback(async () => {
    if (!selected || isGenerating) return;
    const qty = Math.max(1, Math.min(500, parseInt(quantity, 10) || 1));
    const fd = new FormData();
    fd.set("quantity", String(qty));
    fd.set("productTitle", selected.productTitle);
    fd.set("variantTitle", selected.variantTitle);
    fd.set("sku", selected.sku ?? "");
    fd.set("barcode", selected.barcode ?? "");
    if (selected.price != null) fd.set("price", String(selected.price));

    setIsGenerating(true);
    try {
      const response = await fetch("/api/labels/adhoc", {
        method: "POST",
        body: fd,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Label endpoint returned ${response.status}. ${body.slice(0, 200)}`,
        );
      }
      const blob = await response.blob();
      if (blob.size === 0) throw new Error("Generated PDF was empty.");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeSku =
        (selected.sku ?? "labels").replace(/[^a-zA-Z0-9-_]/g, "_") || "labels";
      a.download = `labels-${safeSku}-${qty}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error("Print labels failed:", error);
      window.alert(
        `Couldn't generate labels: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      setIsGenerating(false);
    }
  }, [selected, quantity, isGenerating]);

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          Print labels
        </Text>
        <TextField
          label="Search for a product"
          labelHidden
          value={query}
          onChange={setQuery}
          placeholder="Search by product, SKU, or vendor…"
          autoComplete="off"
          prefix={<Icon source={SearchIcon} />}
          clearButton
          onClearButtonClick={() => {
            setQuery("");
            setResults([]);
            setSelected(null);
          }}
        />
        {isSearching && (
          <InlineStack gap="200" blockAlign="center">
            <Spinner size="small" />
            <Text as="span" tone="subdued" variant="bodySm">
              Searching…
            </Text>
          </InlineStack>
        )}

        {results.length > 0 && (
          <div
            style={{
              maxHeight: "240px",
              overflowY: "auto",
              border: "1px solid #e1e3e5",
              borderRadius: "6px",
            }}
          >
            <BlockStack gap="0">
              {results.slice(0, 30).map((v) => {
                const isSelected = selected?.variantId === v.variantId;
                return (
                  <div
                    key={v.variantId}
                    onClick={() => setSelected(v)}
                    style={{
                      padding: "8px 10px",
                      cursor: "pointer",
                      background: isSelected ? "#f0f7ff" : "transparent",
                      borderBottom: "1px solid #f1f1f1",
                    }}
                  >
                    <InlineStack
                      align="space-between"
                      blockAlign="center"
                      wrap={false}
                    >
                      <Text as="span" variant="bodySm">
                        {v.productTitle} —{" "}
                        <Text as="span" tone="subdued">
                          {v.variantTitle}
                        </Text>
                        {v.sku && (
                          <Text as="span" tone="subdued">
                            {" "}
                            · {v.sku}
                          </Text>
                        )}
                      </Text>
                      {isSelected && <Badge tone="info">Selected</Badge>}
                    </InlineStack>
                  </div>
                );
              })}
            </BlockStack>
          </div>
        )}

        {query.trim() && !isSearching && results.length === 0 && (
          <Text as="p" tone="subdued">
            No matches.
          </Text>
        )}

        {selected && (
          <BlockStack gap="200">
            <Banner tone="info">
              <Text as="p" variant="bodySm">
                <strong>{selected.productTitle}</strong> —{" "}
                {selected.variantTitle}
                {selected.sku && <> · SKU: {selected.sku}</>}
                {selected.barcode && <> · Barcode: {selected.barcode}</>}
              </Text>
            </Banner>
            <InlineStack gap="200" blockAlign="end">
              <div style={{ maxWidth: "120px" }}>
                <TextField
                  label="Quantity"
                  type="number"
                  value={quantity}
                  onChange={setQuantity}
                  min={1}
                  max={500}
                  autoComplete="off"
                />
              </div>
              <Button
                variant="primary"
                onClick={handlePrint}
                loading={isGenerating}
                disabled={isGenerating}
              >
                Print
              </Button>
            </InlineStack>
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
