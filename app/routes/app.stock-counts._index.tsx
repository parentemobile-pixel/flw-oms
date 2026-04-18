import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";
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
import { getStockCounts } from "../services/stock-counts/stock-count-service.server";
import { getLocations } from "../services/shopify-api/locations.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [counts, locations] = await Promise.all([
    getStockCounts(session.shop),
    getLocations(admin, session.shop).catch(() => []),
  ]);
  const locMap = new Map(locations.map((l) => [l.id, l.name]));
  return json({
    counts: counts.map((c) => ({
      ...c,
      locationName: locMap.get(c.locationId) ?? "—",
    })),
  });
};

const STATUS_TONES: Record<
  string,
  "info" | "success" | "warning" | "critical" | "attention"
> = {
  in_progress: "attention",
  completed: "success",
  abandoned: "critical",
};
const STATUS_LABELS: Record<string, string> = {
  in_progress: "In Progress",
  completed: "Completed",
  abandoned: "Abandoned",
};

export default function StockCounts() {
  const { counts } = useLoaderData<typeof loader>();

  const empty = (
    <EmptyState
      heading="Start your first stock count"
      action={{ content: "New Stock Count", url: "/app/stock-counts/new" }}
      image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
    >
      <p>Count any location. Pause and resume anytime. Reconcile with Shopify when done.</p>
    </EmptyState>
  );

  const rows = counts.map((c, i) => (
    <IndexTable.Row id={c.id} key={c.id} position={i}>
      <IndexTable.Cell>
        <Link
          to={`/app/stock-counts/${c.id}`}
          style={{ textDecoration: "none" }}
        >
          <Text variant="bodyMd" fontWeight="bold" as="span">
            {c.name}
          </Text>
        </Link>
      </IndexTable.Cell>
      <IndexTable.Cell>{c.locationName}</IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={STATUS_TONES[c.status] ?? "info"}>
          {STATUS_LABELS[c.status] ?? c.status}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {(c as any)._count?.lineItems ?? 0} SKUs
      </IndexTable.Cell>
      <IndexTable.Cell>
        {new Date(c.createdAt).toLocaleDateString()}
      </IndexTable.Cell>
      <IndexTable.Cell>
        {c.completedAt ? new Date(c.completedAt).toLocaleDateString() : "—"}
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page
      title="Stock Counts"
      primaryAction={{
        content: "New Stock Count",
        url: "/app/stock-counts/new",
      }}
    >
      <Layout>
        <Layout.Section>
          <Card padding="0">
            {counts.length === 0 ? (
              empty
            ) : (
              <IndexTable
                resourceName={{
                  singular: "stock count",
                  plural: "stock counts",
                }}
                itemCount={counts.length}
                selectable={false}
                headings={[
                  { title: "Name" },
                  { title: "Location" },
                  { title: "Status" },
                  { title: "SKUs" },
                  { title: "Started" },
                  { title: "Completed" },
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
