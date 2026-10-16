// Render one approved candidate as a 9:16 clip with burned-in captions.
// This ffmpeg has no libass or drawtext, so captions are drawn as PNGs with @napi-rs/canvas
// and played back as a second video stream (ffconcat) laid over the picture.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { FONT_PATH, jobsDir } from "./config.mjs";
import { readJson, run, srtTime } from "./util.mjs";

export const PRESETS = {
  shorts: {
    width: 1080,
    height: 1920,
    crf: 20,
    x264: "veryfast",
    audioBitrate: "160k",
    lufs: -14,
    padStart: 0.08, // seconds of air before the first word
    padEnd: 0.35, // and after the last, so the last word is not clipped
    caption: {
      fontSize: 84,
      maxWidth: 920, // keeps 80 px side margins
      boxHeight: 400, // caption image height
      // bottom edge of the caption image: clear of the bottom 18% kept for platform UI
      bottomLimit: 0.82,
      fill: "#FFFFFF",
      highlight: "#F2BE22",
      stroke: "rgba(0,0,0,0.92)",
      strokeWidth: 13,
      maxWords: 4,
      maxChars: 22,
    },
  },
};

/** Scale a 1080-wide preset's caption sizes to another width. */
function scaledCaption(c, f) {
  return { ...c, fontSize: Math.round(c.fontSize * f), maxWidth: Math.round(c.maxWidth * f), boxHeight: Math.round(c.boxHeight * f), strokeWidth: Math.max(4, Math.round(c.strokeWidth * f)) };
}

// A fast draft for checking a cut before the slow final render: 720x1280, x264 ultrafast.
PRESETS.preview = {
  ...PRESETS.shorts,
  width: 720,
  height: 1280,
  crf: 26,
  x264: "ultrafast",
  audioBitrate: "128k",
  caption: scaledCaption(PRESETS.shorts.caption, 720 / 1080),
};

let fontReady = false;
const FONT_FAMILY = "Selects Caption";
function ensureFont() {
  if (!fontReady) {
    GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY);
    fontReady = true;
  }
}

/** Words inside [start, end], shifted so the clip starts at 0. */
export function clipWords(words, start, end, offset = start) {
  return words
    .filter((w) => (w.s + w.e) / 2 >= start && (w.s + w.e) / 2 <= end)
    .map((w) => ({ ...w, s: +Math.max(0, w.s - offset).toFixed(3), e: +Math.max(0, w.e - offset).toFixed(3) }));
}

/**
 * Group words into on-screen captions of 2 to 4 words. Breaks after sentence ends, after
 * commas once two words are up, at pauses, and before the line gets too long.
 */
export function captionChunks(words, { maxWords = 4, maxChars = 22, pause = 0.5 } = {}) {
  const chunks = [];
  let cur = [];
  const chars = (arr) => arr.reduce((a, w) => a + w.w.length + 1, -1);
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const brk =
      cur.length &&
      (cur.length >= maxWords ||
        chars([...cur, w]) > maxChars ||
        /[.!?]["')\]]*$/.test(prev.w) ||
        (cur.length >= 2 && /[,;:]$/.test(prev.w)) ||
        w.s - prev.e > pause);
    if (brk) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  // fold a lone trailing word into the previous caption when it fits
  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i];
    const p = chunks[i - 1];
    if (c.length === 1 && p.length < maxWords && chars([...p, ...c]) <= maxChars + 4 && c[0].s - p[p.length - 1].e < pause && !/[.!?]$/.test(p[p.length - 1].w)) {
      p.push(c[0]);
      chunks.splice(i, 1);
      i--;
    }
  }
  return chunks.map((ws) => ({ words: ws, s: ws[0].s, e: ws[ws.length - 1].e, text: ws.map((x) => x.w).join(" ") }));
}

/** Caption display text: drop trailing commas and full stops (keep ? and !). */
const display = (w) => w.replace(/[,.;:]+$/, "");

/**
 * Lay a caption out: one line if it fits (shrinking the font by up to 15%), otherwise two
 * lines split where they are closest to equal width, so no single word is left hanging.
 * measure(text, size) returns a width in pixels. Returns { size, lines: [[{i, t, tw}]] }.
 */
