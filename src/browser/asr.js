// Main-thread side of the whisper worker: load once, transcribe, report progress.
import { MODELS, speechModel } from "./models.js";
import { runtimes } from "./devices.js";
import { explainModelError } from "./load-errors.js";
import { keepStored } from "./cache.js";

let worker = null;
let ready = null;
let readyKey = null;
let info = null;

function getWorker() {
  if (!worker) worker = new Worker(new URL("./asr.worker.js", import.meta.url), { type: "module" });
  return worker;
}

/** The device whisper runs on: "auto" resolves with the same rule as the download estimate (devices.js). */
export async function resolveAsrDevice(device = "auto") {
  return (await runtimes({ asrDevice: device })).asr;
}

/**
 * Which whisper and where: "auto" picks tiny.en on iPhones, iPads and devices with 4 GB of
 * memory or less, base.en elsewhere (devices.js, the same rule as the download estimate).
 * Resolves { device, size, model }.
 */
export async function resolveSpeech({ device = "auto", speech = "auto" } = {}) {
  const rt = await runtimes({ asrDevice: device, speech });
  return { device: rt.asr, size: rt.speech, model: speechModel(rt.speech) };
}

/**
 * Load whisper (downloads on first use, then from what this browser keeps).
 * model: an entry of MODELS (MODELS.whisper by default).
 * onDownload({ file, loaded, total }) for each model file.
 * Resolves { device: "webgpu" | "wasm", loadSec }. Rejects with a plain message and hint
 * (load-errors.js) and err.kind: network, quota, memory, blocked, integrity, http, unsupported.
 */
export function loadAsr({ device = "auto", model = MODELS.whisper, onDownload } = {}) {
  const key = `${model.id}|${device}`;
  if (ready && readyKey === key) return ready;
  if (ready && worker) {
    // another speech model was loaded: start a fresh worker rather than hold both in memory
    worker.terminate();
    worker = null;
  }
  readyKey = key;
  ready = resolveAsrDevice(device).then((wantDevice) => new Promise((resolve, reject) => {
    const w = getWorker();
    const onMsg = (ev) => {
      const m = ev.data;
      if (m.type === "download") onDownload?.(m);
      else if (m.type === "ready") {
        w.removeEventListener("message", onMsg);
        info = m;
        keepStored(); // the speech model is on this device now: ask the browser not to evict it
        resolve(m);
      } else if (m.type === "error") {
        w.removeEventListener("message", onMsg);
        ready = null;
        const x = explainModelError(m, { sizeBytes: model.bytes?.[wantDevice] || null });
        console.error("speech model load failed:", m.name, m.message, m.kind || "", m.stack || "");
        reject(Object.assign(new Error(x.message), { hint: x.hint, kind: x.kind, cause: m }));
      }
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ type: "load", model: model.id, dtype: model.dtype, wantDevice });
  }));
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
        else {
          const x = explainModelError(m);
          if (x.kind === "memory") reject(Object.assign(new Error(x.message), { hint: x.hint, kind: x.kind }));
          else reject(Object.assign(new Error(`Transcription failed: ${m.message}`), { hint: "Reload the page and try again. Very long videos may run out of memory in a tab; the desktop app has no such limit." }));
        }
      }
    };
    w.addEventListener("message", onMsg);
    const copy = new Float32Array(pcm);
    w.postMessage({ type: "transcribe", pcm: copy, rate }, [copy.buffer]);
  });
}

export const asrInfo = () => info;
