// The transcribe stage when a remote transcriber is chosen (Light mode). Called by the
// engine (engine.js) in place of its on-device whisper path, with the same progress,
// events, saved parts and job.asr fields, so every later stage is unchanged.
//
// When the shared free transcriber is busy (its free quota is used up, or it is not set up)
// or cannot be reached, nothing is paid for and nothing is downloaded behind the person's
// back: the words already back are kept, and
//   - if whisper is already saved in this browser, the rest is transcribed on the device;
//   - otherwise the job stops with an honest choice (error code "light_busy"): try again,
//     use your own free Groq key, or transcribe on this device (with the download size).
import { splitNonSpeech } from "../core/nonspeech.mjs";
import { decodeAudio16k, loudnessFromPcm } from "./media.js";
import { decodeAudioSegments } from "./pcm.js";
import { growingPcm } from "./speech-chunks.js";
import { dueForPicks, preliminaryPicks } from "./preliminary.js";
import { MODELS } from "./models.js";
import { deviceTranscriber } from "./transcribers.js";
import { speechModelCached } from "./light.js";
import { downloadAdvice, runtimes } from "./devices.js";

export const BUSY_LINE = "The free transcriber is busy right now. Use your own free key, or transcribe on this phone.";
export const OFF_LINE = "The free shared transcriber is not switched on yet. Use your own free key, or transcribe on this phone.";

const LONG_SEC = 20 * 60;

/**
 * Early picks from the transcript so far (preliminary.js), when they are due: set on
 * job.preliminary ({ upTo, picks }) and sent as a "preliminary" event (and the job). Never
 * fatal. pcm: the 16 kHz audio heard so far, for the loudness part of the score, or null.
 */
export function publishPicks(engine, r, upTo, pcm = null) {
  try {
    const job = r.job;
    upTo = Math.min(upTo, job.source.duration); // the last piece can end a few ms past the probed length
    if (!dueForPicks({ upTo, lastAt: r.picksAt ?? null, duration: job.source.duration })) return;
    r.picksAt = upTo;
    const heard = pcm ? pcm.subarray(0, Math.min(pcm.length, Math.floor(upTo * 16000))) : null;
    const picks = preliminaryPicks({ words: r.words, events: r.events, loudness: heard ? loudnessFromPcm(heard) : null, settings: job.settings, upTo });
    if (!picks.length) return;
    job.preliminary = { upTo: +upTo.toFixed(1), picks, at: new Date().toISOString() };
    engine.emit(job.id, "preliminary", structuredClone(job.preliminary));
    engine.emit(job.id, "job", structuredClone(job));
  } catch (e) {
    console.error(e);
  }
}

/** The stop when the free transcriber is busy and whisper is not saved here: the choices, with the download's real size. */
export async function lightBusy(e, { asrDevice = "auto" } = {}) {
  const dev = await runtimes({ asrDevice }).then((r) => r.asr).catch(() => "wasm");
  const a = downloadAdvice(MODELS.whisper.bytes[dev] || MODELS.whisper.bytes.wasm);
  const mb = Math.round(a.bytes / 1e6);
  // 503: the server has no key for the free transcriber (not switched on), not a busy quota
  return Object.assign(new Error(e?.status === 503 ? OFF_LINE : BUSY_LINE), {
    code: "light_busy",
    hint: `${e?.hint || e?.message || "The free transcriber did not answer."} Nothing was downloaded, and nothing is charged.`,
    choices: [
      { id: "retry", label: "Try the free transcriber again" },
      { id: "key", label: "Use your own free Groq key", detail: "Make a free key at console.groq.com (no card needed). It stays in this tab and goes only to Groq.", needsKey: true },
      { id: "device", label: `Transcribe on this device (${mb} MB once)`, detail: "Downloads the speech model once and keeps it in this browser. Nothing is uploaded.", bytes: a.bytes, estSec: a.estSec, mbps: a.mbps, metered: a.metered, warning: a.warning },
    ],
  });
}

/**
 * Transcribe r.file with `transcriber` (remote). progress/finish are the engine's stage
 * helpers; choice is the person's answer to a "light_busy" stop ("device" or null).
 */
