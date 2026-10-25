// Render one captioned 9:16 clip in the browser: decode the source with WebCodecs
// (mediabunny), draw each frame on an OffscreenCanvas with the same reframe and captions
// as the desktop (src/core/layout.mjs), encode H.264 + AAC and mux an MP4 in memory.
// Runs in a worker (render.worker.js) or, as a fallback, on the main thread.
import {
  ALL_FORMATS, AudioSample, AudioSampleSink, AudioSampleSource, BlobSource, BufferTarget, CanvasSink, CanvasSource,
  canEncodeAudio, canEncodeVideo, Input, Mp4OutputFormat, Output,
} from "mediabunny";
import { clipCues, cuesFromWords, toSrt } from "../core/cues.mjs";
import { captionOptions, captionTimeline, captionTop, motionSize, paintCaption, PRESETS, reframeByShape, reframeFromMotion, workingSize } from "../core/layout.mjs";
import { AUDIOGRAM_FPS, audiogramSettings, dbMeter, envelopeFromDb, paintCover, paintMoving, paintPreset } from "../core/audiogram.mjs";

export const FAMILIES = ["Selects Caption", "Selects Caption Fallback"];

/**
 * Safari's (WebKit's) H.264 encoder in latencyMode "quality" never returns a frame in Safari
 * 27.0 and 27.0.1 (mediabunny issue 541, WebKit bug fixed later); "realtime" works on every
 * profile. Other engines keep "quality".
 */
export function encoderLatencyMode(ua = globalThis.navigator?.userAgent || "") {
  const webkit = /AppleWebKit/.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua);
  return webkit ? "realtime" : "quality";
}

/** How long one frame may sit in the encoder before Selects says it has stopped responding. */
export const ENCODER_STALL_SEC = 30;

/** p, or a rejection when it has not settled after sec seconds (an encoder that hangs). */
export function withStallLimit(p, sec = ENCODER_STALL_SEC) {
  let t;
  const stall = new Promise((_, reject) => {
    t = setTimeout(() => reject(Object.assign(new Error("This browser's video encoder stopped responding."), { hint: "Update the browser (Safari 27.0 has a known encoder fault), then render again, or render on a computer with Chrome or Edge.", code: "encoder_stalled" })), sec * 1000);
  });
  return Promise.race([p, stall]).finally(() => clearTimeout(t));
}

/** Load the caption fonts into this realm (window or worker). */
export async function loadFonts(urls) {
  const set = self.fonts || globalThis.document?.fonts;
  if (!set) return false;
  const faces = [new FontFace(FAMILIES[0], `url(${urls.main})`), new FontFace(FAMILIES[1], `url(${urls.fallback})`)];
  await Promise.all(faces.map((f) => f.load()));
  faces.forEach((f) => set.add(f));
  return true;
}

const gray = (img) => {
  const out = new Uint8Array(img.width * img.height);
  const d = img.data;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return out;
};

/** The crop-or-fit choice from 16 tiny grayscale frames (layout.mjs decides, as on desktop). */
async function chooseReframe(track, dispW, dispH, start, dur, samples = 16) {
  const byShape = reframeByShape(dispW, dispH);
  if (byShape) return byShape;
  const { W, H } = motionSize(dispW, dispH);
  const sink = new CanvasSink(track, { width: W, height: H, fit: "fill", poolSize: 1 });
  const times = Array.from({ length: samples }, (_, i) => start + ((i + 0.5) * dur) / samples);
  const raw = new Uint8Array(W * H * samples);
  let n = 0;
  for await (const wc of sink.canvasesAtTimestamps(times)) {
    if (!wc) continue;
    raw.set(gray(wc.canvas.getContext("2d").getImageData(0, 0, W, H)), n * W * H);
    n++;
  }
  return reframeFromMotion(raw.subarray(0, n * W * H), W, H, dispW, dispH);
}

/**
 * The audiogram's frames and sound. The clip's audio is read once: its loudness per frame
 * drives the meter and the mouth, and the same samples (with the gain) are encoded. The
 * background is painted once and copied under every frame.
 */
