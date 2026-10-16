// Whisper in a Web Worker (transformers.js on ONNX Runtime Web). WebGPU when the browser
// has an adapter, otherwise WebAssembly. The audio is cut into windows of up to 30 s at
// quiet points, so every word lands in one window, and each window's words are sent back
// as soon as it is done (the UI's streaming reveal).
import { env, pipeline } from "@huggingface/transformers";

env.allowLocalModels = false;
env.useBrowserCache = true;

let asr = null;
let device = null;

const post = (m, transfer) => self.postMessage(m, transfer || []);

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

async function load({ model, dtype, wantDevice }) {
  let dev = wantDevice;
  if (!dev || dev === "auto") {
    dev = "wasm";
    try {
      if (self.navigator?.gpu && (await self.navigator.gpu.requestAdapter())) dev = "webgpu";
    } catch {}
  }
  const t0 = performance.now();
  asr = await pipeline("automatic-speech-recognition", model, {
    device: dev,
    dtype: dtype[dev] || dtype.wasm,
    progress_callback: (p) => {
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
    const wall = (performance.now() - t0) / 1000;
    post({ type: "chunk", i, n: wins.length, words: clean, processed: +done.toFixed(2), sec: +((performance.now() - t1) / 1000).toFixed(2), wallSec: +wall.toFixed(1) });
  }
  post({ type: "done", words: all, wallSec: +((performance.now() - t0) / 1000).toFixed(1), device });
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === "load") await load(m);
    else if (m.type === "transcribe") await transcribe(m);
  } catch (e) {
    post({ type: "error", message: String(e?.message || e), stack: String(e?.stack || "") });
  }
};
