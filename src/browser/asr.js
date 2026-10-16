// Main-thread side of the whisper worker: load once, transcribe, report progress.
import { MODELS } from "./models.js";

let worker = null;
let ready = null;
let info = null;

function getWorker() {
  if (!worker) worker = new Worker(new URL("./asr.worker.js", import.meta.url), { type: "module" });
  return worker;
}

/**
 * Load whisper (downloads on first use, then from the browser's cache).
 * onDownload({ file, loaded, total }) for each model file.
 * Resolves { device: "webgpu" | "wasm", loadSec }.
 */
export function loadAsr({ device = "auto", onDownload } = {}) {
  if (ready) return ready;
  const w = getWorker();
  ready = new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = ev.data;
      if (m.type === "download") onDownload?.(m);
      else if (m.type === "ready") {
        w.removeEventListener("message", onMsg);
        info = m;
        resolve(m);
      } else if (m.type === "error") {
        w.removeEventListener("message", onMsg);
        ready = null;
        reject(Object.assign(new Error(`Speech model failed to load: ${m.message}`), { hint: "Check the connection and reload the page. The download resumes from what is cached." }));
      }
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ type: "load", model: MODELS.whisper.id, dtype: MODELS.whisper.dtype, wantDevice: device });
  });
  return ready;
}

/**
 * Transcribe 16 kHz mono PCM. onChunk({ words, processed, i, n, wallSec }) after each window.
 * Resolves { words, wallSec, device }. The PCM buffer is copied, so the caller keeps it.
 */
export async function transcribePcm(pcm, { rate = 16000, onChunk, signal } = {}) {
  await ready;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      w.terminate();
      worker = null;
      ready = null;
      reject(Object.assign(new Error("Stopped before it finished."), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const onMsg = (ev) => {
      const m = ev.data;
      if (m.type === "chunk") onChunk?.(m);
      else if (m.type === "done" || m.type === "error") {
        w.removeEventListener("message", onMsg);
        signal?.removeEventListener("abort", onAbort);
        if (m.type === "done") resolve(m);
        else reject(Object.assign(new Error(`Transcription failed: ${m.message}`), { hint: "Reload the page and try again. Very long videos may run out of memory in a tab; the desktop app has no such limit." }));
      }
    };
    w.addEventListener("message", onMsg);
    const copy = new Float32Array(pcm);
    w.postMessage({ type: "transcribe", pcm: copy, rate }, [copy.buffer]);
  });
}

export const asrInfo = () => info;
