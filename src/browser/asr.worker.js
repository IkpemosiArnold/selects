// Whisper in a Web Worker (transformers.js on ONNX Runtime Web). WebGPU when the browser
// has an adapter, otherwise WebAssembly. The audio is cut into windows of up to 30 s at
// quiet points, so every word lands in one window, and each window's words are sent back
// as soon as it is done (the UI's streaming reveal).
//
// The model's large .onnx files come through download.js: byte ranges kept in OPFS as they
// arrive, so a dropped connection or a reload carries on instead of starting again (the
// iPhone "Load failed"). ONNX Runtime's own WebAssembly is served from this site, not a CDN.
import { env, pipeline } from "@huggingface/transformers";
import ortAsyncifyMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortAsyncifyWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortPlainMjs from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import ortPlainWasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { fetchWithRetry, memoryStore, opfsStore, resumableDownload } from "./download.js";

env.allowLocalModels = false;
env.useBrowserCache = true;

// transformers.js points ONNX Runtime at cdn.jsdelivr.net; the copies built into this site
// are used instead (same version). Which build is chosen at load time (setOrtBuild): WebKit
// running whisper on the CPU gets the plain build, since the asyncify build is reported to
// run away with memory on Safari 26 (onnxruntime issue 26827) and only WebGPU needs it;
// everything else keeps the asyncify build, as transformers.js would pick.
const ua = self.navigator?.userAgent || "";
const webkit = /AppleWebKit/.test(ua) && !/Chrome\/|Chromium\/|Edg\/|Android/.test(ua);
function setOrtBuild(dev) {
  if (!env.backends?.onnx?.wasm) return;
  const plain = webkit && dev !== "webgpu";
  env.backends.onnx.wasm.wasmPaths = plain ? { mjs: ortPlainMjs, wasm: ortPlainWasm } : { mjs: ortAsyncifyMjs, wasm: ortAsyncifyWasm };
}
setOrtBuild("wasm");

let asr = null;
let device = null;

const post = (m, transfer) => self.postMessage(m, transfer || []);

// ---- resumable model files ----
const BIG = /\.onnx(_data)?$/;
const isBig = (u) => {
  try {
    return BIG.test(new URL(u).pathname);
  } catch {
    return false;
  }
};
/** "onnx/encoder_model.onnx" from a resolve URL, the same name transformers.js reports. */
const fileOf = (u) => decodeURIComponent(new URL(u).pathname.split("/resolve/")[1]?.split("/").slice(1).join("/") || new URL(u).pathname.split("/").pop());
let storeP = null;
const getStore = () => (storeP ??= opfsStore().then((s) => s || memoryStore()));
let lastDownloadError = null;
let expected = {}; // { "onnx/encoder_model.onnx": { size, sha256 } } for the model being loaded
const netFetch = env.fetch;

env.fetch = async (input, init) => {
  const url = String(input?.url || input);
  // the small files (configs, tokenizer) are retried too: one dropped connection on any of
  // them used to fail the whole load
  if (!isBig(url)) return fetchWithRetry(input, init, { fetchImpl: netFetch });
  const store = await getStore();
  // transformers.js asks for byte 0 first to learn the size: answer from what is stored
  if (new Headers(init?.headers).get("range") === "bytes=0-0") {
    const { meta } = await store.info(url);
    if (meta?.size) return new Response(new Uint8Array(1), { status: 206, headers: { "content-range": `bytes 0-0/${meta.size}`, "content-length": "1", "content-type": "application/octet-stream" } });
    return fetchWithRetry(input, init, { fetchImpl: netFetch });
  }
  const file = fileOf(url);
  let last = 0;
  try {
    const blob = await resumableDownload(url, {
      store,
      fetchImpl: netFetch,
      onProgress: (p) => {
        const now = performance.now();
        if (p.loaded < p.total && now - last < 200) return;
        last = now;
        post({ type: "download", file, loaded: p.loaded, total: p.total, cached: !!p.cached });
      },
      onNote: (n) => post({ type: "download-note", file, ...n }),
      expect: expected[file] || null,
    });
    return new Response(blob, { status: 200, headers: { "content-length": String(blob.size), "content-type": "application/octet-stream" } });
  } catch (e) {
    lastDownloadError = e;
    throw e;
  }
};

// The large files live in OPFS (above), so Cache Storage keeps only the small ones; a model
// saved there before resumable downloads existed is still used, never fetched twice.
let legacyP = null;
const legacy = () => (legacyP ??= caches.open("transformers-cache").catch(() => null));
env.useCustomCache = true;
env.customCache = {
  async match(key) {
    const k = String(key);
    if (isBig(k)) {
      const store = await getStore();
      const { bytes, meta } = await store.info(k);
      if (meta?.done && meta.size === bytes) {
        const blob = await store.blob(k);
        return new Response(blob, { status: 200, headers: { "content-length": String(blob.size), "content-type": "application/octet-stream" } });
      }
    }
    return (await legacy())?.match(k);
  },
  async put(key, response) {
    if (isBig(String(key))) return; // already stored, chunk by chunk
    await (await legacy())?.put(key, response);
  },
};

