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
import { backfillStockyIfNeeded } from "./services/reports/stocky-backfill.server";
import { buildVariantDaySnapshot } from "./services/forecast/variant-day-snapshot.server";

export const streamTimeout = 5000;

// ─── Nightly per-variant snapshot ─────────────────────────────────────
// Writes one VariantDaySnapshot per variant per day — the foundation
// for both demand forecasting and historical inventory valuation.
// Runs every 3 hours so a missed tick catches up fast; each per-shop
// invocation is idempotent on (shop, date). Stored on globalThis so
// HMR reloads don't spawn duplicate timers.
//
// The old shop-total InventoryValueSnapshot cron was retired here —
// its data (Stocky historical + one day of location rollups) stays on
// disk for the valuation view's pre-cutover fallback, but new writes
// only go into VariantDaySnapshot from now on.
const SNAPSHOT_TICK_MS = 3 * 60 * 60 * 1000;
type CronGlobal = typeof globalThis & {
  __flwForecastCron?: NodeJS.Timeout;
};
const cronGlobal = globalThis as CronGlobal;
if (!cronGlobal.__flwForecastCron) {
  const run = async () => {
    try {
      const sessions = await db.session.findMany({
        select: { shop: true },
        distinct: ["shop"],
      });
      for (const { shop } of sessions) {
        // One-shot Stocky historical backfill (idempotent — checks for
        // existing sentinel rows before writing).
        try {
          await backfillStockyIfNeeded(shop);
        } catch (error) {
          console.error(`[StockyBackfill] ${shop} failed:`, error);
        }

        // Skip if today's variant-day snapshot is already on disk.
        // Represented day = the UTC day the tick is running on.
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const existing = await db.variantDaySnapshot.findFirst({
          where: { shop, date: { gte: today } },
          select: { id: true },
        });
        if (existing) continue;
        try {
          const { admin } = await unauthenticated.admin(shop);
          const result = await buildVariantDaySnapshot(admin, shop);
          // Loud logging — the spec explicitly calls out that gaps in
          // this table are unrecoverable, so we want failures & every
          // success visible in Fly logs.
          console.log(
            `[VariantDayCron] ${shop}: wrote ${result.variantsWritten} variants ` +
              `for ${result.date.slice(0, 10)} ` +
              `(${result.productsSeen} products, ` +
              `${result.totalOnHand} units on-hand, ` +
              `${result.totalUnitsSold} units sold in-day)`,
          );
        } catch (error) {
          console.error(
            `[VariantDayCron] ${shop} FAILED — gap in variant_day is unrecoverable:`,
            error,
          );
        }
      }
    } catch (error) {
      console.error("[VariantDayCron] tick failed:", error);
    }
  };
  // Fire once shortly after boot, then on the interval.
  setTimeout(run, 60_000);
  cronGlobal.__flwForecastCron = setInterval(run, SNAPSHOT_TICK_MS);
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