async function audiogramFrames({ atrack, asrc, vsrc, ctx, W, H, start, end, dur, gainDb, audiogram, signal, onProgress, drawCaption }) {
  const fps = AUDIOGRAM_FPS;
  const frames = Math.ceil(dur * fps);
  const gain = Math.pow(10, gainDb / 20);
  const chunks = [];
  const meter = dbMeter(atrack.sampleRate || 48000, fps);
  let rate = atrack.sampleRate || 48000;
  for await (const s of new AudioSampleSink(atrack).samples(start, end)) {
    rate = s.sampleRate;
    const chans = Math.min(2, s.numberOfChannels);
    const skip = Math.max(0, Math.round((start - s.timestamp) * rate));
    const take = Math.min(s.numberOfFrames - skip, Math.round((end - Math.max(start, s.timestamp)) * rate));
    if (take <= 0) {
      s.close();
      continue;
    }
    const data = new Float32Array(take * chans);
    const mono = new Float32Array(take);
    for (let c = 0; c < chans; c++) {
      const plane = data.subarray(c * take, (c + 1) * take);
      s.copyTo(plane, { planeIndex: c, format: "f32-planar", frameOffset: skip, frameCount: take });
      for (let i = 0; i < take; i++) mono[i] += plane[i] / chans;
      for (let i = 0; i < plane.length; i++) plane[i] = Math.max(-0.98, Math.min(0.98, plane[i] * gain));
    }
    meter.push(mono);
    chunks.push({ data, chans, rate, ts: Math.max(0, s.timestamp - start) });
    s.close();
    if (signal?.aborted) throw Object.assign(new Error("Stopped before it finished."), { name: "AbortError" });
    onProgress?.({ progress: Math.min(0.1, (0.1 * chunks.reduce((a, c) => a + c.data.length / c.chans, 0)) / (dur * rate)) });
  }
  const db = new Float32Array(frames).fill(-120);
  db.set(meter.finish().subarray(0, frames));
  const env = envelopeFromDb(db, fps);

  const a = audiogramSettings({ audiogram });
  const bgCanvas = new OffscreenCanvas(W, H);
  const bctx = bgCanvas.getContext("2d");
  const coverBlob = audiogram?.cover instanceof Blob ? audiogram.cover : null;
  if (a.bg === "cover" && coverBlob) {
    let img;
    try {
      img = await createImageBitmap(coverBlob);
    } catch {
      throw Object.assign(new Error("This browser could not read the background image."), { hint: "Choose a JPEG or PNG image, or one of the drawn backgrounds." });
    }
    paintCover(bctx, img, W, H, { focus: audiogram.focus, makeCanvas: (w, h) => new OffscreenCanvas(w, h) });
    img.close?.();
  } else paintPreset(bctx, a.bg === "cover" ? null : a.bg, W, H);
  const bg = a.bg === "cover" && !coverBlob ? "sunny" : a.bg;

  const audioDone = (async () => {
    if (!asrc) return;
    for (const c of chunks) {
      const out = new AudioSample({ data: c.data, format: "f32-planar", numberOfChannels: c.chans, sampleRate: c.rate, timestamp: c.ts });
      await asrc.add(out);
      out.close();
    }
    asrc.close();
  })();
  const videoDone = (async () => {
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw Object.assign(new Error("Stopped before it finished."), { name: "AbortError" });
      const t = i / fps;
      ctx.drawImage(bgCanvas, 0, 0);
      paintMoving(ctx, { env, t, W, H, bg });
      drawCaption(t);
      await withStallLimit(vsrc.add(t, Math.min(1 / fps, dur - t)));
      onProgress?.({ progress: Math.min(0.99, 0.1 + (0.89 * (i + 1)) / frames) });
    }
    vsrc.close();
  })();
  await Promise.all([videoDone, audioDone]);
  return { bg, frames };
}

/**
 * @param {object} o
 *   file        the source File or Blob
 *   source      the Job's source object (duration, uprightWidth, uprightHeight, fps)
 *   candidate   { id, start, end }
 *   cues        the job's caption cues (source times), or null for no captions
 *   preset      "shorts" (1080x1920) or "preview" (720x1280)
 *   gainDb      audio gain towards -14 LUFS, worked out from the clip's audio
 *   onProgress  ({ progress }) 0..1
 *   audiogram   for a file with no picture: { bg, cover?: Blob, focus? } (settings.audiogram,
 *               with the person's image as a Blob). The clip becomes an audiogram.
 * @returns {Promise<{ mp4: ArrayBuffer, srt: string, reframe, wallSec, frames, codec, audioCodec }>}
 */
