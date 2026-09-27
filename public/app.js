"use strict";

// Viewing reads data/entries.json from this site. Editing commits changes to
// the GitHub repo (SITE_REPO in config.js) with a token the editor pastes in;
// GitHub Pages then republishes. The token lives only in this tab.
const TOKEN_KEY = "music-timeline-github-token";
const GITHUB_API = "https://api.github.com";
const DATA_PATH = "public/data/entries.json";
const MEDIA_DIR = "public/media";

const LIMITS = {
  title: 200,
  description: 8000,
  imageAlt: 300,
  links: 20,
  linkLabel: 200,
  url: 2048,
  imageBytes: 5 * 1024 * 1024,
  entries: 5000,
  // Oldest known instruments are ~40,000 years old; leave headroom
  maxBce: 100000,
  maxYear: 2100
};

const IMAGE_MAX_DIMENSION = 2000;
const MEDIA_RE = /^media\/[a-z0-9]{8,16}-[a-f0-9]{16}\.(jpg|png|webp|gif)$/;

let entries = [];
let loaded = false;
let editingEntry = null;

/** Images uploaded this session, shown from memory until Pages publishes them */
const localImages = new Map();

// —— helpers ——————————————————————————————————————————————

/** Build DOM nodes with textContent only — entry text never becomes HTML */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Only plain http(s) links without credentials (blocks javascript: etc.) */
function safeHref(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch (_) {
    return null;
  }
}

/** Image paths must be files this editor created under media/ */
function safeMediaPath(path) {
  return typeof path === "string" && MEDIA_RE.test(path) ? path : null;
}

function mediaSrc(path) {
  return localImages.get(path) || path;
}

function formatYear(y) {
  return y < 0 ? `${(-y).toLocaleString("en-US")} BCE` : String(y);
}

function formatDate(entry) {
  const start = entry.year;
  const end = entry.end_year;
  const prefix = entry.circa ? "c. " : "";
  if (end == null) return prefix + formatYear(start);
  // Mark CE explicitly only when a range crosses from BCE into CE
  const endLabel = start < 0 && end > 0 ? `${end} CE` : formatYear(end);
  const startLabel = start < 0 && end < 0 ? (-start).toLocaleString("en-US") : formatYear(start);
  return `${prefix}${startLabel} – ${endLabel}`;
}

function byDate(a, b) {
  return (
    a.year - b.year ||
    (a.end_year ?? a.year) - (b.end_year ?? b.year) ||
    String(a.created_at).localeCompare(String(b.created_at))
  );
}

/** Drop anything malformed so a bad data file can't break the page */
function cleanEntries(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e) => e && typeof e.id === "string" && Number.isInteger(e.year) && typeof e.title === "string")
    .sort(byDate);
}

function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch (_) {
    return "";
  }
}

function setToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch (_) {
    /* storage blocked: editing just won't survive a reload */
  }
}

function isEditor() {
  return !!getToken();
}

let messageTimer = null;
function showMessage(msg, kind = "error") {
  const el = document.getElementById("error-message");
  el.textContent = msg;
  el.classList.toggle("is-info", kind === "info");
  el.hidden = false;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => {
    el.hidden = true;
    el.textContent = "";
  }, 10000);
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function showError(msg) {
  showMessage(msg, "error");
}

