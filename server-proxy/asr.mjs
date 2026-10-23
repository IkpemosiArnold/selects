// Light mode's speech-to-text for the proxy: check that a request body is a short audio file
// (never video), then pass it to a hosted open-weights whisper and return word times in the
// browser engine's shape ([{ w, s, e }], src/core/asr-words.mjs). The audio and the text are
// held in memory for the one request and never logged or stored.
//
// Providers sit behind one interface, so the vendor can change without touching the page:
//   provider.transcribe({ buf, mime, ext, language }) -> { words, duration, model }
// openAiCompatibleAsr covers Groq and any server with OpenAI's /audio/transcriptions and
// verbose_json word timestamps; cloudflareAsr covers Workers AI's whisper. asrFromEnv picks one.
import { cleanWords, wordsFromVerbose } from "../src/core/asr-words.mjs";
import { failover, providerRequest } from "../src/core/provider-request.mjs";

// ---------------------------------------------------------------- audio checks

const ascii = (buf, at, n) => buf.subarray(at, at + n).toString("latin1");

/**
 * What kind of audio file this is, from its first bytes (the Content-Type is the client's
 * claim, the bytes are the truth). Returns { kind, mime, ext } or null for anything else.
 */
export function sniffAudio(buf) {
  if (!buf || buf.length < 12) return null;
  if (ascii(buf, 0, 4) === "OggS") return { kind: "ogg", mime: "audio/ogg", ext: "ogg" };
  if (ascii(buf, 0, 4) === "fLaC") return { kind: "flac", mime: "audio/flac", ext: "flac" };
  if (ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 4) === "WAVE") return { kind: "wav", mime: "audio/wav", ext: "wav" };
  if (ascii(buf, 4, 4) === "ftyp") return { kind: "mp4", mime: "audio/mp4", ext: "m4a" };
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { kind: "webm", mime: "audio/webm", ext: "webm" };
  if (ascii(buf, 0, 3) === "ID3") return { kind: "mp3", mime: "audio/mpeg", ext: "mp3" };
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return { kind: "aac", mime: "audio/aac", ext: "aac" };
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return { kind: "mp3", mime: "audio/mpeg", ext: "mp3" };
  return null;
}

/** True when a container file carries a video track (MP4 'vide' handler, Matroska V_ codec, Ogg Theora). */
export function hasVideoTrack(buf, kind) {
  const s = buf.toString("latin1");
  if (kind === "mp4") {
    for (let i = s.indexOf("hdlr"); i >= 0; i = s.indexOf("hdlr", i + 4)) if (s.slice(i + 12, i + 16) === "vide") return true;
    return false;
  }
  if (kind === "webm") return /V_(VP8|VP9|AV1|MPEG4|MPEGH|THEORA|UNCOMPRESSED|MS)/.test(s);
  if (kind === "ogg") return s.includes("\x80theora");
  return false;
}

const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const MP3_KBPS = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

/** MP3: walk every frame header after any ID3v2 tag and add up the samples. null when no frames. */
function mp3Seconds(buf) {
  let i = 0;
  if (buf.toString("latin1", 0, 3) === "ID3" && buf.length > 10) i = 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f));
  let sec = 0;
  let frames = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) {
      i++;
      continue;
    }
    const ver = (buf[i + 1] >> 3) & 3; // 3 MPEG-1, 2 MPEG-2, 0 MPEG-2.5
    const layer = 4 - ((buf[i + 1] >> 1) & 3); // 1, 2 or 3
    const bi = buf[i + 2] >> 4;
    const ri = (buf[i + 2] >> 2) & 3;
    const pad = (buf[i + 2] >> 1) & 1;
    if (ver === 1 || layer === 4 || bi === 0 || bi === 15 || ri === 3) {
      i++;
      continue;
    }
    const rate = MP3_RATES[ver][ri];
    const kbps = MP3_KBPS[ver === 3 ? `1-${layer}` : layer === 1 ? "2-1" : "2-2"][bi];
    const samples = layer === 1 ? 384 : layer === 3 && ver !== 3 ? 576 : 1152;
    const size = layer === 1 ? (Math.floor((12 * kbps * 1000) / rate) + pad) * 4 : Math.floor(((samples / 8) * kbps * 1000) / rate) + pad;
    if (size < 4) break;
    sec += samples / rate;
    frames++;
    i += size;
  }
  return frames ? sec : null;
}

