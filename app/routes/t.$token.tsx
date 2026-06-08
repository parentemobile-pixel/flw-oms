import { useState, useCallback } from "react";
import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
} from "@remix-run/node";
import { json } from "@remix-run/node";
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
  Button,
  Banner,
  InlineStack,
  ButtonGroup,
  Modal,
  EmptyState,
  Divider,
} from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";

import {
  getTransferByToken,
  receiveTransfer,
} from "../services/transfers/transfer-service.server";
import { unauthenticated } from "../shopify.server";
import { getLocations } from "../services/shopify-api/locations.server";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: polarisStyles },
];

/**
 * Public scan-to-receive page for Inventory Transfers — accessed via the
 * QR code printed on the packing slip PDF.
 *
 * Auth model mirrors `r.$token.tsx`:
 *  - URL contains a per-transfer random token (`InventoryTransfer.receiveToken`,
 *    cuid() default).
 *  - No Shopify admin session required on the visitor's browser.
 *  - Shopify API access uses the app's offline session for the transfer's
 *    shop via `shopify.unauthenticated.admin(shop)`.
 *
 * All the heavy lifting (delta computation, `adjustInventoryBatch` at the
 * destination, audit session, status transition) lives in
 * `receiveTransfer(...)` — this route is just a thin public-input surface.
 */
export const loader = async ({ params }: LoaderFunctionArgs) => {
  const transfer = await getTransferByToken(params.token!);
  if (!transfer) {
    throw new Response("Transfer not found or token expired", { status: 404 });
  }
  // Try to resolve location names for the header. Best-effort — falls back
  // to the raw location IDs if Shopify auth fails or the locations query
  // throws.
  let fromLocationName: string | null = null;
  let toLocationName: string | null = null;
  try {
    const { admin } = await unauthenticated.admin(transfer.shop);
    const locations = await getLocations(admin, transfer.shop).catch(() => []);
    fromLocationName =
      locations.find((l) => l.id === transfer.fromLocationId)?.name ?? null;
    toLocationName =
      locations.find((l) => l.id === transfer.toLocationId)?.name ?? null;
  } catch {
    // Stay public — don't fail the page just because location names
    // couldn't be resolved.
  }
  return json({ transfer, fromLocationName, toLocationName });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const transfer = await getTransferByToken(params.token!);
  if (!transfer) {
    throw new Response("Transfer not found", { status: 404 });
  }
  if (transfer.status === "cancelled") {
    return json({ error: "This transfer was cancelled. Nothing to receive." });
  }
  if (transfer.status === "received") {
    // Idempotency: if someone scans the QR after the transfer was already
    // marked received (from any surface), don't try to re-apply.
    return json({
      ok: true as const,
      message: "This transfer was already received.",
    });
  }

  const formData = await request.formData();
  const changesJson = formData.get("changes") as string;
  const changes = JSON.parse(changesJson) as Array<{
    lineItemId: string;
    quantityReceived: number;
  }>;

  // Open an admin client using the app's offline session for the shop.
  let admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];
  try {
    const ctx = await unauthenticated.admin(transfer.shop);
    admin = ctx.admin;
  } catch (error) {
    console.error("Transfer scan-to-receive: offline admin failed", error);
    return json({
      error:
        "App session for this shop isn't available. A manager needs to re-open the app in the Shopify admin, then try again.",
    });
  }

  try {
    await receiveTransfer(admin, transfer.shop, transfer.id, changes);
    return json({
      ok: true as const,
      message: "Transfer received. Shopify inventory updated.",
    });
  } catch (error) {
    console.error("Transfer scan-to-receive failed", error);
    return json({ error: String(error) });
  }
};

