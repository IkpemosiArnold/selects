// Main-thread side of the sound-event worker (sound.worker.js): load YAMNet once, then score
// the recording a minute at a time from the saved 16 kHz audio, so the tab never holds more
// than one minute of it for this. Events come out as src/core/sound.mjs makes them on the
// desktop. If the model cannot load (offline on first use, no room to store it), the page
// falls back to the signal-processing laughter detector and says so.
import { addFrames, chunkSamples, CHUNK_SEC, eventsFromFrames, framesToKeep, laughterHeuristic, soundRecord, YAMNET } from "../core/sound.mjs";

let worker = null;
let ready = null;
let seq = 0;

function getWorker() {
  worker ??= new Worker(new URL("./sound.worker.js", import.meta.url), { type: "module" });
  return worker;
}

function call(msg, transfer, until) {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = ev.data;
      if (m.type === "error" && (m.id == null || m.id === msg.id)) {
        w.removeEventListener("message", onMsg);
        reject(Object.assign(new Error(m.message), { kind: m.kind }));
      } else if (until(m)) {
        w.removeEventListener("message", onMsg);
        resolve(m);
      } else if (m.type === "download") msg.onDownload?.(m);
    };
    w.addEventListener("message", onMsg);
    const { onDownload, ...plain } = msg;
    w.postMessage(plain, transfer || []);
  });
}

/** Load the model (downloading it the first time). onDownload({ loaded, total, cached }). */
export function loadSound({ onDownload } = {}) {
  ready ??= call({ type: "load", onDownload }, [], (m) => m.type === "loaded").catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

/**
 * Sound events for a recording of `duration` seconds. pcmRange(start, end) resolves that
 * stretch of the 16 kHz audio (engine.js pcmRange). Returns soundRecord(...): { by, events, ... }.
 * onProgress(0..1). words: for the fallback detector.
 */
export async function soundEvents(duration, pcmRange, { onProgress, onDownload, signal, words = null } = {}) {
  const t0 = performance.now();
  const total = Math.round(duration * YAMNET.rate);
  const step = CHUNK_SEC;
  let modelOk = true;
  let why = null;
  try {
    await loadSound({ onDownload });
  } catch (e) {
    modelOk = false;
    why = `the sound model could not load (${e.message})`;
  }
  const frames = { hop: YAMNET.hop, laughter: [], applause: [], shout: [] };
  const dsp = [];
  for (let t = 0; t < duration; t += step) {
    if (signal?.aborted) throw Object.assign(new Error("Stopped before it finished."), { name: "AbortError" });
    const pcm = await pcmRange(t, Math.min(duration, t + chunkSamples() / YAMNET.rate));
    if (!pcm?.length) break;
    if (modelOk) {
      const copy = new Float32Array(pcm);
      const id = ++seq;
      const m = await call({ type: "run", id, pcm: copy }, [copy.buffer], (x) => x.type === "scores" && x.id === id);
      addFrames(frames, m.scores, framesToKeep(Math.round(t * YAMNET.rate), total));
    } else {
      const ws = words ? words.filter((w) => w.e >= t && w.s <= t + step + 1).map((w) => ({ ...w, s: w.s - t, e: w.e - t })) : null;
      for (const e of laughterHeuristic(pcm.subarray(0, Math.min(pcm.length, step * YAMNET.rate)), { words: ws })) dsp.push({ ...e, s: +(e.s + t).toFixed(2), e: +(e.e + t).toFixed(2) });
    }
    onProgress?.(Math.min(1, (t + step) / duration));
  }
  const sec = +((performance.now() - t0) / 1000).toFixed(1);
  return modelOk ? soundRecord({ frames, events: eventsFromFrames(frames), by: "yamnet", sec }) : { ...soundRecord({ events: dsp, by: "dsp", sec }), why };
}
