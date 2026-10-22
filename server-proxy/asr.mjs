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

/**
 * The audio's length in seconds when the container says so cheaply (Ogg's last granule
 * position, WAV's data size, MP4's mvhd), else null. Used to refuse over-long chunks before
 * any model time is spent.
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
      return scale ? dur / scale : null;
    }
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
  if (sec != null && sec > maxSec) return { ok: false, reason: `each piece must be at most ${maxSec} seconds of audio` };
  return { ok: true, audio: { ...a, sec } };
}

// ---------------------------------------------------------------- providers

const withTimeout = async (fetchImpl, url, init, ms) => {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: ctl.signal });
  } catch (e) {
    throw Object.assign(new Error(ctl.signal.aborted ? "timeout" : "network"), { status: 0, transient: true });
  } finally {
    clearTimeout(t);
  }
};

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
      const r = await withTimeout(fetchImpl, `${root}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form }, timeoutMs);
      const j = await r.json().catch(() => null);
      if (!r.ok) throw Object.assign(new Error(`upstream ${r.status}`), { status: r.status, transient: r.status === 429 || r.status >= 500, retrySec: Number(r.headers.get("retry-after")) || null });
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
      const r = await withTimeout(fetchImpl, `${base}/accounts/${accountId}/ai/run/${model}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }, timeoutMs);
      const j = await r.json().catch(() => null);
      if (!r.ok || j?.success === false) throw Object.assign(new Error(`upstream ${r.status}`), { status: r.ok ? 502 : r.status, transient: r.status === 429 || r.status >= 500 });
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
    async transcribe(args) {
      let last;
      for (const p of ps) {
        try {
          return await p.transcribe(args);
        } catch (e) {
          last = e;
          if (!(e.status === 0 || e.status === 429 || e.status >= 500)) throw e;
        }
      }
      throw last;
    },
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
