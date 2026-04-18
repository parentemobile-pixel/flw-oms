import { useState, useCallback, useMemo } from "react";
import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
} from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useLoaderData,
  useActionData,
  useSubmit,
  useNavigation,
} from "@remix-run/react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import {
  AppProvider,
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Badge,
  TextField,
  Button,
  Banner,
  InlineStack,
  ButtonGroup,
} from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";

import { getPurchaseOrderByToken } from "../services/purchase-orders/po-service.server";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: polarisStyles },
];

/**
 * Public scan-to-receive page — accessed via the QR code printed on the PO PDF.
 *
 * Auth model: the URL contains a per-PO random token (stored as receiveToken
 * on PurchaseOrder). No Shopify session is required to view or submit — any
 * physical holder of the QR can receive items. Token can be rotated via
 * rotateReceiveToken() if compromised.
 *
 * Because we don't have a Shopify admin context here, we can't talk directly
 * to Shopify GraphQL from this route. Instead we record the received
 * quantities in our DB; the Shopify inventory adjustment happens in a
 * follow-up background job OR the next time someone with admin access opens
 * the PO and the app reconciles. For V2 simplicity we just update the DB
 * and surface a clear "pending Shopify sync" note.
 */
export const loader = async ({ params }: LoaderFunctionArgs) => {
  const po = await getPurchaseOrderByToken(params.token!);
  if (!po) {
    throw new Response("PO not found or token expired", { status: 404 });
  }
  return json({ po });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const po = await getPurchaseOrderByToken(params.token!);
  if (!po) {
    throw new Response("PO not found", { status: 404 });
  }

  const formData = await request.formData();
  const changesJson = formData.get("changes") as string;
  const changes = JSON.parse(changesJson) as Array<{
    lineItemId: string;
    quantityReceived: number;
  }>;

  // Import lazily to keep route small on public path
  const { receiveLineItems } = await import(
    "../services/purchase-orders/po-service.server"
  );

  try {
    await receiveLineItems(po.id, changes);
    return json({
      ok: true,
      message:
        "Received quantities saved. A manager will sync these to Shopify inventory on their next session.",
    });
  } catch (error) {
    return json({ error: String(error) });
  }
};

