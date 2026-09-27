/**
 * Local dev server — no Netlify account or CLI needed.
 *
 *   MUSIC_ADMIN_TOKEN=<32+ chars> npm run dev
 *
 * Serves public/, routes /api/* to the real function handlers, stores data in
 * .dev-blobs/ via a local Blobs server, and sends the same security headers
 * as netlify.toml so CSP problems show up locally too.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BlobsServer } from "@netlify/blobs/server";
import { configureStores } from "../netlify/functions/lib/store.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT || 8888);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

/** Pull the [headers.values] block out of netlify.toml */
async function securityHeaders() {
  const toml = await readFile(join(ROOT, "netlify.toml"), "utf8");
  const block = toml.split("[headers.values]")[1] || "";
  const out = {};
  for (const m of block.matchAll(/^\s*([A-Za-z-]+)\s*=\s*"([^"]*)"\s*$/gm)) out[m[1]] = m[2];
  return out;
}

/**
 * The local Blobs server omits the ETag on GET (production sends one), which
 * breaks the index's compare-and-swap. Add it back the same way PUT computes it.
 */
class DevBlobsServer extends BlobsServer {
  async get(req) {
    const res = await super.get(req);
    if (res.status !== 200 || res.headers.get("etag")) return res;
    const url = this.parseAPIRequest(req)?.url ?? new URL(req.url ?? "", this.address);
    const { dataPath } = this.getLocalPaths(url);
    if (!dataPath) return res;
    const headers = new Headers(res.headers);
    headers.set("etag", await BlobsServer.generateETag(dataPath));
    return new Response(res.body, { status: res.status, headers });
  }
}

const routes = {
  "/api/entries": "entries.js",
  "/api/media": "media.js",
  "/api/session": "session.js",
  "/api/save": "save.js",
  "/api/delete": "delete.js"
};

async function toWebRequest(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body
  });
}

async function sendWebResponse(res, response, extra) {
  const headers = { ...extra };
  response.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function main() {
  process.env.NETLIFY_DEV_LOCAL = "1";
  if ((process.env.MUSIC_ADMIN_TOKEN || "").length < 32)
    console.warn("⚠  MUSIC_ADMIN_TOKEN is unset or shorter than 32 chars — editing will be disabled.");

  const token = randomBytes(16).toString("hex");
  const blobs = new DevBlobsServer({ directory: join(ROOT, ".dev-blobs"), token });
  const { port: blobsPort } = await blobs.start();
  configureStores({ siteID: "local-dev", token, edgeURL: `http://localhost:${blobsPort}` });

  const headers = await securityHeaders();

  createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");

      if (routes[url.pathname]) {
        const mod = await import(join(ROOT, "netlify/functions", routes[url.pathname]));
        return sendWebResponse(res, await mod.default(await toWebRequest(req)), headers);
      }

      // Stand-in for Netlify's image CDN: serve the original
      if (url.pathname === "/.netlify/images") {
        const src = url.searchParams.get("url") || "";
        if (!src.startsWith("/api/media?")) return res.writeHead(400).end();
        return res.writeHead(302, { Location: src }).end();
      }

      const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const file = normalize(join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
      const data = await readFile(file);
      res.writeHead(200, { ...headers, "Content-Type": MIME[extname(file)] || "application/octet-stream" });
      res.end(data);
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "EISDIR") return res.writeHead(404).end("Not found");
      console.error(e);
      res.writeHead(500).end("Server error");
    }
  }).listen(PORT, "127.0.0.1", () => console.log(`Music timeline → http://localhost:${PORT}`));
}

main();
