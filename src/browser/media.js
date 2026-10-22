// Reading the user's video in the tab: probe it, decode its audio to 16 kHz mono for
// whisper, measure loudness for the pre-score, and grab filmstrip thumbnails. Everything
// reads the File directly (mediabunny over WebCodecs); nothing is uploaded.
import { ALL_FORMATS, AudioSampleSink, BlobSource, CanvasSink, Input } from "mediabunny";

export const ASR_RATE = 16000;

/**
 * An Error when this browser has no WebCodecs audio decoder (Safari before 26, which older
 * iPhones cannot update past), or null. Selects reads every video's sound through it.
 */
export function audioDecodeUnsupported(g = globalThis) {
  if (typeof g.AudioDecoder !== "undefined") return null;
  const ua = g.navigator?.userAgent || "";
  const apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (g.navigator?.maxTouchPoints || 0) > 1);
  return apple
    ? Object.assign(new Error("This iPhone's Safari is too old for Selects Web."), { hint: "Selects Web needs iOS 26 or later to read a video's sound. Update in Settings, General, Software Update, or use Selects on a computer.", code: "no_audio_decoder" })
    : Object.assign(new Error("This browser is too old to read the video's sound."), { hint: "Update the browser, or use a recent Chrome, Edge or Safari (26 or later).", code: "no_audio_decoder" });
}

export function openInput(file) {
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
}

/**
 * The Job's `source` object (CONTRACTS.md), from the file itself. `path` is null in the
 * browser: the File stays in memory and is never named by a path.
 */
export async function probeFile(file) {
  const input = openInput(file);
  try {
    const duration = await input.computeDuration();
    const v = await input.getPrimaryVideoTrack();
    const a = await input.getPrimaryAudioTrack();
    const src = { path: null, name: file.name, size: file.size, duration: +duration.toFixed(3), hasVideo: !!v, audioStreams: [] };
    if (v) {
      const [w, h, rot, disW, disH, codec, stats, canDecode] = await Promise.all([
        v.getCodedWidth(), v.getCodedHeight(), v.getRotation(), v.getDisplayWidth(), v.getDisplayHeight(), v.getCodec(), v.computePacketStats(120), v.canDecode(),
      ]);
      Object.assign(src, {
        width: w,
        height: h,
        rotation: rot,
        // upright display size: after the pixel aspect ratio and the rotation flag
        uprightWidth: disW,
        uprightHeight: disH,
        displayWidth: rot % 180 ? disH : disW,
        fps: +stats.averagePacketRate.toFixed(3),
        vcodec: codec,
        canDecodeVideo: canDecode,
      });
    }
    if (a) {
      src.audioStreams = [{ index: 0, codec: await a.getCodec(), channels: a.numberOfChannels, sampleRate: a.sampleRate, canDecode: await a.canDecode() }];
    }
    return src;
  } finally {
    input.dispose?.();
  }
}

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

/** Resample mono PCM to `rate` with WebAudio's OfflineAudioContext (good, fast resampler). */
async function resample(pcm, fromRate, rate) {
  if (fromRate === rate) return pcm;
  const frames = Math.max(1, Math.round((pcm.length * rate) / fromRate));
  const ctx = new OfflineAudioContext(1, frames, rate);
  const b = ctx.createBuffer(1, pcm.length, fromRate);
  b.copyToChannel(pcm, 0);
  const node = ctx.createBufferSource();
  node.buffer = b;
  node.connect(ctx.destination);
  node.start();
  return (await ctx.startRendering()).getChannelData(0);
}

/**
 * Decode the audio track to 16 kHz mono Float32 for whisper, in blocks of about 60 s so a
 * long video never sits in memory at its native rate. onProgress(0..1). onBlock(pcm16k) gets
 * each resampled block as soon as it is ready (blockSec, default 60), so Light mode can start
 * sending speech while the rest is still being read; with keep: false nothing is returned.
 */
