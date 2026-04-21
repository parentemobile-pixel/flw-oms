import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  createStagedUpload,
  type StagedUploadResource,
} from "../services/shopify-api/products.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const filename = formData.get("filename") as string;
  const mimeType = formData.get("mimeType") as string;
  const fileSize = formData.get("fileSize") as string;
  // Optional; defaults to IMAGE for back-compat with the hero-image upload.
  // Callers uploading PDFs or other documents pass resource=FILE.
  const resourceRaw = formData.get("resource");
  const resource: StagedUploadResource =
    resourceRaw === "FILE" ? "FILE" : "IMAGE";

  try {
    const target = await createStagedUpload(
      admin,
      filename,
      mimeType,
      fileSize,
      resource,
    );
    return json({ target });
  } catch (error) {
    return json({ error: `Staged upload failed: ${error}` }, { status: 500 });
  }
};
