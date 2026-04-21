/**
 * Client-side helpers for Shopify's two-phase file upload flow.
 *
 * Phase 1 (`stageAndUpload`): call our `/api/staged-upload` to get a
 * pre-signed POST target, then POST the file bytes to it. That's the
 * minimum needed for product hero images — Shopify's product mutations
 * accept the staged `resourceUrl` directly for images.
 *
 * Phase 2 (`createFile`): for file_reference / list.file_reference
 * metafields we need an actual file gid; call `/api/create-file` after
 * stage+upload to register the file via Shopify's `fileCreate` mutation.
 */

export type StagedUploadResource = "IMAGE" | "FILE";

export interface StagedTarget {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
}

/**
 * Stage a staged upload target with Shopify, then POST the file bytes
 * to it. Returns the staged target (including `resourceUrl`) on success.
 * Callers decide whether to finalize with `fileCreate` (needed for
 * metafield file_reference) or use `resourceUrl` directly (images).
 */
export async function stageAndUpload(
  file: File,
  resource: StagedUploadResource = "IMAGE",
): Promise<StagedTarget> {
  const stageForm = new FormData();
  stageForm.set("filename", file.name);
  stageForm.set("mimeType", file.type || "application/octet-stream");
  stageForm.set("fileSize", String(file.size));
  stageForm.set("resource", resource);

  const stageRes = await fetch("/api/staged-upload", {
    method: "POST",
    body: stageForm,
  });
  const stageData = await stageRes.json();
  if (stageData.error || !stageData.target) {
    throw new Error(stageData.error || "Staged upload target request failed");
  }
  const target = stageData.target as StagedTarget;

  const uploadForm = new FormData();
  for (const param of target.parameters) {
    uploadForm.append(param.name, param.value);
  }
  uploadForm.append("file", file);
  const uploadRes = await fetch(target.url, {
    method: "POST",
    body: uploadForm,
  });
  if (!uploadRes.ok) {
    throw new Error(`Upload POST failed (${uploadRes.status})`);
  }

  return target;
}

/**
 * Finalize a staged upload via Shopify's fileCreate mutation (through
 * our `/api/create-file` route). Returns the file gid, which is what
 * gets stored in a file_reference / list.file_reference metafield.
 */
export async function createFile(
  resourceUrl: string,
  filename: string,
  mimeType: string,
): Promise<string> {
  const createForm = new FormData();
  createForm.set("resourceUrl", resourceUrl);
  createForm.set("filename", filename);
  createForm.set("mimeType", mimeType || "application/octet-stream");
  const createRes = await fetch("/api/create-file", {
    method: "POST",
    body: createForm,
  });
  const createData = await createRes.json();
  if (createData.error || !createData.file?.id) {
    throw new Error(createData.error || "fileCreate returned no file id");
  }
  return createData.file.id as string;
}
