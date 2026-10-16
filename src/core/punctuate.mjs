// Punctuation and casing for transcripts that whisper left without full stops. Uses the
// Edge-Punct-Casing CNN-BiLSTM (English, Apache-2.0) through sherpa-onnx. Measured on 16 Oct:
// with whisper's punctuation stripped from 7 well-punctuated talks, the model put sentence
// ends back with an F1 of 0.61 to 0.84 (mean 0.76), against 0.17 to 0.50 (mean 0.35) for the
// pause-based fallback in sentences.mjs. Only used when isSparsePunctuation says so.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { modelsDir } from "./config.mjs";

const require = createRequire(import.meta.url);
const CHUNK = 150; // words per call; the model is streaming, so chunks keep memory flat

/** The punctuation model folder (SELECTS_PUNCT_DIR overrides), or null if not installed. */
export function punctModel() {
  const dir = process.env.SELECTS_PUNCT_DIR || path.join(modelsDir(), "punct", "sherpa-onnx-online-punct-en-2024-08-06");
  const onnx = ["model.int8.onnx", "model.onnx"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  const vocab = path.join(dir, "bpe.vocab");
  return onnx && fs.existsSync(vocab) ? { onnx, vocab, name: path.basename(dir) } : null;
}

const bare = (w) => String(w).replace(/[^\p{L}\p{N}'-]/gu, "").toLowerCase();

/**
 * Merge the model's token into whisper's word: whisper's spelling, the model's casing when
 * whisper's word was all lowercase, and the model's trailing punctuation when whisper had none.
 */
export function mergeToken(orig, token) {
  if (!token || bare(orig) !== bare(token)) return orig;
  let out = orig;
  const core = token.replace(/[.,?!;:]+$/, "");
  if (orig === orig.toLowerCase() && /^[\p{Lu}]/u.test(core) && bare(core) === bare(orig) && !/[^\p{L}\p{N}'-]/u.test(orig)) out = core;
  const tail = token.match(/[.,?!]+$/)?.[0];
  if (tail && !/[.,?!;:]["')]*$/.test(orig)) out += tail;
  return out;
}

/**
 * Restore punctuation and casing. punct: an object with addPunct(text) -> text (sherpa's
 * OnlinePunctuation; injected in tests). Returns { words, changed } with new word objects
 * (times untouched).
 */
export function applyPunctuation(words, punct) {
  const idx = words.map((w, i) => (bare(w.w) ? i : -1)).filter((i) => i >= 0);
  const out = words.map((w) => ({ ...w }));
  let changed = 0;
  for (let c = 0; c < idx.length; c += CHUNK) {
    const ids = idx.slice(c, c + CHUNK);
    const toks = String(punct.addPunct(ids.map((i) => bare(words[i].w)).join(" ")))
      .split(/\s+/)
      .filter(Boolean);
    if (toks.length !== ids.length) continue; // the model split or merged a word: leave this chunk alone
    ids.forEach((i, j) => {
      const m = mergeToken(words[i].w, toks[j]);
      if (m !== words[i].w) {
        out[i].w = m;
        changed++;
      }
    });
  }
  return { words: out, changed };
}

/** Load sherpa-onnx and the model. Returns an object with addPunct, or null with a reason. */
export function loadPunctuation() {
  const m = punctModel();
  if (!m) return { punct: null, reason: "the punctuation model is not installed" };
  let sherpa;
  try {
    sherpa = require("sherpa-onnx-node");
  } catch {
    return { punct: null, reason: "sherpa-onnx-node is not installed (npm install sherpa-onnx-node)" };
  }
  try {
    const punct = new sherpa.OnlinePunctuation({ model: { cnnBilstm: m.onnx, bpeVocab: m.vocab, numThreads: 1 } });
    return { punct, model: m.name };
  } catch (e) {
    return { punct: null, reason: `the punctuation model did not load: ${e.message}` };
  }
}

/**
 * Restore punctuation in a word list, or explain why not. Never throws.
 * Returns { words, info: { restored, model, changed, sec, reason } }.
 */
export function restorePunctuation(words, { load = loadPunctuation } = {}) {
  const t0 = Date.now();
  const { punct, model, reason } = load();
  if (!punct) return { words, info: { restored: false, model: null, changed: 0, sec: 0, reason } };
  try {
    const r = applyPunctuation(words, punct);
    return { words: r.words, info: { restored: true, model, changed: r.changed, sec: +((Date.now() - t0) / 1000).toFixed(1), reason: null } };
  } catch (e) {
    return { words, info: { restored: false, model, changed: 0, sec: +((Date.now() - t0) / 1000).toFixed(1), reason: e.message } };
  }
}