// —— GitHub API ———————————————————————————————————————————

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64ToText(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function repoPath(path) {
  const { owner, repo } = SITE_REPO;
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;
}

function contentsPath(filePath) {
  return repoPath(`/contents/${filePath.split("/").map(encodeURIComponent).join("/")}`);
}

async function github(path, { method = "GET", body, token = getToken() } = {}) {
  const r = await fetch(GITHUB_API + path, {
    method,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (r.ok) return data;

  const err = new Error(data.message || `GitHub request failed (${r.status})`);
  err.status = r.status;
  if (r.status === 401) {
    setToken("");
    applyMode();
    err.message = "Your GitHub token is no longer valid. Sign in again.";
  }
  throw err;
}

/** Latest entries straight from the repo (Pages can lag behind a save) */
async function readIndex() {
  const file = await github(`${contentsPath(DATA_PATH)}?ref=${encodeURIComponent(SITE_REPO.branch)}`);
  // Files over 1 MB come back without inline content; fetch the blob instead
  const b64 = file.content || (await github(repoPath(`/git/blobs/${file.sha}`))).content;
  let data;
  try {
    data = JSON.parse(base64ToText(b64));
  } catch (_) {
    throw new Error("data/entries.json in the repo isn't valid JSON");
  }
  return { list: Array.isArray(data.entries) ? data.entries : [], sha: file.sha };
}

/**
 * Read-modify-write entries.json. GitHub rejects the write if the file changed
 * since we read it (sha mismatch), so edits from two tabs can't overwrite
 * each other — we just re-read and try again.
 */
async function mutateIndex(mutator, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { list, sha } = await readIndex();
    const result = mutator(list);
    const json = JSON.stringify({ entries: list.sort(byDate) }, null, 2) + "\n";
    try {
      await github(contentsPath(DATA_PATH), {
        method: "PUT",
        body: {
          message,
          content: bytesToBase64(new TextEncoder().encode(json)),
          sha,
          branch: SITE_REPO.branch
        }
      });
      return { result, list };
    } catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
    }
  }
  throw new Error("The timeline changed while saving. Please try again.");
}

async function uploadImage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) throw new Error("Image must be JPEG, PNG, WebP or GIF");
  if (bytes.length > LIMITS.imageBytes) throw new Error("Image is too large (max 5 MB)");

  const rand = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const name = `${Date.now().toString(36)}-${rand}.${kind.ext}`;
  await github(contentsPath(`${MEDIA_DIR}/${name}`), {
    method: "PUT",
    body: { message: `Add image ${name}`, content: bytesToBase64(bytes), branch: SITE_REPO.branch }
  });

  const path = `media/${name}`;
  localImages.set(path, URL.createObjectURL(file));
  return path;
}

async function deleteImage(path) {
  if (!safeMediaPath(path)) return;
  const repoFile = `public/${path}`;
  try {
    const file = await github(`${contentsPath(repoFile)}?ref=${encodeURIComponent(SITE_REPO.branch)}`);
    await github(contentsPath(repoFile), {
      method: "DELETE",
      body: { message: `Remove image ${path.slice(6)}`, sha: file.sha, branch: SITE_REPO.branch }
    });
  } catch (_) {
    /* an orphaned image file is harmless */
  }
}

// —— validation (only the editor writes, but keep the data clean) ——————

function cleanText(value, max, field, { required = false } = {}) {
  const s = String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (required && !s) throw new Error(`${field} is required`);
  if (s.length > max) throw new Error(`${field} is too long (max ${max} characters)`);
  return s;
}

function readYear(yearInput, eraInput, field, required) {
  const raw = yearInput.value.trim();
  if (!raw) {
    if (required) throw new Error(`${field} is required`);
    return null;
  }
  if (!/^\d{1,6}$/.test(raw) || Number(raw) < 1)
    throw new Error(`${field} must be a whole number, 1 or more (pick BCE/CE beside it)`);
  const n = Number(raw);
  const value = eraInput.value === "BCE" ? -n : n;
  if (value < -LIMITS.maxBce || value > LIMITS.maxYear) throw new Error(`${field} is out of range`);
  return value;
}

/** Decide the image type from its bytes. No SVG: it can carry script. */
function sniffImage(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg" };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: "png" };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { ext: "gif" };
  const ascii = String.fromCharCode(...b.subarray(0, 12));
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return { ext: "webp" };
  return null;
}

