import { useCallback, useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import { Page, Layout, Banner } from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import {
  getDefaultLocation,
  getLocations,
  type Location,
} from "../services/shopify-api/locations.server";
import { createTransfer } from "../services/transfers/transfer-service.server";
import { handleTransferEditorIntent } from "../services/transfers/transfer-editor.server";
import {
  TransferEditor,
  type TransferEditorInitial,
  type TransferEditorPayload,
  type TransferRow,
} from "../components/TransferEditor";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [locations, defaultLocation] = await Promise.all([
    getLocations(admin, session.shop).catch(() => [] as Location[]),
    getDefaultLocation(admin, session.shop).catch(() => null),
  ]);
  return json({
    locations,
    defaultLocationId: defaultLocation?.id ?? null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Product search + From-location stock — shared with the detail
  // route's edit mode.
  const helper = await handleTransferEditorIntent(admin, intent, formData);
  if (helper) return helper;

  if (intent === "create") {
    const fromLocationId = String(formData.get("fromLocationId") ?? "");
    const toLocationId = String(formData.get("toLocationId") ?? "");
    const name = String(formData.get("name") ?? "").trim() || null;
    const notes = String(formData.get("notes") ?? "") || null;
    const lineItems = JSON.parse(
      String(formData.get("lineItems") ?? "[]"),
    ) as TransferEditorPayload["lineItems"];

    try {
      const t = await createTransfer(session.shop, {
        name,
        fromLocationId,
        toLocationId,
        notes,
        lineItems,
      });
      throw redirect(`/app/transfers/${t.id}`);
    } catch (error) {
      if (error instanceof Response) throw error;
      return json({ error: String(error) });
    }
  }

  return json({});
};

// Where the Replenishment report stashes a prefill before navigating
// here. Kept in sync with the writer in app.replenishment._index.tsx.
const PREFILL_KEY = "flw-oms.transfer-prefill";

interface PrefillPayload {
  ts?: number;
  fromLocationId?: string;
  toLocationId?: string;
  rows?: Array<{
    variantId: string;
    productId: string;
    productTitle: string;
    variantTitle: string;
    sku: string | null;
    selectedOptions: Array<{ name: string; value: string }>;
    quantitySent: number;
  }>;
}

export default function NewTransfer() {
  const { locations, defaultLocationId } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isBusy = navigation.state === "submitting";

  // Read a prefill payload written by another page (currently the
  // Replenishment report) once on mount. We clear the key immediately
  // so a refresh doesn't re-apply, and drop payloads older than 60s so
  // a stale handoff doesn't surface after the user navigated elsewhere
  // first. The editor is keyed on whether a prefill landed so it
  // re-mounts with the prefilled initial state (localStorage isn't
  // available during SSR, so this can't be a lazy initializer).
  const [prefill, setPrefill] = useState<TransferEditorInitial | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(PREFILL_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      window.localStorage.removeItem(PREFILL_KEY);
    } catch {
      /* ignore */
    }
    let payload: PrefillPayload | null = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (!payload) return;
    if (typeof payload.ts === "number" && Date.now() - payload.ts > 60_000) {
      return; // stale
    }
    const rows: TransferRow[] = (payload.rows ?? []).map((r) => ({
      variantId: r.variantId,
      productId: r.productId,
      productTitle: r.productTitle,
      variantTitle: r.variantTitle,
      sku: r.sku,
      selectedOptions: r.selectedOptions,
      fromStock: 0,
      quantitySent: r.quantitySent,
    }));
    setPrefill({
      fromLocationId: payload.fromLocationId ?? defaultLocationId,
      toLocationId: payload.toLocationId ?? null,
      rows,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = useCallback(
    (payload: TransferEditorPayload) => {
      const fd = new FormData();
      fd.set("intent", "create");
      fd.set("fromLocationId", payload.fromLocationId);
      fd.set("toLocationId", payload.toLocationId);
      fd.set("name", payload.name);
      fd.set("notes", payload.notes);
      fd.set("lineItems", JSON.stringify(payload.lineItems));
      submit(fd, { method: "post" });
    },
    [submit],
  );

  return (
    <Page title="New Transfer" backAction={{ url: "/app/transfers" }}>
      <Layout>
        {actionData && "error" in actionData && (
          <Layout.Section>
            <Banner tone="critical">{actionData.error as string}</Banner>
          </Layout.Section>
        )}

        <TransferEditor
          key={prefill ? "prefilled" : "blank"}
          locations={locations}
          initial={prefill ?? { fromLocationId: defaultLocationId, rows: [] }}
          onSave={handleSave}
          saveLabel="Save as draft"
          isBusy={isBusy}
          cancelUrl="/app/transfers"
        />
        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
