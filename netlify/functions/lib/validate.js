import { httpError } from "./respond.js";

export const LIMITS = {
  title: 200,
  description: 8000,
  imageAlt: 300,
  links: 20,
  linkLabel: 200,
  url: 2048,
  imageBytes: 5 * 1024 * 1024,
  entries: 5000,
  // Oldest known instruments are ~40,000 years old; leave headroom
  minYear: -100000,
  maxYear: 2100
};

function text(value, max, field, { required = false } = {}) {
  // Drop control characters (keep newline/tab) so nothing odd gets stored
  const s = String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (required && !s) throw httpError(400, `${field} is required`);
  if (s.length > max) throw httpError(400, `${field} is too long (max ${max} characters)`);
  return s;
}

function year(value, field, { required = false } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    if (required) throw httpError(400, `${field} is required`);
    return null;
  }
  if (!/^-?\d{1,6}$/.test(raw)) throw httpError(400, `${field} must be a whole number`);
  const n = Number(raw);
  if (n === 0) throw httpError(400, `${field}: there is no year 0 (use 1 BCE or 1 CE)`);
  if (n < LIMITS.minYear || n > LIMITS.maxYear) throw httpError(400, `${field} is out of range`);
  return n;
}

/** Only plain http(s) links, no embedded credentials */
export function safeUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.length > LIMITS.url) throw httpError(400, "Link is too long");

  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    throw httpError(400, `Not a valid link: ${raw.slice(0, 80)}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw httpError(400, "Links must start with http:// or https://");
  if (u.username || u.password) throw httpError(400, "Links can't contain a username or password");
  return u.href;
}

function links(raw) {
  let list;
  try {
    list = JSON.parse(String(raw || "[]"));
  } catch (_) {
    throw httpError(400, "Invalid links");
  }
  if (!Array.isArray(list)) throw httpError(400, "Invalid links");
  if (list.length > LIMITS.links) throw httpError(400, `Too many links (max ${LIMITS.links})`);

  const out = [];
  for (const item of list) {
    const url = safeUrl(item && item.url);
    if (!url) continue;
    const label = text(item.label, LIMITS.linkLabel, "Link label") || new URL(url).hostname;
    out.push({ label, url });
  }
  return out;
}

/** Validate the text fields of a create/update form */
export function entryFields(form) {
  const start = year(form.get("year"), "Year", { required: true });
  const end = year(form.get("end_year"), "End year");
  if (end !== null && end < start) throw httpError(400, "End year must be after the start year");

  return {
    year: start,
    end_year: end === start ? null : end,
    circa: form.get("circa") === "true",
    title: text(form.get("title"), LIMITS.title, "Title", { required: true }),
    description: text(form.get("description"), LIMITS.description, "Description"),
    links: links(form.get("links")),
    image_alt: text(form.get("image_alt"), LIMITS.imageAlt, "Image description")
  };
}

/**
 * Decide the image type from its bytes, never from the client's claim.
 * Only raster formats: SVG/HTML could carry script served from our origin.
 */
export function sniffImage(bytes) {
  const b = new Uint8Array(bytes.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: "png", mime: "image/png" };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { ext: "gif", mime: "image/gif" };
  const ascii = String.fromCharCode(...b);
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return { ext: "webp", mime: "image/webp" };
  return null;
}
