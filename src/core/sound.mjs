// Sound events on the device: where people laugh, clap or raise their voices. A transcript
// cannot hear a laugh, and whisper usually leaves laughter out of the words altogether, so
// the moments a podcast is posted for (a joke landing, banter, a heated turn) were invisible
// to the ranking. Two sources, no network, no cost:
//
//   1. YAMNet (Google, Apache-2.0), an AudioSet classifier of 521 sound classes, as a 16 MB
//      ONNX file with its log-mel front end inside the graph. It reads raw 16 kHz audio and
//      scores one 0.96 s frame every 0.48 s. ONNX Runtime runs it: onnxruntime-node in the CLI,
//      onnxruntime-web in the browser. Callers pass `run(pcm) -> Float32Array` (frames x 521).
//   2. Without the model or a runtime: a signal-processing laughter detector (laughterHeuristic
//      below), weaker and documented as such.
//
// No Node imports: the desktop app and the browser build share this file.

/** The model file: pinned to a revision, checked by size and SHA-256 after download. */
export const YAMNET = {
  id: "audiomagic/yamnet-onnx",
  revision: "f25b741c2f0bdc6d7e6db24b5fddda23347dbafd",
  file: "yamnet.onnx",
  url: "https://huggingface.co/audiomagic/yamnet-onnx/resolve/f25b741c2f0bdc6d7e6db24b5fddda23347dbafd/yamnet.onnx",
  bytes: 16093355,
  sha256: "d3835ffbbd4a1bb3e777f0ca217b5007907f5171dd5d17c4236b95b2af8f908e",
  licence: "Apache-2.0 (Google YAMNet; tf2onnx conversion, weights unchanged)",
  source: "https://huggingface.co/audiomagic/yamnet-onnx",
  rate: 16000,
  hop: 0.48,
  win: 0.96,
  classes: 521,
};

/** AudioSet class indexes (yamnet_class_map.csv) for the events Selects keeps. */
export const CLASSES = {
  laughter: [13, 14, 15, 16, 17, 18], // Laughter, Baby laughter, Giggle, Snicker, Belly laugh, Chuckle
  applause: [61, 62], // Cheering, Applause
  shout: [6, 9, 11], // Shout, Yell, Screaming
};

/**
 * Thresholds, set on three eval talks with whisper-marked laughter (notes/timings.md, "Sound
 * events"), not on any clip a person picked: laughter over speech scores low in YAMNet (0.1 to
 * 0.45 at whisper's laugh marks), while 99.5% of frames stay under 0.09.
 */
export const THRESHOLDS = { laughter: { frame: 0.08, peak: 0.12 }, applause: { frame: 0.1, peak: 0.2 }, shout: { frame: 0.1, peak: 0.2 } };

// one model call reads a minute of audio
export const CHUNK_SEC = 60;

/** Frames each model call adds: 125 a minute. */
export const FRAMES_PER_CHUNK = Math.round(CHUNK_SEC / YAMNET.hop);
/** Samples per model call: a minute plus one hop, so consecutive calls tile the frames exactly. */
export const chunkSamples = (rate = YAMNET.rate) => CHUNK_SEC * rate + Math.round(YAMNET.hop * rate);

/**
 * Add one model call's scores (row-major [frames, 521]) to `out`, keeping at most `keep`
 * frames (the last call covers only what is left of the recording).
 */
export function addFrames(out, scores, keep = FRAMES_PER_CHUNK) {
  const n = Math.min(keep, Math.floor(scores.length / YAMNET.classes));
  for (let i = 0; i < n; i++) {
    for (const [name, idx] of Object.entries(CLASSES)) {
      let m = 0;
      for (const k of idx) m = Math.max(m, scores[i * YAMNET.classes + k]);
      (out[name] ||= []).push(+m.toFixed(3));
    }
  }
  return out;
}

