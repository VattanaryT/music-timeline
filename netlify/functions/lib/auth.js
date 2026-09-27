import { createHash, timingSafeEqual } from "node:crypto";
import { httpError } from "./respond.js";

/** Short tokens are guessable; refuse to run with one rather than be weak */
const MIN_TOKEN_LENGTH = 32;

/** Slows down guessing; a long random token makes guessing hopeless anyway */
const FAILURE_DELAY_MS = 750;

function digest(s) {
  return createHash("sha256").update(String(s), "utf8").digest();
}

function getAuthBearer(req) {
  const raw = req.headers.get("authorization") || "";
  const m = String(raw).match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : "";
}

/**
 * Every write needs MUSIC_ADMIN_TOKEN. The token never ships in the site's
 * code — the editor types it into the browser, which holds it for the tab only.
 * A missing or too-short env var fails closed.
 */
export async function requireAdmin(req) {
  const expected = process.env.MUSIC_ADMIN_TOKEN || "";
  if (expected.length < MIN_TOKEN_LENGTH)
    throw httpError(503, "Editing is disabled: MUSIC_ADMIN_TOKEN is not set (min 32 chars)");

  // Hash both sides so the comparison is constant-time regardless of length
  const given = getAuthBearer(req);
  if (!given || !timingSafeEqual(digest(given), digest(expected))) {
    await new Promise((r) => setTimeout(r, FAILURE_DELAY_MS));
    throw httpError(401, "Unauthorized");
  }
}