export default function ScanReceivePage() {
  const { po } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [quantities, setQuantities] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const li of po.lineItems) init[li.id] = li.quantityReceived;
    return init;
  });

  const [scanFeedback, setScanFeedback] = useState<string | null>(null);

  const scanLookup = useMemo(() => {
    const map: Record<string, string> = {};
    for (const li of po.lineItems) {
      if (li.sku) map[li.sku.toUpperCase()] = li.id;
      if (li.barcode) map[li.barcode.toUpperCase()] = li.id;
    }
    return map;
  }, [po.lineItems]);

  const handleScanInput = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter") return;
      const el = e.currentTarget;
      const code = el.value.trim().toUpperCase();
      if (!code) return;
      const lineId = scanLookup[code];
      if (!lineId) {
        setScanFeedback(`No match for "${code}".`);
        el.value = "";
        return;
      }
      const line = po.lineItems.find((li) => li.id === lineId);
      if (!line) return;
      setQuantities((prev) => {
        const next = Math.min((prev[lineId] ?? 0) + 1, line.quantityOrdered);
        if (next === prev[lineId]) {
          setScanFeedback(
            `${line.productTitle} already fully received (${line.quantityOrdered}).`,
          );
        } else {
          setScanFeedback(
            `✓ ${line.productTitle} — ${line.variantTitle}: ${next} / ${line.quantityOrdered}`,
          );
        }
        return { ...prev, [lineId]: next };
      });
      el.value = "";
    },
    [scanLookup, po.lineItems],
  );

  const handleQuantityChange = useCallback(
    (lineItemId: string, val: string) => {
      setQuantities((prev) => ({
        ...prev,
        [lineItemId]: Math.max(0, parseInt(val, 10) || 0),
      }));
    },
    [],
  );

  const handleSubmit = useCallback(() => {
    const changes = po.lineItems.map((li) => ({
      lineItemId: li.id,
      quantityReceived: quantities[li.id] ?? li.quantityReceived,
    }));
    const fd = new FormData();
    fd.set("changes", JSON.stringify(changes));
    submit(fd, { method: "post" });
  }, [po.lineItems, quantities, submit]);

  const receivedNow = po.lineItems.reduce(
    (s, li) => s + (quantities[li.id] ?? li.quantityReceived),
    0,
  );
  const totalOrdered = po.lineItems.reduce(
    (s, li) => s + li.quantityOrdered,
    0,
  );

  return (
    <AppProvider i18n={enTranslations}>
      <Page
        title={`Receive: ${po.poNumber}`}
        subtitle={po.vendor ?? undefined}
      >
        <Layout>
          {actionData && "ok" in actionData && actionData.ok && (
            <Layout.Section>
              <Banner tone="success">{actionData.message}</Banner>
            </Layout.Section>
          )}
          {actionData && "error" in actionData && (
            <Layout.Section>
              <Banner tone="critical">{actionData.error as string}</Banner>
            </Layout.Section>
          )}

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200">
                  <Badge>{po.status}</Badge>
                  <Text as="span" variant="bodySm" tone="subdued">
                    {receivedNow} / {totalOrdered} units
                  </Text>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  Scan items or enter quantities below. Save when done — a
                  manager will sync counts to Shopify inventory from the admin
                  app.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Scan
                </Text>
                <input
                  type="text"
                  autoFocus
                  placeholder="Scan SKU or barcode…"
                  onKeyDown={handleScanInput}
                  style={{
                    width: "100%",
                    padding: "12px",
                    fontSize: "16px",
                    border: "1px solid #ccc",
                    borderRadius: "6px",
                  }}
                />
                {scanFeedback && (
                  <Text
                    as="p"
                    variant="bodySm"
                    tone={
                      scanFeedback.startsWith("✓") ? "success" : "subdued"
                    }
                  >
                    {scanFeedback}
                  </Text>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Line items
                </Text>
                {po.lineItems.map((li) => {
                  const currentQty =
                    quantities[li.id] ?? li.quantityReceived;
                  return (
                    <div
                      key={li.id}
                      style={{
                        padding: "12px",
                        borderRadius: "6px",
                        border: "1px solid #e1e3e5",
                      }}
                    >
                      <BlockStack gap="200">
                        <Text as="p" variant="bodyMd" fontWeight="medium">
                          {li.productTitle}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {li.variantTitle}
                          {li.sku ? ` · ${li.sku}` : ""}
                        </Text>
                        <InlineStack
                          align="space-between"
                          blockAlign="center"
                        >
                          <Text as="span" variant="bodySm">
                            Received / ordered
                          </Text>
                          <InlineStack gap="200" blockAlign="center">
                            <div style={{ width: "80px" }}>
                              <TextField
                                label=""
                                labelHidden
                                value={String(currentQty)}
                                onChange={(val) =>
                                  handleQuantityChange(li.id, val)
                                }
                                type="number"
                                min={0}
                                max={li.quantityOrdered}
                                autoComplete="off"
                              />
                            </div>
                            <Text as="span" variant="bodySm">
                              / {li.quantityOrdered}
                            </Text>
                          </InlineStack>
                        </InlineStack>
                      </BlockStack>
                    </div>
                  );
                })}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <ButtonGroup fullWidth>
              <Button
                variant="primary"
                onClick={handleSubmit}
                loading={isSubmitting}
                size="large"
              >
                Save received quantities
              </Button>
            </ButtonGroup>
          </Layout.Section>

          <Layout.Section>
            <div style={{ height: "3rem" }} />
          </Layout.Section>
        </Layout>
      </Page>
    </AppProvider>
  );
}
