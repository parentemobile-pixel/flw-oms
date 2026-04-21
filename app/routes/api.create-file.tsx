import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { createFileFromStagedUpload } from "../services/shopify-api/products.server";

/**
 * Second half of the Shopify upload flow. After the client has staged-
 * uploaded a file and POSTed its bytes, it calls this endpoint with the
 * `resourceUrl` returned by stagedUploadsCreate to register the file in
 * Shopify (fileCreate). We return the file's gid so the caller can store
 * it in a file_reference / list.file_reference metafield.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const resourceUrl = formData.get("resourceUrl") as string;
  const filename = formData.get("filename") as string;
  const mimeType = formData.get("mimeType") as string;

  if (!resourceUrl || !filename || !mimeType) {
    return json(
      { error: "resourceUrl, filename, and mimeType are required" },
      { status: 400 },
    );
  }

  try {
    const file = await createFileFromStagedUpload(
      admin,
      resourceUrl,
      filename,
      mimeType,
    );
    return json({ file });
  } catch (error) {
    return json(
      { error: `fileCreate failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    );
  }
};