/** Frames to keep from the call that starts `offsetSamples` into a recording of `totalSamples`. */
export function framesToKeep(offsetSamples, totalSamples, rate = YAMNET.rate) {
  const left = totalSamples - offsetSamples;
  return left >= CHUNK_SEC * rate ? FRAMES_PER_CHUNK : Math.max(1, Math.ceil(left / rate / YAMNET.hop));
}

/**
 * Score a recording with YAMNet, a minute at a time (so a long file never sits in the model
 * at once). run(Float32Array) resolves the frame scores, row-major [frames, 521].
 * Returns { hop, laughter: number[], applause: number[], shout: number[] } with one value per
 * 0.48 s frame (the highest score among each event's classes, rounded to 3 places).
 */
export async function yamnetFrames(run, pcm, { rate = YAMNET.rate, onProgress, signal } = {}) {
  if (rate !== YAMNET.rate) throw new Error("YAMNet needs 16 kHz audio");
  const step = CHUNK_SEC * rate;
  const out = { hop: YAMNET.hop, laughter: [], applause: [], shout: [] };
  for (let o = 0; o < pcm.length; o += step) {
    if (signal?.aborted) throw Object.assign(new Error("Stopped before it finished."), { name: "AbortError" });
    const chunk = pcm.subarray(o, Math.min(pcm.length, o + chunkSamples(rate)));
    addFrames(out, await run(chunk), framesToKeep(o, pcm.length, rate));
    onProgress?.(Math.min(1, (o + step) / pcm.length));
  }
  return out;
}

/**
 * Frame scores -> events [{ type, s, e, p, by }]: runs of frames over the frame threshold,
 * joined across gaps of one frame, kept when the run's best frame reaches the peak threshold.
 * A frame at index i covers [i * hop, i * hop + win].
 */
export function eventsFromFrames(frames, { thresholds = THRESHOLDS, by = "yamnet" } = {}) {
  const hop = frames.hop ?? YAMNET.hop;
  const out = [];
  for (const type of Object.keys(CLASSES)) {
    const xs = frames[type] || [];
    const t = thresholds[type];
    let run = null;
    const close = () => {
      if (run && run.p >= t.peak) out.push({ type, s: +(run.i0 * hop).toFixed(2), e: +(run.i1 * hop + YAMNET.win).toFixed(2), p: +run.p.toFixed(3), by });
      run = null;
    };
    for (let i = 0; i < xs.length; i++) {
      if (xs[i] >= t.frame) {
        if (run && i - run.i1 <= 2) {
          run.i1 = i;
          run.p = Math.max(run.p, xs[i]);
        } else {
          close();
          run = { i0: i, i1: i, p: xs[i] };
        }
      }
    }
    close();
  }
  return out.sort((a, b) => a.s - b.s);
}

// ---------------------------------------------------------------- the fallback detector

const FRAME_SEC = 0.01;

/** RMS energy per 10 ms, in dB. */
export function envelopeDb(pcm, rate = 16000) {
  const n = Math.max(1, Math.round(FRAME_SEC * rate));
  const out = new Float32Array(Math.floor(pcm.length / n));
  for (let f = 0; f < out.length; f++) {
    let s = 0;
    for (let i = f * n; i < (f + 1) * n; i++) s += pcm[i] * pcm[i];
    out[f] = 10 * Math.log10(s / n + 1e-10);
  }
  return out;
}

/**
 * A laughter detector from signal processing alone, for when YAMNet cannot run. Laughter is a
 * train of short voiced bursts ("ha-ha-ha") repeating 3.5 to 7 times a second, more regular and
 * often louder than syllables in speech, and usually not written down by whisper. For each 1 s
 * window (0.5 s apart) it measures how periodic the energy envelope is at those rates (the
 * normalised autocorrelation peak at lags of 140 to 290 ms) and how many separate bursts there
 * are; a window is laughter-like when the envelope is strongly periodic, has 4 or more bursts,
 * and is not quieter than the recording's typical speech. Consecutive windows join into events.
 * Weaker than the model: periodic speech (a chant, a list read out in rhythm) also fires it,
 * and laughter under someone's voice does not. With `words`, a window full of transcribed
 * words counts for half.
 * Returns events [{ type: "laughter", s, e, p, by: "dsp" }].
 */
