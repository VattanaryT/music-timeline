import { json, errorResponse } from "./lib/respond.js";
import { readIndex, serializeTimeline, ENTRIES_CACHE_TAG } from "./lib/store.js";

export default async (req) => {
  if (req.method !== "GET") return json(405, { error: "Method not allowed" });

  try {
    const index = await readIndex();
    return json(200, serializeTimeline(index), {
      // Browsers always revalidate; Netlify's CDN keeps it until a write purges
      // the tag, so public traffic doesn't run this function on every view.
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=31536000",
      "Netlify-Cache-Tag": ENTRIES_CACHE_TAG
    });
  } catch (e) {
    return errorResponse(e);
  }
};

export const config = { path: "/api/entries" };
