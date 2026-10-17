// Speech to words with whisper.cpp, streaming words and progress while it runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { whisperBin, whisperModel } from "./config.mjs";
import { splitNonSpeech } from "./nonspeech.mjs";
import { readJson, run, writeJsonAtomic } from "./util.mjs";

const SEG_RE = /^\[(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)\](?: {2})?(.*)$/; // whisper prints "]  " then the token text
const toSec = (h, m, s, ms) => +h * 3600 + +m * 60 + +s + +ms / 1000;


/**
 * Turn whisper's one-token-ish segments into words. A segment that does not start with a
 * space and starts with punctuation or an apostrophe is glued to the previous word
 * ("don" + "'t", "end" + ".").
 * Whisper's non-speech notes ([BLANK_AUDIO], (laughs), a split-up "(speaking in foreign
 * language)") are dropped; their spans stay as gaps and ride along as a non-enumerable
 * `events` property ([{ type, s, e }], see nonspeech.mjs).
 * @param {{text:string,from:number,to:number,p?:number}[]} segs times in seconds
 */
export function segmentsToWords(segs) {
  const glued = [];
  for (const seg of segs) {
    const raw = seg.text ?? "";
    const text = raw.trim();
    if (!text) continue;
    const prev = glued[glued.length - 1];
    const glue = prev && !/^\s/.test(raw) && /^([^\w\s]|'|n't)/i.test(text) && seg.from - prev.e < 1;
    if (glue) {
      prev.w += text;
      prev.e = Math.max(prev.e, seg.to);
    } else {
      glued.push({ w: text, s: seg.from, e: seg.to, p: seg.p ?? 1 });
    }
  }
  const { words, events } = splitNonSpeech(glued);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // zero-length words happen; give them a little time without overlapping the next word
    if (w.e - w.s < 0.05) w.e = Math.min(w.s + 0.12, words[i + 1]?.s ?? w.s + 0.12);
    w.s = +w.s.toFixed(3);
    w.e = +w.e.toFixed(3);
    w.p = +(+w.p).toFixed(2);
  }
  Object.defineProperty(words, "events", { value: events.map((e) => ({ ...e, s: +e.s.toFixed(3), e: +e.e.toFixed(3) })), enumerable: false });
  return words;
}

