// Render one captioned 9:16 clip in the browser: decode the source with WebCodecs
// (mediabunny), draw each frame on an OffscreenCanvas with the same reframe and captions
// as the desktop (src/core/layout.mjs), encode H.264 + AAC and mux an MP4 in memory.
// Runs in a worker (render.worker.js) or, as a fallback, on the main thread.
import {
  ALL_FORMATS, AudioSample, AudioSampleSink, AudioSampleSource, BlobSource, BufferTarget, CanvasSink, CanvasSource,
  canEncodeAudio, canEncodeVideo, Input, Mp4OutputFormat, Output,
} from "mediabunny";
import { clipCues, toSrt } from "../core/cues.mjs";
import { captionTimeline, captionTop, motionSize, paintCaption, PRESETS, reframeByShape, reframeFromMotion, workingSize } from "../core/layout.mjs";

export const FAMILIES = ["Selects Caption", "Selects Caption Fallback"];

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
 * @param {object} o
 *   file        the source File or Blob
 *   source      the Job's source object (duration, uprightWidth, uprightHeight, fps)
 *   candidate   { id, start, end }
 *   cues        the job's caption cues (source times), or null for no captions
 *   preset      "shorts" (1080x1920) or "preview" (720x1280)
 *   gainDb      audio gain towards -14 LUFS, worked out from the clip's audio
 *   onProgress  ({ progress }) 0..1
 * @returns {Promise<{ mp4: ArrayBuffer, srt: string, reframe, wallSec, frames, codec, audioCodec }>}
 */
export async function renderClip({ file, source, candidate, cues, preset = "shorts", gainDb = 0, reframe = "auto", onProgress, signal }) {
  const P = PRESETS[preset];
  if (!P) throw new Error(`Unknown preset "${preset}".`);
  const t0 = performance.now();
  const start = Math.max(0, candidate.start - P.padStart);
  const end = Math.min(source.duration || candidate.end + P.padEnd, candidate.end + P.padEnd);
  const dur = +(end - start).toFixed(3);
  const W = P.width;
  const H = P.height;
  const cap = { ...P.caption, style: "bold" };
  const clipped = cues ? clipCues(cues, candidate.start, candidate.end, start) : [];
  const timeline = captionTimeline(clipped, dur, { perWord: true });

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const vtrack = await input.getPrimaryVideoTrack();
    const atrack = await input.getPrimaryAudioTrack();
    if (!vtrack) throw Object.assign(new Error("This file has no video track."), { hint: "Clips need video. The desktop app can caption audio-only files." });
    const dispW = source.uprightWidth || (await vtrack.getDisplayWidth());
    const dispH = source.uprightHeight || (await vtrack.getDisplayHeight());
    const rf = reframe === "auto" ? await chooseReframe(vtrack, dispW, dispH, start, dur) : { mode: reframe };

    // ---- output: H.264 video, AAC audio (Opus if this browser cannot encode AAC)
    const vOk = await canEncodeVideo("avc", { width: W, height: H });
    if (!vOk) throw Object.assign(new Error("This browser cannot encode H.264 video."), { hint: "Use Chrome or Edge on a desktop computer, or the desktop app." });
    const audioCodec = atrack ? ((await canEncodeAudio("aac", { numberOfChannels: Math.min(2, atrack.numberOfChannels), sampleRate: 48000 })) ? "aac" : "opus") : null;
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d", { alpha: false });
    const vsrc = new CanvasSource(canvas, { codec: "avc", bitrate: preset === "preview" ? 2.5e6 : 6e6, keyFrameInterval: 2, latencyMode: "quality" });
    output.addVideoTrack(vsrc, { frameRate: Math.min(P.fps, Math.round(source.fps || P.fps)) });
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
        await vsrc.add(pending, Math.max(1e-3, nextAt - pending));
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
    await output.finalize();
    onProgress?.({ progress: 1 });
    return {
      mp4: output.target.buffer,
      srt: toSrt(clipped),
      reframe: rf,
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
