// Caption cues: build them from words, edit them without losing timings, and write or
// read SRT and WebVTT. captions.json in the job folder is the one copy every render reads,
// so a fix made in the review step shows up in caption mode and in every clip.
import fs from "node:fs";
import path from "node:path";
import { readJson, srtTime, writeJsonAtomic } from "./util.mjs";

/** Caption styles: how many words a cue holds and how it is drawn. */
export const STYLES = {
  // short-form: 2 to 4 big words, the current word highlighted
  bold: { maxWords: 4, maxChars: 22, pause: 0.5, commaMin: 2, highlight: true },
  // classic subtitles: up to two lines of about 42 characters, no highlight
  subtitle: { maxWords: 16, maxChars: 76, pause: 0.9, commaMin: 7, maxDur: 6, highlight: false },
};

/**
 * Group words into cues. Breaks after sentence ends, after commas once `commaMin` words are
 * up, at pauses, and before a cue gets too long (in words, characters or seconds).
 */
export function chunkWords(words, { maxWords = 4, maxChars = 22, pause = 0.5, commaMin = 2, maxDur = Infinity } = {}) {
  const chunks = [];
  let cur = [];
  const chars = (arr) => arr.reduce((a, w) => a + w.w.length + 1, -1);
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const brk =
      cur.length &&
      (cur.length >= maxWords ||
        chars([...cur, w]) > maxChars ||
        w.e - cur[0].s > maxDur ||
        /[.!?]["')\]]*$/.test(prev.w) ||
        (cur.length >= commaMin && /[,;:]$/.test(prev.w)) ||
        w.s - prev.e > pause);
    if (brk) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  // fold a lone trailing word into the previous cue when it fits
  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i];
    const p = chunks[i - 1];
    if (c.length === 1 && p.length < maxWords && chars([...p, ...c]) <= maxChars + 4 && c[0].s - p[p.length - 1].e < pause && !/[.!?]$/.test(p[p.length - 1].w)) {
      p.push(c[0]);
      chunks.splice(i, 1);
      i--;
    }
  }
  return chunks.map((ws) => ({ s: ws[0].s, e: ws[ws.length - 1].e, text: ws.map((x) => x.w).join(" "), words: ws }));
}

export const cuesFromWords = (words, style = "bold") => chunkWords(words, STYLES[style] || STYLES.bold);

/** Split text into word tokens the way captions show them. */
const tokens = (text) => String(text).trim().split(/\s+/).filter(Boolean);

/**
 * Apply edited cues ({ s, e, text }[]) to the current cues, keeping timings.
 * For each edited cue, the old words whose midpoint falls inside [s, e] are its words.
 * Same number of tokens: every word keeps its time (changed words get p = 1, since a
 * person has now confirmed them). Different number: the tokens are spread over the span
 * of the old words in proportion to their length. Empty text deletes the cue.
 */
export function applyCueEdits(oldCues, edits) {
  const old = oldCues.flatMap((c) => c.words || []).sort((a, b) => a.s - b.s);
  const out = [];
  const sorted = edits
    .map((c) => ({ s: Number(c.s), e: Number(c.e), text: c.text ?? "" }))
    .filter((c) => Number.isFinite(c.s) && Number.isFinite(c.e) && c.e > c.s)
    .sort((a, b) => a.s - b.s);
  for (const c of sorted) {
    const toks = tokens(c.text);
    if (!toks.length) continue;
    const inside = old.filter((w) => {
      const mid = (w.s + w.e) / 2;
      return mid >= c.s - 1e-3 && mid <= c.e + 1e-3;
    });
    let words;
    if (inside.length === toks.length) {
      words = inside.map((w, i) => (w.w === toks[i] ? { ...w } : { ...w, w: toks[i], p: 1, edited: true }));
    } else {
      const s0 = inside.length ? inside[0].s : c.s;
      const e0 = inside.length ? inside[inside.length - 1].e : c.e;
      const weights = toks.map((t) => t.length + 1);
      const total = weights.reduce((a, b) => a + b, 0);
      let t = s0;
      words = toks.map((w, i) => {
        const d = ((e0 - s0) * weights[i]) / total;
        const word = { w, s: +t.toFixed(3), e: +(t + d * 0.92).toFixed(3), p: 1, edited: true };
        t += d;
        return word;
      });
    }
    const prev = out[out.length - 1];
    let s = +Math.min(c.s, words[0].s).toFixed(3);
    if (prev && s < prev.e) s = prev.e; // cues never overlap
    out.push({ s, e: +Math.max(c.e, words[words.length - 1].e).toFixed(3), text: words.map((w) => w.w).join(" "), words });
  }
  return out;
}

/** When a cue leaves the screen: a short hold after its last word, never into the next cue. */
function cueEnd(cues, i, hold = 0.2) {
  const next = cues[i + 1]?.s ?? Infinity;
  return Math.min(cues[i].e + hold, next);
}

export function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.s)} --> ${srtTime(cueEnd(cues, i))}\n${c.text}\n`).join("\n");
}

export const vttTime = (sec) => srtTime(sec).replace(",", ".");

export function toVtt(cues) {
  return "WEBVTT\n\n" + cues.map((c, i) => `${i + 1}\n${vttTime(c.s)} --> ${vttTime(cueEnd(cues, i))}\n${c.text}\n`).join("\n");
}

const TIME_RE = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/;
const parseTime = (s) => {
  const m = s.match(TIME_RE);
  if (!m) return NaN;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, "0") / 1000;
};

/** Parse SRT or WebVTT text into [{ s, e, text }]. Multi-line cue text is joined with a space. */
export function parseSubtitles(text) {
  const blocks = String(text).replace(/\r/g, "").replace(/^﻿/, "").split(/\n\s*\n/);
  const out = [];
  for (const b of blocks) {
    const lines = b.split("\n").filter((l) => l.trim() !== "");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split("-->");
    const s = parseTime(a);
    const e = parseTime(z);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    out.push({ s, e, text: lines.slice(ti + 1).join(" ").replace(/<[^>]+>/g, "").trim() });
  }
  return out;
}

/** The cues inside [start, end], shifted so the clip starts at 0 (for clip renders). */
export function clipCues(cues, start, end, offset = start) {
  const out = [];
  for (const c of cues) {
    const ws = (c.words || []).filter((w) => (w.s + w.e) / 2 >= start && (w.s + w.e) / 2 <= end);
    if (!ws.length) continue;
    const shifted = ws.map((w) => ({ ...w, s: +Math.max(0, w.s - offset).toFixed(3), e: +Math.max(0, w.e - offset).toFixed(3) }));
    out.push({ s: shifted[0].s, e: shifted[shifted.length - 1].e, text: shifted.map((w) => w.w).join(" "), words: shifted });
  }
  return out;
}

// ---- captions.json in a job folder -------------------------------------------------

export const captionsFile = (dir) => path.join(dir, "captions.json");

/** Load the job's cues, building them from words.json the first time. */
export function loadCaptions(dir, { style = "bold" } = {}) {
  const f = captionsFile(dir);
  const saved = readJson(f, null);
  if (saved?.cues) return saved;
  const words = readJson(path.join(dir, "words.json"), []);
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