/** Parse whisper's -ojf JSON into words (with per-word probability). */
export function wordsFromWhisperJson(json) {
  const segs = (json.transcription || []).map((t) => {
    const toks = (t.tokens || []).filter((k) => !/^\[_/.test(k.text || ""));
    const p = toks.length ? toks.reduce((a, k) => a + (k.p ?? 1), 0) / toks.length : 1;
    return { text: t.text, from: t.offsets.from / 1000, to: t.offsets.to / 1000, p };
  });
  return segmentsToWords(segs);
}

/** Parse whisper stdout lines ("[00:00:01.230 --> 00:00:01.560]  word") into segments. */
export function parseSegmentLines(chunk) {
  const out = [];
  for (const line of chunk.split("\n")) {
    const m = line.match(SEG_RE);
    if (!m) continue;
    out.push({ from: toSec(m[1], m[2], m[3], m[4]), to: toSec(m[5], m[6], m[7], m[8]), text: m[9] });
  }
  return out;
}

/** Audio clean-up before whisper. "clean": rumble and hiss cut, loudness evened out. */
export const AUDIO_FILTERS = {
  none: null,
  clean: "highpass=f=80,lowpass=f=7600,loudnorm=I=-18:TP=-2:LRA=11",
};

/**
 * Extract 16 kHz mono WAV for whisper. ranges: optional [{ start, dur }] to cut and join
 * samples (with half a second of silence after each), for cheap language checks.
 */
export async function extractAudio(input, wav, { stream = null, preprocess = "none", ranges = null, signal } = {}) {
  const map = stream != null ? `0:${stream}` : "0:a:0";
  const af = AUDIO_FILTERS[preprocess] ?? null;
  let args;
  if (ranges?.length) {
    const ins = ranges.flatMap((r) => ["-ss", String(r.start), "-t", String(r.dur), "-i", input]);
    const m = stream != null ? (i) => `[${i}:${stream}]` : (i) => `[${i}:a:0]`;
    const parts = ranges.map((_, i) => `${m(i)}aresample=16000,aformat=channel_layouts=mono,apad=pad_dur=0.5[a${i}]`);
    const fc = `${parts.join(";")};${ranges.map((_, i) => `[a${i}]`).join("")}concat=n=${ranges.length}:v=0:a=1${af ? `,${af}` : ""}[out]`;
    args = ["-v", "error", "-y", ...ins, "-filter_complex", fc, "-map", "[out]", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav];
  } else {
    args = ["-v", "error", "-y", "-i", input, "-map", map, "-vn", ...(af ? ["-af", af] : []), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav];
  }
  try {
    await run("ffmpeg", args, { signal });
  } catch (e) {
    fs.rmSync(wav, { force: true });
    const err = new Error(`Could not extract audio: ${e.message}`);
    err.hint = "Check that the file plays and that there is free disk space (about 2 MB per minute of video).";
    throw err;
  }
  return wav;
}

const defaultThreads = () => Number(process.env.SELECTS_WHISPER_THREADS) || Math.max(1, Math.min(8, Math.floor(os.cpus().length / 2)));

/** Whisper's own language guess on the first 30 s of a WAV: { code, p } or null. Needs a multilingual model. */
export async function detectLanguage(wav, { model, bin, threads, signal } = {}) {
  const r = await run(bin || whisperBin(), ["-m", model, "-f", wav, "-l", "auto", "-dl", "-t", String(threads || defaultThreads())], { signal, allowFail: true });
  const m = `${r.stderr}\n${r.stdout}`.match(/auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([\d.]+)\)/i);
  return m ? { code: m[1], p: +(+m[2]).toFixed(3) } : null;
}

/**
 * Run whisper-cli on a WAV and return the parsed JSON (and the path it wrote).
 * Greedy decoding (-bs 1 -bo 1): measured 1.57x real time against 14.8x for the default
 * beam search on this machine, with nearly identical text.
 */
export async function runWhisper(wav, { outBase, model, bin, language = "en", prompt = null, translate = false, threads, signal, onStdout, onStderr, extraArgs = [] } = {}) {
  const args = ["-m", model, "-f", wav, "-l", language, "-t", String(threads || defaultThreads()), "-bs", "1", "-bo", "1", "-ml", "1", "-sow", "-ojf", "-of", outBase, "-pp"];
  if (prompt) args.push("--prompt", prompt);
  if (translate) args.push("-tr");
  args.push(...extraArgs);
  if (process.env.SELECTS_WHISPER_ARGS) args.push(...process.env.SELECTS_WHISPER_ARGS.split(/\s+/).filter(Boolean));
  await run(bin || whisperBin(), args, { signal, keepOutput: false, onStdout, onStderr });
  return readJson(`${outBase}.json`);
}

// Long videos are transcribed in chunks of about CHUNK_SEC (cut at a quiet moment), and each
// finished chunk is kept on disk, so a crash, a kill or a sleep 90 minutes into a 2-hour
// talk loses one chunk at most, not the whole transcription.
export const CHUNK_SEC = 600;
const chunkSec = () => Number(process.env.SELECTS_CHUNK_SEC) || CHUNK_SEC;

/**
 * Where to cut a long recording for whisper: about every `chunkSec` seconds, at the quietest
 * moment `quietest(t0, t1)` finds within `search` seconds of each cut. Recordings up to 1.5
 * chunks long stay whole. Pure.
 * @returns {{start:number, end:number}[]}
 */
