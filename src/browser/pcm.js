// Long videos in the tab: the audio is decoded in segments of about 10 minutes, each
// segment goes to the origin private file system (OPFS) as raw 16 kHz mono Float32 and to
// whisper, and is then let go. So a 2-hour video never holds its whole PCM (440 MB) in
// memory, and a job that stops part way resumes at the next segment. Measured in headless
// Chrome on the 2017 MacBook Pro: see notes/timings.md, "Long videos".
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from "mediabunny";
import { audioDecodeUnsupported } from "./media.js";

export const RATE = 16000;
export const SEGMENT_SEC = 600;
// segments end on the loudness grid (0.5 s), so per-segment loudness tracks join exactly
const GRID = 0.5;

/** Mix an AudioBuffer's channels down to one Float32Array. */
function mono(buf) {
  const n = buf.numberOfChannels;
  const out = new Float32Array(buf.length);
  for (let c = 0; c < n; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / n;
  }
  return out;
}

async function resample(pcm, fromRate) {
  if (fromRate === RATE) return pcm;
  const frames = Math.max(1, Math.round((pcm.length * RATE) / fromRate));
  const ctx = new OfflineAudioContext(1, frames, RATE);
  const b = ctx.createBuffer(1, pcm.length, fromRate);
  b.copyToChannel(pcm, 0);
  const node = ctx.createBufferSource();
  node.buffer = b;
  node.connect(ctx.destination);
  node.start();
  return (await ctx.startRendering()).getChannelData(0);
}

/**
 * Where to end a segment: the quietest 0.5 s step (on the global 0.5 s grid) within
 * `searchSec` of `target` seconds into `pcm` (default: its end), which starts at `start`
 * seconds. Returns a sample index into pcm. Pure.
 */
export function quietCut(pcm, start, { target = null, searchSec = 20 } = {}) {
  const step = Math.round(GRID * RATE);
  const endT = start + pcm.length / RATE;
  const aim = target == null ? endT : Math.min(endT, start + target);
  let best = Math.round((aim - start) * RATE);
  let bestE = Infinity;
  const firstT = Math.max(start + GRID, Math.ceil((aim - searchSec) / GRID) * GRID);
  const lastT = Math.min(endT, aim + (target == null ? 0 : searchSec));
  for (let t = firstT; t + GRID <= lastT + 1e-9; t += GRID) {
    const i = Math.round((t - start) * RATE);
    let e = 0;
    for (let k = i; k < Math.min(pcm.length, i + step); k++) e += pcm[k] * pcm[k];
    if (e < bestE) {
      bestE = e;
      best = i;
    }
  }
  return best;
}

/**
 * Decode a file's audio to 16 kHz mono in segments of about `segmentSec`, each ending at a
 * quiet moment. Yields { index, start, end, pcm } one at a time and keeps nothing after a
 * segment is yielded. startAt and firstIndex resume after segments already done.
 * onProgress(0..1) over the whole file.
 */
export async function* decodeAudioSegments(file, { segmentSec = SEGMENT_SEC, startAt = 0, firstIndex = 0, duration, onProgress } = {}) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw Object.assign(new Error("This video has no audio track, so there is nothing to transcribe."), { hint: "Choose a video with speech in it." });
    if (!(await track.canDecode())) throw audioDecodeUnsupported() || Object.assign(new Error("This browser cannot decode the video's audio."), { hint: "Try Chrome or Edge, or convert the video to MP4 (H.264 and AAC)." });
    const total = duration || (await input.computeDuration());
    const sink = new AudioSampleSink(track);
    let index = firstIndex;
    let segStart = startAt;
    let blocks = []; // resampled 16 kHz pieces of the current segment
    let have = 0;
    let pending = [];
    let pendingLen = 0;
    let rate = track.sampleRate;
    const resampleBlock = async () => {
      if (!pendingLen) return;
      const joined = new Float32Array(pendingLen);
      let o = 0;
      for (const p of pending) {
        joined.set(p, o);
        o += p.length;
      }
      pending = [];
      pendingLen = 0;
      const r = await resample(joined, rate);
      blocks.push(r);
      have += r.length;
    };
    const join = () => {
      const out = new Float32Array(have);
      let o = 0;
      for (const b of blocks) {
        out.set(b, o);
        o += b.length;
      }
      return out;
    };
    for await (const sample of sink.samples(startAt > 0 ? startAt : undefined)) {
      const buf = sample.toAudioBuffer();
      rate = buf.sampleRate;
      let m = mono(buf);
      // the first sample after a resume may start before startAt: drop the part already done
      if (sample.timestamp < startAt) m = m.subarray(Math.min(m.length, Math.round((startAt - sample.timestamp) * rate)));
      const end = sample.timestamp + sample.duration;
      sample.close();
      pending.push(m);
      pendingLen += m.length;
      if (pendingLen >= rate * 60) await resampleBlock();
      onProgress?.(Math.min(1, end / total));
      // decoded in 60 s blocks: once there is enough for the segment and the search after it,
      // cut at the quietest moment within 20 s of the segment's length
      if (have >= (segmentSec + 20) * RATE) {
        const all = join();
        const cut = quietCut(all, segStart, { target: segmentSec });
        const pcm = all.slice(0, cut);
        const rest = all.slice(cut);
        blocks = [rest];
        have = rest.length;
        const s = segStart;
        segStart = +(segStart + cut / RATE).toFixed(3);
        yield { index: index++, start: s, end: segStart, pcm };
      }
    }
    await resampleBlock();
    if (have) {
      const pcm = join();
      blocks = [];
      yield { index: index++, start: segStart, end: +(segStart + pcm.length / RATE).toFixed(3), pcm, last: true };
    }
  } finally {
    input.dispose?.();
  }
}