export async function decodeAudio16k(file, { onProgress, duration, onBlock, blockSec = 60, keep = true } = {}) {
  const input = openInput(file);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw Object.assign(new Error("This video has no audio track, so there is nothing to transcribe."), { hint: "Choose a video with speech in it." });
    if (!(await track.canDecode())) throw audioDecodeUnsupported() || Object.assign(new Error("This browser cannot decode the video's audio."), { hint: "Try Chrome or Edge, or convert the video to MP4 (H.264 and AAC)." });
    const total = duration || (await input.computeDuration());
    const sink = new AudioSampleSink(track);
    const parts = [];
    let pending = [];
    let pendingLen = 0;
    let rate = track.sampleRate;
    const flush = async () => {
      if (!pendingLen) return;
      const joined = new Float32Array(pendingLen);
      let o = 0;
      for (const p of pending) {
        joined.set(p, o);
        o += p.length;
      }
      const block = await resample(joined, rate, ASR_RATE);
      // keep: false when onBlock keeps the audio itself (Light mode), so it is not held twice
      if (keep) parts.push(block);
      await onBlock?.(block);
      pending = [];
      pendingLen = 0;
    };
    for await (const sample of sink.samples()) {
      const buf = sample.toAudioBuffer();
      rate = buf.sampleRate;
      const m = mono(buf);
      pending.push(m);
      pendingLen += m.length;
      const end = sample.timestamp + sample.duration;
      sample.close();
      if (pendingLen >= rate * blockSec) await flush();
      onProgress?.(Math.min(1, end / total));
    }
    await flush();
    if (!keep) return null;
    const len = parts.reduce((a, p) => a + p.length, 0);
    const pcm = new Float32Array(len);
    let o = 0;
    for (const p of parts) {
      pcm.set(p, o);
      o += p.length;
    }
    return pcm;
  } finally {
    input.dispose?.();
  }
}

/**
 * Loudness in dBFS for each `step` seconds, the same measure as loudnessFromWav in
 * src/core/transcribe.mjs (RMS of 16 kHz mono, 20 log10), so the pre-score reads it the same.
 */
export function loudnessFromPcm(pcm, rate = ASR_RATE, { step = 0.5 } = {}) {
  const per = Math.round(rate * step);
  const db = [];
  for (let i = 0; i < pcm.length; i += per) {
    const end = Math.min(pcm.length, i + per);
    let sum = 0;
    for (let k = i; k < end; k++) sum += pcm[k] * pcm[k];
    db.push(+(20 * Math.log10(Math.sqrt(sum / Math.max(1, end - i)) + 1e-9)).toFixed(1));
  }
  return { step, db };
}

/**
 * Integrated loudness (ITU-R BS.1770, K-weighted, gated) of mono PCM. Used to normalise
 * clip audio towards the shorts preset's -14 LUFS, as ffmpeg's loudnorm does on desktop.
 * Returns LUFS, or -70 for silence.
 */
export function integratedLoudness(pcm, rate) {
  // K-weighting: a high shelf (+4 dB above about 1.5 kHz), then a high-pass at about 38 Hz.
  const biquad = (x, b0, b1, b2, a1, a2) => {
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  };
  const shelf = (() => {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    const K = Math.tan((Math.PI * f0) / rate), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / Q + K * K;
    return [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  })();
  const hp = (() => {
    const f0 = 38.13547087602444, Q = 0.5003270373238773, K = Math.tan((Math.PI * f0) / rate);
    const a0 = 1 + K / Q + K * K;
    return [1 / a0, -2 / a0, 1 / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  })();
  const k = biquad(biquad(pcm, ...shelf), ...hp);
  const block = Math.round(rate * 0.4);
  const hop = Math.round(rate * 0.1);
  const ms = [];
  for (let i = 0; i + block <= k.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + block; j++) s += k[j] * k[j];
    ms.push(s / block);
  }
  const lufs = (m) => -0.691 + 10 * Math.log10(m + 1e-12);
  const abs = ms.filter((m) => lufs(m) > -70);
  if (!abs.length) return -70;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const rel = lufs(mean(abs)) - 10;
  const gated = abs.filter((m) => lufs(m) > rel);
  return +lufs(mean(gated.length ? gated : abs)).toFixed(2);
}

/**
 * Filmstrip thumbnails, as object URLs: `count` frames spread over the video, 160 px wide.
 * Returns { count, interval, urls }. The UI asks for them with thumbUrl(id, n), n from 1.
 */
export async function makeThumbs(file, duration, { count = 60, width = 160 } = {}) {
  const input = openInput(file);
  try {
    const v = await input.getPrimaryVideoTrack();
    if (!v || !(await v.canDecode())) return { count: 0, interval: 0, urls: [] };
    const n = Math.max(1, Math.min(count, Math.floor(duration / 2)));
    const interval = duration / n;
    const times = Array.from({ length: n }, (_, i) => Math.min(duration - 0.05, (i + 0.5) * interval));
    const sink = new CanvasSink(v, { width, poolSize: 2 });
    const urls = [];
    for await (const wc of sink.canvasesAtTimestamps(times)) {
      if (!wc) {
        urls.push(urls[urls.length - 1] ?? null);
        continue;
      }
      const blob = wc.canvas.convertToBlob ? await wc.canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 }) : await new Promise((r) => wc.canvas.toBlob(r, "image/jpeg", 0.7));
      urls.push(URL.createObjectURL(blob));
    }
    return { count: urls.length, interval: +interval.toFixed(3), urls };
  } finally {
    input.dispose?.();
  }
}
