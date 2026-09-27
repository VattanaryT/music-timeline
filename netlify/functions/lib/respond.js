// Same-origin API: no CORS headers, so other sites can't script against it.
const baseHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store"
};

export function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...baseHeaders,
      ...extraHeaders
    }
  });
}

/** Error carrying an HTTP status, unwrapped by errorResponse() */
export function httpError(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}

/** Known errors keep their message; anything unexpected is logged, not leaked */
export function errorResponse(e) {
  if (e && e.statusCode) return json(e.statusCode, { error: e.message });
  console.error(e);
  return json(500, { error: "Something went wrong" });
}