export async function transcribeLight(engine, r, transcriber, { progress, finish, sig, choice = null }) {
  const job = r.job;
  const dur = job.source.duration;
  const id = job.id;
  // the browser-only pieces, replaceable in tests (engine.lightHooks)
  const hooks = { decode: decodeAudio16k, decodeSegments: decodeAudioSegments, device: deviceTranscriber, cached: speechModelCached, ...(engine.lightHooks || {}) };
  r.words = [];
  r.events = [];
  r.picksAt = null; // early picks start again with this transcript
  job.preliminary = null;
  const t0 = performance.now();
  const take = (words) => {
    const split = splitNonSpeech(words);
    r.words.push(...split.words);
    r.events.push(...split.events);
    if (split.words.length) engine.emit(id, "words", split.words);
  };
  const device = () => hooks.device({ device: job.settings.asrDevice || "auto", model: MODELS.whisper.id });
  let used = choice === "device" ? device() : transcriber;
  let note = null;
  let fellBack = false;

  progress("transcribe", { progress: 0, note: "reading the audio" });
  const long = dur > LONG_SEC;
  const decodeT = performance.now();
  let decodeSec = null;
  // short videos: the audio is decoded in 15 s blocks into a growing buffer, and the remote
  // transcriber cuts and sends pieces from it while the rest is still being read
  let audio = null;
  let decoding = null;
  if (!long) {
    audio = growingPcm(Math.ceil(dur * 16000));
    decoding = hooks
      .decode(r.file, { duration: dur, blockSec: 15, keep: false, onBlock: (b) => audio.append(b), onProgress: (p) => !r.words.length && progress("transcribe", { progress: p * 0.05, note: "reading the audio" }) })
      .then((pcm) => {
        if (pcm && !audio.length) audio.append(pcm); // a decoder that returns everything at once
        decodeSec = +((performance.now() - decodeT) / 1000).toFixed(1);
        audio.finish();
      }, (e) => {
        audio.finish();
        throw e;
      });
    decoding.catch(() => {}); // awaited below; never an unhandled rejection meanwhile
  }

  const prepare = async (t) => {
    if (t.where === "remote") {
      await t.prepare({ onWaking: (s) => s >= 2 && progress("transcribe", { progress: 0.05, note: "Getting ready..." }) });
    } else {
      const files = {};
      await t.prepare({
        onProgress: (m) => {
          if (m.total) files[m.file] = { loaded: m.loaded, total: m.total };
          const loaded = Object.values(files).reduce((a, f) => a + f.loaded, 0);
          const total = Object.values(files).reduce((a, f) => a + f.total, 0);
          progress("transcribe", { progress: 0.05, note: `getting the speech model: ${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB`, download: { loaded, total } });
        },
      });
    }
  };
  // a remote failure: carry on on the device when whisper is already here, otherwise stop and ask
  const fallBack = async (e) => {
    if (used.where !== "remote" || e?.name === "AbortError") throw e;
    if (e?.badKey) throw Object.assign(new Error(e.message), { hint: e.hint });
    if (choice !== "device" && (await hooks.cached(MODELS.whisper.id)) !== true) throw await lightBusy(e, { asrDevice: job.settings.asrDevice });
    used = device();
    fellBack = true;
    note = "The free transcriber was busy, so the rest was transcribed on this device with the speech model already in this browser.";
    progress("transcribe", { progress: 0.05, note: "the free transcriber is busy, so carrying on on this device" });
    await prepare(used);
  };

  // pcm null: the growing audio (short videos). The device needs all of it, so it waits for the decode
  const run = async (pcm, base, total) => {
    let from = 0;
    for (;;) {
      try {
        const progressive = !pcm && used.where === "remote" && from === 0;
        if (!pcm && !progressive) await decoding;
        const res = await used.transcribe(progressive ? null : pcm || audio.pcm, {
          ...(progressive ? { audio } : {}),
          from,
          onChunk: (m) => {
            take(m.words.map((w) => ({ ...w, s: +(w.s + base).toFixed(3), e: +(w.e + base).toFixed(3) })));
            const heard = base + m.processed;
            publishPicks(engine, r, heard, audio ? audio.pcm : null);
            const wall = (performance.now() - t0) / 1000;
            const speed = heard / Math.max(0.1, wall);
            const where = used.where === "remote" ? `sent ${(m.bytes / 1e6).toFixed(2)} MB of audio` : "transcribing on this device";
            progress("transcribe", { progress: 0.06 + 0.94 * Math.min(1, heard / total), speed, etaSec: Math.round((total - heard) / Math.max(0.1, speed)), note: `${where}, ${Math.round(heard)} of ${Math.round(total)} s` });
          },
        });
        return res;
      } catch (e) {
        await fallBack(e);
        from = e.doneSec != null ? e.doneSec : from;
      }
    }
  };

  try {
    await prepare(used);
  } catch (e) {
    await fallBack(e);
  }
  let bytes = 0;
  let pieces = 0;
  let codec = null;
  if (!long) {
    const res = await run(null, 0, dur);
    await decoding; // a decode error surfaces here
    r.pcm = audio.pcm.slice(); // its own buffer: a view would save the spare capacity too
    bytes = res.bytes || 0;
    pieces = res.pieces || 0;
    codec = res.codec || null;
    job.loudness = loudnessFromPcm(r.pcm);
  } else {
    // long videos: 10-minute segments kept in OPFS, as the device path does
    const segs = [];
    const db = [];
    for await (const seg of hooks.decodeSegments(r.file, { duration: dur })) {
      await engine.pcm.put(r.key, seg.index, seg.pcm);
      const res = await run(seg.pcm, seg.start, dur);
      bytes += res.bytes || 0;
      pieces += res.pieces || 0;
      codec ||= res.codec || null;
      db.push(...loudnessFromPcm(seg.pcm).db);
      segs.push({ index: seg.index, start: seg.start, end: seg.end });
    }
    r.pcm = null;
    r.pcmSegs = segs;
    job.loudness = { step: 0.5, db };
  }
  const wallSec = (performance.now() - t0) / 1000;
  job.asr = {
    provider: fellBack ? `${transcriber.id}, then device` : used.id,
    model: used.where === "remote" ? transcriber.model : MODELS.whisper.id,
    where: fellBack ? "remote+device" : used.where,
    language: "en",
    decodeSec,
    sec: +wallSec.toFixed(1),
    speed: +(dur / Math.max(0.1, wallSec)).toFixed(2),
    sentBytes: bytes,
    pieces,
    codec,
    ...(note ? { note } : {}),
  };
  job.language = await engine.languageNote(r.words);
  const sentMb = bytes ? `, ${(bytes / 1e6).toFixed(2)} MB of audio sent` : "";
  finish("transcribe", `${r.words.length} words in ${Math.round(wallSec)} s${sentMb}`);
  await engine.save(r, "transcribe", { words: r.words, events: r.events, loudness: job.loudness, ...(r.pcm ? { pcm: r.pcm } : { pcmSegs: r.pcmSegs }) }, { transcribe: fellBack ? null : sig });
}
