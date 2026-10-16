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
  return res.status === 204 || res.status === 202 ? null : res.json();
}

const EVENTS = ["job", "stage", "progress", "words", "candidates", "render", "error"];

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
    queue: () => get("/api/queue"),
    render: (id, ids) => send("POST", `/api/jobs/${id}/render`, ids ? { ids } : {}),
    resume: (id) => send("POST", `/api/jobs/${id}/resume`),
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
export const api = isMock ? createMockApi(params) : createHttpApi();