function readForm() {
  const year = readYear(document.getElementById("year-input"), document.getElementById("era-input"), "Year", true);
  const endYear = readYear(document.getElementById("end-year-input"), document.getElementById("end-era-input"), "End year", false);
  if (endYear !== null && endYear < year) throw new Error("End year must be after the start year");

  const links = [...document.querySelectorAll("#links-list .link-row")]
    .map((row) => ({ label: row.querySelector(".link-label").value, url: row.querySelector(".link-url").value.trim() }))
    .filter((l) => l.url);
  if (links.length > LIMITS.links) throw new Error(`Too many links (max ${LIMITS.links})`);

  return {
    year,
    end_year: endYear === year ? null : endYear,
    circa: document.getElementById("circa-input").checked,
    title: cleanText(document.getElementById("title-input").value, LIMITS.title, "Title", { required: true }),
    description: cleanText(document.getElementById("description-input").value, LIMITS.description, "Description"),
    links: links.map((l) => {
      if (l.url.length > LIMITS.url) throw new Error("A link is too long");
      const href = safeHref(l.url);
      if (!href) throw new Error(`Links must start with http:// or https:// (${l.url.slice(0, 60)})`);
      return { label: cleanText(l.label, LIMITS.linkLabel, "Link label") || new URL(href).hostname, url: href };
    }),
    image_alt: cleanText(document.getElementById("image-alt-input").value, LIMITS.imageAlt, "Image description")
  };
}

// —— loading ——————————————————————————————————————————————