/** ADTS AAC: 1024 samples a frame (times the frame's raw blocks), frame lengths from each header. */
function adtsSeconds(buf) {
  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let i = 0;
  let sec = 0;
  let frames = 0;
  while (i + 7 <= buf.length && buf[i] === 0xff && (buf[i + 1] & 0xf6) === 0xf0) {
    const rate = RATES[(buf[i + 2] >> 2) & 0xf];
    const len = ((buf[i + 3] & 3) << 11) | (buf[i + 4] << 3) | (buf[i + 5] >> 5);
    const blocks = (buf[i + 6] & 3) + 1;
    if (!rate || len < 7) break;
    sec += (1024 * blocks) / rate;
    frames++;
    i += len;
  }
  return frames ? sec : null;
}

/** EBML element at i: { id, size, start (of data) } or null. */
function ebml(buf, i) {
  const vint = (at, keepMarker) => {
    const b = buf[at];
    if (b == null || b === 0) return null;
    const len = Math.clz32(b) - 23;
    if (at + len > buf.length) return null;
    let v = keepMarker ? b : b & (0xff >> len);
    for (let k = 1; k < len; k++) v = v * 256 + buf[at + k];
    return { v, len };
  };
  const id = vint(i, true);
  if (!id) return null;
  const size = vint(i + id.len, false);
  if (!size) return null;
  return { id: id.v, size: size.v, start: i + id.len + size.len };
}

/** WebM/Matroska: Segment > Info > Duration (a float in TimecodeScale units). null when absent. */
function webmSeconds(buf) {
  let i = 0;
  const top = ebml(buf, 0);
  if (!top) return null;
  i = top.start + top.size; // past the EBML header
  const seg = ebml(buf, i);
  if (!seg || seg.id !== 0x18538067) return null;
  let j = seg.start;
  while (j < buf.length) {
    const el = ebml(buf, j);
    if (!el) return null;
    if (el.id === 0x1549a966) {
      let scale = 1e6;
      let dur = null;
      for (let k = el.start; k < Math.min(buf.length, el.start + el.size); ) {
        const c = ebml(buf, k);
        if (!c) break;
        if (c.id === 0x2ad7b1) scale = buf.readUIntBE(c.start, Math.min(6, c.size));
        if (c.id === 0x4489) dur = c.size === 4 ? buf.readFloatBE(c.start) : c.size === 8 ? buf.readDoubleBE(c.start) : null;
        k = c.start + c.size;
      }
      return dur != null && dur > 0 ? (dur * scale) / 1e9 : null;
    }
    j = el.start + el.size;
  }
  return null;
}

/**
 * The audio's length in seconds, read from the file itself for every accepted format (Ogg's
 * last granule position, WAV's data size, MP4's mvhd, FLAC's STREAMINFO, every MP3 or ADTS
 * frame, WebM's Duration), or null when it cannot be read. Used to refuse over-long pieces
 * before any model time is spent; a piece whose length is unknown is refused too.
 */
