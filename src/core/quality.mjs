// Transcript quality: can the rest of the pipeline trust these words?
// Candidates, the judge, the cuts and the captions all sit on the transcript, so a bad one
// must stop the run (or at least warn) before Gemma spends ten minutes judging noise.
import zlib from "node:zlib";

export const LOW_P = 0.5; // a word below this is "low confidence" (faint underline in the editor)

// Calibrated on 16 Oct: the clean EMF talk with base.en against the elderly speaker's
// Nigerian-accented English with base.en (see notes/timings.md, "Transcript quality").
export const THRESHOLDS = { good: 0.7, shaky: 0.5 };

/**
 * Share of words that sit inside a repeated n-gram loop (whisper's hallucination mode:
 * "and then and then and then ..."). Counts words whose 3-gram already appeared in the
 * previous 30 words.
 */
export function repeatShare(texts, { n = 3, window = 30 } = {}) {
  const t = texts.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "")).filter(Boolean);
  if (t.length < n * 3) return 0;
  const seen = new Map(); // gram -> last index
  let rep = 0;
  for (let i = 0; i + n <= t.length; i++) {
    const g = t.slice(i, i + n).join(" ");
    const last = seen.get(g);
    if (last != null && i - last <= window && i - last >= 1) rep++;
    seen.set(g, i);
  }
  return +(rep / (t.length - n + 1)).toFixed(3);
}

/** Text length over deflated length; whisper treats above 2.4 as a likely loop. */
export function compressionRatio(text) {
  const b = Buffer.from(text, "utf8");
  if (b.length < 120) return 1;
  return +(b.length / zlib.deflateRawSync(b, { level: 9 }).length).toFixed(2);
}

/**
 * The worst compression ratio over 80-word chunks. Whole transcripts compress better the
 * longer they are, so a single ratio for a long talk is meaningless; whisper itself checks
 * per 30 s segment. Clean talks measured 1.75 to 2.08 here.
 */
export function maxChunkCompression(texts, size = 80) {
  let worst = 1;
  for (let i = 0; i < texts.length; i += size) {
    const chunk = texts.slice(i, i + size);
    if (chunk.length < size / 2 && i > 0) break;
    worst = Math.max(worst, compressionRatio(chunk.join(" ")));
  }
  return worst;
}

/**
 * Score a transcript. words: [{ w, s, e, p }].
 * score = mean word p, minus penalties for many low-confidence words, loops and
 * runaway compression. Returns { score, meanP, lowShare, repeatShare, compression,
 * words, verdict, hint }.
 */
export function transcriptQuality(words, { duration = null, thresholds = THRESHOLDS } = {}) {
  const n = words.length;
  if (!n) {
    return { score: 0, meanP: 0, lowShare: 1, repeatShare: 0, compression: 1, words: 0, wordsPerMin: 0, verdict: "unreliable", hint: "Whisper heard no speech. Check the audio track, or set --language." };
  }
  const ps = words.map((w) => (Number.isFinite(w.p) ? w.p : 1));
  const meanP = ps.reduce((a, b) => a + b, 0) / n;
  const lowShare = ps.filter((p) => p < LOW_P).length / n;
  const rep = repeatShare(words.map((w) => w.w));
  const comp = maxChunkCompression(words.map((w) => w.w));
  const span = duration || Math.max(1, words[n - 1].e - words[0].s);
  const wordsPerMin = (n / span) * 60;
  let score = meanP - 0.5 * Math.max(0, lowShare - 0.1) - 1.5 * Math.max(0, rep - 0.05) - 0.3 * Math.max(0, comp - 2.4);
  score = Math.max(0, Math.min(1, score));
  let verdict = score >= thresholds.good ? "good" : score >= thresholds.shaky ? "shaky" : "unreliable";
  // a long video with almost no words is suspicious however confident they are
  if (duration && duration > 60 && wordsPerMin < 15 && verdict === "good") verdict = "shaky";
  const pct = (x) => `${Math.round(x * 100)}%`;
  const hint =
    verdict === "good"
      ? null
      : verdict === "shaky"
        ? `Whisper was unsure of ${pct(lowShare)} of the words (mean confidence ${meanP.toFixed(2)}). Check the captions before posting; a bigger model (--asr-model small.en) usually helps with accents.`
        : rep > 0.15 && lowShare < 0.2
          ? `Whisper repeated itself (${pct(rep)} of the text is a loop), which happens when it loses track of the audio, so clips picked from it would be guesses. Try --asr-model small.en, or set --language to the language spoken.`
          : `Whisper was unsure of ${pct(lowShare)} of the words (mean confidence ${meanP.toFixed(2)}), so clips picked from this transcript would be guesses. Try --asr-model small.en, or set --language to the language spoken.`;
  return {
    score: +score.toFixed(3),
    meanP: +meanP.toFixed(3),
    lowShare: +lowShare.toFixed(3),
    repeatShare: rep,
    compression: comp,
    words: n,
    wordsPerMin: +wordsPerMin.toFixed(1),
    verdict,
    hint,
  };
}

/** Mean word probability of the words between start and end (seconds). null if none. */
export function meanPIn(words, start, end) {
  let sum = 0;
  let n = 0;
  for (const w of words) {
    const mid = (w.s + w.e) / 2;
    if (mid < start) continue;
    if (mid > end) break;
    sum += Number.isFinite(w.p) ? w.p : 1;
    n++;
  }
  return n ? +(sum / n).toFixed(3) : null;
}
