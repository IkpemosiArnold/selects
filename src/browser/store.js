// On-device storage for Selects Web, so a job survives a closed tab or a frozen phone tab
// and resumes from its last finished stage. Phones stop background tabs, so Selects never
// promises background processing: it saves after every stage instead.
//
// Everything is keyed by a content hash of the video (contentKey), so choosing the same file
// again finds its job. Nothing here leaves the device.
//
// The storage backend is abstract ({ get, put, del, keys }), so the logic is tested in Node
// with a Map (src/browser/store.test.mjs) and runs on IndexedDB in the browser.

const MB = 1024 * 1024;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * A stable key for a video file: SHA-256 over its size, name, lastModified and its first
 * and last 1 MB. Reading 2 MB is fast even for a 2 GB file, and a re-encoded or trimmed
 * file gets a different key.
 */
export async function contentKey(file, { subtle = globalThis.crypto.subtle } = {}) {
  const head = await file.slice(0, Math.min(file.size, MB)).arrayBuffer();
  const tail = file.size > MB ? await file.slice(Math.max(MB, file.size - MB)).arrayBuffer() : new ArrayBuffer(0);
  const meta = new TextEncoder().encode(`${file.size}|${file.name || ""}|${file.lastModified || 0}|`);
  const all = new Uint8Array(meta.byteLength + head.byteLength + tail.byteLength);
  all.set(meta, 0);
  all.set(new Uint8Array(head), meta.byteLength);
  all.set(new Uint8Array(tail), meta.byteLength + head.byteLength);
  return `v_${hex(await subtle.digest("SHA-256", all)).slice(0, 32)}`;
}

/** A Map-backed storage backend (tests, and browsers with no IndexedDB). */
export function memoryBackend() {
  const m = new Map();
  return {
    kind: "memory",
    get: async (k) => m.get(k),
    put: async (k, v) => void m.set(k, v),
    del: async (k) => void m.delete(k),
    keys: async (prefix = "") => [...m.keys()].filter((k) => k.startsWith(prefix)),
  };
}

