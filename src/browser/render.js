// Main-thread side of clip rendering: one worker, one clip at a time.
import mainFont from "../core/assets/AtkinsonHyperlegibleNext-Bold.ttf?url";
import fallbackFont from "../core/assets/NotoSans-Bold.ttf?url";
import { integratedLoudness } from "./media.js";

const FONT_URLS = { main: new URL(mainFont, location.href).href, fallback: new URL(fallbackFont, location.href).href };
let worker = null;
let seq = 0;
let queue = Promise.resolve();

/**
 * The gain that brings a clip's speech towards -14 LUFS (the shorts preset), measured on
 * the 16 kHz mono audio already decoded for whisper. Capped at +12 dB so near-silence is
 * not blown up.
 */
export function clipGainDb(pcm16k, start, end, target = -14) {
  if (!pcm16k) return 0;
  const a = Math.max(0, Math.floor(start * 16000));
  const b = Math.min(pcm16k.length, Math.ceil(end * 16000));
  const lufs = integratedLoudness(pcm16k.subarray(a, b), 16000);
  if (lufs <= -60) return 0;
  return +Math.max(-12, Math.min(12, target - lufs)).toFixed(2);
}

/** Render one clip. Resolves { mp4: ArrayBuffer, srt, reframe, frames, wallSec, ... }. */
export function renderInWorker(job, { onProgress } = {}) {
  const run = () =>
    new Promise((resolve, reject) => {
      worker ??= new Worker(new URL("./render.worker.js", import.meta.url), { type: "module" });
      const id = ++seq;
      const onMsg = (ev) => {
        const m = ev.data;
        if (m.id !== id) return;
        if (m.type === "progress") onProgress?.(m);
        else {
          worker.removeEventListener("message", onMsg);
          if (m.type === "done") resolve(m.result);
          else reject(Object.assign(new Error(m.message), { hint: m.hint || "Try the preview size, or the desktop app for long clips." }));
        }
      };
      worker.addEventListener("message", onMsg);
      worker.postMessage({ id, job, fontUrls: FONT_URLS });
    });
  queue = queue.then(run, run);
  return queue;
}