export function layoutCaption(texts, c, measure) {
  const widths = (s) => texts.map((t) => measure(t, s));
  const lineW = (ws, s) => ws.reduce((a, b) => a + b, 0) + measure(" ", s) * Math.max(0, ws.length - 1);
  const asLines = (ws, cut) => [texts.slice(0, cut), texts.slice(cut)].filter((l) => l.length).map((l, li) => l.map((t, k) => ({ i: li === 0 ? k : cut + k, t, tw: ws[li === 0 ? k : cut + k] })));
  for (let s = c.fontSize; s >= Math.round(c.fontSize * 0.85); s -= 2) {
    const ws = widths(s);
    if (lineW(ws, s) <= c.maxWidth) return { size: s, lines: asLines(ws, texts.length) };
  }
  for (let s = c.fontSize; s >= 40; s -= 4) {
    const ws = widths(s);
    let best = null;
    for (let cut = 1; cut < texts.length; cut++) {
      const w = Math.max(lineW(ws.slice(0, cut), s), lineW(ws.slice(cut), s));
      if (!best || w < best.w) best = { cut, w };
    }
    if (best && best.w <= c.maxWidth) return { size: s, lines: asLines(ws, best.cut) };
    if (!best && lineW(ws, s) <= c.maxWidth) return { size: s, lines: asLines(ws, texts.length) };
  }
  const s = 40;
  return { size: s, lines: asLines(widths(s), texts.length) };
}

/** Draw one caption frame. highlightIdx = -1 draws a transparent frame. */
export function drawCaption(chunkWords, highlightIdx, opts) {
  ensureFont();
  const { width, caption: c } = opts;
  const canvas = createCanvas(width, c.boxHeight);
  const ctx = canvas.getContext("2d");
  if (highlightIdx < 0 || !chunkWords?.length) return canvas.toBuffer("image/png");
  const font = (s) => `bold ${s}px "${FONT_FAMILY}"`;
  const texts = chunkWords.map((w) => display(w.w));
  const { size, lines } = layoutCaption(texts, c, (t, s) => {
    ctx.font = font(s);
    return ctx.measureText(t).width;
  });
  ctx.font = font(size);
  const space = ctx.measureText(" ").width;
  const lineH = size * 1.18;
  const totalH = lineH * lines.length;
  let y = (c.boxHeight - totalH) / 2 + lineH / 2;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  for (const line of lines) {
    const lw = line.reduce((a, x) => a + x.tw, 0) + space * (line.length - 1);
    let x = (width - lw) / 2;
    for (const part of line) {
      ctx.lineWidth = c.strokeWidth;
      ctx.strokeStyle = c.stroke;
      ctx.strokeText(part.t, x, y);
      ctx.fillStyle = part.i === highlightIdx ? c.highlight : c.fill;
      ctx.fillText(part.t, x, y);
      x += part.tw + space;
    }
    y += lineH;
  }
  return canvas.toBuffer("image/png");
}

/**
 * Build the caption track: one PNG per spoken word (its caption, that word highlighted),
 * plus a transparent frame for gaps, listed in an ffconcat file with durations.
 */
export function buildCaptionTrack(words, clipDur, dir, opts) {
  fs.mkdirSync(dir, { recursive: true });
  const chunks = captionChunks(words, opts.caption);
  const blank = path.join(dir, "blank.png");
  fs.writeFileSync(blank, drawCaption([], -1, opts));
  const entries = []; // { file, dur }
  let t = 0;
  let n = 0;
  const push = (file, until) => {
    const d = +(until - t).toFixed(3);
    if (d <= 0.001) return;
    entries.push({ file, dur: d });
    t = until;
  };
  chunks.forEach((ch, ci) => {
    const nextStart = chunks[ci + 1]?.s ?? clipDur;
    const holdUntil = Math.min(nextStart, ch.e + 0.4, clipDur);
    if (ch.s > t) push(blank, Math.min(ch.s, clipDur));
    ch.words.forEach((w, wi) => {
      const file = path.join(dir, `cap-${String(n++).padStart(4, "0")}.png`);
      fs.writeFileSync(file, drawCaption(ch.words, wi, opts));
      const until = wi < ch.words.length - 1 ? Math.max(t, ch.words[wi + 1].s) : Math.max(t, holdUntil);
      push(file, Math.min(until, clipDur));
    });
  });
  if (t < clipDur) push(blank, clipDur);
  const last = entries[entries.length - 1]?.file ?? blank;
  const lines = ["ffconcat version 1.0"];
  for (const e of entries) lines.push(`file '${e.file.replace(/'/g, "'\\''")}'`, `duration ${e.dur}`);
  lines.push(`file '${last.replace(/'/g, "'\\''")}'`); // the concat demuxer drops the last duration without this
  const list = path.join(dir, "captions.ffconcat");
  fs.writeFileSync(list, lines.join("\n") + "\n");
  return { list, chunks, frames: n };
}