/**
 * Where segments are kept: OPFS (pcm/<key>/<index>.f32) when the browser has it, else memory.
 * put(key, index, pcm), range(key, segs, start, end) -> Float32Array, drop(key).
 */
export function pcmStore({ storage = globalThis.navigator?.storage } = {}) {
  const mem = new Map();
  const dirFor = async (key, create) => {
    const root = await storage.getDirectory();
    const pcm = await root.getDirectoryHandle("pcm", { create });
    return pcm.getDirectoryHandle(key, { create });
  };
  let opfs = !!storage?.getDirectory;
  return {
    get kind() {
      return opfs ? "opfs" : "memory";
    },
    async put(key, index, pcm) {
      if (opfs) {
        try {
          const dir = await dirFor(key, true);
          const h = await dir.getFileHandle(`${index}.f32`, { create: true });
          const w = await h.createWritable();
          await w.write(pcm);
          await w.close();
          return "opfs";
        } catch {
          opfs = false; // private windows and some browsers: keep it in memory instead
        }
      }
      mem.set(`${key}/${index}`, pcm);
      return "memory";
    },
    /** The PCM between start and end seconds, read from the segments that cover it. */
    async range(key, segs, start, end) {
      const out = new Float32Array(Math.max(0, Math.round((end - start) * RATE)));
      for (const s of segs || []) {
        const a = Math.max(start, s.start);
        const b = Math.min(end, s.end);
        if (b <= a) continue;
        const from = Math.round((a - s.start) * RATE);
        const to = Math.round((b - s.start) * RATE);
        let piece = mem.get(`${key}/${s.index}`)?.subarray(from, to);
        if (!piece && opfs) {
          try {
            const f = await (await (await dirFor(key, false)).getFileHandle(`${s.index}.f32`)).getFile();
            piece = new Float32Array(await f.slice(from * 4, to * 4).arrayBuffer());
          } catch {}
        }
        if (!piece) continue;
        const at = Math.round((a - start) * RATE);
        out.set(piece.subarray(0, Math.max(0, out.length - at)), at);
      }
      return out;
    },
    async drop(key) {
      for (const k of [...mem.keys()]) if (k.startsWith(`${key}/`)) mem.delete(k);
      if (!storage?.getDirectory) return;
      try {
        await (await (await storage.getDirectory()).getDirectoryHandle("pcm")).removeEntry(key, { recursive: true });
      } catch {}
    },
  };
}

/**
 * The honest limit for this device: on a phone or tablet, videos over about 30 minutes are
 * better done on a laptop (hours of whisper on a phone CPU, and the tab is frozen whenever
 * it is in the background). Returns the note to show, or null.
 */
export function longVideoNote(duration, { mobile = isMobile(), audio = false } = {}) {
  if (!(duration > 0)) return null;
  const what = audio ? "recording" : "video";
  if (mobile && duration > 30 * 60) return `For ${what}s over about 30 minutes, use Selects on a laptop. A phone can take hours on one this long, and stops whenever the tab is in the background.`;
  if (duration > 60 * 60) return `This is a long ${what} for a browser tab. Selects works through it 10 minutes at a time and saves as it goes, but it can take a few hours; the desktop app is faster.`;
  return null;
}

export function isMobile(nav = globalThis.navigator) {
  if (!nav) return false;
  if (nav.userAgentData?.mobile != null) return nav.userAgentData.mobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent || "") || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
}