export function audioSeconds(buf, kind) {
  try {
    if (kind === "ogg") {
      const i = buf.lastIndexOf("OggS");
      if (i < 0 || i + 14 > buf.length) return null;
      const gran = Number(buf.readBigInt64LE(i + 6));
      // Opus granules count 48 kHz samples; the pre-skip is a few ms and ignored here
      const opus = buf.includes("OpusHead");
      const rate = opus ? 48000 : buf.includes("\x01vorbis") ? buf.readUInt32LE(buf.indexOf("\x01vorbis") + 12) : 0;
      return rate > 0 && gran > 0 ? gran / rate : null;
    }
    if (kind === "wav") {
      const byteRate = buf.readUInt32LE(28);
      const d = buf.indexOf("data", 12);
      if (!byteRate || d < 0) return null;
      return buf.readUInt32LE(d + 4) / byteRate;
    }
    if (kind === "mp4") {
      const i = buf.indexOf("mvhd");
      if (i < 0) return null;
      const v = buf[i + 4];
      const scale = v === 1 ? buf.readUInt32BE(i + 24) : buf.readUInt32BE(i + 16);
      const dur = v === 1 ? Number(buf.readBigUInt64BE(i + 28)) : buf.readUInt32BE(i + 20);
      return scale && dur ? dur / scale : null;
    }
    if (kind === "flac") {
      // STREAMINFO follows "fLaC" and a 4-byte block header: sample rate (20 bits) and total samples (36 bits)
      const rate = (buf[18] << 12) | (buf[19] << 4) | (buf[20] >> 4);
      const total = (buf[21] & 0x0f) * 2 ** 32 + buf.readUInt32BE(22);
      return rate && total ? total / rate : null;
    }
    if (kind === "mp3") return mp3Seconds(buf);
    if (kind === "aac") return adtsSeconds(buf);
    if (kind === "webm") return webmSeconds(buf);
  } catch {}
  return null;
}

/**
 * The whole check for a /transcribe body. Returns { ok: true, audio: { kind, mime, ext, sec } }
 * or { ok: false, reason }.
 */
export function checkAudio(buf, { maxSec = 180 } = {}) {
  const a = sniffAudio(buf);
  if (!a) return { ok: false, reason: "the body is not an audio file (Ogg, WebM, M4A, MP3, AAC, WAV or FLAC)" };
  if (hasVideoTrack(buf, a.kind)) return { ok: false, reason: "the file has a video track; send the audio only" };
  const sec = audioSeconds(buf, a.kind);
  if (sec == null) return { ok: false, reason: "the audio's length could not be read from the file" };
  if (sec > maxSec) return { ok: false, reason: `each piece must be at most ${maxSec} seconds of audio` };
  return { ok: true, audio: { ...a, sec } };
}

// ---------------------------------------------------------------- providers

/** Upstream answers are small JSON: a transcript of a 3-minute piece is well under 1 MB. */
const ANSWER_CAP = 2 << 20;

/** A non-2xx upstream answer as an error with .status, .transient and .retrySec. */
const upstreamError = (r) => Object.assign(new Error(`upstream ${r.status}`), { status: r.status, transient: r.status === 429 || r.status >= 500, retrySec: Number(r.headers?.get?.("retry-after")) || null });

/**
 * OpenAI-compatible /audio/transcriptions with word timestamps (Groq's whisper-large-v3 and
 * whisper-large-v3-turbo, and others that follow it). multipart: file, model,
 * response_format=verbose_json, timestamp_granularities[]=word and segment, language, temperature.
 */