export function chunksToSrt(chunks) {
  return chunks
    .map((c, i) => `${i + 1}\n${srtTime(c.s)} --> ${srtTime(c.e + 0.2 < (chunks[i + 1]?.s ?? Infinity) ? c.e + 0.2 : chunks[i + 1].s)}\n${c.words.map((w) => w.w).join(" ")}\n`)
    .join("\n");
}

/**
 * Decide how to make 9:16 from the source: "crop" (centre crop) when the motion in the
 * clip sits in the centre band a 9:16 crop would keep, otherwise "fit" (the whole frame
 * over a blurred copy of itself), which keeps slides and off-centre speakers in shot.
 */
export async function chooseReframe(source, start, dur, { samples = 16 } = {}) {
  if (!source.hasVideo && source.hasVideo !== undefined) return { mode: "fit", centreShare: 0 };
  const dispW = source.displayWidth || source.width;
  if (!dispW || !source.height || dispW / source.height < 1.2) return { mode: "fit", centreShare: null, why: "source is not landscape" };
  const W = 64;
  const H = Math.max(8, Math.round((W * source.height) / dispW / 2) * 2);
  const fps = Math.max(0.2, samples / Math.max(1, dur));
  const map = source.videoStream != null ? `0:${source.videoStream}` : "0:v:0";
  const raw = await rawFrames(source.path, map, start, dur, fps, W, H);
  const frameSize = W * H;
  const n = Math.floor(raw.length / frameSize);
  if (n < 3) return { mode: "fit", centreShare: null, why: "too few frames" };
  const col = new Float64Array(W);
  for (let f = 1; f < n; f++) {
    const a = (f - 1) * frameSize;
    const b = f * frameSize;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) col[x] += Math.abs(raw[b + y * W + x] - raw[a + y * W + x]);
  }
  const total = col.reduce((p, v) => p + v, 0);
  const band = (source.height * 9) / 16 / dispW; // fraction of width a centre crop keeps
  const x0 = Math.floor(((1 - band) / 2) * W);
  const x1 = Math.ceil(((1 + band) / 2) * W);
  let centre = 0;
  for (let x = x0; x < x1; x++) centre += col[x];
  const meanMotion = total / ((n - 1) * frameSize);
  const centreShare = total > 0 ? centre / total : 0;
  // crop only when there is real motion (a person moving) and most of it is in the band
  const mode = meanMotion > 1.5 && centreShare >= 0.6 ? "crop" : "fit";
  return { mode, centreShare: +centreShare.toFixed(2), meanMotion: +meanMotion.toFixed(2) };
}

/** Decode a few tiny grayscale frames as raw bytes (binary stdout, so not via run()). */
function rawFrames(file, map, start, dur, fps, W, H) {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-v", "error", "-ss", String(start), "-t", String(dur), "-i", file, "-map", map, "-vf", `fps=${fps.toFixed(3)},scale=${W}:${H},format=gray`, "-f", "rawvideo", "pipe:1"]);
    const bufs = [];
    p.stdout.on("data", (d) => bufs.push(d));
    p.on("close", () => resolve(Buffer.concat(bufs)));
    p.on("error", () => resolve(Buffer.alloc(0)));
  });
}

/**
 * Render a candidate.
 * @param {object} job the Job (needs id and source)
 * @param {object} candidate
 * @param {{preset?:string, onProgress?:Function, jobDir?:string, words?:object[], reframe?:"auto"|"crop"|"fit", signal?:AbortSignal}} opts
 * @returns {Promise<{path:string, srt:string, absPath:string, absSrt:string, reframe:object, wallSec:number}>}
 *   path and srt are relative to the job folder, as stored in candidate.render.
 */
