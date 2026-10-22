// Light mode: compress 16 kHz mono speech on the device before it is sent, so a 4-minute
// talk costs about half a megabyte instead of the video's tens of megabytes. The video never
// leaves the device; only these audio pieces do.
//
// Codecs, best first (pickCodec): Opus at 16 kbps in Ogg (WebCodecs AudioEncoder; Chrome,
// Edge, Firefox), AAC at 24 kbps in M4A (Safari's WebCodecs), MP3 at 32 kbps with a WASM
// encoder (@mediabunny/mp3-encoder, loaded only when needed), and 16-bit WAV as the last
// resort (32 KB a second, so its pieces are kept short). Every format here is accepted by the
// hosted whisper APIs (Groq: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm).
import { AudioSample, AudioSampleSource, BufferTarget, Mp3OutputFormat, Mp4OutputFormat, OggOutputFormat, Output, WavOutputFormat, canEncodeAudio } from "mediabunny";

export const SPEECH_CODECS = [
  { codec: "opus", bitrate: 16000, format: "ogg", mime: "audio/ogg", ext: "ogg", rates: [16000, 48000] },
  { codec: "aac", bitrate: 24000, format: "mp4", mime: "audio/mp4", ext: "m4a", rates: [16000, 24000, 44100, 48000] },
  { codec: "mp3", bitrate: 32000, format: "mp3", mime: "audio/mpeg", ext: "mp3", rates: [16000], wasm: true },
  { codec: "pcm-s16", bitrate: 256000, format: "wav", mime: "audio/wav", ext: "wav", rates: [16000], maxSec: 40 },
];

/** The first codec this browser can encode: support is { opus: rate|false, aac: rate|false, mp3: rate|false }. */
export function pickCodec(support = {}) {
  for (const c of SPEECH_CODECS) {
    if (c.codec === "pcm-s16") return { ...c, rate: 16000 };
    if (support[c.codec]) return { ...c, rate: support[c.codec] };
  }
  return { ...SPEECH_CODECS[SPEECH_CODECS.length - 1], rate: 16000 };
}

/** The bytes a piece of `sec` seconds will take with this codec (for estimates and tests). */
export const estimateBytes = (codec, sec) => Math.round((codec.bitrate / 8) * sec * (codec.format === "wav" ? 1 : 1.03)) + (codec.format === "wav" ? 44 : 200);

let mp3Registered = null;
async function registerMp3() {
  mp3Registered ??= import("@mediabunny/mp3-encoder").then((m) => {
    m.registerMp3Encoder();
    return true;
  }).catch(() => false);
  return mp3Registered;
}

let chosen = null;
/** The codec for this browser, asked once: Opus, AAC, MP3 (WASM) or WAV. */
export function speechCodec() {
  chosen ??= (async () => {
    const support = {};
    for (const c of SPEECH_CODECS) {
      if (c.codec === "pcm-s16") break;
      if (c.wasm && !(await registerMp3())) continue;
      for (const rate of c.rates) {
        try {
          if (await canEncodeAudio(c.codec, { numberOfChannels: 1, sampleRate: rate, bitrate: c.bitrate })) {
            support[c.codec] = rate;
            break;
          }
        } catch {}
      }
      if (support[c.codec]) break;
    }
    return pickCodec(support);
  })();
  return chosen;
}

const FORMATS = { ogg: () => new OggOutputFormat(), mp4: () => new Mp4OutputFormat({ fastStart: "in-memory" }), mp3: () => new Mp3OutputFormat(), wav: () => new WavOutputFormat() };

/**
 * Encode one piece of mono Float32 PCM. Returns { blob, bytes, sec, codec, mime, ext }.
 * Input at `rate` (16 kHz in Selects) is resampled by mediabunny when the codec needs another
 * rate (Opus encoders often take only 48 kHz).
 */
export async function encodeSpeech(pcm, { rate = 16000, codec = null } = {}) {
  const c = codec || (await speechCodec());
  const target = new BufferTarget();
  const output = new Output({ format: FORMATS[c.format](), target });
  const src = new AudioSampleSource({ codec: c.codec, bitrate: c.bitrate, ...(c.rate && c.rate !== rate ? { transform: { sampleRate: c.rate, numberOfChannels: 1 } } : {}) });
  output.addAudioTrack(src);
  await output.start();
  // one second at a time keeps each encoder call small
  for (let i = 0; i < pcm.length; i += rate) {
    const part = pcm.subarray(i, Math.min(pcm.length, i + rate));
    const sample = new AudioSample({ data: part.slice(), format: "f32", numberOfChannels: 1, sampleRate: rate, timestamp: i / rate });
    await src.add(sample);
    sample.close();
  }
  await output.finalize();
  const buf = target.buffer;
  return { blob: new Blob([buf], { type: c.mime }), bytes: buf.byteLength, sec: pcm.length / rate, codec: c.codec, mime: c.mime, ext: c.ext };
}
