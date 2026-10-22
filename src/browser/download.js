// Resumable model downloads. A phone on mobile data loses its connection now and then, and
// iOS cuts a page's network when the person switches apps. One long fetch of a 140 MB model
// then fails as a whole (Safari says only "Load failed"), and Cache Storage keeps only
// complete responses, so every retry started again from zero.
//
// Here a large file comes down in closed HTTP byte ranges (8 MB by default). Every byte that
// arrives is written to the origin private file system (OPFS) at once, so a dropped
// connection, a "Try again" or a reload carries on from the last byte received. Failures are
// retried with backoff; the finished file is checked against its size and, when the server's
// ETag is a SHA-256 (Hugging Face's large files), against that hash.

const MB = 2 ** 20;
export const CHUNK_BYTES = 8 * MB;

/** A download failure with a kind the UI can explain: network, http, quota, integrity. */
export class DownloadError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "DownloadError";
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const isAbort = (e) => e?.name === "AbortError";
const isQuota = (e) => e?.name === "QuotaExceededError" || /quota/i.test(String(e?.message || ""));
const cleanTag = (t) => (t ? t.replace(/^W\//, "").replace(/"/g, "") : null);

/** Wait ms, waking early when the browser says it is back online; rejects on abort. */
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(t);
      globalThis.removeEventListener?.("online", done);
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    const stop = () => {
      clearTimeout(t);
      globalThis.removeEventListener?.("online", done);
      reject(signal.reason ?? new DOMException("Stopped", "AbortError"));
    };
    const t = setTimeout(done, ms);
    globalThis.addEventListener?.("online", done, { once: true });
    signal?.addEventListener("abort", stop, { once: true });
  });
}