/** IndexedDB backend: one object store, structured-cloned values (Blobs and Float32Arrays included). */
export function indexedDbBackend({ name = "selects-web", store = "kv", idb = globalThis.indexedDB } = {}) {
  let dbp = null;
  const db = () =>
    (dbp ??= new Promise((resolve, reject) => {
      const req = idb.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const tx = async (mode, fn) => {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => resolve(r?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  return {
    kind: "indexeddb",
    get: (k) => tx("readonly", (s) => s.get(k)),
    put: (k, v) => tx("readwrite", (s) => s.put(v, k)).then(() => undefined),
    del: (k) => tx("readwrite", (s) => s.delete(k)).then(() => undefined),
    keys: async (prefix = "") => (await tx("readonly", (s) => s.getAllKeys())).map(String).filter((k) => k.startsWith(prefix)),
  };
}

/** The stages in order, and which saved parts each one leaves behind. */
export const SAVED_AFTER = {
  probe: ["source"],
  transcribe: ["words", "events", "loudness", "asr", "language", "pcm"],
  candidates: ["shortlist"],
  judge: ["judgment"], // { judged, candidates (as the judge ranked them), curve, verdict, listwise, faithful, judge }
};
// Saved apart from the stages: "decisions" (a person's approvals, trims and faithful accepts,
// keyed by window: src/core/decisions.mjs), "captions" and "kits".
const ORDER = ["probe", "transcribe", "candidates", "judge"];

/**
 * Where to pick a saved job up: the first stage whose saved parts are not all there.
 * Returns { from: "probe" | "transcribe" | "candidates" | "judge" | "ready", done: [stages] }.
 */
export function resumePoint(rec) {
  const done = [];
  for (const s of ORDER) {
    if (rec?.stages?.[s] !== "done") return { from: s, done };
    done.push(s);
  }
  return { from: "ready", done };
}

/**
 * The job store. A job is saved as several keys so a stage's save is small:
 *   job:<key>            { key, id, name, size, savedAt, stages: { probe: "done", ... }, job }
 *   part:<key>:<name>    words, events, loudness, shortlist, judgment, decisions, captions, kits
 *   pcm:<key>            the 16 kHz mono audio (Float32Array, about 3.8 MB a minute)
 *   clip:<key>:<cid>:<preset>   a rendered MP4 (Blob)
 */
export function createJobStore(backend = memoryBackend()) {
  const jk = (key) => `job:${key}`;
  return {
    backend,
    async load(key) {
      return (await backend.get(jk(key))) ?? null;
    },
    /**
     * Save the job summary and mark a stage done (or just update the job with stage = null).
     * sigs: { [stage]: signature } of what that stage's saved parts were computed from
     * (src/core/signatures.mjs); a later run reuses a part only when its signature matches.
     */
    async saveStage(key, job, stage, parts = {}, sigs = null) {
      for (const [name, value] of Object.entries(parts || {})) {
        if (name === "pcm") await backend.put(`pcm:${key}`, value);
        else await backend.put(`part:${key}:${name}`, value);
      }
      const prev = (await backend.get(jk(key))) || { key, stages: {} };
      const rec = { ...prev, key, id: job.id, name: job.source?.name ?? prev.name, size: job.source?.size ?? prev.size, savedAt: new Date().toISOString(), job, stages: stage ? { ...prev.stages, [stage]: "done" } : prev.stages, sigs: { ...(prev.sigs || {}), ...(sigs || {}) } };
      delete rec.candKey; // the old shortlist fingerprint, replaced by sigs
      await backend.put(jk(key), rec);
      return rec;
    },
    async part(key, name) {
      return name === "pcm" ? backend.get(`pcm:${key}`) : backend.get(`part:${key}:${name}`);
    },
    async savePart(key, name, value) {
      await backend.put(name === "pcm" ? `pcm:${key}` : `part:${key}:${name}`, value);
    },
    async saveClip(key, cid, preset, blob) {
      await backend.put(`clip:${key}:${cid}:${preset}`, blob);
    },
    async clip(key, cid, preset) {
      return backend.get(`clip:${key}:${cid}:${preset}`);
    },
    async clips(key) {
      return (await backend.keys(`clip:${key}:`)).map((k) => {
        const [, , cid, preset] = k.split(":");
        return { cid, preset };
      });
    },
    /** Saved jobs, newest first: { key, id, name, size, savedAt, from, finished }. */
    async list() {
      const out = [];
      for (const k of await backend.keys("job:")) {
        const rec = await backend.get(k);
        if (!rec) continue;
        const { from } = resumePoint(rec);
        out.push({ key: rec.key, id: rec.id, name: rec.name, size: rec.size, savedAt: rec.savedAt, from, finished: from === "ready" });
      }
      return out.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    },
    async remove(key) {
      for (const k of [jk(key), `pcm:${key}`, ...(await backend.keys(`part:${key}:`)), ...(await backend.keys(`clip:${key}:`))]) await backend.del(k);
    },
  };
}

// ------------------------------------------------------------------ the video itself, in OPFS

/**
 * Keep a copy of the video in the origin private file system when it fits comfortably
 * (under half of the free quota), so a resumed job can render without asking for the file
 * again. Asks the browser to make storage persistent first. Returns true when stored.
 */
export async function keepVideo(key, file, { storage = globalThis.navigator?.storage } = {}) {
  try {
    if (!storage?.getDirectory) return false;
    await storage.persist?.().catch(() => false);
    const est = await storage.estimate();
    const free = (est.quota || 0) - (est.usage || 0);
    if (file.size > free * 0.5) return false;
    const dir = await (await storage.getDirectory()).getDirectoryHandle("videos", { create: true });
    try {
      const existing = await (await dir.getFileHandle(key)).getFile();
      if (existing.size === file.size) return true;
    } catch {}
    const h = await dir.getFileHandle(key, { create: true });
    const w = await h.createWritable();
    await file.stream().pipeTo(w);
    return true;
  } catch {
    return false;
  }
}

/** The kept copy of a video as a File, or null. */
export async function keptVideo(key, name, { storage = globalThis.navigator?.storage } = {}) {
  try {
    const dir = await (await storage.getDirectory()).getDirectoryHandle("videos");
    const f = await (await dir.getFileHandle(key)).getFile();
    return new File([f], name || key, { type: f.type || "video/mp4", lastModified: f.lastModified });
  } catch {
    return null;
  }
}

export async function dropVideo(key, { storage = globalThis.navigator?.storage } = {}) {
  try {
    const dir = await (await storage.getDirectory()).getDirectoryHandle("videos");
    await dir.removeEntry(key);
  } catch {}
}