export function openAiCompatibleAsr({ base, key, model, name = "openai-compatible", timeoutMs = 60000, fetchImpl = globalThis.fetch }) {
  const root = String(base).replace(/\/+$/, "");
  return {
    id: name,
    model,
    async transcribe({ buf, mime, ext, language = "en" }) {
      const form = new FormData();
      form.append("file", new Blob([buf], { type: mime }), `audio.${ext}`);
      form.append("model", model);
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      form.append("timestamp_granularities[]", "segment");
      if (language) form.append("language", language);
      form.append("temperature", "0");
      // the deadline covers the whole answer, body included, and the answer is size-capped
      const r = await providerRequest(`${root}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form }, { deadlineMs: timeoutMs, maxBytes: ANSWER_CAP, read: "json", fetchImpl });
      const j = r.json;
      if (!r.ok) throw upstreamError(r);
      const words = wordsFromVerbose(j);
      if (!words) throw Object.assign(new Error("no word times"), { status: 502 });
      return { words, duration: Number(j?.duration) || null, model };
    },
  };
}

/** Cloudflare Workers AI whisper (@cf/openai/whisper-large-v3-turbo): base64 audio in JSON, words per segment out. */
export function cloudflareAsr({ accountId, token, model = "@cf/openai/whisper-large-v3-turbo", timeoutMs = 60000, fetchImpl = globalThis.fetch, base = "https://api.cloudflare.com/client/v4" }) {
  return {
    id: "cloudflare",
    model,
    async transcribe({ buf, language = "en" }) {
      const body = model.endsWith("whisper-large-v3-turbo") ? { audio: buf.toString("base64"), language, task: "transcribe" } : { audio: [...buf] };
      const r = await providerRequest(`${base}/accounts/${accountId}/ai/run/${model}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }, { deadlineMs: timeoutMs, maxBytes: ANSWER_CAP, read: "json", fetchImpl });
      const j = r.json;
      if (!r.ok) throw upstreamError(r);
      if (j?.success === false) throw Object.assign(new Error("upstream refused"), { status: 502, transient: true });
      const res = j?.result || {};
      // the turbo model nests words in segments; the original whisper model lists them at the top
      const raw = res.words?.length ? res.words : (res.segments || []).flatMap((s) => s.words || []);
      const words = wordsFromVerbose({ text: res.text, segments: res.segments, words: raw });
      if (!words) throw Object.assign(new Error("no word times"), { status: 502 });
      const last = raw.length ? Number(raw[raw.length - 1].end) : null;
      return { words: cleanWords(words), duration: Number(res.transcription_info?.duration) || last, model };
    },
  };
}

/**
 * Several providers as one: the first answers, and on a quota, server or network failure
 * (429, 5xx, timeout) the next is tried. A refusal of the audio itself (4xx) is not retried.
 */
export function chainAsr(list) {
  const ps = list.filter(Boolean);
  if (ps.length <= 1) return ps[0] || null;
  return {
    id: ps.map((p) => p.id).join("+"),
    model: ps[0].model,
    // in order, moving on only for no answer, a timeout, 429 or 5xx (provider-request.mjs)
    transcribe: (args) => failover(ps, (p) => p.transcribe(args)),
  };
}

/**
 * The provider (or failover chain) from the environment, or null when Light mode is not set
 * up on this server. Chosen on 22 Oct 2026 (notes/MODELS.md, "Light mode"):
 *   GROQ_API_KEY                 primary: Groq, ASR_MODEL default whisper-large-v3
 *   CF_ACCOUNT_ID, CF_API_TOKEN  failover: Cloudflare Workers AI, CF_ASR_MODEL default
 *                                @cf/openai/whisper-large-v3-turbo
 *   ASR_BASE, ASR_API_KEY        any other OpenAI-compatible whisper (tried after those)
 *   ASR_PROVIDER                 groq, cloudflare or openai-compatible: use only that one
 */
export function asrFromEnv(env = process.env, fetchImpl = globalThis.fetch) {
  const timeoutMs = Number(env.ASR_TIMEOUT_MS || 60000);
  const groq = env.GROQ_API_KEY ? openAiCompatibleAsr({ name: "groq", base: "https://api.groq.com/openai/v1", key: env.GROQ_API_KEY, model: env.ASR_MODEL || "whisper-large-v3", timeoutMs, fetchImpl }) : null;
  const cf = env.CF_API_TOKEN && env.CF_ACCOUNT_ID ? cloudflareAsr({ accountId: env.CF_ACCOUNT_ID, token: env.CF_API_TOKEN, model: env.CF_ASR_MODEL || "@cf/openai/whisper-large-v3-turbo", timeoutMs, fetchImpl }) : null;
  const other = env.ASR_BASE && env.ASR_API_KEY ? openAiCompatibleAsr({ base: env.ASR_BASE, key: env.ASR_API_KEY, model: env.ASR_MODEL || "whisper-large-v3", timeoutMs, fetchImpl }) : null;
  const only = { groq, cloudflare: cf, "openai-compatible": other }[env.ASR_PROVIDER];
  if (env.ASR_PROVIDER) return only || null;
  return chainAsr([groq, cf, other]);
}
