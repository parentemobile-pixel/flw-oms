import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, Link } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  IndexTable,
  Badge,
  Text,
  EmptyState,
} from "@shopify/polaris";

import { authenticate } from "../shopify.server";
import { getTransfers } from "../services/transfers/transfer-service.server";
import { getLocations } from "../services/shopify-api/locations.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [transfers, locations] = await Promise.all([
    getTransfers(session.shop),
    getLocations(admin, session.shop).catch(() => []),
  ]);
  const locMap = new Map(locations.map((l) => [l.id, l.name]));
  return json({
    transfers: transfers.map((t) => ({
      ...t,
      fromName: locMap.get(t.fromLocationId) ?? "—",
      toName: locMap.get(t.toLocationId) ?? "—",
    })),
  });
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

export default function TransfersList() {
  const { transfers } = useLoaderData<typeof loader>();

  const emptyState = (
    <EmptyState
      heading="Move inventory between locations"
      action={{ content: "New Transfer", url: "/app/transfers/new" }}
      image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
    >
      <p>Create a transfer, send from origin, then receive at destination.</p>
    </EmptyState>
  );

  const rows = transfers.map((t, i) => (
    <IndexTable.Row id={t.id} key={t.id} position={i}>
      <IndexTable.Cell>
        <Link
          to={`/app/transfers/${t.id}`}
          style={{ textDecoration: "none" }}
        >
          <Text variant="bodyMd" fontWeight="bold" as="span">
            {t.transferNumber}
          </Text>
        </Link>
      </IndexTable.Cell>
      <IndexTable.Cell>{t.fromName}</IndexTable.Cell>
      <IndexTable.Cell>{t.toName}</IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={STATUS_TONES[t.status] ?? "info"}>
          {STATUS_LABELS[t.status] ?? t.status}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {(t as any)._count?.lineItems ?? 0} lines
      </IndexTable.Cell>
      <IndexTable.Cell>
        {new Date(t.createdAt).toLocaleDateString()}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {t.sentAt ? new Date(t.sentAt).toLocaleDateString() : "—"}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {t.receivedAt ? new Date(t.receivedAt).toLocaleDateString() : "—"}
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      title="Transfers"
      subtitle="Move inventory between store locations"
      primaryAction={{ content: "New Transfer", url: "/app/transfers/new" }}
    >
      <Layout>
        <Layout.Section>
          <Card padding="0">
            {transfers.length === 0 ? (
              emptyState
            ) : (
              <IndexTable
                resourceName={{ singular: "transfer", plural: "transfers" }}
                itemCount={transfers.length}
                selectable={false}
                headings={[
                  { title: "Transfer #" },
                  { title: "From" },
                  { title: "To" },
                  { title: "Status" },
                  { title: "Lines" },
                  { title: "Created" },
                  { title: "Sent" },
                  { title: "Received" },
                ]}
              >
                {rows}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
