"use strict";

// The editor token lives only in this tab's sessionStorage. It is never part
// of the site's code — without it the API refuses every write.
const TOKEN_KEY = "music-timeline-editor-token";

const IMAGE_MAX_DIMENSION = 2000;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const CARD_IMAGE_WIDTH = 720;

let entries = [];
let loaded = false;
let editingEntry = null;

// —— helpers ——————————————————————————————————————————————

/** Build DOM nodes with textContent only — user text never becomes HTML */
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

/** Only plain http(s) links become clickable (blocks javascript: etc.) */
function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch (_) {
    return null;
  }
}

/** Media URLs must be our own /api/media paths */
function safeMediaPath(url) {
  return typeof url === "string" && /^\/api\/media\?id=[A-Za-z0-9.%-]+$/.test(url) ? url : null;
}

function cardImageSrc(mediaPath) {
  const params = new URLSearchParams({ url: mediaPath, w: String(CARD_IMAGE_WIDTH), fm: "webp", q: "75" });
  return `/.netlify/images?${params}`;
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

let errorTimer = null;
function showError(msg) {
  const el = document.getElementById("error-message");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    el.hidden = true;
    el.textContent = "";
  }, 10000);
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// —— API ——————————————————————————————————————————————————

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.auth) headers.Authorization = `Bearer ${getToken()}`;

  const r = await fetch(path, { method: options.method || "GET", headers, body: options.body, credentials: "same-origin" });
  let body = {};
  try {
    body = await r.json();
  } catch (_) {
    /* non-JSON error page */
  }

  if (r.status === 401 && options.auth) {
    setToken("");
    applyMode();
    throw new Error("Your editor session is no longer valid. Sign in again.");
  }
  if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
  return body;
}

async function loadEntries() {
  const data = await api("/api/entries");
  entries = Array.isArray(data.entries) ? data.entries : [];
  loaded = true;
}

// —— rendering ————————————————————————————————————————————

function linkList(links) {
  const items = (links || [])
    .map((l) => {
      const href = safeHref(l.url);
      if (!href) return null;
      return h("li", {},
        h("a", { href, target: "_blank", rel: "noopener noreferrer nofollow ugc" }, l.label || new URL(href).hostname, h("span", { class: "link-arrow", "aria-hidden": "true" }, " ↗"))
      );
    })
    .filter(Boolean);
  return items.length ? h("ul", { class: "entry-links" }, items) : null;
}

function entryImage(entry) {
  const media = safeMediaPath(entry.image_url);
  if (!media) return null;

  const img = h("img", { src: cardImageSrc(media), alt: entry.image_alt || "", loading: "lazy", decoding: "async" });
  const btn = h("button", { type: "button", class: "entry-image", dataset: { full: media }, "aria-label": `View image: ${entry.image_alt || entry.title}` },
    h("span", { class: "img-placeholder", "aria-hidden": "true" }),
    img
  );
  const done = () => btn.classList.add("img-loaded");
  img.addEventListener("load", done);
  // Local dev has no image CDN — fall back to the original once
  img.addEventListener("error", () => {
    if (img.src.includes("/.netlify/images")) img.src = media;
  }, { once: true });
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
    entry.description ? h("p", { class: "entry-desc" }, entry.description) : null,
    linkList(entry.links)
  );

  return h("article", { class: `entry entry-${side}`, id: `entry-${entry.id}` },
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

// —— editor form ——————————————————————————————————————————

function addLinkRow(link = { label: "", url: "" }) {
  const list = document.getElementById("links-list");
  const row = h("div", { class: "link-row" },
    h("input", { type: "text", class: "field-input link-label", maxlength: "200", placeholder: "label", "aria-label": "Link label", value: link.label }),
    h("input", { type: "url", class: "field-input link-url", maxlength: "2048", placeholder: "https://...", "aria-label": "Link URL", value: link.url }),
    h("button", { type: "button", class: "tool-btn link-remove", "aria-label": "Remove link" }, "×")
  );
  list.append(row);
  return row;
}

function readLinks() {
  return [...document.querySelectorAll("#links-list .link-row")]
    .map((row) => ({
      label: row.querySelector(".link-label").value.trim(),
      url: row.querySelector(".link-url").value.trim()
    }))
    .filter((l) => l.url);
}

function setYearFields(yearInput, eraInput, value) {
  if (value == null) {
    yearInput.value = "";
    eraInput.value = "CE";
  } else {
    yearInput.value = String(Math.abs(value));
    eraInput.value = value < 0 ? "BCE" : "CE";
  }
}

function readYearField(yearInput, eraInput) {
  const raw = yearInput.value.trim();
  if (!raw) return "";
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return "invalid";
  return String(eraInput.value === "BCE" ? -n : n);
}

let previewUrl = null;
function setPreview(src) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = src && src.startsWith("blob:") ? src : null;
  const wrap = document.getElementById("image-preview-wrap");
  const img = document.getElementById("image-preview");
  if (src) img.src = src;
  else img.removeAttribute("src");
  wrap.hidden = !src;
}