export async function render(job, candidate, { preset = "shorts", onProgress, jobDir, words, reframe = "auto", signal } = {}) {
  const P = PRESETS[preset];
  if (!P) throw new Error(`Unknown preset "${preset}". Known: ${Object.keys(PRESETS).join(", ")}`);
  const dir = jobDir || path.join(jobsDir(), job.id);
  const allWords = words || readJson(path.join(dir, "words.json"));
  const src = job.source;
  const t0 = Date.now();
  const start = Math.max(0, candidate.start - P.padStart);
  const end = Math.min(src.duration || candidate.end + P.padEnd, candidate.end + P.padEnd);
  const dur = +(end - start).toFixed(3);

  const clipsDir = path.join(dir, "clips");
  const tmp = path.join(dir, "tmp", candidate.id);
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  const suffix = preset === "shorts" ? "" : `.${preset}`;
  const outRel = `clips/${candidate.id}${suffix}.mp4`;
  const srtRel = `clips/${candidate.id}.srt`; // the same for every preset
  const outAbs = path.join(dir, outRel);
  const partAbs = path.join(clipsDir, `${candidate.id}${suffix}.part.mp4`);

  try {
    const cw = clipWords(allWords, candidate.start, candidate.end, start);
    const track = buildCaptionTrack(cw, dur, tmp, P);
    fs.writeFileSync(path.join(dir, srtRel), chunksToSrt(track.chunks));

    const rf = reframe === "auto" ? await chooseReframe(src, start, dur) : { mode: reframe };
    const W = P.width;
    const H = P.height;
    const vmap = src.videoStream != null ? `0:${src.videoStream}` : "0:v:0";
    const square = `[${vmap}]scale=trunc(iw*sar/2)*2:ih,setsar=1`;
    let v;
    if (rf.mode === "crop") {
      v = `${square},crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:0,scale=${W}:${H},setsar=1[v]`;
    } else {
      // whole frame on a darkened blur of itself; nudged up so captions sit below the picture
      v =
        `${square},split[a][b];` +
        `[a]scale=${W / 4}:${H / 4}:force_original_aspect_ratio=increase,crop=${W / 4}:${H / 4},boxblur=12:2,eq=brightness=-0.12,scale=${W}:${H}[bg];` +
        `[b]scale=${W}:-2[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2-${Math.round(H * 0.04)},setsar=1[v]`;
    }
    const capY = Math.round(H * P.caption.bottomLimit - P.caption.boxHeight);
    const filter = `${v};[1:v]format=rgba[cap];[v][cap]overlay=0:${capY}:eof_action=pass:format=auto,format=yuv420p[out]`;
    const args = [
      "-v", "error", "-y", "-nostats", "-progress", "pipe:1",
      "-ss", String(start), "-t", String(dur), "-i", src.path,
      "-f", "concat", "-safe", "0", "-i", track.list,
      "-filter_complex", filter,
      "-map", "[out]", "-map", "0:a:0",
      "-af", `loudnorm=I=${P.lufs}:TP=-1.5:LRA=11,aresample=48000`,
      "-c:v", "libx264", "-preset", P.x264, "-crf", String(P.crf), "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", P.audioBitrate,
      "-movflags", "+faststart", "-t", String(dur),
      partAbs,
    ];
    let buf = "";
    await run("ffmpeg", args, {
      signal,
      keepOutput: false,
      onStdout: (chunk) => {
        buf += chunk;
        const m = buf.match(/out_time_(?:us|ms)=(\d+)/g);
        if (m) {
          const us = +m[m.length - 1].split("=")[1];
          onProgress?.({ progress: Math.min(0.99, us / 1e6 / dur) });
          buf = buf.slice(-200);
        }
      },
    });
    fs.renameSync(partAbs, outAbs);
    onProgress?.({ progress: 1 });
    return { path: outRel, srt: srtRel, absPath: outAbs, absSrt: path.join(dir, srtRel), reframe: rf, captions: track.chunks.length, wallSec: +((Date.now() - t0) / 1000).toFixed(1) };
  } catch (e) {
    fs.rmSync(partAbs, { force: true });
    if (!e.hint) e.hint = "Check free disk space, then render again. Approved clips stay approved.";
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      fs.rmdirSync(path.join(dir, "tmp"));
    } catch {}
  }
}
