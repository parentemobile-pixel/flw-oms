import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { RemixServer } from "@remix-run/react";
import {
  createReadableStreamFromReadable,
  type EntryContext,
} from "@remix-run/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders, unauthenticated } from "./shopify.server";
import db from "./db.server";
import { buildInventoryValueSnapshot } from "./services/reports/inventory-value-snapshot.server";

export const streamTimeout = 5000;

// ─── Nightly inventory-value snapshot ──────────────────────────────────
// Once per process, schedule a recurring tick that builds the day's
// inventory-value snapshot for every installed shop. The tick fires
// every 6 hours so we catch up on a missed day quickly; the snapshot
// builder is idempotent on (shop, periodEnd) so re-runs the same day
// don't duplicate. Stored on globalThis to survive HMR module reloads.
const SNAPSHOT_TICK_MS = 6 * 60 * 60 * 1000;
type CronGlobal = typeof globalThis & {
  __flwInventoryValueCron?: NodeJS.Timeout;
};
const cronGlobal = globalThis as CronGlobal;
if (!cronGlobal.__flwInventoryValueCron) {
  const run = async () => {
    try {
      const sessions = await db.session.findMany({
        select: { shop: true },
        distinct: ["shop"],
      });
      for (const { shop } of sessions) {
        // Skip if today's snapshot is already on disk.
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const existing = await db.inventoryValueSnapshot.findFirst({
          where: { shop, periodEnd: { gte: today } },
          select: { id: true },
        });
        if (existing) continue;
        try {
          const { admin } = await unauthenticated.admin(shop);
          const result = await buildInventoryValueSnapshot(admin, shop);
          console.log(
            `[InventoryValueCron] ${shop}: wrote ${result.rowsWritten} rows across ${result.productCount} products`,
          );
        } catch (error) {
          console.error(`[InventoryValueCron] ${shop} failed:`, error);
        }
      }
    } catch (error) {
      console.error("[InventoryValueCron] tick failed:", error);
    }
  };
  // Fire once shortly after boot, then on the interval.
  setTimeout(run, 60_000);
  cronGlobal.__flwInventoryValueCron = setInterval(run, SNAPSHOT_TICK_MS);
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? '')
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <RemixServer
        context={remixContext}
        url={request.url}
      />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      }
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