async function sha256Hex(blob) {
  const d = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function concat(parts, n) {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// one download per (store, file): transformers.js can ask for the same file twice at once,
// and two writers appending to one file would interleave their bytes
const inflight = new WeakMap();

/**
 * Download url into store, resuming from whatever the store already holds.
 * onProgress({ loaded, total, cached }) as bytes arrive. Resolves a Blob of the whole file.
 * Rejects with DownloadError (kind "network" after `retries` failures in a row with no
 * progress, "http" for a missing file, "quota", "integrity") or the signal's AbortError.
 */
export function resumableDownload(url, opts = {}) {
  const { store } = opts;
  let mine = inflight.get(store);
  if (!mine) inflight.set(store, (mine = new Map()));
  const running = mine.get(url);
  if (running) {
    running.listeners.push(opts.onProgress);
    return running.promise;
  }
  const listeners = [opts.onProgress];
  const promise = download(url, { ...opts, onProgress: (p) => listeners.forEach((f) => f?.(p)) }).finally(() => mine.delete(url));
  mine.set(url, { promise, listeners });
  return promise;
}

async function download(url, { store, fetchImpl = (...a) => fetch(...a), chunkBytes = CHUNK_BYTES, retries = 8, maxWaitMs = 30000, sleep = defaultSleep, onProgress, signal, estimate } = {}) {
  let { bytes: have, meta } = await store.info(url);
  if (meta?.done && meta.size === have) {
    onProgress?.({ loaded: have, total: have, cached: true });
    return store.blob(url);
  }
  let src = null; // the CDN address the first range was redirected to (signed, so kept in memory only)
  let failures = 0;
  let lastError = null;
  const progress = (loaded) => onProgress?.({ loaded, total: meta?.size ?? 0, cached: false });

  const append = async (bytes) => {
    try {
      await store.append(url, bytes);
    } catch (e) {
      if (isQuota(e)) throw new DownloadError("quota", "There is no room left to store the model.", { loaded: have, total: meta?.size ?? 0, cause: e });
      throw e;
    }
    have += bytes.length;
  };
  const restart = async () => {
    await store.reset(url);
    have = 0;
    meta = null;
    src = null;
  };
  const backoff = async (e) => {
    lastError = e;
    failures++;
    if (failures > retries) {
      throw new DownloadError("network", `The connection dropped ${failures} times in a row.`, { loaded: have, total: meta?.size ?? 0, cause: e });
    }
    await sleep(Math.min(maxWaitMs, 1000 * 2 ** (failures - 1)), signal);
  };
  const checkRoom = async () => {
    let est = null;
    try {
      est = await (estimate ? estimate() : globalThis.navigator?.storage?.estimate?.());
    } catch {}
    if (est?.quota && meta?.size && est.quota - est.usage < meta.size - have) {
      throw new DownloadError("quota", "There is no room left to store the model.", { loaded: have, total: meta.size, needBytes: meta.size - have, freeBytes: est.quota - est.usage });
    }
  };

  while (!(meta?.size != null && have >= meta.size)) {
    signal?.throwIfAborted();
    const end = (meta?.size != null ? Math.min(meta.size, have + chunkBytes) : have + chunkBytes) - 1;
    let res;
    try {
      res = await fetchImpl(src || url, { headers: { Range: `bytes=${have}-${end}` }, mode: "cors", credentials: "omit", cache: "no-store", signal });
    } catch (e) {
      if (isAbort(e)) throw e;
      await backoff(e);
      continue;
    }
    if (src && (res.status === 401 || res.status === 403 || res.status === 410)) {
      src = null; // the signed CDN address expired: ask the original address again
      continue;
    }
    if (res.status === 416) {
      await restart(); // the file is shorter than what is stored: it changed
      continue;
    }
    if (res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500) {
      await backoff(new DownloadError("http", `The server answered ${res.status}.`, { status: res.status }));
      continue;
    }
    if (res.status !== 200 && res.status !== 206) {
      throw new DownloadError("http", `The server answered ${res.status} for ${url}.`, { status: res.status, loaded: have, total: meta?.size ?? 0 });
    }
    const tag = cleanTag(res.headers.get("etag"));
    let start = 0;
    let size;
    if (res.status === 206) {
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(res.headers.get("content-range") || "");
      if (!m) {
        await backoff(new Error("A partial response came without a Content-Range header."));
        continue;
      }
      start = +m[1];
      size = +m[3];
    } else {
      size = +res.headers.get("content-length") || undefined;
    }
    // the file changed on the server since the stored part was fetched: never stitch versions
    if (meta && ((meta.etag && tag && tag !== meta.etag) || (size != null && meta.size !== size))) {
      await res.body?.cancel().catch(() => {});
      await restart();
      continue;
    }
    if (res.status === 200 && have > 0) {
      await store.reset(url); // the server ignored the range: this answer is the whole file from byte 0
      have = 0;
    } else if (start !== have) {
      await res.body?.cancel().catch(() => {});
      await backoff(new Error(`Asked for byte ${have}, got byte ${start}.`));
      continue;
    }
    if (!meta) {
      meta = { url, size: size ?? null, etag: tag, startedAt: new Date().toISOString() };
      await store.setMeta(url, meta);
      await checkRoom();
    }
    if (res.url && res.url !== url && res.status === 206) src = res.url;

    // read what arrives, keeping it even if the connection drops part way
    const parts = [];
    let got = 0;
    const reader = res.body.getReader();
    let readError = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        progress(have + got);
      }
    } catch (e) {
      readError = e;
    }
    if (got) await append(concat(parts, got));
    if (meta.size == null && !readError) {
      meta.size = have; // a whole-file answer without a length: done when the body ends
      await store.setMeta(url, meta);
    }
    if (readError) {
      if (isAbort(readError)) throw readError;
      if (got) failures = 0; // progress was made: only failures in a row count
      await backoff(readError);
      continue;
    }
    failures = 0;
  }

  if (have !== meta.size) {
    await restart();
    throw new DownloadError("integrity", "The model file came out the wrong size.", { loaded: 0, total: 0 });
  }
  const blob = await store.blob(url);
  if (meta.etag && /^[0-9a-f]{64}$/.test(meta.etag)) {
    const hex = await sha256Hex(blob);
    if (hex !== meta.etag) {
      await store.reset(url);
      throw new DownloadError("integrity", "The model file arrived damaged.", { loaded: 0, total: meta.size, cause: lastError });
    }
  }
  meta.done = true;
  meta.doneAt = new Date().toISOString();
  await store.setMeta(url, meta);
  progress(have);
  return store.blob(url);
}

/** Keeps downloads in memory: resumes after a dropped connection, but not after a reload. */
export function memoryStore({ quotaBytes = Infinity } = {}) {
  const files = new Map();
  const get = (k) => files.get(k) || files.set(k, { parts: [], bytes: 0, meta: null }).get(k);
  const used = () => [...files.values()].reduce((a, f) => a + f.bytes, 0);
  return {
    kind: "memory",
    async info(k) {
      const f = get(k);
      return { bytes: f.bytes, meta: f.meta };
    },
    async append(k, bytes) {
      if (used() + bytes.length > quotaBytes) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      const f = get(k);
      f.parts.push(bytes.slice());
      f.bytes += bytes.length;
    },
    async setMeta(k, meta) {
      get(k).meta = { ...meta };
    },
    async blob(k) {
      return new Blob(get(k).parts, { type: "application/octet-stream" });
    },
    async reset(k) {
      files.delete(k);
    },
  };
}

