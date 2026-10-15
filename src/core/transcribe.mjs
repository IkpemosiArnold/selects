// Speech to words with whisper.cpp, streaming words and progress while it runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { whisperBin, whisperModel } from "./config.mjs";
import { readJson, run } from "./util.mjs";

const SEG_RE = /^\[(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)\](?: {2})?(.*)$/; // whisper prints "]  " then the token text
const toSec = (h, m, s, ms) => +h * 3600 + +m * 60 + +s + +ms / 1000;

// Non-speech markers whisper emits, like [BLANK_AUDIO], (laughs), [Music], * applause *
const NON_SPEECH = /^\s*[[(*♪].*[\])*♪]\s*$/;

/**
 * Turn whisper's one-token-ish segments into words. A segment that does not start with a
 * space and starts with punctuation or an apostrophe is glued to the previous word
 * ("don" + "'t", "end" + ".").
 * @param {{text:string,from:number,to:number,p?:number}[]} segs times in seconds
 */
export function segmentsToWords(segs) {
  const words = [];
  for (const seg of segs) {
    const raw = seg.text ?? "";
    const text = raw.trim();
    if (!text || NON_SPEECH.test(text)) continue;
    const prev = words[words.length - 1];
    const glue = prev && !/^\s/.test(raw) && /^([^\w\s]|'|n't)/i.test(text) && seg.from - prev.e < 1;
    if (glue) {
      prev.w += text;
      prev.e = Math.max(prev.e, seg.to);
    } else {
      words.push({ w: text, s: seg.from, e: seg.to, p: seg.p ?? 1 });
    }
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // zero-length words happen; give them a little time without overlapping the next word
    if (w.e - w.s < 0.05) w.e = Math.min(w.s + 0.12, words[i + 1]?.s ?? w.s + 0.12);
    w.s = +w.s.toFixed(3);
    w.e = +w.e.toFixed(3);
    w.p = +(+w.p).toFixed(2);
  }
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

/**
 * Transcribe a video to words.
 * @param {string} videoPath
 * @param {object} opts
 * @param {string} opts.cacheDir where audio.wav (temporary) and whisper.json go
 * @param {number} [opts.duration] seconds, for progress and ETA
 * @param {(p:{progress:number,speed:number|null,etaSec:number|null,note:string,processed:number})=>void} [opts.onProgress]
 * @param {(words:object[])=>void} [opts.onWords] newly transcribed words, as they stream
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{w,s,e,p}[]>}
 */
export async function transcribe(videoPath, { cacheDir, duration, onProgress, onWords, signal, threads, model, bin } = {}) {
  if (!cacheDir) throw new Error("transcribe needs a cacheDir");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outBase = path.join(cacheDir, "whisper");
  const jsonFile = `${outBase}.json`;
  if (fs.existsSync(jsonFile)) {
    // a previous run finished whisper; reuse it rather than spend minutes again
    const words = wordsFromWhisperJson(readJson(jsonFile));
    onWords?.(words);
    onProgress?.({ progress: 1, speed: null, etaSec: 0, note: "reused the saved transcript", processed: duration ?? 0 });
    return words;
  }
  const whisper = bin || whisperBin();
  const modelPath = model || whisperModel();
  if (!fs.existsSync(modelPath)) {
    const err = new Error(`The whisper model is missing at ${modelPath}.`);
    err.hint = "Download ggml-base.en.bin from huggingface.co/ggerganov/whisper.cpp and set SELECTS_WHISPER_MODEL to its path.";
    throw err;
  }

  const wav = path.join(cacheDir, "audio.wav");
  try {
    await run("ffmpeg", ["-v", "error", "-y", "-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], { signal });
  } catch (e) {
    fs.rmSync(wav, { force: true });
    const err = new Error(`Could not extract audio: ${e.message}`);
    err.hint = "Check that the file plays and that there is free disk space (about 2 MB per minute of video).";
    throw err;
  }

  const nThreads = threads || Math.max(1, Math.min(8, os.cpus().length));
  const args = ["-m", modelPath, "-f", wav, "-l", "en", "-t", String(nThreads), "-ml", "1", "-sow", "-ojf", "-of", outBase, "-pp"];
  if (process.env.SELECTS_WHISPER_ARGS) args.push(...process.env.SELECTS_WHISPER_ARGS.split(/\s+/).filter(Boolean));

  const t0 = Date.now();
  let processed = 0;
  let pct = 0;
  let pending = "";
  let liveSegs = [];
  let emitted = 0;
  const report = () => {
    const wall = (Date.now() - t0) / 1000;
    const done = duration ? Math.max(processed / duration, pct) : pct;
    const audioDone = duration ? done * duration : processed;
    const speed = wall > 3 && audioDone > 0 ? audioDone / wall : null;
    const etaSec = speed && duration ? Math.max(0, (duration - audioDone) / speed) : null;
    const note = speed ? `transcribing at ${speed.toFixed(2)}x real time` : "transcribing";
    onProgress?.({ progress: Math.min(0.999, done), speed, etaSec: etaSec == null ? null : Math.round(etaSec), note, processed: audioDone });
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
    await run(whisper, args, {
      signal,
      keepOutput: false,
      onStdout: (chunk) => {
        pending += chunk;
        const nl = pending.lastIndexOf("\n");
        if (nl < 0) return;
        const segs = parseSegmentLines(pending.slice(0, nl));
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
  } catch (e) {
    fs.rmSync(jsonFile, { force: true });
    const err = new Error(e.code === "ENOENT" ? `whisper-cli was not found at ${whisper}.` : `whisper stopped: ${e.message}`);
    err.hint =
      e.code === "ENOENT"
        ? "Build whisper.cpp (cmake -B build && cmake --build build) and set SELECTS_WHISPER_BIN to build/bin/whisper-cli."
        : "Check free disk space and memory, then resume the job. Your progress up to this stage is saved.";
    throw err;
  } finally {
    fs.rmSync(wav, { force: true });
  }
  if (!fs.existsSync(jsonFile)) throw Object.assign(new Error("whisper finished but wrote no JSON."), { hint: "Run `selects doctor` to check the whisper build." });
  const words = wordsFromWhisperJson(readJson(jsonFile));
  // send whatever the live stream did not (the held-back tail, or everything if stdout was quiet)
  if (words.length > emitted) onWords?.(words.slice(emitted));
  const wall = (Date.now() - t0) / 1000;
  const speed = duration ? duration / wall : null;
  onProgress?.({ progress: 1, speed, etaSec: 0, note: speed ? `transcribed at ${speed.toFixed(2)}x real time` : "transcribed", processed: duration ?? 0, wallSec: +wall.toFixed(1) });
  return words;
}
