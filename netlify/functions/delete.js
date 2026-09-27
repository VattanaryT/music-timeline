import { requireAdmin } from "./lib/auth.js";
import { json, errorResponse, httpError } from "./lib/respond.js";
import { purgeEntriesCache } from "./lib/cache.js";
import { imagesStore, mutateIndex, serializeTimeline } from "./lib/store.js";

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    await requireAdmin(req);

    let body;
    try {
      body = await req.json();
    } catch (_) {
      throw httpError(400, "Invalid JSON body");
    }

    const id = String((body && body.id) || "");
    if (!id) throw httpError(400, "Invalid id");

    const { result: removed, index } = await mutateIndex((index) => {
      const i = index.entries.findIndex((e) => e.id === id);
      if (i === -1) throw httpError(404, "Entry not found");
      return index.entries.splice(i, 1)[0];
    });

    if (removed.image_key) {
      try {
        await imagesStore().delete(removed.image_key);
      } catch (_) {
        /* entry is gone either way; an orphan blob is harmless */
      }
    }

    await purgeEntriesCache();
    return json(200, serializeTimeline(index));
  } catch (e) {
    return errorResponse(e);
  }
};

export const config = { path: "/api/delete" };
