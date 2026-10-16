// Caption cues: build them from words, edit them without losing timings, and write or
// read SRT and WebVTT. captions.json in the job folder is the one copy every render reads,
// so a fix made in the review step shows up in caption mode and in every clip.
import fs from "node:fs";
import path from "node:path";
import { speechOnly } from "./nonspeech.mjs";
import { cuesFromWords, applyCueEdits } from "./cues.mjs";
import { readJson, writeJsonAtomic } from "./util.mjs";

export { STYLES, chunkWords, cuesFromWords, applyCueEdits, toSrt, toVtt, vttTime, parseSubtitles, clipCues, textInRange } from "./cues.mjs";

// ---- captions.json in a job folder -------------------------------------------------

export const captionsFile = (dir) => path.join(dir, "captions.json");

/** Load the job's cues, building them from words.json the first time. */
export function loadCaptions(dir, { style = "bold" } = {}) {
  const f = captionsFile(dir);
  const saved = readJson(f, null);
  if (saved?.cues) return saved;
  const words = speechOnly(readJson(path.join(dir, "words.json"), [])); // never caption "[Music]"
  const caps = { edited: false, style, updatedAt: new Date().toISOString(), cues: cuesFromWords(words, style) };
  writeJsonAtomic(f, caps);
  return caps;
}

export function saveCaptions(dir, cues, { edited = true, style } = {}) {
  const prev = readJson(captionsFile(dir), {});
  const caps = { edited, style: style || prev.style || "bold", updatedAt: new Date().toISOString(), cues };
  writeJsonAtomic(captionsFile(dir), caps);
  return caps;
}

/** Rebuild from words.json (drops edits). */
export function resetCaptions(dir, { style = "bold" } = {}) {
  fs.rmSync(captionsFile(dir), { force: true });
  return loadCaptions(dir, { style });
}

/** Apply { s, e, text }[] edits to the job's captions and save. */
export function editCaptions(dir, edits) {
  const cur = loadCaptions(dir);
  return saveCaptions(dir, applyCueEdits(cur.cues, edits), { edited: true });
}
