// Words -> sentences, and snapping a trim to sentence boundaries.

const END_RE = /[.!?]["')\]]*$/;
const LONG_PAUSE = 1.2; // seconds of silence that end a sentence whisper left unpunctuated
const MAX_SENTENCE_WORDS = 45; // past this, split at the next pause or comma

/**
 * Group words into sentences.
 * A sentence ends at a word ending in . ! or ?, or at a long pause, or (for run-ons)
 * at a pause or comma once it grows too long.
 * @param {{w:string,s:number,e:number}[]} words
 * @returns {{s:number,e:number,text:string,wordIdx:[number,number]}[]}
 */
export function toSentences(words) {
  const out = [];
  let i0 = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    const gap = next ? next.s - w.e : Infinity;
    const n = i - i0 + 1;
    const end =
      !next ||
      END_RE.test(w.w) ||
      gap >= LONG_PAUSE ||
      (n >= MAX_SENTENCE_WORDS && (gap >= 0.35 || /[,;:]$/.test(w.w))) ||
      n >= MAX_SENTENCE_WORDS * 2;
    if (end) {
      const ws = words.slice(i0, i + 1);
      out.push({ s: ws[0].s, e: w.e, text: ws.map((x) => x.w).join(" "), wordIdx: [i0, i] });
      i0 = i + 1;
    }
  }
  return out;
}

/** Index of the item whose `key` value is nearest to t. */
function nearest(items, key, t) {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < items.length; i++) {
    const d = Math.abs(items[i][key] - t);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

/**
 * Snap a requested [start, end] to the nearest sentence start and sentence end,
 * so a clip never opens or closes mid-sentence. Always returns end > start.
 * @param {{w,s,e}[]} words
 * @param {number} start
 * @param {number} end
 * @param {{sentences?: object[]}} [opts] pass precomputed sentences to save work
 */
export function snapTrim(words, start, end, { sentences } = {}) {
  const sents = sentences || toSentences(words);
  if (!sents.length) return { start, end };
  if (end < start) [start, end] = [end, start];
  const si = nearest(sents, "s", start);
  // the end must be a sentence end at or after the chosen start sentence
  const tail = sents.slice(si);
  let ei = si + nearest(tail, "e", end);
  if (ei < si) ei = si;
  return { start: sents[si].s, end: sents[ei].e };
}
