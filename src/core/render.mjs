// Render video with burned-in captions: a 9:16 clip of one approved candidate, or the whole
// video at its own aspect (caption mode). This ffmpeg has no libass or drawtext, so captions
// are drawn as PNGs with @napi-rs/canvas and played back as a second video stream (ffconcat)
// laid over the picture. Privacy blur is cropped, blurred and laid back the same way.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { blurBoxes, blurFilter } from "./blur.mjs";
import { clipCues, cuesFromWords, loadCaptions, toSrt, toVtt } from "./captions.mjs";
import { config, FONT_PATH, FONT_FALLBACK_PATH, jobsDir } from "./config.mjs";
import { speechOnly } from "./nonspeech.mjs";
import { captionOptions, captionTimeline, clipWords, motionSize, paintCaption, PRESETS, reframeByShape, reframeFromMotion, workingSize } from "./layout.mjs";
import { uprightSize } from "./probe.mjs";
import { clipCaptionStyle } from "./madefor.mjs";
import { readJson, run } from "./util.mjs";
import { isDiskFull } from "./estimate.mjs";

// presets, caption layout and the reframe decision have no Node imports (layout.mjs), so the
// browser build draws the same captions; they are re-exported here for older callers
export { PRESETS, captionOptions, clipWords, captionChunks, layoutCaption, paintCaption, captionTop, captionTimeline, workingSize, reframeByShape, reframeFromMotion, motionSize } from "./layout.mjs";

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

/** Draw one caption frame. highlightIdx = -1 draws a transparent frame; null draws no highlight. */
export function drawCaption(chunkWords, highlightIdx, opts) {
  ensureFont();
  const { width, caption: c } = opts;
  const canvas = createCanvas(width, c.boxHeight);
  const ctx = canvas.getContext("2d");
  if (highlightIdx === -1 || !chunkWords?.length) return canvas.toBuffer("image/png");
  paintCaption(ctx, chunkWords, highlightIdx, { width, caption: c, families: [FONT_FAMILY, FALLBACK_FAMILY] });
  return canvas.toBuffer("image/png");
}

/**
 * Build the caption track from cues ({ s, e, words }[], render time). The bold style makes
 * one PNG per spoken word (its cue, that word highlighted); the subtitle style one per cue.
 * Gaps get a transparent frame. Listed in an ffconcat file with durations.
 */
export function buildCaptionTrack(cues, clipDur, dir, opts) {
  fs.mkdirSync(dir, { recursive: true });
  const blank = path.join(dir, "blank.png");
  fs.writeFileSync(blank, drawCaption([], -1, opts));
  // the timing lives in layout.mjs, so the browser build shows each word for the same span
  const entries = captionTimeline(cues, clipDur, { perWord: opts.caption.style !== "subtitle" }).map((e, n) => {
    if (e.cue < 0) return { file: blank, dur: e.dur };
    const file = path.join(dir, `cap-${String(n).padStart(4, "0")}.png`);
    fs.writeFileSync(file, drawCaption(cues[e.cue].words, e.word, opts));
    return { file, dur: e.dur };
  });
  const n = entries.filter((e) => e.file !== blank).length;
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
  if (!config().hwaccel) return [];
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
  return hwaccelArgs(src).length > 0 && config().gpuScale && ["yuv420p", "yuvj420p", "nv12"].includes(src.pixFmt);
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
  const byShape = reframeByShape(dispW, dispH);
  if (byShape) return byShape;
  const { W, H } = motionSize(dispW, dispH);
  const fps = Math.max(0.2, samples / Math.max(1, dur));
  const map = source.videoStream != null ? `0:${source.videoStream}` : "0:v:0";
  const raw = await rawFrames(source, map, start, dur, fps, W, H);
  return reframeFromMotion(raw, W, H, dispW, dispH);
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
      // another decoder will not help when the disk is full
      if (e.name === "AbortError" || isDiskFull(e)) throw e;
    }
  }
  try {
    await attempt(hw);
    return hw.length ? "hw" : "sw";
  } catch (e) {
    if (!hw.length || e.name === "AbortError" || isDiskFull(e)) throw e;
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
export async function render(job, candidate, { preset = "shorts", onProgress, jobDir, words, reframe = "auto", signal, captions, cues, blur, tracks, style } = {}) {
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
    // the caption look: bold (2 to 4 words, the current one in yellow) or subtitle (two lines),
    // from the job's caption style or its "made for" preset (LinkedIn defaults to subtitle)
    const st = style && style !== "auto" ? style : clipCaptionStyle(job.settings);
    // cues: the reviewed captions.json when there is one, else built from the words
    let all = cues;
    let edited = !!cues;
    if (!all) {
      const capFile = path.join(dir, "captions.json");
      if (fs.existsSync(capFile)) {
        const caps = loadCaptions(dir);
        all = caps.cues;
        edited = !!caps.edited;
      }
    }
    let clipped = all ? clipCues(all, candidate.start, candidate.end, start) : cuesFromWords(clipWords(words || speechOnly(readJson(path.join(dir, "words.json"))), candidate.start, candidate.end, start), st);
    // cues grouped for the other look are regrouped, unless a person edited them
    if (all && !edited && st === "subtitle") clipped = cuesFromWords(clipped.flatMap((c) => c.words), st);
    fs.writeFileSync(path.join(dir, srtRel), toSrt(clipped));
    const capOpts = { width: P.width, caption: st === "subtitle" ? captionOptions(P.width, P.height, "subtitle") : { ...P.caption, style: "bold" } };
    const track = withCaptions ? buildCaptionTrack(clipped, dur, tmp, capOpts) : null;

    const rf = reframe === "auto" ? await chooseReframe(src, start, dur) : { mode: reframe };
    const spec = blur ?? candidate.blur ?? job.settings?.blur ?? null;
    const boxes = blurBoxes(spec, { tracks: tracks || loadTracks(dir), offset: start, duration: dur });
    const graph = (gpu) => videoGraph({ src, W: P.width, H: P.height, reframe: rf.mode, blur: boxes, fps: P.fps, vmap: src.videoStream != null ? `0:${src.videoStream}` : "0:v:0", duration: dur, gpu });
    const capY = Math.round(P.height * capOpts.caption.bottomLimit - capOpts.caption.boxHeight);
    const decode = await encode({ src, start, dur, graph, capList: track?.list, capY, P, out: partAbs, onProgress, signal });
    fs.renameSync(partAbs, outAbs);
    onProgress?.({ progress: 1 });
    return { path: outRel, srt: srtRel, absPath: outAbs, absSrt: path.join(dir, srtRel), reframe: rf, captions: track ? clipped.length : 0, captionStyle: st, blurBoxes: boxes.length, decode, wallSec: +((Date.now() - t0) / 1000).toFixed(1) };
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