function resetForm() {
  editingEntry = null;
  const form = document.getElementById("entry-form");
  form.reset();
  document.getElementById("entry-id").value = "";
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
    document.getElementById("entry-id").value = entry.id;
    document.getElementById("form-heading").textContent = "edit entry";
    document.getElementById("btn-save").textContent = "save changes";
    document.getElementById("title-input").value = entry.title;
    setYearFields(document.getElementById("year-input"), document.getElementById("era-input"), entry.year);
    setYearFields(document.getElementById("end-year-input"), document.getElementById("end-era-input"), entry.end_year);
    document.getElementById("circa-input").checked = !!entry.circa;
    document.getElementById("description-input").value = entry.description || "";
    document.getElementById("image-alt-input").value = entry.image_alt || "";
    (entry.links || []).forEach((l) => addLinkRow(l));
    const media = safeMediaPath(entry.image_url);
    if (media) {
      setPreview(media);
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
 * GIFs are sent as-is so animations survive (the server still checks bytes).
 */
async function prepareImage(file) {
  if (file.type === "image/gif") {
    if (file.size > IMAGE_MAX_BYTES) throw new Error("GIF is too large (max 5 MB)");
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
  for (const quality of [0.88, 0.8, 0.7, 0.6]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    if (blob && blob.size <= IMAGE_MAX_BYTES) {
      return new File([blob], keepAlpha ? "image.webp" : "image.jpg", { type: blob.type });
    }
  }
  throw new Error("Image is too large even after compression (max 5 MB)");
}

async function submitEntry(e) {
  e.preventDefault();
  const btn = document.getElementById("btn-save");
  const idsBefore = new Set(entries.map((x) => x.id));

  const title = document.getElementById("title-input").value.trim();
  const year = readYearField(document.getElementById("year-input"), document.getElementById("era-input"));
  const endYear = readYearField(document.getElementById("end-year-input"), document.getElementById("end-era-input"));
  if (!title) return showError("Add a title.");
  if (!year || year === "invalid") return showError("Add a start year (1 or later, then pick CE or BCE).");
  if (endYear === "invalid") return showError("End year must be 1 or later.");

  const links = readLinks();
  const badLink = links.find((l) => !safeHref(l.url));
  if (badLink) return showError(`Links must start with http:// or https:// (${badLink.url.slice(0, 60)})`);

  const fd = new FormData();
  const id = document.getElementById("entry-id").value;
  if (id) fd.append("id", id);
  fd.append("title", title);
  fd.append("year", year);
  fd.append("end_year", endYear);
  fd.append("circa", String(document.getElementById("circa-input").checked));
  fd.append("description", document.getElementById("description-input").value);
  fd.append("links", JSON.stringify(links));
  fd.append("image_alt", document.getElementById("image-alt-input").value);
  fd.append("remove_image", String(document.getElementById("remove-image-input").checked));

  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "saving...";
  try {
    const file = document.getElementById("image-input").files[0];
    if (file) fd.append("image", await prepareImage(file));

    const data = await api("/api/save", { method: "POST", auth: true, body: fd });
    entries = data.entries || [];
    const savedId = id || (entries.find((x) => !idsBefore.has(x.id)) || {}).id;
    closeForm();
    renderTimeline();
    if (savedId) document.getElementById(`entry-${savedId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
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
  if (!confirm(`Delete "${entry.title}"? This can't be undone.`)) return;
  try {
    const data = await api("/api/delete", {
      method: "POST",
      auth: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id })
    });
    entries = data.entries || [];
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
  const main = document.getElementById("main-content");
  main.hidden = false;
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
    const r = await fetch("/api/session", { method: "POST", headers: { Authorization: `Bearer ${token}` }, credentials: "same-origin" });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(r.status === 401 ? "That token isn't right." : body.error || `Sign-in failed (${r.status})`);
    }
    setToken(token);
    input.value = "";
    document.getElementById("login-dialog").close();
    applyMode();
  } catch (ex) {
    err.textContent = ex.message || String(ex);
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

function openImage(src, alt) {
  const dialog = document.getElementById("image-dialog");
  const img = document.getElementById("image-dialog-img");
  img.src = src;
  img.alt = alt || "";
  dialog.showModal();
}

// —— wiring ———————————————————————————————————————————————

function init() {
  document.getElementById("btn-view").addEventListener("click", showTimeline);
  document.getElementById("back-home-link").addEventListener("click", (e) => {
    e.preventDefault();
    history.pushState(null, "", location.pathname);
    showLanding();
    window.scrollTo({ top: 0 });
  });
  window.addEventListener("popstate", route);

  document.getElementById("btn-editor-login").addEventListener("click", () => {
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
    else setPreview(editingEntry ? safeMediaPath(editingEntry.image_url) : null);
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
      const full = safeMediaPath(imgBtn.dataset.full);
      if (full) openImage(full, imgBtn.querySelector("img")?.alt);
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
