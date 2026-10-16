// Render video with burned-in captions: a 9:16 clip of one approved candidate, or the whole
// video at its own aspect (caption mode). This ffmpeg has no libass or drawtext, so captions
// are drawn as PNGs with @napi-rs/canvas and played back as a second video stream (ffconcat)
// laid over the picture. Privacy blur is cropped, blurred and laid back the same way.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { blurBoxes, blurFilter } from "./blur.mjs";
import { chunkWords, clipCues, cuesFromWords, loadCaptions, STYLES, toSrt, toVtt } from "./captions.mjs";
import { FONT_PATH, FONT_FALLBACK_PATH, jobsDir } from "./config.mjs";
import { uprightSize } from "./probe.mjs";
import { readJson, run } from "./util.mjs";

export const PRESETS = {
  shorts: {
    width: 1080,
    height: 1920,
    crf: 20,
    x264: "veryfast",
    audioBitrate: "160k",
    lufs: -14,
    fps: 30, // 50 and 60 fps sources are halved: half the frames to decode, scale and encode
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

/** Scale a 1080-wide preset's caption sizes by f. */
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

// Caption mode: the whole video at its own aspect, never larger than 1080 on the short side.
PRESETS.full = { ...PRESETS.shorts, maxShort: 1080, maxLong: 1920, crf: 21 };

/**
 * Caption drawing options for an output of W x H in a style ("bold" or "subtitle").
 * Bold is the short-form look; subtitle is two smaller lines low in the frame.
 */
export function captionOptions(W, H, style = "bold") {
  const base = PRESETS.shorts.caption;
  const portrait = H > W;
  if (style === "subtitle") {
    const fontSize = Math.round(Math.min(W, H) * 0.05);
    return { ...base, fontSize, maxWidth: Math.round(W * 0.86), boxHeight: Math.round(fontSize * 3.3), bottomLimit: portrait ? 0.8 : 0.95, strokeWidth: Math.max(4, Math.round(fontSize * 0.16)), highlight: base.fill, maxWords: STYLES.subtitle.maxWords, maxChars: STYLES.subtitle.maxChars, style };
  }
  const f = Math.min(W / 1080, (H / 1080) * 0.75);
  return { ...scaledCaption(base, f), maxWidth: Math.round(Math.min(base.maxWidth * f, W * 0.86)), bottomLimit: portrait ? 0.82 : 0.92, style: "bold" };
}

let fontReady = false;
const FONT_FAMILY = "Selects Caption";
const FALLBACK_FAMILY = "Selects Caption Fallback";
function ensureFont() {
  if (!fontReady) {
    GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY);
    // Noto Sans covers the letters Atkinson lacks (Yoruba's dot-below vowels, for example)
    if (FONT_FALLBACK_PATH && fs.existsSync(FONT_FALLBACK_PATH)) GlobalFonts.registerFromPath(FONT_FALLBACK_PATH, FALLBACK_FAMILY);
    fontReady = true;
  }
}

/** Words inside [start, end], shifted so the clip starts at 0. */
export function clipWords(words, start, end, offset = start) {
  return words
    .filter((w) => (w.s + w.e) / 2 >= start && (w.s + w.e) / 2 <= end)
    .map((w) => ({ ...w, s: +Math.max(0, w.s - offset).toFixed(3), e: +Math.max(0, w.e - offset).toFixed(3) }));
}

/** Group words into on-screen captions of 2 to 4 words (the bold style). */
export function captionChunks(words, { maxWords = 4, maxChars = 22, pause = 0.5 } = {}) {
  return chunkWords(words, { maxWords, maxChars, pause, commaMin: 2 });
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
  const floor = Math.min(40, Math.round(c.fontSize * 0.6));
  for (let s = c.fontSize; s >= floor; s -= Math.max(2, Math.round(c.fontSize / 20))) {
    const ws = widths(s);
    let best = null;
    for (let cut = 1; cut < texts.length; cut++) {
      const w = Math.max(lineW(ws.slice(0, cut), s), lineW(ws.slice(cut), s));
      if (!best || w < best.w) best = { cut, w };
    }
    if (best && best.w <= c.maxWidth) return { size: s, lines: asLines(ws, best.cut) };
    if (!best && lineW(ws, s) <= c.maxWidth) return { size: s, lines: asLines(ws, texts.length) };
  }
  return { size: floor, lines: asLines(widths(floor), texts.length) };
}

/** Draw one caption frame. highlightIdx = -1 draws a transparent frame; null draws no highlight. */
export function drawCaption(chunkWords, highlightIdx, opts) {
  ensureFont();
  const { width, caption: c } = opts;
  const canvas = createCanvas(width, c.boxHeight);
  const ctx = canvas.getContext("2d");
  if (highlightIdx === -1 || !chunkWords?.length) return canvas.toBuffer("image/png");
  const font = (s) => `bold ${s}px "${FONT_FAMILY}", "${FALLBACK_FAMILY}"`;
  const texts = chunkWords.map((w) => (c.style === "subtitle" ? w.w : display(w.w)));
  const { size, lines } = layoutCaption(texts, c, (t, s) => {
    ctx.font = font(s);
    return ctx.measureText(t).width;
  });
  ctx.font = font(size);
  const space = ctx.measureText(" ").width;
  const lineH = size * 1.18;
  const totalH = lineH * lines.length;
  let y = c.style === "subtitle" ? c.boxHeight - totalH + lineH / 2 - size * 0.25 : (c.boxHeight - totalH) / 2 + lineH / 2;
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
 * Build the caption track from cues ({ s, e, words }[], render time). The bold style makes
 * one PNG per spoken word (its cue, that word highlighted); the subtitle style one per cue.
 * Gaps get a transparent frame. Listed in an ffconcat file with durations.
 */
export function buildCaptionTrack(cues, clipDur, dir, opts) {
  fs.mkdirSync(dir, { recursive: true });
  const perWord = opts.caption.style !== "subtitle";
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
  cues.forEach((ch, ci) => {
    if (!ch.words?.length) return;
    const nextStart = cues[ci + 1]?.s ?? clipDur;
    const holdUntil = Math.min(nextStart, ch.e + 0.4, clipDur);
    if (ch.s > t) push(blank, Math.min(ch.s, clipDur));
    if (!perWord) {
      const file = path.join(dir, `cap-${String(n++).padStart(4, "0")}.png`);
      fs.writeFileSync(file, drawCaption(ch.words, null, opts));
      push(file, Math.max(t, holdUntil));
      return;
    }
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
  return { list, chunks: cues, frames: n };
}

/** Kept for older callers: SRT from caption chunks. */
export const chunksToSrt = (chunks) => toSrt(chunks);

/** Decode flags: Apple's hardware decoder when it can help (HEVC and H.264 on macOS). */
export function hwaccelArgs(src) {
  if (process.env.SELECTS_HWACCEL === "0") return [];
  if (process.platform !== "darwin") return [];
  if (!["hevc", "h264", "prores"].includes(src.vcodec)) return [];
  return ["-hwaccel", "videotoolbox"];
}

/**
 * The faster path: keep decoded frames on the GPU, drop to 30 fps and scale there
 * (scale_vt), then download the small frame and turn it upright. Measured on 20 s of 4K
 * HEVC at 60 fps: 22.7 s, against 34.2 s with hardware decode and CPU scaling, and 80.4 s
 * all on the CPU. 8-bit 4:2:0 sources only (10-bit HDR would need tone mapping).
 */
export function gpuScaleOk(src) {
  return hwaccelArgs(src).length > 0 && process.env.SELECTS_GPU_SCALE !== "0" && ["yuv420p", "yuvj420p", "nv12"].includes(src.pixFmt);
}
// -display_rotation 0 (not -noautorotate): with -noautorotate ffmpeg copies the source's
// rotation into the output, so a frame we already turned upright would be turned again by
// every player. Found on the first real run: the clips came out sideways.
const GPU_INPUT = ["-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld", "-display_rotation:v", "0"];

/** Filters that turn a frame stored with a rotation upright (what autorotate would add). */
export function uprightFilter(rotation) {
  const r = ((Math.round(rotation || 0) % 360) + 360) % 360;
  if (r === 270) return "transpose=clock";
  if (r === 90) return "transpose=cclock";
  if (r === 180) return "hflip,vflip";
  return "";
}

/** Fit an upright w x h inside maxShort x maxLong (by orientation), never upscaling; even sizes. */
export function workingSize(w, h, { maxShort = 1080, maxLong = 1920 } = {}) {
  const portrait = h > w;
  const [bw, bh] = portrait ? [maxShort, maxLong] : [maxLong, maxShort];
  const f = Math.min(1, bw / w, bh / h);
  const ev = (n) => Math.max(2, Math.round((n * f) / 2) * 2);
  return { w: ev(w), h: ev(h) };
}

/**
 * The video half of the filter graph, from [0:v] to [v]: early frame-rate cut and
 * downscale, privacy blur, then reframing into W x H.
 * reframe: "crop" (centre crop), "fit" (whole frame over a blur of itself), "scale" (the
 * source is already about 9:16: just scale, padding any sliver), or "none" (keep aspect).
 */
export function videoGraph({ src, W, H, reframe, blur = [], fps = 30, vmap = "0:v:0", duration = Infinity, gpu = false }) {
  const { w: uw, h: uh } = uprightSize(src);
  const work = reframe === "none" ? { w: W, h: H } : workingSize(uw, uh);
  const rate = src.fps && src.fps > fps + 0.5 ? `fps=${fps},` : "";
  let pre;
  if (gpu) {
    // frames arrive as stored (no autorotate): scale on the GPU in stored orientation, then turn upright
    const turned = Math.abs(((src.rotation || 0) % 180)) === 90;
    const [cw, ch] = turned ? [work.h, work.w] : [work.w, work.h];
    const up = uprightFilter(src.rotation);
    // planar 4:2:0 after the download: crop, boxblur and overlay on semi-planar nv12 left
    // the chroma of blurred boxes empty (solid green), seen on the first blurred caption render
    pre = `[${vmap}]${rate}scale_vt=w=${cw}:h=${ch},hwdownload,format=nv12${up ? `,${up}` : ""},format=yuv420p,setsar=1[pre]`;
  } else {
    // autorotate has already turned the frames upright; scale also squares non-square pixels
    pre = `[${vmap}]${rate}scale=${work.w}:${work.h},setsar=1[pre]`;
  }
  const bf = blurFilter(blur, { W: work.w, H: work.h, inLabel: "pre", outLabel: "bl", duration });
  const inL = bf ? "bl" : "pre";
  let v;
  if (reframe === "none") v = `[${inL}]null[v]`;
  else if (reframe === "crop") v = `[${inL}]crop=trunc(ih*9/16/2)*2:ih:(iw-ow)/2:0,scale=${W}:${H},setsar=1[v]`;
  else if (reframe === "scale") v = `[${inL}]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v]`;
  else
    v =
      `[${inL}]split[a][b];` +
      `[a]scale=${W / 4}:${H / 4}:force_original_aspect_ratio=increase,crop=${W / 4}:${H / 4},boxblur=12:2,eq=brightness=-0.12,scale=${W}:${H}[bg];` +
      `[b]scale=${W}:-2[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2-${Math.round(H * 0.04)},setsar=1[v]`;
  return [pre, bf, v].filter(Boolean).join(";");
}

/**
 * Decide how to make 9:16 from the source: "scale" when it is already portrait and close to
 * 9:16, "crop" (centre crop) when the motion in the clip sits in the centre band a 9:16 crop
 * would keep, otherwise "fit" (the whole frame over a blurred copy of itself).
 */
export async function chooseReframe(source, start, dur, { samples = 16 } = {}) {
  if (!source.hasVideo && source.hasVideo !== undefined) return { mode: "fit", centreShare: 0 };
  const { w: dispW, h: dispH } = uprightSize(source);
  if (dispW && dispH && dispW / dispH <= 0.6) return { mode: "scale", centreShare: null, why: "source is already portrait" };
  if (!dispW || !dispH || dispW / dispH < 1.2) return { mode: "fit", centreShare: null, why: "source is not landscape" };
  const W = 64;
  const H = Math.max(8, Math.round((W * dispH) / dispW / 2) * 2);
  const fps = Math.max(0.2, samples / Math.max(1, dur));
  const map = source.videoStream != null ? `0:${source.videoStream}` : "0:v:0";
  const raw = await rawFrames(source, map, start, dur, fps, W, H);
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
  const band = (dispH * 9) / 16 / dispW; // fraction of width a centre crop keeps
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
function rawFrames(src, map, start, dur, fps, W, H) {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-v", "error", ...hwaccelArgs(src), "-ss", String(start), "-t", String(dur), "-i", src.path, "-map", map, "-vf", `fps=${fps.toFixed(3)},scale=${W}:${H},format=gray`, "-f", "rawvideo", "pipe:1"]);
    const bufs = [];
    p.stdout.on("data", (d) => bufs.push(d));
    p.on("close", () => resolve(Buffer.concat(bufs)));
    p.on("error", () => resolve(Buffer.alloc(0)));
  });
}

/** Face tracks for blur, if the job has run detection. */
function loadTracks(dir) {
  return readJson(path.join(dir, "faces.json"), null)?.tracks || [];
}

/**
 * Run one ffmpeg encode with captions laid over a video graph. Retries once without the
 * hardware decoder if it fails (some files and drivers refuse it).
 */
async function encode({ src, start, dur, graph: graphFor, capList, capY, P, out, onProgress, signal }) {
  const vmapAudio = src.audioStreams?.length ? ["-map", `0:${src.audioStreams[0].index}`] : ["-map", "0:a:0"];
  const attempt = (hw, gpu = false) => {
    const graph = graphFor(gpu);
    const filter = capList ? `${graph};[1:v]format=rgba[cap];[v][cap]overlay=0:${capY}:eof_action=pass:format=auto,format=yuv420p[out]` : `${graph};[v]format=yuv420p[out]`;
    const args = [
      "-v", "error", "-y", "-nostats", "-progress", "pipe:1",
      ...hw,
      ...(start > 0 ? ["-ss", String(start)] : []), "-t", String(dur), "-i", src.path,
      ...(capList ? ["-f", "concat", "-safe", "0", "-i", capList] : []),
      "-filter_complex", filter,
      "-map", "[out]", ...vmapAudio,
      "-af", `loudnorm=I=${P.lufs}:TP=-1.5:LRA=11,aresample=48000`,
      "-c:v", "libx264", "-preset", P.x264, "-crf", String(P.crf), "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", P.audioBitrate,
      "-movflags", "+faststart", "-t", String(dur),
      out,
    ];
    let buf = "";
    return run("ffmpeg", args, {
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
  };
  const hw = hwaccelArgs(src);
  if (gpuScaleOk(src)) {
    try {
      await attempt(GPU_INPUT, true);
      return "gpu";
    } catch (e) {
      if (e.name === "AbortError") throw e;
    }
  }
  try {
    await attempt(hw);
    return hw.length ? "hw" : "sw";
  } catch (e) {
    if (!hw.length || e.name === "AbortError") throw e;
    await attempt([]);
    return "sw";
  }
}

/**
 * Render a candidate.
 * @param {object} job the Job (needs id and source)
 * @param {object} candidate
 * @param {{preset?:string, onProgress?:Function, jobDir?:string, words?:object[], reframe?:"auto"|"crop"|"fit"|"scale", signal?:AbortSignal, captions?:boolean, cues?:object[], blur?:object, tracks?:object[]}} opts
 * @returns {Promise<{path:string, srt:string, absPath:string, absSrt:string, reframe:object, wallSec:number}>}
 *   path and srt are relative to the job folder, as stored in candidate.render.
 */
export async function render(job, candidate, { preset = "shorts", onProgress, jobDir, words, reframe = "auto", signal, captions, cues, blur, tracks } = {}) {
  const P = PRESETS[preset];
  if (!P) throw new Error(`Unknown preset "${preset}". Known: ${Object.keys(PRESETS).join(", ")}`);
  const dir = jobDir || path.join(jobsDir(), job.id);
  const src = job.source;
  const t0 = Date.now();
  const start = Math.max(0, candidate.start - P.padStart);
  const end = Math.min(src.duration || candidate.end + P.padEnd, candidate.end + P.padEnd);
  const dur = +(end - start).toFixed(3);
  const withCaptions = captions ?? job.settings?.captions ?? true;

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
    // cues: the reviewed captions.json when there is one, else built from the words
    let all = cues;
    if (!all) {
      const capFile = path.join(dir, "captions.json");
      if (fs.existsSync(capFile)) all = loadCaptions(dir).cues;
    }
    const clipped = all ? clipCues(all, candidate.start, candidate.end, start) : cuesFromWords(clipWords(words || readJson(path.join(dir, "words.json")), candidate.start, candidate.end, start), "bold");
    fs.writeFileSync(path.join(dir, srtRel), toSrt(clipped));
    const capOpts = { width: P.width, caption: { ...P.caption, style: "bold" } };
    const track = withCaptions ? buildCaptionTrack(clipped, dur, tmp, capOpts) : null;

    const rf = reframe === "auto" ? await chooseReframe(src, start, dur) : { mode: reframe };
    const spec = blur ?? candidate.blur ?? job.settings?.blur ?? null;
    const boxes = blurBoxes(spec, { tracks: tracks || loadTracks(dir), offset: start, duration: dur });
    const graph = (gpu) => videoGraph({ src, W: P.width, H: P.height, reframe: rf.mode, blur: boxes, fps: P.fps, vmap: src.videoStream != null ? `0:${src.videoStream}` : "0:v:0", duration: dur, gpu });
    const capY = Math.round(P.height * P.caption.bottomLimit - P.caption.boxHeight);
    const decode = await encode({ src, start, dur, graph, capList: track?.list, capY, P, out: partAbs, onProgress, signal });
    fs.renameSync(partAbs, outAbs);
    onProgress?.({ progress: 1 });
    return { path: outRel, srt: srtRel, absPath: outAbs, absSrt: path.join(dir, srtRel), reframe: rf, captions: track ? clipped.length : 0, blurBoxes: boxes.length, decode, wallSec: +((Date.now() - t0) / 1000).toFixed(1) };
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

/**
 * Caption mode: the whole video, its own aspect ratio, captions burned in, plus SRT and VTT.
 * Writes output/captioned.mp4, output/captions.srt, output/captions.vtt in the job folder.
 */
export async function renderFull(job, { onProgress, jobDir, signal, style, blur, tracks, captions = true } = {}) {
  const P = PRESETS.full;
  const dir = jobDir || path.join(jobsDir(), job.id);
  const src = job.source;
  const t0 = Date.now();
  const { w: uw, h: uh } = uprightSize(src);
  const { w: W, h: H } = workingSize(uw, uh, P);
  const dur = src.duration;
  const st = style && style !== "auto" ? style : H > W ? "bold" : "subtitle";
  const outDir = path.join(dir, "output");
  const tmp = path.join(dir, "tmp", "full");
  fs.mkdirSync(outDir, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  const outRel = "output/captioned.mp4";
  const partAbs = path.join(outDir, "captioned.part.mp4");
  try {
    const caps = loadCaptions(dir, { style: st });
    // a style other than the one the cues were grouped for: regroup unless a person edited them
    const cues = !caps.edited && caps.style !== st ? cuesFromWords(caps.cues.flatMap((c) => c.words), st) : caps.cues;
    fs.writeFileSync(path.join(outDir, "captions.srt"), toSrt(cues));
    fs.writeFileSync(path.join(outDir, "captions.vtt"), toVtt(cues));
    const capOpts = { width: W, caption: captionOptions(W, H, st) };
    const track = captions ? buildCaptionTrack(cues, dur, tmp, capOpts) : null;
    const spec = blur ?? job.settings?.blur ?? null;
    const boxes = blurBoxes(spec, { tracks: tracks || loadTracks(dir), offset: 0, duration: dur });
    const graph = (gpu) => videoGraph({ src, W, H, reframe: "none", blur: boxes, fps: P.fps, vmap: src.videoStream != null ? `0:${src.videoStream}` : "0:v:0", duration: dur, gpu });
    const capY = Math.round(H * capOpts.caption.bottomLimit - capOpts.caption.boxHeight);
    const decode = await encode({ src, start: 0, dur, graph, capList: track?.list, capY, P, out: partAbs, onProgress, signal });
    fs.renameSync(partAbs, path.join(dir, outRel));
    onProgress?.({ progress: 1 });
    return { path: outRel, srt: "output/captions.srt", vtt: "output/captions.vtt", width: W, height: H, style: st, cues: cues.length, blurBoxes: boxes.length, decode, wallSec: +((Date.now() - t0) / 1000).toFixed(1) };
  } catch (e) {
    fs.rmSync(partAbs, { force: true });
    if (!e.hint) e.hint = "Check free disk space, then render again. Your caption edits are saved.";
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      fs.rmdirSync(path.join(dir, "tmp"));
    } catch {}
  }
}