/** Cut points: windows of at most `maxSec`, each ending at the quietest 50 ms in its last `searchSec`. */
export function planWindows(pcm, rate, { maxSec = 29.5, searchSec = 5 } = {}) {
  const out = [];
  const frame = Math.round(rate * 0.05);
  let pos = 0;
  while (pos < pcm.length) {
    const hardEnd = Math.min(pcm.length, pos + Math.round(maxSec * rate));
    if (hardEnd >= pcm.length) {
      out.push([pos, pcm.length]);
      break;
    }
    let best = hardEnd;
    let bestE = Infinity;
    for (let i = Math.max(pos + frame, hardEnd - Math.round(searchSec * rate)); i + frame <= hardEnd; i += frame) {
      let e = 0;
      for (let k = i; k < i + frame; k++) e += pcm[k] * pcm[k];
      if (e < bestE) {
        bestE = e;
        best = i + Math.round(frame / 2);
      }
    }
    out.push([pos, best]);
    pos = best;
  }
  return out;
}

async function load({ model, dtype, wantDevice, files }) {
  lastDownloadError = null;
  expected = files || {};
  // the main thread resolves "auto" with devices.js (the same rule as the download estimate);
  // this is only a fallback for callers that still send "auto"
  let dev = wantDevice;
  if (!dev || dev === "auto") {
    dev = "wasm";
    try {
      const adapter = self.navigator?.gpu && (await self.navigator.gpu.requestAdapter());
      // On an Intel integrated GPU whisper ran 2.4 times slower than on the CPU (2017 MacBook
      // Pro, notes/timings.md), so "auto" keeps whisper on the CPU there
      if (adapter && !/intel/i.test(adapter.info?.vendor || "")) dev = "webgpu";
    } catch {}
  }
  setOrtBuild(dev);
  const t0 = performance.now();
  asr = await pipeline("automatic-speech-recognition", model, {
    device: dev,
    dtype: dtype[dev] || dtype.wasm,
    progress_callback: (p) => {
      // large files report their own progress from the network (env.fetch above); here
      // transformers.js only reads them back from the device
      if (BIG.test(p.file || "")) return;
      if (p.status === "progress") post({ type: "download", file: p.file, loaded: p.loaded, total: p.total });
      else if (p.status === "done") post({ type: "download", file: p.file, done: true });
    },
  });
  device = dev;
  post({ type: "ready", device: dev, loadSec: +((performance.now() - t0) / 1000).toFixed(1) });
}

function toWords(chunks, offset) {
  const out = [];
  for (const c of chunks || []) {
    const w = String(c.text || "").trim();
    if (!w) continue;
    let [s, e] = c.timestamp || [];
    if (!Number.isFinite(s)) continue;
    if (!Number.isFinite(e) || e < s) e = s + 0.2;
    out.push({ w, s: +(s + offset).toFixed(3), e: +(e + offset).toFixed(3) });
  }
  return out;
}

async function transcribe({ pcm, rate }) {
  const wins = planWindows(pcm, rate);
  const t0 = performance.now();
  const all = [];
  const secs = [];
  for (let i = 0; i < wins.length; i++) {
    const [a, b] = wins[i];
    const t1 = performance.now();
    const res = await asr(pcm.subarray(a, b), { return_timestamps: "word" });
    const words = toWords(res.chunks, a / rate);
    // a word whisper placed past its window's end belongs to the next one; keep times monotonic
    const prevEnd = all.length ? all[all.length - 1].e : 0;
    const clean = words.filter((w) => w.s >= prevEnd - 0.05).map((w) => ({ ...w, s: Math.max(w.s, prevEnd), e: Math.max(w.e, Math.max(w.s, prevEnd) + 0.02) }));
    all.push(...clean);
    const done = b / rate;
    secs.push(+((performance.now() - t1) / 1000).toFixed(2));
    const wall = (performance.now() - t0) / 1000;
    post({ type: "chunk", i, n: wins.length, words: clean, processed: +done.toFixed(2), sec: +((performance.now() - t1) / 1000).toFixed(2), wallSec: +wall.toFixed(1) });
  }
  post({ type: "done", words: all, wallSec: +((performance.now() - t0) / 1000).toFixed(1), device, chunks: secs });
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === "load") await load(m);
    else if (m.type === "transcribe") await transcribe(m);
  } catch (err) {
    // the download's own error says more (kind, bytes saved) than what transformers.js passes on
    const e = m.type === "load" && lastDownloadError ? lastDownloadError : err;
    post({ type: "error", during: m.type, name: String(e?.name || ""), message: String(e?.message || e), kind: e?.kind || null, status: e?.status || null, loaded: e?.loaded ?? null, total: e?.total ?? null, stack: String(e?.stack || "") });
  }
};