export default function ScanReceiveTransferPage() {
  const { transfer, fromLocationName, toLocationName } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Default to "sent" qty — typical receive is "everything arrived".
  // Counter walks down from the full amount for missing / damaged items.
  const [quantities, setQuantities] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const li of transfer.lineItems) init[li.id] = li.quantitySent;
    return init;
  });
  const [markAllModalOpen, setMarkAllModalOpen] = useState(false);

  // Locked states: explicit success from the action, OR the transfer was
  // already received before this page even loaded.
  const alreadyDone =
    transfer.status === "received" || transfer.status === "cancelled";
  const submitted =
    alreadyDone ||
    Boolean(actionData && "ok" in actionData && actionData.ok === true);

  const handleIncrement = useCallback((lineItemId: string) => {
    setQuantities((prev) => ({
      ...prev,
      [lineItemId]: (prev[lineItemId] ?? 0) + 1,
    }));
  }, []);

  const handleDecrement = useCallback((lineItemId: string) => {
    setQuantities((prev) => ({
      ...prev,
      [lineItemId]: Math.max(0, (prev[lineItemId] ?? 0) - 1),
    }));
  }, []);

  const handleMarkLineReceived = useCallback(
    (lineItemId: string) => {
      setQuantities((prev) => {
        const li = transfer.lineItems.find((l) => l.id === lineItemId);
        if (!li) return prev;
        return { ...prev, [lineItemId]: li.quantitySent };
      });
    },
    [transfer.lineItems],
  );

  const handleClearAll = useCallback(() => {
    setQuantities((prev) => {
      const next = { ...prev };
      for (const li of transfer.lineItems) next[li.id] = 0;
      return next;
    });
  }, [transfer.lineItems]);

  const handleSubmit = useCallback(() => {
    const changes = transfer.lineItems.map((li) => ({
      lineItemId: li.id,
      quantityReceived: quantities[li.id] ?? li.quantityReceived,
    }));
    const fd = new FormData();
    fd.set("changes", JSON.stringify(changes));
    submit(fd, { method: "post" });
  }, [transfer.lineItems, quantities, submit]);

  // Mark-all-and-submit: bypass the quantities state so there's no async
  // React update race. Send every line at full quantitySent.
  const handleConfirmMarkAll = useCallback(() => {
    const changes = transfer.lineItems.map((li) => ({
      lineItemId: li.id,
      quantityReceived: li.quantitySent,
    }));
    const fd = new FormData();
    fd.set("changes", JSON.stringify(changes));
    submit(fd, { method: "post" });
    setMarkAllModalOpen(false);
  }, [transfer.lineItems, submit]);

  const receivedNow = transfer.lineItems.reduce(
    (s, li) => s + (quantities[li.id] ?? li.quantityReceived),
    0,
  );
  const totalSent = transfer.lineItems.reduce(
    (s, li) => s + li.quantitySent,
    0,
  );

  const subtitle = `${fromLocationName ?? "From"} → ${toLocationName ?? "To"}`;
  const trackingLabel = [transfer.trackingCarrier, transfer.trackingNumber]
    .filter(Boolean)
    .join(" · ");

  return (
    <AppProvider i18n={enTranslations}>
      <Page
        title={`Receive: ${transfer.name || `#${transfer.transferNumber}`}`}
        subtitle={subtitle}
      >
        <Layout>
          {/* ── Submitted / already-done state replaces the form ── */}
          {submitted && (
            <Layout.Section>
              <Card>
                <EmptyState
                  heading={
                    transfer.status === "cancelled"
                      ? "Transfer was cancelled"
                      : "Received and saved"
                  }
                  image=""
                >
                  <BlockStack gap="300">
                    <Text as="p" variant="bodyMd">
                      {actionData && "message" in actionData
                        ? (actionData as { message: string }).message
                        : transfer.status === "cancelled"
                          ? "This transfer was cancelled before being received. No inventory was moved."
                          : "Inventory was already updated in Shopify."}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      You can close this tab. If something looks off, have
                      a manager open the transfer in the admin app.
                    </Text>
                  </BlockStack>
                </EmptyState>
              </Card>
            </Layout.Section>
          )}

          {!submitted && actionData && "error" in actionData && (
            <Layout.Section>
              <Banner tone="critical">{actionData.error as string}</Banner>
            </Layout.Section>
          )}

          {/* Header card — transfer summary + tracking */}
          {!submitted && (
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center">
                    <Badge>{transfer.status.replace(/_/g, " ")}</Badge>
                    <Text as="span" variant="bodyMd">
                      #{transfer.transferNumber} ·{" "}
                      {totalSent} unit{totalSent !== 1 ? "s" : ""}
                    </Text>
                  </InlineStack>
                  {trackingLabel && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Tracking: {trackingLabel}
                    </Text>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

          {/* Happy path: big "Mark all received" CTA at the top */}
          {!submitted && (
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="p" variant="headingMd">
                    Did everything arrive exactly as sent?
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Tap below and we&apos;ll mark the whole transfer received
                    and update Shopify. If any unit is missing or damaged,
                    scroll down and adjust per line instead.
                  </Text>
                  <Button
                    variant="primary"
                    size="large"
                    fullWidth
                    onClick={() => setMarkAllModalOpen(true)}
                    disabled={isSubmitting}
                  >
                    ✓ Mark all {totalSent} received
                  </Button>
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

          {!submitted && (
            <Layout.Section>
              <Card>
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="span" variant="bodySm" tone="subdued">
                    Running total: {receivedNow} / {totalSent} units
                  </Text>
                  <Button onClick={handleClearAll} size="slim" variant="plain">
                    Clear all
                  </Button>
                </InlineStack>
              </Card>
            </Layout.Section>
          )}

          {!submitted && (
            <Layout.Section>
              <Divider />
            </Layout.Section>
          )}

          {!submitted && (
            <Layout.Section>
              <Text as="h2" variant="headingMd">
                Or adjust per item
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Start from the sent amount and deduct missing or damaged
                units. Tap &ldquo;Save&rdquo; at the bottom when done.
              </Text>
            </Layout.Section>
          )}

          {!submitted && (
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  {transfer.lineItems.map((li) => {
                    const currentQty =
                      quantities[li.id] ?? li.quantitySent;
                    const isFull = currentQty >= li.quantitySent;
                    return (
                      <div
                        key={li.id}
                        style={{
                          padding: "14px",
                          borderRadius: "8px",
                          border: isFull
                            ? "2px solid #b7e3c7"
                            : "1px solid #e1e3e5",
                          background: isFull ? "#f3faf6" : undefined,
                        }}
                      >
                        <BlockStack gap="300">
                          <InlineStack align="space-between" blockAlign="start">
                            <BlockStack gap="050">
                              <Text
                                as="p"
                                variant="bodyLg"
                                fontWeight="semibold"
                              >
                                {li.productTitle}
                              </Text>
                              <Text as="p" variant="bodySm" tone="subdued">
                                {li.variantTitle}
                                {li.sku ? ` · ${li.sku}` : ""}
                              </Text>
                            </BlockStack>
                            {isFull && <Badge tone="success">Received</Badge>}
                          </InlineStack>

                          <InlineStack
                            align="space-between"
                            blockAlign="center"
                            wrap={false}
                          >
                            <Button
                              size="large"
                              onClick={() => handleDecrement(li.id)}
                              disabled={currentQty <= 0}
                              accessibilityLabel="Decrement"
                            >
                              −
                            </Button>
                            <InlineStack
                              gap="200"
                              blockAlign="baseline"
                              align="center"
                            >
                              <Text
                                as="span"
                                variant="heading2xl"
                                fontWeight="bold"
                              >
                                {currentQty}
                              </Text>
                              <Text as="span" variant="bodyMd" tone="subdued">
                                / {li.quantitySent}
                              </Text>
                            </InlineStack>
                            <Button
                              size="large"
                              onClick={() => handleIncrement(li.id)}
                              accessibilityLabel="Increment"
                              variant="primary"
                            >
                              +
                            </Button>
                          </InlineStack>

                          {!isFull && (
                            <Button
                              fullWidth
                              onClick={() => handleMarkLineReceived(li.id)}
                            >
                              Mark all {li.quantitySent} received
                            </Button>
                          )}
                        </BlockStack>
                      </div>
                    );
                  })}
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

          {!submitted && (
            <Layout.Section>
              <ButtonGroup fullWidth>
                <Button
                  variant="primary"
                  onClick={handleSubmit}
                  loading={isSubmitting}
                  size="large"
                >
                  Save adjusted quantities
                </Button>
              </ButtonGroup>
            </Layout.Section>
          )}

          <Layout.Section>
            <div style={{ height: "3rem" }} />
          </Layout.Section>
        </Layout>

        {/* Confirmation for the "Mark all received" button */}
        <Modal
          open={markAllModalOpen && !submitted}
          onClose={() => setMarkAllModalOpen(false)}
          title="Mark everything received?"
          primaryAction={{
            content: isSubmitting
              ? "Saving…"
              : `Yes, receive all ${totalSent}`,
            onAction: handleConfirmMarkAll,
            loading: isSubmitting,
          }}
          secondaryActions={[
            {
              content: "Cancel",
              onAction: () => setMarkAllModalOpen(false),
            },
          ]}
        >
          <Modal.Section>
            <BlockStack gap="300">
              <Text as="p" variant="bodyMd">
                This will mark all{" "}
                <Text as="span" fontWeight="semibold">
                  {totalSent} units
                </Text>{" "}
                on transfer{" "}
                <Text as="span" fontWeight="semibold">
                  #{transfer.transferNumber}
                </Text>{" "}
                as received and update Shopify inventory immediately.
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                This can&apos;t be undone from here — if you need to adjust
                after submitting, a manager will have to open the transfer
                in the admin app.
              </Text>
            </BlockStack>
          </Modal.Section>
        </Modal>
      </Page>
    </AppProvider>
  );
}
