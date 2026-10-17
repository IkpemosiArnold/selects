// Transcript reuse: the language check and the transcript are kept per source file, so a
// second job on the same video (caption mode after clip mode, a new k, a re-run) skips both.
// The key is a fast content fingerprint of the file (size, mtime and the first and last 4 MB)
// plus the model and settings that shape the result. Kept in <SELECTS_HOME>/cache/.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, selectsHome } from "./config.mjs";
import { readJson, sha1, writeJsonAtomic } from "./util.mjs";

const CHUNK = 4 * 1024 * 1024;

/** SELECTS_REUSE=0 turns reuse off everywhere (settings.reuse: false turns it off for one job). */
export const reuseEnabled = (settings = {}) => settings.reuse !== false && config().reuse;

export const reuseDir = () => path.join(selectsHome(), "cache");

/**
 * A fast fingerprint of a file's content: sha1 of its size, mtime, first 4 MB and last 4 MB.
 * Reads at most 8 MB, so a two-hour video costs the same as a short one.
 */
export function sourceFingerprint(file, { chunk = CHUNK } = {}) {
  const st = fs.statSync(file);
  const h = crypto.createHash("sha1");
  h.update(`${st.size}|${Math.round(st.mtimeMs)}|`);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(chunk, st.size));
    h.update(buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)));
    if (st.size > chunk) h.update(buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, Math.max(chunk, st.size - chunk))));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex").slice(0, 20);
}

/** Key for a transcript: the source plus everything that changes whisper's output. */
export function transcriptKey(fingerprint, { model, language, prompt = null, preprocess = "none", translate = false, audioStream = null }) {
  return sha1(JSON.stringify({ v: 1, fingerprint, model: path.basename(String(model)), language, prompt: prompt || null, preprocess, translate: !!translate, audioStream })).slice(0, 20);
}

/** Key for a language decision: the source plus the setting, the rule and the check model. */
export function languageKey(fingerprint, { setting, remembered = null, rule, model = null, audioStream = null }) {
  return sha1(JSON.stringify({ v: 1, fingerprint, setting, remembered, rule, model: model ? path.basename(String(model)) : null, audioStream })).slice(0, 20);
}

const tDir = (key) => path.join(reuseDir(), "transcripts", key);
const lFile = (key) => path.join(reuseDir(), "language", `${key}.json`);

/**
 * A saved transcript: { words (with their non-speech `events`), meta } or null. Copies the
 * saved loudness track into `jobDir` so the pre-score keeps its loudness signal.
 */
export function loadTranscript(key, { jobDir } = {}) {
  const dir = tDir(key);
  const words = readJson(path.join(dir, "words.json"), null);
  if (!Array.isArray(words) || !words.length) return null;
  const events = readJson(path.join(dir, "events.json"), []);
  Object.defineProperty(words, "events", { value: Array.isArray(events) ? events : [], enumerable: false });
  if (jobDir && fs.existsSync(path.join(dir, "loudness.json"))) {
    fs.mkdirSync(jobDir, { recursive: true });
    fs.copyFileSync(path.join(dir, "loudness.json"), path.join(jobDir, "loudness.json"));
  }
  return { words, meta: readJson(path.join(dir, "meta.json"), {}) };
}

/** Save a transcript (whisper's words before punctuation, and its events) and the job's loudness track. */
export function saveTranscript(key, words, { jobDir, meta = {} } = {}) {
  const dir = tDir(key);
  writeJsonAtomic(path.join(dir, "words.json"), words);
  writeJsonAtomic(path.join(dir, "events.json"), words.events || []);
  if (jobDir && fs.existsSync(path.join(jobDir, "loudness.json"))) fs.copyFileSync(path.join(jobDir, "loudness.json"), path.join(dir, "loudness.json"));
  writeJsonAtomic(path.join(dir, "meta.json"), { ...meta, savedAt: new Date().toISOString() });
}

export const loadLanguage = (key) => readJson(lFile(key), null);
export const saveLanguage = (key, result) => writeJsonAtomic(lFile(key), result);