export function planChunks(duration, { chunkSec: len = chunkSec(), quietest = null, search = 15 } = {}) {
  if (!(duration > 0) || duration <= len * 1.5) return [{ start: 0, end: duration > 0 ? duration : null }];
  const n = Math.round(duration / len);
  const cuts = [0];
  for (let i = 1; i < n; i++) {
    const t = (i * duration) / n;
    const q = quietest ? quietest(Math.max(cuts[cuts.length - 1] + 1, t - search), Math.min(duration - 1, t + search)) : t;
    cuts.push(+(Number.isFinite(q) ? q : t).toFixed(2));
  }
  cuts.push(duration);
  return cuts.slice(0, -1).map((start, i) => ({ start, end: cuts[i + 1] }));
}

/** Where the samples start in a 16-bit PCM WAV, and its rate. */
export function wavInfo(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(44);
    fs.readSync(fd, head, 0, 44, 0);
    const rate = head.readUInt32LE(24) || 16000;
    let off = 12;
    let dataStart = 44;
    const hdr = Buffer.alloc(8);
    for (let i = 0; i < 16; i++) {
      if (fs.readSync(fd, hdr, 0, 8, off) < 8) break;
      if (hdr.toString("ascii", 0, 4) === "data") {
        dataStart = off + 8;
        break;
      }
      const size = hdr.readUInt32LE(4);
      off += 8 + size + (size % 2);
    }
    const bytes = fs.fstatSync(fd).size - dataStart;
    return { rate, dataStart, seconds: bytes / 2 / rate };
  } finally {
    fs.closeSync(fd);
  }
}

/** The start of the quietest `step`-second stretch between t0 and t1 of a 16-bit mono WAV. */
export function quietestIn(file, info, t0, t1, { step = 0.2 } = {}) {
  const per = Math.max(1, Math.round(info.rate * step));
  const first = Math.max(0, Math.floor(t0 * info.rate));
  const last = Math.max(first, Math.floor(t1 * info.rate));
  const buf = Buffer.alloc((last - first + per) * 2);
  const fd = fs.openSync(file, "r");
  let n;
  try {
    n = fs.readSync(fd, buf, 0, buf.length, info.dataStart + first * 2);
  } finally {
    fs.closeSync(fd);
  }
  let best = t0;
  let bestE = Infinity;
  for (let i = 0; (i + per) * 2 <= n; i += per) {
    let e = 0;
    for (let k = i; k < i + per; k++) {
      const v = buf.readInt16LE(k * 2);
      e += v * v;
    }
    if (e < bestE) {
      bestE = e;
      best = (first + i + per / 2) / info.rate;
    }
  }
  return best;
}