export function laughterHeuristic(pcm, { rate = 16000, words = null, minPeriodicity = 0.55 } = {}) {
  const env = envelopeDb(pcm, rate);
  if (env.length < 100) return [];
  const voiced = Array.from(env).filter((d) => d > -50).sort((a, b) => a - b);
  if (!voiced.length) return [];
  const speechDb = voiced[Math.floor(voiced.length * 0.5)];
  const win = 100; // 1 s of 10 ms frames
  const hopF = 50;
  const lag0 = 14;
  const lag1 = 29;
  const wordAt = words?.length ? wordCoverage(words) : null;
  const hits = [];
  for (let f0 = 0; f0 + win <= env.length; f0 += hopF) {
    // floor at -60 dB, so the silent gaps between bursts do not swamp the shape
    const seg = Array.from(env.subarray(f0, f0 + win), (d) => Math.max(-60, d));
    const loud = seg.slice().sort((a, b) => a - b)[Math.floor(win * 0.8)];
    if (loud < speechDb - 6) continue; // quieter than the talk: background, not a laugh
    let mean = 0;
    for (const d of seg) mean += d;
    mean /= win;
    const x = seg.map((d) => d - mean);
    let e0 = 0;
    for (const v of x) e0 += v * v;
    if (e0 <= 1e-6) continue;
    let best = 0;
    for (let lag = lag0; lag <= lag1; lag++) {
      let c = 0;
      for (let i = 0; i + lag < win; i++) c += x[i] * x[i + lag];
      best = Math.max(best, c / e0);
    }
    // bursts: upward crossings of the window's mean energy, each at least 60 ms apart
    let bursts = 0;
    let last = -100;
    for (let i = 1; i < win; i++) if (x[i - 1] < 0 && x[i] >= 0 && i - last >= 6) (bursts++, (last = i));
    let p = best >= minPeriodicity && bursts >= 4 ? best : 0;
    if (p && wordAt) p *= 1 - 0.5 * wordAt((f0 + win / 2) * FRAME_SEC);
    if (p >= minPeriodicity * 0.75) hits.push({ s: f0 * FRAME_SEC, e: (f0 + win) * FRAME_SEC, p });
  }
  const out = [];
  for (const h of hits) {
    const prev = out[out.length - 1];
    if (prev && h.s <= prev.e) {
      prev.e = h.e;
      prev.p = Math.max(prev.p, h.p);
    } else out.push({ ...h });
  }
  return out.map((h) => ({ type: "laughter", s: +h.s.toFixed(2), e: +h.e.toFixed(2), p: +Math.min(1, h.p).toFixed(3), by: "dsp" }));
}

/** t -> the share of the second around t that is covered by transcribed words (0..1). */
function wordCoverage(words) {
  const sorted = words.filter((w) => Number.isFinite(w.s) && Number.isFinite(w.e)).sort((a, b) => a.s - b.s);
  return (t) => {
    const a = t - 0.5;
    const b = t + 0.5;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].e < a) lo = mid + 1;
      else hi = mid;
    }
    let cover = 0;
    for (let i = lo; i < sorted.length && sorted[i].s < b; i++) cover += Math.max(0, Math.min(b, sorted[i].e) - Math.max(a, sorted[i].s));
    return Math.min(1, cover);
  };
}

/**
 * The saved form (sound.json): { by: "yamnet" | "dsp", model, frames?, events, sec }. Frames
 * are kept so thresholds can change without running the model again.
 */
export function soundRecord({ frames = null, events, by, sec = null }) {
  return { by, model: by === "yamnet" ? { id: YAMNET.id, revision: YAMNET.revision } : null, thresholds: by === "yamnet" ? THRESHOLDS : null, ...(frames ? { frames } : {}), events, sec };
}
