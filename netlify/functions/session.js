import { requireAdmin } from "./lib/auth.js";
import { json, errorResponse } from "./lib/respond.js";

/** Lets the editor check a token before showing the edit tools */
export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  try {
    await requireAdmin(req);
    return json(200, { ok: true });
  } catch (e) {
    return errorResponse(e);
  }
};

export const config = { path: "/api/session" };