async function loadPublished() {
  const r = await fetch("data/entries.json", { cache: "no-cache" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return data.entries;
}

async function loadEntries() {
  // Editors read the repo directly so they see their own saves immediately
  const list = isEditor() ? (await readIndex()).list : await loadPublished();
  entries = cleanEntries(list);
  loaded = true;
}

// —— rendering ————————————————————————————————————————————

function linkList(links) {
  const items = (Array.isArray(links) ? links : [])
    .map((l) => {
      const href = l && safeHref(l.url);
      if (!href) return null;
      return h("li", {},
        h("a", { href, target: "_blank", rel: "noopener noreferrer nofollow ugc" },
          String(l.label || new URL(href).hostname),
          h("span", { class: "link-arrow", "aria-hidden": "true" }, " ↗"))
      );
    })
    .filter(Boolean);
  return items.length ? h("ul", { class: "entry-links" }, items) : null;
}

function entryImage(entry) {
  const path = safeMediaPath(entry.image);
  if (!path) return null;

  const alt = typeof entry.image_alt === "string" ? entry.image_alt : "";
  const img = h("img", { src: mediaSrc(path), alt, loading: "lazy", decoding: "async" });
  const btn = h("button", { type: "button", class: "entry-image", dataset: { full: path }, "aria-label": `View image: ${alt || entry.title}` },
    h("span", { class: "img-placeholder", "aria-hidden": "true" }),
    img
  );
  img.addEventListener("load", () => btn.classList.add("img-loaded"));
  return btn;
}

function entryNode(entry, side, editor) {
  const card = h("div", { class: "entry-card" },
    editor
      ? h("div", { class: "entry-tools" },
          h("button", { type: "button", class: "tool-btn", dataset: { action: "edit", id: entry.id } }, "edit"),
          h("button", { type: "button", class: "tool-btn tool-btn-danger", dataset: { action: "delete", id: entry.id } }, "delete")
        )
      : null,
    entryImage(entry),
    h("h3", { class: "entry-title" }, entry.title),
    entry.description ? h("p", { class: "entry-desc" }, String(entry.description)) : null,
    linkList(entry.links)
  );

  return h("article", { class: `entry entry-${side}`, dataset: { entryId: entry.id } },
    h("div", { class: "entry-date" }, h("span", { class: "entry-year" }, formatDate(entry))),
    h("span", { class: "entry-dot", "aria-hidden": "true" }),
    card
  );
}

function renderTimeline() {
  const container = document.getElementById("timeline");
  container.replaceChildren();

  if (!loaded) {
    container.append(h("p", { class: "timeline-empty" }, "Loading..."));
    return;
  }

  if (entries.length === 0) {
    container.append(
      h("p", { class: "timeline-empty" }, isEditor() ? "The timeline is empty. Add the first entry above." : "The timeline is empty for now. The first entries are on their way.")
    );
    container.classList.add("is-empty");
    return;
  }

  container.classList.remove("is-empty");
  const editor = isEditor();
  container.append(...entries.map((e, i) => entryNode(e, i % 2 === 0 ? "left" : "right", editor)));
}

function renderLandingStat() {
  const el = document.getElementById("landing-stat");
  if (entries.length === 0) {
    el.hidden = true;
    return;
  }
  const first = entries[0];
  const last = entries[entries.length - 1];
  const span = first === last ? formatYear(first.year) : `${formatYear(first.year)} – ${formatYear(last.end_year ?? last.year)}`;
  el.textContent = `${entries.length} ${entries.length === 1 ? "entry" : "entries"} · ${span}`;
  el.hidden = false;
}

function scrollToEntry(id) {
  const el = [...document.querySelectorAll(".entry")].find((n) => n.dataset.entryId === id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
}

// —— editor form ——————————————————————————————————————————

function addLinkRow(link = { label: "", url: "" }) {
  const row = h("div", { class: "link-row" },
    h("input", { type: "text", class: "field-input link-label", maxlength: "200", placeholder: "label", "aria-label": "Link label", value: link.label }),
    h("input", { type: "url", class: "field-input link-url", maxlength: "2048", placeholder: "https://...", "aria-label": "Link URL", value: link.url }),
    h("button", { type: "button", class: "tool-btn link-remove", "aria-label": "Remove link" }, "×")
  );
  document.getElementById("links-list").append(row);
  return row;
}

function setYearFields(yearInput, eraInput, value) {
  yearInput.value = value == null ? "" : String(Math.abs(value));
  eraInput.value = value != null && value < 0 ? "BCE" : "CE";
}

let previewUrl = null;
function setPreview(src) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = src && src.startsWith("blob:") && ![...localImages.values()].includes(src) ? src : null;
  const img = document.getElementById("image-preview");
  if (src) img.src = src;
  else img.removeAttribute("src");
  document.getElementById("image-preview-wrap").hidden = !src;
}

function resetForm() {
  editingEntry = null;
  document.getElementById("entry-form").reset();
  document.getElementById("links-list").replaceChildren();
  document.getElementById("form-heading").textContent = "new entry";
  document.getElementById("btn-save").textContent = "add to timeline";
  document.getElementById("remove-image-wrap").hidden = true;
  setPreview(null);
}

function openForm(entry) {
  resetForm();
  const section = document.getElementById("editor-section");
  section.hidden = false;

  if (entry) {
    editingEntry = entry;
    document.getElementById("form-heading").textContent = "edit entry";
    document.getElementById("btn-save").textContent = "save changes";
    document.getElementById("title-input").value = entry.title;
    setYearFields(document.getElementById("year-input"), document.getElementById("era-input"), entry.year);
    setYearFields(document.getElementById("end-year-input"), document.getElementById("end-era-input"), entry.end_year);
    document.getElementById("circa-input").checked = !!entry.circa;
    document.getElementById("description-input").value = entry.description || "";
    document.getElementById("image-alt-input").value = entry.image_alt || "";
    (Array.isArray(entry.links) ? entry.links : []).forEach((l) => addLinkRow(l));
    const path = safeMediaPath(entry.image);
    if (path) {
      setPreview(mediaSrc(path));
      document.getElementById("remove-image-wrap").hidden = false;
    }
  }

  section.scrollIntoView({ behavior: "smooth", block: "start" });
  document.getElementById("title-input").focus({ preventScroll: true });
}

function closeForm() {
  resetForm();
  document.getElementById("editor-section").hidden = true;
}

/**
 * Re-encode every image through a canvas. This drops EXIF/GPS and any other
 * embedded metadata before it leaves the browser, and shrinks huge photos.
 * GIFs are sent as-is so animations survive.
 */
async function prepareImage(file) {
  if (file.type === "image/gif") {
    if (file.size > LIMITS.imageBytes) throw new Error("GIF is too large (max 5 MB)");
    return file;
  }

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("Could not read that image");
  });
  const ratio = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
  canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const keepAlpha = file.type === "image/png" || file.type === "image/webp";
  const type = keepAlpha ? "image/webp" : "image/jpeg";
  for (const quality of [0.85, 0.78, 0.7, 0.6]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    // Stay well under the limit: every image is a file in the repo
    if (blob && blob.size <= LIMITS.imageBytes / 2) {
      return new File([blob], keepAlpha ? "image.webp" : "image.jpg", { type: blob.type });
    }
  }
  throw new Error("Image is too large even after compression");
}

