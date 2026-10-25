// The desktop audiogram render: an audio-only source becomes a 9:16 video. The still
// background is drawn once as a PNG; the moving band (the meter and the character's mouth,
// from the clip's real loudness) is drawn per frame with @napi-rs/canvas and piped to ffmpeg
// as raw RGBA; the captions are the same PNG track as any clip. All drawing is in
// audiogram.mjs, which the browser render shares.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { AUDIOGRAM_FPS, AUDIOGRAM_LAYOUT, audiogramSettings, dbMeter, envelopeFromDb, paintCover, paintMoving, paintPreset } from "./audiogram.mjs";

/**
 * The clip's loudness per video frame, read from the source by ffmpeg as 16 kHz mono floats
 * and measured as it streams (a whole recording never sits in memory).
 */
export function audioDbPerFrame(src, start, dur, { fps = AUDIOGRAM_FPS, signal } = {}) {
  return new Promise((resolve, reject) => {
    const map = src.audioStreams?.length ? `0:${src.audioStreams[0].index}` : "0:a:0";
    const p = spawn("ffmpeg", ["-v", "error", ...(start > 0 ? ["-ss", String(start)] : []), "-t", String(dur), "-i", src.path, "-map", map, "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"], { signal });
    const meter = dbMeter(16000, fps);
    let rest = Buffer.alloc(0);
    let err = "";
    p.stdout.on("data", (d) => {
      const buf = rest.length ? Buffer.concat([rest, d]) : d;
      const n = Math.floor(buf.length / 4);
      const f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = buf.readFloatLE(i * 4);
      meter.push(f);
      rest = buf.subarray(n * 4);
    });
    p.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not read the audio: ${err.trim().split("\n").pop()}`));
      const db = meter.finish();
      const frames = Math.ceil(dur * fps);
      // exactly one value per output frame (the decode can be a frame short or long)
      const out = new Float32Array(frames).fill(-120);
      out.set(db.subarray(0, frames));
      resolve(out);
    });
  });
}

/** The clip's envelope (audiogram.mjs), for the desktop render and the review card. */
export async function clipEnvelope(src, start, dur, opts = {}) {
  return envelopeFromDb(await audioDbPerFrame(src, start, dur, opts), opts.fps ?? AUDIOGRAM_FPS);
}

/** Resolve the cover image's path from the job's settings (relative paths live in the job folder). */
export function coverPath(settings, dir) {
  const a = audiogramSettings(settings);
  if (a.bg !== "cover") return null;
  return path.isAbsolute(a.cover) ? a.cover : path.join(dir, a.cover);
}

/** Draw the still background (a preset, or the person's image) as a W x H PNG. */
export async function backgroundPng(settings, dir, W, H) {
  const a = audiogramSettings(settings);
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  if (a.bg === "cover") {
    const file = coverPath(settings, dir);
    let img;
    try {
      img = await loadImage(fs.readFileSync(file));
    } catch (e) {
      throw Object.assign(new Error(`Selects could not read the background image (${path.basename(file || "")}).`), { hint: "Use a JPEG, PNG or WebP image, or pick one of the drawn backgrounds." });
    }
    paintCover(ctx, img, W, H, { focus: a.focus, makeCanvas: (w, h) => createCanvas(w, h) });
  } else paintPreset(ctx, a.bg, W, H);
  return { png: c.toBuffer("image/png"), bg: a.bg };
}

/**
 * Encode the audiogram: background PNG, moving band from stdin, caption track, the source's
 * audio (loudness normalised like every clip). Resolves when the MP4 is written.
 */
export async function encodeAudiogram({ src, start, dur, W, H, P, settings, dir, tmp, capList, capY, out, onProgress, signal }) {
  fs.mkdirSync(tmp, { recursive: true });
  const fps = AUDIOGRAM_FPS;
  const env = await clipEnvelope(src, start, dur, { fps, signal });
  const { png, bg } = await backgroundPng(settings, dir, W, H);
  const bgFile = path.join(tmp, "background.png");
  fs.writeFileSync(bgFile, png);
  const s = W / 1080;
  const bandY = Math.round(AUDIOGRAM_LAYOUT.band.y * s);
  const bandH = Math.round((AUDIOGRAM_LAYOUT.band.h * s) / 2) * 2;
  const ai = capList ? 3 : 2; // the source's input index: after the background, the band and the captions
  const amap = src.audioStreams?.length ? `${ai}:${src.audioStreams[0].index}` : `${ai}:a:0`;
  const capIn = capList ? ["-f", "concat", "-safe", "0", "-i", capList] : [];
  const filter =
    `[0:v]format=yuv420p[bg];[1:v]format=rgba[band];[bg][band]overlay=0:${bandY}:eof_action=pass:format=auto[v0];` +
    (capList ? `[2:v]format=rgba[cap];[v0][cap]overlay=0:${capY}:eof_action=pass:format=auto,format=yuv420p[out]` : `[v0]format=yuv420p[out]`);
  const args = [
    "-v", "error", "-y", "-nostats", "-progress", "pipe:2",
    "-loop", "1", "-framerate", String(fps), "-t", String(dur), "-i", bgFile,
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${bandH}`, "-framerate", String(fps), "-i", "pipe:0",
    ...capIn,
    ...(start > 0 ? ["-ss", String(start)] : []), "-t", String(dur), "-i", src.path,
    "-filter_complex", filter,
    "-map", "[out]", "-map", amap,
    "-af", `loudnorm=I=${P.lufs}:TP=-1.5:LRA=11,aresample=48000`,
    "-c:v", "libx264", "-preset", P.x264, "-crf", String(P.crf), "-pix_fmt", "yuv420p", "-r", String(fps),
    "-c:a", "aac", "-b:a", P.audioBitrate,
    "-movflags", "+faststart", "-t", String(dur),
    out,
  ];
  const frames = Math.ceil(dur * fps);
  const band = createCanvas(W, bandH);
  const bctx = band.getContext("2d");
  await new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { signal, stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    let buf = "";
    p.stderr.on("data", (d) => {
      const t = d.toString();
      buf += t;
      const m = buf.match(/out_time_(?:us|ms)=(\d+)/g);
      if (m) {
        const us = +m[m.length - 1].split("=")[1];
        // drawing the band is the first half of the work, encoding keeps pace with it
        onProgress?.({ progress: Math.min(0.99, us / 1e6 / dur) });
        buf = buf.slice(-200);
      }
      if (!/^(frame|fps|stream_|bitrate|total_size|out_time|dup_frames|drop_frames|speed|progress)=/m.test(t)) err = (err + t).slice(-4000);
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error(`ffmpeg exited with code ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}`), { stderr: err }));
    });
    p.stdin.on("error", () => {}); // ffmpeg closing early is reported by its exit code
    (async () => {
      for (let i = 0; i < frames; i++) {
        if (signal?.aborted) break;
        bctx.clearRect(0, 0, W, bandH);
        paintMoving(bctx, { env, t: i / fps, W, H, bg, offsetY: bandY });
        const px = bctx.getImageData(0, 0, W, bandH).data;
        if (!p.stdin.write(Buffer.from(px.buffer, px.byteOffset, px.byteLength))) await new Promise((r) => p.stdin.once("drain", r));
      }
      p.stdin.end();
    })().catch(reject);
  });
  return { bg, frames, fps, envelope: { frames: env.v.length } };
}
