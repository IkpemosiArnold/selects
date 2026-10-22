// The HTTP and SSE client for the core server (notes/CONTRACTS.md).
// In mock mode the same interface is served from src/mock/server.js.
import { createMockApi } from "../mock/server.js";

async function j(res) {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      msg = [body.message || body.error || msg, body.hint].filter(Boolean).join(" ");
    } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  // 202s may carry a body ({ queued, ... }); an empty one is fine too.
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const EVENTS = ["job", "stage", "progress", "words", "candidates", "render", "output", "faces", "captions", "quality", "error"];

function createHttpApi() {
  const get = (p) => fetch(p).then(j);
  const send = (method, p, body) =>
    fetch(p, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }).then(j);
  return {
    mock: false,
    health: () => get("/api/health"),
    models: () => get("/api/models"),
    listJobs: () => get("/api/jobs"),
    getJob: (id) => get(`/api/jobs/${id}`),
    getWords: (id) => get(`/api/jobs/${id}/words`),
    createJob: (path, settings) => send("POST", "/api/jobs", { path, settings }),
    patchCandidate: (id, cid, body) => send("PATCH", `/api/jobs/${id}/candidates/${cid}`, body),
    patchJob: (id, settings) => send("PATCH", `/api/jobs/${id}`, { settings }),
    getKit: (id, cid) => get(`/api/jobs/${id}/candidates/${cid}/kit`),
    retryKit: (id, cid) => send("POST", `/api/jobs/${id}/candidates/${cid}/kit`, {}),
    queue: () => get("/api/queue"),
    render: (id, ids) => send("POST", `/api/jobs/${id}/render`, ids ? { ids } : {}),
    // Approve the best N clips not skipped, and queue their render when asked: { approved, candidates }.
    approveTop: (id, top, { render = false, preset } = {}) => send("POST", `/api/jobs/${id}/approve`, { top, ...(render ? { render } : {}), ...(preset ? { preset } : {}) }),
    resume: (id, body) => send("POST", `/api/jobs/${id}/resume`, body || {}),
    // Captions, languages and blur (CONTRACTS.md, "Languages, captions, transcript quality and blur").
    asrModels: () => get("/api/asr-models"),
    getCaptions: (id) => get(`/api/jobs/${id}/captions`),
    putCaptions: (id, cues) => send("PUT", `/api/jobs/${id}/captions`, { cues }),
    resetCaptions: (id) => send("POST", `/api/jobs/${id}/captions/reset`),
    setLanguage: (id, body) => send("POST", `/api/jobs/${id}/language`, body),
    detectFaces: (id) => send("POST", `/api/jobs/${id}/faces`),
    getFaces: (id) => get(`/api/jobs/${id}/faces`),
    captionsFileUrl: (id, ext) => `/api/jobs/${id}/captions.${ext}`,
    outputUrl: (id) => `/media/${id}/output`,
    frameUrl: (id, t) => `/media/${id}/frame?t=${(+t || 0).toFixed(2)}`,
    // Optional: lets drag-and-drop work in browsers that hide a file's folder.
    // Falls back to asking for the full path if the server does not have it.
    locate: (name, size) =>
      fetch(`/api/locate?name=${encodeURIComponent(name)}&size=${size}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => b?.path ?? null)
        .catch(() => null),
    events(id, onEvent) {
      const es = new EventSource(`/api/jobs/${id}/events`);
      for (const type of EVENTS) {
        es.addEventListener(type, (ev) => {
          let data = null;
          try { data = JSON.parse(ev.data); } catch {}
          // EventSource also fires a bare "error" on connection loss; ignore those.
          if (type === "error" && !ev.data) return;
          onEvent(type, data);
        });
      }
      return () => es.close();
    },
    thumbUrl: (id, n) => `/media/${id}/thumbs/${n}`,
    sourceUrl: (id) => `/media/${id}/source`,
    clipUrl: (id, cid) => `/media/${id}/clips/${cid}`,
  };
}

const params = new URLSearchParams(location.search);
export const isMock = params.has("mock") ? params.get("mock") !== "0" : import.meta.env.VITE_MOCK === "1" || import.meta.env.VITE_MOCK === "true";
export const debugMode = params.has("debug") || params.has("eval");

// One app, two engines. VITE_ENGINE=browser (the hosted Selects Web) runs the whole
// pipeline in this tab through src/browser's adapter; the default, server, talks to
// `selects serve` on this laptop. The flag is replaced at build time, so a server build
// never bundles the browser engine and its models' runtimes.
export const ENGINE = import.meta.env.VITE_ENGINE === "browser" ? "browser" : "server";

async function createApi() {
  if (isMock) return createMockApi(params);
  if (import.meta.env.VITE_ENGINE === "browser") {
    const { createBrowserApi } = await import("../../../src/browser/api.js");
    const saved = readEngineMode();
    return createBrowserApi(saved ? { mode: saved } : {});
  }
  return createHttpApi();
}

/** Private, Light or Smart, remembered per browser once chosen (keys stay in the tab only). */
export function readEngineMode() {
  try {
    const m = localStorage.getItem("selects-engine-mode");
    return m === "smart" || m === "private" || m === "light" ? m : null;
  } catch {
    return null;
  }
}
export function saveEngineMode(m) {
  try {
    localStorage.setItem("selects-engine-mode", m);
  } catch {}
}

export const api = await createApi();
/** True when the work runs in this tab (the hosted build). */
export const inBrowser = !!api.browser;


/**
 * Carry on with a stopped job. On the server that is POST /resume; in the browser the
 * engine picks the job up from its last saved step, after taking the video again when
 * the step needs it (attachFile checks it is the same file).
 */
export async function retryJob(id, { file = null, body, judge = null } = {}) {
  if (!inBrowser) return api.resume(id, body);
  if (file) await api.attachFile(id, file);
  // Smart mode was not answering: the person's choice (retry, preliminary, download)
  if (judge) return api.chooseJudge(id, judge);
  api.engine.start(id).catch(() => {});
  return { queued: true };
}

/** In the browser, whether this tab still has the video file for a job (rendering needs it). */
export function hasVideo(id) {
  if (!inBrowser) return true;
  try {
    return !!api.engine?.rec?.(id)?.file;
  } catch {
    return true;
  }
}

/**
 * Open the file picker for the video again. Call it straight from a tap, before any await,
 * so the browser lets the picker open. Resolves the File, or null when cancelled.
 */
export function pickVideo() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/*";
    input.onchange = () => resolve(input.files?.[0] || null);
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** Render clips, asking for the video again first when the browser no longer has it. */
export async function renderClips(id, ids) {
  if (inBrowser && !hasVideo(id)) {
    const file = await pickVideo();
    if (!file) throw Object.assign(new Error("Rendering needs the video. Choose the same file you started with."), { status: 409 });
    await api.attachFile(id, file);
  }
  return api.render(id, ids);
}