async function submitEntry(e) {
  e.preventDefault();
  const btn = document.getElementById("btn-save");

  let fields;
  try {
    fields = readForm();
  } catch (err) {
    return showError(err.message);
  }

  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "saving...";
  try {
    const file = document.getElementById("image-input").files[0];
    const removeImage = document.getElementById("remove-image-input").checked;
    const id = editingEntry ? editingEntry.id : crypto.randomUUID();

    // Upload the image first: a failed entry save then leaves an unused file
    // (harmless) rather than an entry pointing at nothing.
    btn.textContent = file ? "uploading image..." : "saving...";
    const newImage = file ? await uploadImage(await prepareImage(file)) : null;

    btn.textContent = "saving...";
    const now = new Date().toISOString();
    const { result: oldImage, list } = await mutateIndex((list) => {
      if (!editingEntry) {
        if (list.length >= LIMITS.entries) throw new Error("Timeline is full");
        list.push({ id, ...fields, image: newImage, created_at: now, updated_at: now });
        return null;
      }
      const entry = list.find((x) => x.id === id);
      if (!entry) throw new Error("That entry no longer exists");
      const before = entry.image || null;
      Object.assign(entry, fields, { updated_at: now });
      if (newImage) entry.image = newImage;
      else if (removeImage) entry.image = null;
      return entry.image !== before ? before : null;
    }, `${editingEntry ? "Edit" : "Add"}: ${fields.title}`.slice(0, 120));

    if (oldImage) deleteImage(oldImage);
    entries = cleanEntries(list);
    closeForm();
    renderTimeline();
    scrollToEntry(id);
    showMessage("Saved. The public site updates in about a minute.", "info");
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function deleteEntry(id) {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return;
  if (!confirm(`Delete "${entry.title}"? This can't be undone here (it stays in the repo's history).`)) return;
  try {
    const { result: removed, list } = await mutateIndex((list) => {
      const i = list.findIndex((x) => x.id === id);
      if (i === -1) throw new Error("That entry no longer exists");
      return list.splice(i, 1)[0];
    }, `Delete: ${entry.title}`.slice(0, 120));
    if (removed.image) deleteImage(removed.image);
    entries = cleanEntries(list);
    if (editingEntry && editingEntry.id === id) closeForm();
    renderTimeline();
  } catch (err) {
    showError(err.message || String(err));
  }
}

// —— modes & navigation ———————————————————————————————————

function applyMode() {
  const editor = isEditor();
  document.getElementById("edit-controls").hidden = !editor;
  document.getElementById("btn-editor-login").hidden = editor;
  if (!editor) closeForm();
  renderTimeline();
}

function showTimeline() {
  document.getElementById("landing-page").hidden = true;
  document.getElementById("main-content").hidden = false;
  if (location.hash !== "#timeline") history.pushState(null, "", "#timeline");
  applyMode();
  window.scrollTo({ top: 0 });
}

function showLanding() {
  document.getElementById("landing-page").hidden = false;
  document.getElementById("main-content").hidden = true;
  renderLandingStat();
}

function route() {
  if (location.hash === "#timeline" || isEditor()) showTimeline();
  else showLanding();
}

async function signIn(e) {
  e.preventDefault();
  const input = document.getElementById("token-input");
  const err = document.getElementById("login-error");
  const btn = document.getElementById("btn-login");
  const token = input.value.trim();
  if (!token) return;

  err.hidden = true;
  btn.disabled = true;
  try {
    // Classic tokens reach every repo on the account; insist on a scoped one
    if (!token.startsWith("github_pat_"))
      throw new Error("Use a fine-grained token (starts with github_pat_) limited to this one repository.");

    const repo = await github(repoPath(""), { token }).catch((ex) => {
      throw new Error(ex.status === 401 ? "GitHub didn't accept that token." : ex.status === 404 ? "That token can't see this repository." : ex.message);
    });
    if (!repo.permissions || !repo.permissions.push)
      throw new Error("That token can't write to this repository. Give it Contents: read and write.");

    setToken(token);
    input.value = "";
    document.getElementById("login-dialog").close();
    loaded = false;
    applyMode();
    await loadEntries();
    renderTimeline();
  } catch (ex) {
    err.textContent = ex.message || String(ex);
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function openImage(src, alt) {
  const img = document.getElementById("image-dialog-img");
  img.src = src;
  img.alt = alt || "";
  document.getElementById("image-dialog").showModal();
}

// —— wiring ———————————————————————————————————————————————

function init() {
  // Pages can't send anti-framing headers; never offer editing inside a frame
  const framed = window.top !== window.self;
  if (framed) setToken("");

  document.getElementById("btn-view").addEventListener("click", showTimeline);
  document.getElementById("back-home-link").addEventListener("click", (e) => {
    e.preventDefault();
    history.pushState(null, "", location.pathname);
    showLanding();
    window.scrollTo({ top: 0 });
  });
  window.addEventListener("popstate", route);

  const loginBtn = document.getElementById("btn-editor-login");
  if (framed) loginBtn.remove();
  else
    loginBtn.addEventListener("click", () => {
      document.getElementById("login-error").hidden = true;
      document.getElementById("login-dialog").showModal();
    });
  document.getElementById("login-form").addEventListener("submit", signIn);
  document.getElementById("btn-login-cancel").addEventListener("click", () => document.getElementById("login-dialog").close());
  document.getElementById("btn-sign-out").addEventListener("click", () => {
    setToken("");
    applyMode();
  });

  document.getElementById("btn-new-entry").addEventListener("click", () => openForm(null));
  document.getElementById("btn-cancel").addEventListener("click", closeForm);
  document.getElementById("btn-add-link").addEventListener("click", () => addLinkRow().querySelector(".link-url").focus());
  document.getElementById("links-list").addEventListener("click", (e) => {
    if (e.target.closest(".link-remove")) e.target.closest(".link-row").remove();
  });
  document.getElementById("entry-form").addEventListener("submit", submitEntry);
  document.getElementById("image-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) setPreview(URL.createObjectURL(file));
    else setPreview(editingEntry && safeMediaPath(editingEntry.image) ? mediaSrc(editingEntry.image) : null);
  });

  document.getElementById("timeline").addEventListener("click", (e) => {
    const tool = e.target.closest(".tool-btn[data-action]");
    if (tool) {
      const id = tool.dataset.id;
      if (tool.dataset.action === "edit") openForm(entries.find((x) => x.id === id));
      else if (tool.dataset.action === "delete") deleteEntry(id);
      return;
    }
    const imgBtn = e.target.closest(".entry-image");
    if (imgBtn) {
      const path = safeMediaPath(imgBtn.dataset.full);
      if (path) openImage(mediaSrc(path), imgBtn.querySelector("img")?.alt);
    }
  });

  const imageDialog = document.getElementById("image-dialog");
  document.getElementById("btn-image-close").addEventListener("click", () => imageDialog.close());
  imageDialog.addEventListener("click", (e) => {
    if (e.target === imageDialog) imageDialog.close();
  });

  loadEntries()
    .catch((err) => {
      loaded = true;
      showError(`Couldn't load the timeline: ${err.message || err}`);
    })
    .finally(() => {
      renderLandingStat();
      if (!document.getElementById("main-content").hidden) renderTimeline();
    });

  route();
}

init();
