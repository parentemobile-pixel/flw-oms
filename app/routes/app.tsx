import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  // Stop the mouse wheel / trackpad from nudging the value of a focused
  // <input type="number">. Every quantity field in the app is a Polaris
  // TextField (which doesn't expose onWheel), so one non-passive
  // document-level listener covers all of them. preventDefault only
  // fires while the pointer is over the focused number input, so normal
  // page scrolling is unaffected.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const el = e.target;
      if (
        el instanceof HTMLInputElement &&
        el.type === "number" &&
        document.activeElement === el
      ) {
        e.preventDefault();
      }
    };
    document.addEventListener("wheel", onWheel, { passive: false });
    return () => document.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Home
        </Link>
        <Link to="/app/product-builder">Product Builder</Link>
        <Link to="/app/products">Products</Link>
        <Link to="/app/purchase-orders">Purchase Orders</Link>
        <Link to="/app/on-hand">On Hand</Link>
        <Link to="/app/adjust">Inventory Adjust</Link>
        <Link to="/app/transfers">Transfers</Link>
        <Link to="/app/replenishment">Replenishment</Link>
        <Link to="/app/stock-counts">Stock Counts</Link>
        <Link to="/app/planning">Planning</Link>
        <Link to="/app/forecast">Forecast</Link>
        <Link to="/app/reports">Reports</Link>
        <Link to="/app/print-labels">Print Labels</Link>
        <Link to="/app/product-issues">Product Issues</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
