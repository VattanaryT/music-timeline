import { purgeCache } from "@netlify/functions";
import { ENTRIES_CACHE_TAG } from "./store.js";

/** /api/entries is cached at Netlify's CDN until something changes */
export async function purgeEntriesCache() {
  try {
    await purgeCache({ tags: [ENTRIES_CACHE_TAG] });
  } catch (e) {
    // Outside Netlify (local dev) there is no CDN to purge
    if (process.env.NETLIFY_DEV_LOCAL !== "1") console.warn("Cache purge failed:", e.message || e);
  }
}
