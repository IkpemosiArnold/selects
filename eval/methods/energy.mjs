// "energy": the no-LLM baseline. Scores each candidate window the way cheap clippers do:
// louder speech, faster speech and more dynamic delivery rank higher. No language understanding.
import { spawn } from "node:child_process";

const FFMPEG = process.env.SELECTS_FFMPEG || "ffmpeg";

/**
 * Loudness envelope of a media file: one RMS level in dBFS per `hop` seconds.
 * Decodes to 8 kHz mono 16-bit PCM through ffmpeg and never writes audio to disk.
 */
export function loudnessEnvelope(path, { hop = 0.5, rate = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, ["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"], { stdio: ["ignore", "pipe", "pipe"] });
    const per = Math.round(hop * rate);
    const out = [];
    let acc = 0, cnt = 0, carry = null, err = "";
    ff.stdout.on("data", (buf) => {
      if (carry) { buf = Buffer.concat([carry, buf]); carry = null; }
      const even = buf.length - (buf.length % 2);
      if (even < buf.length) carry = buf.subarray(even);
      for (let i = 0; i < even; i += 2) {
        const s = buf.readInt16LE(i) / 32768;
        acc += s * s; cnt++;
        if (cnt === per) { out.push(toDb(acc / cnt)); acc = 0; cnt = 0; }
      }
    });
    ff.stderr.on("data", (d) => (err += d));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${err.trim()}`));
      if (cnt > 0) out.push(toDb(acc / cnt));
      resolve({ hop, db: out });
    });
  });
}

function toDb(ms) {
  return ms > 0 ? Math.max(-100, 10 * Math.log10(ms)) : -100;
}

function zscores(xs) {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length) || 1;
  return xs.map((x) => (x - m) / sd);
}

/**
 * Score candidates by loudness, speech rate and dynamics.
 * @param {Array<{start:number,end:number}>} candidates
 * @param {{hop:number, db:number[]}} env  from loudnessEnvelope
 * @param {Array<{s:number,e:number}>} words  Word[] for speech rate
 * @returns candidates copies with `total` in 0..1 and `features`
 */
export function energyScore(candidates, env, words) {
  if (!candidates.length) return [];
  const starts = words.map((w) => w.s);
  const feats = candidates.map((c) => {
    const i0 = Math.max(0, Math.floor(c.start / env.hop));
    const i1 = Math.min(env.db.length, Math.ceil(c.end / env.hop));
    const frames = env.db.slice(i0, i1);
    const loud = frames.length ? frames.reduce((s, x) => s + x, 0) / frames.length : -100;
    const dyn = frames.length ? Math.sqrt(frames.reduce((s, x) => s + (x - loud) ** 2, 0) / frames.length) : 0;
    const nWords = countBetween(starts, c.start, c.end);
    const rate = nWords / Math.max(1, c.end - c.start);
    return { loud, dyn, rate };
  });
  const zl = zscores(feats.map((f) => f.loud));
  const zr = zscores(feats.map((f) => f.rate));
  const zd = zscores(feats.map((f) => f.dyn));
  const raw = feats.map((_, i) => (zl[i] + zr[i] + zd[i]) / 3);
  const lo = Math.min(...raw), hi = Math.max(...raw);
  return candidates.map((c, i) => ({
    ...c,
    total: hi > lo ? (raw[i] - lo) / (hi - lo) : 0.5,
    features: { loudDb: round(feats[i].loud), wordsPerSec: round(feats[i].rate), dynDb: round(feats[i].dyn) },
  }));
}

function countBetween(sorted, a, b) {
  return lowerBound(sorted, b) - lowerBound(sorted, a);
}
function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
function round(x) { return Math.round(x * 100) / 100; }