export async function renderClip({ file, source, candidate, cues, preset = "shorts", gainDb = 0, reframe = "auto", style = "bold", edited = false, audiogram = null, onProgress, signal }) {
  const P = PRESETS[preset];
  if (!P) throw new Error(`Unknown preset "${preset}".`);
  const t0 = performance.now();
  const start = Math.max(0, candidate.start - P.padStart);
  const end = Math.min(source.duration || candidate.end + P.padEnd, candidate.end + P.padEnd);
  const dur = +(end - start).toFixed(3);
  const W = P.width;
  const H = P.height;
  // bold (2 to 4 words, the spoken one in yellow) or subtitle (two lines), as the desktop's render
  const cap = style === "subtitle" ? captionOptions(W, H, "subtitle") : { ...P.caption, style: "bold" };
  let clipped = cues ? clipCues(cues, candidate.start, candidate.end, start) : [];
  // cues grouped for the other look are regrouped, unless a person edited them
  if (clipped.length && !edited && style === "subtitle") clipped = cuesFromWords(clipped.flatMap((c) => c.words), "subtitle");
  const timeline = captionTimeline(clipped, dur, { perWord: style !== "subtitle" });

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const vtrack = await input.getPrimaryVideoTrack();
    const atrack = await input.getPrimaryAudioTrack();
    if (!vtrack && !atrack) throw Object.assign(new Error("This file has no picture and no sound."), { hint: "Choose a video, or a recording with speech in it." });
    // no picture: the clip becomes an audiogram (a background, a meter and a mouth driven by its sound)
    const isAudiogram = !vtrack;
    const dispW = isAudiogram ? W : source.uprightWidth || (await vtrack.getDisplayWidth());
    const dispH = isAudiogram ? H : source.uprightHeight || (await vtrack.getDisplayHeight());
    const rf = isAudiogram ? { mode: "audiogram" } : reframe === "auto" ? await chooseReframe(vtrack, dispW, dispH, start, dur) : { mode: reframe };

    // ---- output: H.264 video, AAC audio (Opus if this browser cannot encode AAC)
    const vOk = await canEncodeVideo("avc", { width: W, height: H });
    if (!vOk) throw Object.assign(new Error("This browser cannot encode H.264 video."), { hint: "Use Chrome or Edge on a desktop computer, or the desktop app." });
    const audioCodec = atrack ? ((await canEncodeAudio("aac", { numberOfChannels: Math.min(2, atrack.numberOfChannels), sampleRate: 48000 })) ? "aac" : "opus") : null;
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d", { alpha: false });
    const vsrc = new CanvasSource(canvas, { codec: "avc", bitrate: preset === "preview" ? 2.5e6 : 6e6, keyFrameInterval: 2, latencyMode: encoderLatencyMode() });
    output.addVideoTrack(vsrc, { frameRate: isAudiogram ? AUDIOGRAM_FPS : Math.min(P.fps, Math.round(source.fps || P.fps)) });
    let asrc = null;
    if (atrack && audioCodec) {
      asrc = new AudioSampleSource({ codec: audioCodec, bitrate: preset === "preview" ? 128e3 : 160e3 });
      output.addAudioTrack(asrc);
    }
    await output.start();

    // ---- helpers for drawing
    const { w: workW, h: workH } = workingSize(dispW, dispH);
    const bg = rf.mode === "fit" ? new OffscreenCanvas(W / 4, H / 4) : null;
    const bgCtx = bg?.getContext("2d");
    const capY = captionTop(H, cap);
    // when each caption image shows, as in the desktop's caption track
    const ends = [];
    timeline.reduce((acc, e) => (ends.push(acc + e.dur), acc + e.dur), 0);
    const captionAt = (t) => {
      const i = ends.findIndex((x) => t < x - 1e-6);
      return i >= 0 && timeline[i].cue >= 0 ? i : -1;
    };
    const capLayer = new OffscreenCanvas(W, cap.boxHeight);
    const capCtx = capLayer.getContext("2d");
    let capShown = -2;

    const draw = (frame, t) => {
      const iw = frame.width;
      const ih = frame.height;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      if (rf.mode === "crop") {
        const cw = Math.floor((ih * 9) / 16 / 2) * 2;
        ctx.drawImage(frame, (iw - cw) / 2, 0, cw, ih, 0, 0, W, H);
      } else if (rf.mode === "scale") {
        const f = Math.min(W / iw, H / ih);
        ctx.drawImage(frame, (W - iw * f) / 2, (H - ih * f) / 2, iw * f, ih * f);
      } else {
        // fit: the whole frame over a blurred, darkened copy of itself (as the desktop's boxblur and eq)
        // drawn 15% larger than cover, so the blur's soft edges fall outside the frame
        const f = Math.max(bg.width / iw, bg.height / ih) * 1.15;
        bgCtx.filter = "blur(9px) brightness(0.86)";
        bgCtx.drawImage(frame, (bg.width - iw * f) / 2, (bg.height - ih * f) / 2, iw * f, ih * f);
        ctx.drawImage(bg, 0, 0, W, H);
        const fh = Math.round((W * ih) / iw / 2) * 2;
        ctx.drawImage(frame, 0, Math.round((H - fh) / 2 - H * 0.04), W, fh);
      }
      const ci = captionAt(t);
      if (ci !== capShown) {
        capCtx.clearRect(0, 0, W, cap.boxHeight);
        if (ci >= 0) paintCaption(capCtx, clipped[timeline[ci].cue].words, timeline[ci].word, { width: W, caption: cap, families: FAMILIES });
        capShown = ci;
      }
      if (ci >= 0) ctx.drawImage(capLayer, 0, capY);
    };

    if (isAudiogram) {
      const ag = await audiogramFrames({ atrack, asrc, vsrc, ctx, W, H, start, end, dur, gainDb, audiogram, signal, onProgress, drawCaption: (t) => {
        const ci = captionAt(t);
        if (ci !== capShown) {
          capCtx.clearRect(0, 0, W, cap.boxHeight);
          if (ci >= 0) paintCaption(capCtx, clipped[timeline[ci].cue].words, timeline[ci].word, { width: W, caption: cap, families: FAMILIES });
          capShown = ci;
        }
        if (ci >= 0) ctx.drawImage(capLayer, 0, capY);
      } });
      await withStallLimit(output.finalize(), ENCODER_STALL_SEC * 2);
      onProgress?.({ progress: 1 });
      return { mp4: output.target.buffer, srt: toSrt(clipped), reframe: rf, audiogram: { bg: ag.bg }, captionStyle: style, frames: ag.frames, codec: "avc", audioCodec, captions: clipped.length, wallSec: +((performance.now() - t0) / 1000).toFixed(1) };
    }

    // ---- video: decode at the working size; each frame keeps its own time (so a 25 fps
    // source stays 25 fps), and sources above P.fps are thinned to P.fps
    const sink = new CanvasSink(vtrack, { width: workW, height: workH, fit: "fill", poolSize: 3 });
    const minGap = 1 / P.fps - 1e-4;
    let lastAt = -Infinity;
    let frames = 0;
    const videoDone = (async () => {
      let pending = null; // the previous frame: its duration runs to the next kept frame
      const flush = async (nextAt) => {
        if (!pending) return;
        await withStallLimit(vsrc.add(pending, Math.max(1e-3, nextAt - pending)));
        frames++;
      };
      for await (const wc of sink.canvases(start, end)) {
        if (signal?.aborted) throw Object.assign(new Error("Stopped before it finished."), { name: "AbortError" });
        const at = Math.max(0, wc.timestamp - start);
        if (at >= dur) break;
        if (at - lastAt < minGap) continue; // above P.fps: drop
        await flush(at);
        draw(wc.canvas, at);
        pending = at;
        lastAt = at;
        onProgress?.({ progress: Math.min(0.99, at / dur) });
      }
      // the last picture holds to the end of the clip (the padding after the last word);
      // captions can still change during the hold, so redraw is not needed for the picture
      await flush(dur);
      vsrc.close();
    })();

    // ---- audio: the same span, gain applied, at most two channels
    const audioDone = (async () => {
      if (!asrc) return;
      const gain = Math.pow(10, gainDb / 20);
      const asink = new AudioSampleSink(atrack);
      for await (const s of asink.samples(start, end)) {
        const rate = s.sampleRate;
        const chans = Math.min(2, s.numberOfChannels);
        const skip = Math.max(0, Math.round((start - s.timestamp) * rate));
        const take = Math.min(s.numberOfFrames - skip, Math.round((end - Math.max(start, s.timestamp)) * rate));
        if (take <= 0) {
          s.close();
          continue;
        }
        const data = new Float32Array(take * chans);
        for (let c = 0; c < chans; c++) {
          const plane = data.subarray(c * take, (c + 1) * take);
          s.copyTo(plane, { planeIndex: c, format: "f32-planar", frameOffset: skip, frameCount: take });
          for (let i = 0; i < plane.length; i++) plane[i] = Math.max(-0.98, Math.min(0.98, plane[i] * gain));
        }
        const ts = Math.max(0, s.timestamp - start);
        s.close();
        const out = new AudioSample({ data, format: "f32-planar", numberOfChannels: chans, sampleRate: rate, timestamp: ts });
        await asrc.add(out);
        out.close();
      }
      asrc.close();
    })();

    await Promise.all([videoDone, audioDone]);
    await withStallLimit(output.finalize(), ENCODER_STALL_SEC * 2);
    onProgress?.({ progress: 1 });
    return {
      mp4: output.target.buffer,
      srt: toSrt(clipped),
      reframe: rf,
      captionStyle: style,
      frames,
      codec: "avc",
      audioCodec,
      captions: clipped.length,
      wallSec: +((performance.now() - t0) / 1000).toFixed(1),
    };
  } finally {
    input.dispose?.();
  }
}
