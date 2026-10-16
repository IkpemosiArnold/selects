// Words -> sentences, and snapping a trim to sentence boundaries.

const END_RE = /[.!?]["')\]]*$/;
const LONG_PAUSE = 1.2; // seconds of silence that end a sentence whisper left unpunctuated
const MAX_SENTENCE_WORDS = 45; // past this, split at the next pause or comma

// Whisper sometimes writes casual or accented speech with almost no full stops. Then a
// "sentence" can run for a minute, and windows that must start and end on sentences
// collapse. Below one sentence end per SPARSE_WORDS words, sentences come from timing:
// a pause of PAUSE_SPLIT seconds ends one, and none may run past MAX_SENTENCE_SEC.
const SPARSE_WORDS = 25;
const PAUSE_SPLIT = 0.6;
const PAUSE_MIN_WORDS = 3; // a pause after one or two words is usually a hesitation
const MAX_SENTENCE_SEC = 12;

/** True when a transcript has too few sentence ends to split on (fewer than 1 per 25 words). */
export function isSparsePunctuation(words) {
  if (!words.length) return false;
  let ends = 0;
  for (const w of words) if (END_RE.test(w.w)) ends++;
  return ends < words.length / SPARSE_WORDS;
}

/** Split [i0, i1] at its largest internal gap until no piece runs past maxSec. */
function capLength(words, i0, i1, maxSec, out) {
  if (i1 <= i0 || words[i1].e - words[i0].s <= maxSec) {
    out.push([i0, i1]);
    return;
  }
  let at = i0;
  let best = -Infinity;
  const mid = (words[i0].s + words[i1].e) / 2;
  for (let i = i0; i < i1; i++) {
    const gap = words[i + 1].s - words[i].e;
    // the largest gap wins; on a tie, the one nearer the middle keeps the pieces even
    const better = gap > best + 1e-6 || (Math.abs(gap - best) <= 1e-6 && Math.abs(words[i].e - mid) < Math.abs(words[at].e - mid));
    if (better) {
      best = gap;
      at = i;
    }
  }
  capLength(words, i0, at, maxSec, out);
  capLength(words, at + 1, i1, maxSec, out);
}

/**
 * Group words into sentences.
 * A sentence ends at a word ending in . ! or ?, or at a long pause, or (for run-ons)
 * at a pause or comma once it grows too long. When punctuation is sparse (see
 * isSparsePunctuation), a shorter pause also ends a sentence and none runs past about
 * 12 s; those sentences carry `soft: true`, because their edges come from timing, so a
 * lowercase start or a missing full stop says nothing about whether they are complete.
 * @param {{w:string,s:number,e:number}[]} words
 * @returns {{s:number,e:number,text:string,wordIdx:[number,number],soft?:true}[]}
 */
export function toSentences(words) {
  const sparse = isSparsePunctuation(words);
  const spans = [];
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
      (sparse && gap >= PAUSE_SPLIT && n >= PAUSE_MIN_WORDS) ||
      (n >= MAX_SENTENCE_WORDS && (gap >= 0.35 || /[,;:]$/.test(w.w))) ||
      n >= MAX_SENTENCE_WORDS * 2;
    if (end) {
      if (sparse) capLength(words, i0, i, MAX_SENTENCE_SEC, spans);
      else spans.push([i0, i]);
      i0 = i + 1;
    }
  }
  return spans.map(([a, b]) => {
    const ws = words.slice(a, b + 1);
    return { s: ws[0].s, e: ws[ws.length - 1].e, text: ws.map((x) => x.w).join(" "), wordIdx: [a, b], ...(sparse ? { soft: true } : {}) };
  });
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
