import { requireAdmin } from "./lib/auth.js";
import { json, errorResponse, httpError } from "./lib/respond.js";
import { purgeEntriesCache } from "./lib/cache.js";
import { entryFields, sniffImage, LIMITS } from "./lib/validate.js";
import {
  imagesStore,
  mutateIndex,
  newEntryId,
  newImageKey,
  serializeTimeline
} from "./lib/store.js";

// Multipart overhead on top of the largest allowed image
const MAX_BODY_BYTES = LIMITS.imageBytes + 256 * 1024;

async function storeImage(file) {
  if (!file || typeof file.arrayBuffer !== "function" || file.size === 0) return null;
  if (file.size > LIMITS.imageBytes) throw httpError(413, "Image is too large (max 5 MB)");

  const bytes = await file.arrayBuffer();
  const kind = sniffImage(bytes);
  if (!kind) throw httpError(400, "Image must be JPEG, PNG, WebP or GIF");

  const key = newImageKey(kind.ext);
  await imagesStore().set(key, bytes, { metadata: { mimeType: kind.mime } });
  return key;
}

async function deleteImage(key) {
  if (!key) return;
  try {
    await imagesStore().delete(key);
  } catch (_) {
    /* an orphan blob is harmless */
  }
}

/** Create (no id) or update (with id) one entry; multipart/form-data */
export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  let newImageKeyStored = null;
  try {
    await requireAdmin(req);

    const length = Number(req.headers.get("content-length") || 0);
    if (length > MAX_BODY_BYTES) throw httpError(413, "Upload is too large");

    let form;
    try {
      form = await req.formData();
    } catch (_) {
      throw httpError(400, "Expected multipart/form-data");
    }

    const id = String(form.get("id") || "");
    const fields = entryFields(form);
    const removeImage = form.get("remove_image") === "true";

    // Store the image before touching the index: a failed index write leaves
    // an orphan blob (harmless), never an entry pointing at nothing.
    newImageKeyStored = await storeImage(form.get("image"));

    const now = new Date().toISOString();
    const { result: replacedImage, index } = await mutateIndex((index) => {
      if (!id) {
        if (index.entries.length >= LIMITS.entries) throw httpError(400, "Timeline is full");
        index.entries.push({
          id: newEntryId(),
          ...fields,
          image_key: newImageKeyStored,
          created_at: now,
          updated_at: now
        });
        return null;
      }

      const entry = index.entries.find((e) => e.id === id);
      if (!entry) throw httpError(404, "Entry not found");

      const oldImage = entry.image_key || null;
      Object.assign(entry, fields, { updated_at: now });
      if (newImageKeyStored) entry.image_key = newImageKeyStored;
      else if (removeImage) entry.image_key = null;

      return entry.image_key !== oldImage ? oldImage : null;
    });
    newImageKeyStored = null; // now referenced by the entry — keep it

    await deleteImage(replacedImage);
    await purgeEntriesCache();
    return json(200, serializeTimeline(index));
  } catch (e) {
    await deleteImage(newImageKeyStored);
    return errorResponse(e);
  }
};

export const config = { path: "/api/save" };
