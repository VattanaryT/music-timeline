import { json, errorResponse } from "./lib/respond.js";
import { imagesStore, isImageKey } from "./lib/store.js";

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export default async (req) => {
  if (req.method !== "GET") return json(405, { error: "Method not allowed" });

  const key = new URL(req.url).searchParams.get("id") || "";
  if (!isImageKey(key)) return json(400, { error: "Invalid id" });

  try {
    const res = await imagesStore().getWithMetadata(key, { type: "stream" });
    if (!res) return json(404, { error: "Not found" });

    const mime = res.metadata && res.metadata.mimeType;
    return new Response(res.data, {
      status: 200,
      headers: {
        "Content-Type": ALLOWED_MIME.has(mime) ? mime : "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        // Even if a file were somehow not an image, it can't run anything here
        "Content-Security-Policy": "default-src 'none'; sandbox",
        // Keys are unique per upload and never reused, so this is safe to pin
        "Cache-Control": "public, max-age=31536000, immutable",
        "Netlify-CDN-Cache-Control": "public, durable, max-age=31536000, immutable"
      }
    });
  } catch (e) {
    return errorResponse(e);
  }
};

export const config = { path: "/api/media" };