/** A short, file-system-safe name for a URL. */
export function fileNameFor(url) {
  const u = new URL(url);
  const tail = u.pathname.split("/").filter(Boolean).slice(-4).join("_").replace(/[^A-Za-z0-9._-]/g, "_");
  let h = 2166136261;
  for (const c of url) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return `${tail.slice(-80)}-${h.toString(16)}`;
}

/**
 * Keeps downloads in the origin private file system ("models/<file>/"), so they survive
 * reloads. Each piece that arrives is its own file named by its byte offset, so adding one
 * never rewrites what is stored (a writable stream that keeps existing data copies the
 * whole file first, which for a 2 GB model on every 8 MB piece is far too much disk work).
 * The finished file is a Blob made of the pieces. Writes use a sync access handle in a
 * worker, or a writable stream in the page. Resolves null when this browser cannot write to
 * OPFS here (private windows; Safari before 26 in the page itself).
 */
export async function opfsStore(dirName = "models") {
  let root;
  try {
    root = await (await navigator.storage.getDirectory()).getDirectoryHandle(dirName, { create: true });
  } catch {
    return null;
  }
  const PIECE = /^p-(\d{13})$/;
  const dirFor = (k, create = true) => root.getDirectoryHandle(fileNameFor(k), { create });
  const writeFile = async (dir, name, data) => {
    const h = await dir.getFileHandle(name, { create: true });
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (typeof h.createSyncAccessHandle === "function") {
      const a = await h.createSyncAccessHandle();
      try {
        a.truncate(0);
        const n = a.write(bytes, { at: 0 });
        a.flush();
        if (n !== bytes.length) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      } finally {
        a.close();
      }
      return;
    }
    const w = await h.createWritable();
    try {
      await w.write(bytes);
      await w.close();
    } catch (e) {
      await w.abort?.().catch(() => {});
      throw e;
    }
  };
  /** The pieces in order, as long as they join up from byte 0: [{ name, at, size }]. */
  const pieces = async (k) => {
    let dir;
    try {
      dir = await dirFor(k, false);
    } catch {
      return { dir: null, list: [] };
    }
    const all = [];
    for await (const [name, h] of dir.entries()) {
      const m = PIECE.exec(name);
      if (m) all.push({ name, at: +m[1], file: await h.getFile() });
    }
    all.sort((a, b) => a.at - b.at);
    const list = [];
    let end = 0;
    for (const p of all) {
      if (p.at !== end || !p.file.size) break; // a gap: anything after it is not trusted
      list.push(p);
      end += p.file.size;
    }
    for (const p of all.slice(list.length)) await dir.removeEntry(p.name).catch(() => {});
    return { dir, list, bytes: end };
  };
  const readMeta = async (k) => {
    try {
      const dir = await dirFor(k, false);
      return JSON.parse(await (await (await dir.getFileHandle("meta.json")).getFile()).text());
    } catch {
      return null;
    }
  };
  const sizes = new Map(); // bytes stored per file, kept as pieces are added
  const store = {
    kind: "opfs",
    async info(k) {
      const meta = await readMeta(k);
      if (!meta) {
        sizes.set(k, 0);
        return { bytes: 0, meta: null }; // bytes without a record of which file they belong to are not trusted
      }
      const { bytes = 0 } = await pieces(k);
      sizes.set(k, bytes);
      return { bytes, meta };
    },
    async append(k, bytes) {
      if (!sizes.has(k)) await store.info(k);
      const at = sizes.get(k);
      await writeFile(await dirFor(k), `p-${String(at).padStart(13, "0")}`, bytes);
      sizes.set(k, at + bytes.length);
    },
    async setMeta(k, meta) {
      await writeFile(await dirFor(k), "meta.json", JSON.stringify(meta));
    },
    async blob(k) {
      const { list } = await pieces(k);
      return new Blob(list.map((p) => p.file), { type: "application/octet-stream" });
    },
    async reset(k) {
      sizes.delete(k);
      await root.removeEntry(fileNameFor(k), { recursive: true }).catch(() => {});
    },
  };
  // a write test: some browsers list OPFS but refuse to write to it from here
  try {
    await writeFile(root, ".probe", "ok");
    await root.removeEntry(".probe");
  } catch (e) {
    if (!isQuota(e)) return null;
  }
  return store;
}