/** Copy start..end seconds of a 16-bit mono WAV into a new WAV. */
export function writeWavSlice(file, info, start, end, out) {
  const a = Math.max(0, Math.round(start * info.rate));
  const b = Math.max(a, Math.round((end ?? info.seconds) * info.rate));
  const data = Buffer.alloc((b - a) * 2);
  const fd = fs.openSync(file, "r");
  let n;
  try {
    n = fs.readSync(fd, data, 0, data.length, info.dataStart + a * 2);
  } finally {
    fs.closeSync(fd);
  }
  const body = data.subarray(0, n - (n % 2));
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + body.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(info.rate, 24);
  head.writeUInt32LE(info.rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(body.length, 40);
  fs.writeFileSync(out, Buffer.concat([head, body]));
  return out;
}

/** Join whisper's -ojf JSON for each chunk into one, moving each chunk's times by its start. */
export function mergeWhisperJson(parts) {
  const out = { ...(parts[0]?.json || {}), transcription: [] };
  for (const { json, start } of parts) {
    const ms = Math.round(start * 1000);
    for (const t of json?.transcription || []) {
      const shift = (o) => (o ? { ...o, from: o.from + ms, to: o.to + ms } : o);
      out.transcription.push({ ...t, offsets: shift(t.offsets), tokens: (t.tokens || []).map((k) => ({ ...k, ...(k.offsets ? { offsets: shift(k.offsets) } : {}) })) });
    }
  }
  return out;
}

/**
 * Transcribe a video to words.
 * Long recordings go through whisper in chunks of about 10 minutes (SELECTS_CHUNK_SEC), and
 * each finished chunk is saved in <cacheDir>/whisper-chunks, so a resumed job only redoes
 * the chunk it was in when it stopped.
 * @param {string} videoPath
 * @param {object} opts
 * @param {string} opts.cacheDir where audio.wav (temporary) and whisper.json go
 * @param {number} [opts.duration] seconds, for progress and ETA
 * @param {string} [opts.language] ISO code passed to whisper (default "en")
 * @param {string} [opts.model] path to a ggml model (default SELECTS_WHISPER_MODEL)
 * @param {string} [opts.prompt] a short context passed as --prompt
 * @param {"none"|"clean"} [opts.preprocess] audio clean-up before whisper
 * @param {number} [opts.audioStream] which audio stream (index) to use
 * @param {(p:{progress:number,speed:number|null,etaSec:number|null,note:string,processed:number})=>void} [opts.onProgress]
 * @param {(words:object[])=>void} [opts.onWords] newly transcribed words, as they stream
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{w,s,e,p}[]>}
 */
export async function transcribe(videoPath, { cacheDir, duration, onProgress, onWords, signal, threads, model, bin, language = "en", prompt = null, translate = false, preprocess = "none", audioStream = null, extract = extractAudio } = {}) {
  if (!cacheDir) throw new Error("transcribe needs a cacheDir");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outBase = path.join(cacheDir, "whisper");
  const jsonFile = `${outBase}.json`;
  const metaFile = `${outBase}.meta.json`;
  const chunkDir = path.join(cacheDir, "whisper-chunks");
  const planFile = path.join(chunkDir, "plan.json");
  const whisper = bin || whisperBin();
  const modelPath = model || whisperModel();
  const meta = { model: path.basename(modelPath), language, prompt: prompt || null, translate: !!translate, preprocess };
  const prevMeta = readJson(metaFile, null);
  const sameRun = !prevMeta || JSON.stringify(prevMeta) === JSON.stringify(meta);
  if (fs.existsSync(jsonFile) && sameRun) {
    // a previous run finished whisper with the same settings; reuse it rather than spend minutes again
    const words = wordsFromWhisperJson(readJson(jsonFile));
    onWords?.(words);
    onProgress?.({ progress: 1, speed: null, etaSec: 0, note: "reused the saved transcript", processed: duration ?? 0 });
    return words;
  }
  fs.rmSync(jsonFile, { force: true });
  if (!fs.existsSync(modelPath)) {
    const err = new Error(`The whisper model is missing at ${modelPath}.`);
    err.hint = "Download it from huggingface.co/ggerganov/whisper.cpp into the models folder, or set SELECTS_WHISPER_MODEL to its path.";
    throw err;
  }
  if (/\.en(-q\d_\d)?\.bin$/.test(modelPath) && language !== "en") {
    const err = new Error(`${path.basename(modelPath)} only knows English, but the language is set to "${language}".`);
    err.hint = "Use a multilingual model (--asr-model small) or set --language en.";
    throw err;
  }

  // chunks finished by an earlier run with the same settings are kept; anything else starts over
  const oldPlan = readJson(planFile, null);
  const resumable = oldPlan && JSON.stringify(oldPlan.meta) === JSON.stringify(meta) && oldPlan.audioStream === audioStream;
  if (!resumable) fs.rmSync(chunkDir, { recursive: true, force: true });
  fs.mkdirSync(chunkDir, { recursive: true });

  // the WAV is written under another name and renamed when complete, so a kill mid-extraction
  // never leaves a short WAV that looks finished
  const wav = path.join(cacheDir, "audio.wav");
  const wavPart = path.join(cacheDir, "audio.part.wav");
  if (!(resumable && fs.existsSync(wav))) {
    fs.rmSync(wav, { force: true });
    await extract(videoPath, wavPart, { stream: audioStream, preprocess, signal });
    fs.renameSync(wavPart, wav);
  }
  const info = wavInfo(wav);
  const total = duration || info.seconds;
  const chunks = resumable && oldPlan.chunks?.length ? oldPlan.chunks : planChunks(total, { quietest: (a, b) => quietestIn(wav, info, a, b) });
  if (!resumable) writeJsonAtomic(planFile, { meta, audioStream, duration: total, chunkSec: chunkSec(), chunks });
  const chunkJson = (i) => path.join(chunkDir, `${String(i).padStart(3, "0")}.json`);

  // Physical cores, not hyperthreads: on a dual-core laptop -t 2 beat -t 4 when measured.
  const nThreads = threads || defaultThreads();

  const t0 = Date.now();
  const parts = [];
  let reusedSec = 0;
  for (let i = 0; i < chunks.length; i++) {
    const json = readJson(chunkJson(i), null);
    if (!json) break;
    parts.push({ json, start: chunks[i].start });
    reusedSec += (chunks[i].end ?? total) - chunks[i].start;
  }
  const reusedChunks = parts.length;
  if (parts.length) onWords?.(wordsFromWhisperJson(mergeWhisperJson(parts)));
  let processed = reusedSec;
  let pct = 0; // whisper's own percentage for the current chunk
  let cur = null;
  let pending = "";
  let liveSegs = [];
  let emitted = 0;
  const report = () => {
    const wall = (Date.now() - t0) / 1000;
    const chunkDone = cur ? cur.start + pct * ((cur.end ?? total) - cur.start) : processed;
    const audioDone = Math.min(total, Math.max(processed, chunkDone));
    const fresh = audioDone - reusedSec; // audio transcribed by this run, for an honest speed
    const speed = wall > 3 && fresh > 0 ? fresh / wall : null;
    const etaSec = speed && total ? Math.max(0, (total - audioDone) / speed) : null;
    const of = chunks.length > 1 ? `, part ${Math.min(chunks.length, parts.length + 1)} of ${chunks.length}` : "";
    const note = speed ? `transcribing at ${speed.toFixed(2)}x real time${of}` : `transcribing${of}`;
    onProgress?.({ progress: Math.min(0.999, total ? audioDone / total : pct), speed, etaSec: etaSec == null ? null : Math.round(etaSec), note, processed: audioDone });
  };
  const flushWords = () => {
    // hold back the last segment: the next one may glue onto it
    const words = segmentsToWords(liveSegs);
    const ready = words.slice(emitted, Math.max(emitted, words.length - 1));
    if (ready.length) {
      emitted += ready.length;
      onWords?.(ready);
    }
  };
  try {
    for (let i = parts.length; i < chunks.length; i++) {
      if (signal?.aborted) throw signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" });
      cur = chunks[i];
      pct = 0;
      liveSegs = [];
      emitted = 0;
      pending = "";
      const whole = chunks.length === 1;
      const input = whole ? wav : writeWavSlice(wav, info, cur.start, cur.end, path.join(chunkDir, `${String(i).padStart(3, "0")}.wav`));
      const base = path.join(chunkDir, `${String(i).padStart(3, "0")}.part`);
      const off = cur.start;
      try {
        const json = await runWhisper(input, {
          outBase: base,
          model: modelPath,
          bin: whisper,
          language,
          prompt,
          translate,
          threads: nThreads,
          signal,
          onStdout: (chunk) => {
            pending += chunk;
            const nl = pending.lastIndexOf("\n");
            if (nl < 0) return;
            const segs = parseSegmentLines(pending.slice(0, nl)).map((s) => ({ ...s, from: s.from + off, to: s.to + off }));
            pending = pending.slice(nl + 1);
            if (segs.length) {
              liveSegs = liveSegs.concat(segs);
              processed = Math.max(processed, segs[segs.length - 1].to);
              flushWords();
              report();
            }
          },
          onStderr: (chunk) => {
            const m = chunk.match(/progress\s*=\s*(\d+)%/g);
            if (m) {
              pct = Math.max(pct, +m[m.length - 1].match(/(\d+)%/)[1] / 100);
              report();
            }
          },
        });
        // the chunk is kept only once whisper has finished it
        writeJsonAtomic(chunkJson(i), json);
        fs.rmSync(`${base}.json`, { force: true });
        parts.push({ json, start: cur.start });
        // send what the live stream held back
        const words = wordsFromWhisperJson(mergeWhisperJson([{ json, start: cur.start }]));
        if (words.length > emitted) onWords?.(words.slice(emitted));
        processed = cur.end ?? total;
        cur = null;
        report();
      } finally {
        if (!whole) fs.rmSync(input, { force: true });
      }
    }
  } catch (e) {
    if (e.name === "AbortError") throw e;
    const err = new Error(e.code === "ENOENT" ? `whisper-cli was not found at ${whisper}.` : `whisper stopped: ${e.message}`);
    err.hint =
      e.code === "ENOENT"
        ? "Build whisper.cpp (cmake -B build && cmake --build build) and set SELECTS_WHISPER_BIN to build/bin/whisper-cli."
        : `Check free disk space and memory, then resume the job. ${parts.length ? `The ${parts.length} part${parts.length === 1 ? "" : "s"} already transcribed are kept.` : "Your progress up to this stage is saved."}`;
    throw err;
  }
  const merged = mergeWhisperJson(parts);
  writeJsonAtomic(jsonFile, merged);
  // a loudness track (one value per 0.5 s) feeds the cheap pre-score; then the WAV and the chunks go
  try {
    writeJsonAtomic(path.join(cacheDir, "loudness.json"), loudnessFromWav(wav));
  } catch {}
  writeJsonAtomic(metaFile, meta);
  fs.rmSync(wav, { force: true });
  fs.rmSync(chunkDir, { recursive: true, force: true });
  const words = wordsFromWhisperJson(merged);
  const wall = (Date.now() - t0) / 1000;
  const speed = total ? (total - reusedSec) / wall : null;
  onProgress?.({ progress: 1, speed, etaSec: 0, note: speed ? `transcribed at ${speed.toFixed(2)}x real time` : "transcribed", processed: total ?? 0, wallSec: +wall.toFixed(1), chunks: chunks.length, reusedChunks });
  return words;
}

/**
 * Loudness in dBFS for each `step` seconds of a 16-bit mono WAV, read in blocks so a long
 * talk never sits in memory at once. Returns { step, db: number[] }.
 */
export function loudnessFromWav(file, { step = 0.5 } = {}) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(44);
    fs.readSync(fd, head, 0, 44, 0);
    const rate = head.readUInt32LE(24) || 16000;
    // find the "data" chunk (ffmpeg may write a LIST chunk first)
    let off = 12;
    let dataStart = 44;
    const hdr = Buffer.alloc(8);
    for (let i = 0; i < 16; i++) {
      if (fs.readSync(fd, hdr, 0, 8, off) < 8) break;
      const id = hdr.toString("ascii", 0, 4);
      const size = hdr.readUInt32LE(4);
      if (id === "data") {
        dataStart = off + 8;
        break;
      }
      off += 8 + size + (size % 2);
    }
    const per = Math.round(rate * step);
    const buf = Buffer.alloc(per * 2);
    const db = [];
    let pos = dataStart;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n < 2) break;
      pos += n;
      let sum = 0;
      const count = Math.floor(n / 2);
      for (let i = 0; i < count; i++) {
        const v = buf.readInt16LE(i * 2) / 32768;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / count);
      db.push(+(20 * Math.log10(rms + 1e-9)).toFixed(1));
      if (n < buf.length) break;
    }
    return { step, db };
  } finally {
    fs.closeSync(fd);
  }
}
