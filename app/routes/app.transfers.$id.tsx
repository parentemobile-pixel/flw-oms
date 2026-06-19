import { useCallback, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Badge,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Banner,
  Divider,
  DataTable,
  TextField,
  ButtonGroup,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import {
  getTransfer,
  sendTransfer,
  receiveTransfer,
  cancelTransfer,
  setTransferTracking,
  setTransferName,
} from "../services/transfers/transfer-service.server";
import { getLocations } from "../services/shopify-api/locations.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const t = await getTransfer(session.shop, params.id!);
  if (!t) throw new Response("Not found", { status: 404 });
  const locations = await getLocations(admin, session.shop).catch(() => []);
  const locMap = new Map(locations.map((l) => [l.id, l.name]));
  return json({
    t,
    fromName: locMap.get(t.fromLocationId) ?? t.fromLocationId,
    toName: locMap.get(t.toLocationId) ?? t.toLocationId,
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  try {
    if (intent === "send") {
      await sendTransfer(admin, session.shop, params.id!);
      return json({ ok: true as const });
    }
    if (intent === "cancel") {
      await cancelTransfer(session.shop, params.id!);
      return json({ ok: true as const });
    }
    if (intent === "receive") {
      const receipts = JSON.parse(
        String(formData.get("receipts") ?? "[]"),
      ) as Array<{ lineItemId: string; quantityReceived: number }>;
      await receiveTransfer(admin, session.shop, params.id!, receipts);
      return json({ ok: true as const });
    }
    if (intent === "update-tracking") {
      await setTransferTracking(
        session.shop,
        params.id!,
        (formData.get("trackingCarrier") as string) || null,
        (formData.get("trackingNumber") as string) || null,
      );
      return json({ ok: true as const });
    }
    if (intent === "update-name") {
      await setTransferName(
        session.shop,
        params.id!,
        (formData.get("name") as string) || null,
      );
      return json({ ok: true as const });
    }
  } catch (error) {
    return json({ error: String(error) });
  }
  return json({});
};

const STATUS_TONES: Record<
  string,
  "info" | "success" | "warning" | "critical" | "attention"
> = {
  draft: "info",
  in_transit: "attention",
  received: "success",
  cancelled: "critical",
};
const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  in_transit: "In Transit",
  received: "Received",
  cancelled: "Cancelled",
};

/**
 * Build a "track this package" URL. Matches the carrier name loosely
 * (the field is free text) against the big three; anything else falls
 * back to a Google search of the tracking number, which reliably lands
 * on the right carrier's tracking page.
 */
function trackingUrl(carrier: string | null, num: string): string {
  const c = (carrier ?? "").toLowerCase();
  const n = encodeURIComponent(num.trim());
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${n}`;
  if (c.includes("fedex"))
    return `https://www.fedex.com/fedextrack/?trknbr=${n}`;
  if (c.includes("usps"))
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`;
  if (c.includes("dhl"))
    return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${n}`;
  return `https://www.google.com/search?q=${n}`;
}

export default function TransferDetail() {
  const { t, fromName, toName } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isBusy = navigation.state === "submitting";

  // Per-line receipt state for the Receive flow
  const [receipts, setReceipts] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const li of t.lineItems) init[li.id] = li.quantityReceived;
    return init;
  });

  // Name — editable; falls back to transfer # as title.
  const [name, setName] = useState(t.name ?? "");
  const handleSaveName = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "update-name");
    fd.set("name", name);
    submit(fd, { method: "post" });
  }, [name, submit]);

  // Tracking — manually entered carrier + number.
  const [trackingCarrier, setTrackingCarrier] = useState(
    t.trackingCarrier ?? "",
  );
  const [trackingNumber, setTrackingNumber] = useState(
    t.trackingNumber ?? "",
  );
  const handleSaveTracking = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "update-tracking");
    fd.set("trackingCarrier", trackingCarrier);
    fd.set("trackingNumber", trackingNumber);
    submit(fd, { method: "post" });
  }, [trackingCarrier, trackingNumber, submit]);

  const handleSend = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "send");
    submit(fd, { method: "post" });
  }, [submit]);

  const handleCancel = useCallback(() => {
    if (!window.confirm("Cancel this draft transfer?")) return;
    const fd = new FormData();
    fd.set("intent", "cancel");
    submit(fd, { method: "post" });
  }, [submit]);

  const handleReceiveAll = useCallback(() => {
    const all: Record<string, number> = {};
    for (const li of t.lineItems) all[li.id] = li.quantitySent;
    setReceipts(all);
  }, [t.lineItems]);

  const handleReceive = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "receive");
    fd.set(
      "receipts",
      JSON.stringify(
        t.lineItems.map((li) => ({
          lineItemId: li.id,
          quantityReceived: receipts[li.id] ?? li.quantityReceived,
        })),
      ),
    );
    submit(fd, { method: "post" });
  }, [t.lineItems, receipts, submit]);

  // ── Packing slip PDF downloads ─────────────────────────────────────
  // Fetches inside the embedded iframe so the Shopify admin session
  // cookie is available; trigger a blob download instead of a top-level
  // navigation (which would open a new tab without session and lose
  // the QR-bound URL handling). Same pattern as the PO PDF download in
  // app.purchase-orders.$id._index.tsx.
  const [isGeneratingPdf, setIsGeneratingPdf] = useState<
    "line" | "grid" | null
  >(null);
  const downloadPdf = useCallback(
    async (view: "line" | "grid") => {
      if (isGeneratingPdf !== null) return;
      setIsGeneratingPdf(view);
      try {
        const response = await fetch(
          `/api/transfer-pdf/${t.id}?view=${view}`,
        );
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(
            `Packing slip endpoint returned ${response.status}. ${body.slice(0, 200)}`,
          );
        }
        const blob = await response.blob();
        if (blob.size === 0) throw new Error("Generated PDF was empty.");
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objUrl;
        a.download = `transfer-${t.transferNumber}-${view}.pdf`;
        a.rel = "noreferrer";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
      } catch (error) {
        console.error("Packing slip download failed:", error);
        window.alert(
          `Couldn't generate packing slip: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        setIsGeneratingPdf(null);
      }
    },
    [isGeneratingPdf, t.id, t.transferNumber],
  );
  const handlePackingSlipLine = useCallback(
    () => downloadPdf("line"),
    [downloadPdf],
  );
  const handlePackingSlipGrid = useCallback(
    () => downloadPdf("grid"),
    [downloadPdf],
  );

  const totalSent = t.lineItems.reduce((s, li) => s + li.quantitySent, 0);
  const totalReceived = t.lineItems.reduce(
    (s, li) => s + li.quantityReceived,
    0,
  );

  const rows = t.lineItems.map((li) => [
    li.productTitle,
    li.variantTitle,
    li.sku || "—",
    String(li.quantitySent),
    `${li.quantityReceived} / ${li.quantitySent}`,
  ]);

  return (
    <Page
      // Prefer the human-friendly name in the title; fall back to the
      // transfer number when no name has been set yet.
      title={t.name || t.transferNumber}
      subtitle={t.name ? `#${t.transferNumber}` : undefined}
      backAction={{ url: "/app/transfers" }}
      titleMetadata={
        <Badge tone={STATUS_TONES[t.status] ?? "info"}>
          {STATUS_LABELS[t.status] ?? t.status}
        </Badge>
      }
      secondaryActions={[
        {
          content:
            isGeneratingPdf === "line"
              ? "Generating…"
              : "Packing slip (Line)",
          onAction: handlePackingSlipLine,
          loading: isGeneratingPdf === "line",
          disabled: isGeneratingPdf !== null,
        },
        {
          content:
            isGeneratingPdf === "grid"
              ? "Generating…"
              : "Packing slip (Grid)",
          onAction: handlePackingSlipGrid,
          loading: isGeneratingPdf === "grid",
          disabled: isGeneratingPdf !== null,
        },
      ]}
    >
      <Layout>
        {actionData && "ok" in actionData && (
          <Layout.Section>
            <Banner tone="success">
              {t.status === "in_transit"
                ? "Inventory subtracted at source. Transfer is in transit."
                : t.status === "received"
                  ? "All units received. Transfer complete."
                  : "Saved as draft. Click “Send” when ready to ship."}
            </Banner>
          </Layout.Section>
        )}
        {actionData && "error" in actionData && (
          <Layout.Section>
            <Banner tone="critical">{actionData.error as string}</Banner>
          </Layout.Section>
        )}

        {/* Header */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="600" wrap>
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm" tone="subdued">
                    From
                  </Text>
                  <Text as="p" variant="bodyMd">
                    {fromName}
                  </Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm" tone="subdued">
                    To
                  </Text>
                  <Text as="p" variant="bodyMd">
                    {toName}
                  </Text>
                </BlockStack>
                <BlockStack gap="050">
                  <Text as="p" variant="bodySm" tone="subdued">
                    Created
                  </Text>
                  <Text as="p" variant="bodyMd">
                    {new Date(t.createdAt).toLocaleDateString()}
                  </Text>
                </BlockStack>
                {t.sentAt && (
                  <BlockStack gap="050">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Sent
                    </Text>
                    <Text as="p" variant="bodyMd">
                      {new Date(t.sentAt).toLocaleDateString()}
                    </Text>
                  </BlockStack>
                )}
                {t.receivedAt && (
                  <BlockStack gap="050">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Received
                    </Text>
                    <Text as="p" variant="bodyMd">
                      {new Date(t.receivedAt).toLocaleDateString()}
                    </Text>
                  </BlockStack>
                )}
              </InlineStack>
              {t.notes && (
                <>
                  <Divider />
                  <Text as="p" variant="bodyMd">
                    {t.notes}
                  </Text>
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Editable transfer name */}
        {t.status !== "cancelled" && (
          <Layout.Section>
            <Card>
              <InlineStack gap="400" wrap blockAlign="end">
                <div style={{ flex: "1 1 320px", minWidth: "240px" }}>
                  <TextField
                    label="Transfer name"
                    value={name}
                    onChange={setName}
                    autoComplete="off"
                    placeholder="e.g. FW25 Marblehead initial stock"
                  />
                </div>
                <div>
                  <Button
                    onClick={handleSaveName}
                    loading={isBusy}
                    disabled={name === (t.name ?? "")}
                  >
                    Save name
                  </Button>
                </div>
              </InlineStack>
            </Card>
          </Layout.Section>
        )}

        {/* Shipping & tracking — manually entered */}
        {t.status !== "cancelled" && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Shipping & tracking
                  </Text>
                  {t.trackingNumber && (
                    <Button
                      url={trackingUrl(t.trackingCarrier, t.trackingNumber)}
                      target="_blank"
                      variant="plain"
                    >
                      Track package ↗
                    </Button>
                  )}
                </InlineStack>
                <InlineStack gap="400" wrap>
                  <div style={{ flex: "0 0 200px" }}>
                    <TextField
                      label="Carrier"
                      value={trackingCarrier}
                      onChange={setTrackingCarrier}
                      autoComplete="off"
                      placeholder="UPS, FedEx, USPS…"
                    />
                  </div>
                  <div style={{ flex: "1 1 280px", minWidth: "240px" }}>
                    <TextField
                      label="Tracking number"
                      value={trackingNumber}
                      onChange={setTrackingNumber}
                      autoComplete="off"
                      placeholder="Paste the carrier tracking number"
                    />
                  </div>
                  <div style={{ alignSelf: "flex-end" }}>
                    <Button
                      onClick={handleSaveTracking}
                      loading={isBusy}
                      disabled={
                        trackingCarrier === (t.trackingCarrier ?? "") &&
                        trackingNumber === (t.trackingNumber ?? "")
                      }
                    >
                      Save tracking
                    </Button>
                  </div>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Line items */}
        <Layout.Section>
          <Card padding="0">
            <DataTable
              columnContentTypes={["text", "text", "text", "numeric", "text"]}
              headings={["Product", "Variant", "SKU", "Sent", "Received"]}
              rows={rows}
              totals={[
                "",
                "",
                "",
                String(totalSent),
                `${totalReceived} / ${totalSent}`,
              ]}
            />
          </Card>
        </Layout.Section>

        {/* Draft actions */}
        {t.status === "draft" && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Ready to send?
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  This will subtract the sent quantities from {fromName} in
                  Shopify inventory. The destination isn't credited until you
                  receive it at {toName}.
                </Text>
                <InlineStack align="end" gap="200">
                  <Button tone="critical" onClick={handleCancel} loading={isBusy}>
                    Cancel transfer
                  </Button>
                  <Button variant="primary" onClick={handleSend} loading={isBusy}>
                    Send — subtract at source
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Receive flow */}
        {(t.status === "in_transit" ||
          (t.status === "received" && totalReceived < totalSent)) && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Receive at {toName}
                  </Text>
                  <ButtonGroup>
                    <Button size="slim" onClick={handleReceiveAll}>
                      Receive All
                    </Button>
                  </ButtonGroup>
                </InlineStack>
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
                        <th style={{ padding: "8px", textAlign: "left" }}>
                          Product
                        </th>
                        <th style={{ padding: "8px", textAlign: "left" }}>
                          Variant
                        </th>
                        <th style={{ padding: "8px", textAlign: "right" }}>
                          Sent
                        </th>
                        <th style={{ padding: "8px", textAlign: "right" }}>
                          Previously
                        </th>
                        <th
                          style={{
                            padding: "8px",
                            textAlign: "right",
                            width: "110px",
                          }}
                        >
                          Received
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.lineItems.map((li) => {
                        const curr = receipts[li.id] ?? 0;
                        return (
                          <tr
                            key={li.id}
                            style={{ borderBottom: "1px solid #f1f1f1" }}
                          >
                            <td style={{ padding: "8px" }}>{li.productTitle}</td>
                            <td style={{ padding: "8px" }}>{li.variantTitle}</td>
                            <td style={{ padding: "8px", textAlign: "right" }}>
                              {li.quantitySent}
                            </td>
                            <td style={{ padding: "8px", textAlign: "right" }}>
                              {li.quantityReceived}
                            </td>
                            <td style={{ padding: "4px 8px" }}>
                              <TextField
                                label=""
                                labelHidden
                                value={String(curr)}
                                onChange={(val) =>
                                  setReceipts((prev) => ({
                                    ...prev,
                                    [li.id]: Math.max(
                                      0,
                                      parseInt(val, 10) || 0,
                                    ),
                                  }))
                                }
                                type="number"
                                min={0}
                                max={li.quantitySent}
                                autoComplete="off"
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <InlineStack align="end">
                  <Button
                    variant="primary"
                    onClick={handleReceive}
                    loading={isBusy}
                  >
                    Confirm received — add at {toName}
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
