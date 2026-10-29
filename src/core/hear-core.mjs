// The hearing judge's pure parts: a model that listens to the audio of a moment and says how
// much it sounds worth posting. The text judge reads words; a laugh, a voice cracking up, two
// people talking over each other or a sudden change of energy are in the sound, not the words.
//
// How it works: the listener scores fixed 30 s stretches of the recording (Gemma 3n reads at
// most 30 s of audio at a time), on a grid with a 15 s hop. A candidate window's hearing score
// is the best score among the stretches that overlap it by at least half a stretch. The score
// then joins the pre-score when the shortlist is drawn, and the judge's total after judging.
//
// No Node imports: the desktop app and the browser build can share this file.

/** The grid: 30 s stretches every 15 s. */
export const HEAR_LEN = 30;
export const HEAR_HOP = 15;
/** A stretch counts for a window when it overlaps the window by at least this many seconds. */
export const HEAR_MIN_OVERLAP = 15;

/**
 * How the hearing score joins the ranking when it is on (opt-in).
 *   shortlist  the shortlist is drawn by (1 - shortlist) x pre-score + shortlist x hearing
 *   judge/pre/hear  the total after judging
 * Fixed before the private test on one podcast (see the eval notes); not tuned on it.
 */
export const HEAR_BLEND = { shortlist: 0.5, judge: 0.5, pre: 0.15, hear: 0.35 };

/** The 30 s stretches that cover [0, duration]: [{ i, s, e }]. The last one is cut at the end. */
export function hearGrid(duration, { len = HEAR_LEN, hop = HEAR_HOP } = {}) {
  const out = [];
  if (!(duration > 0)) return out;
  for (let i = 0; ; i++) {
    const s = i * hop;
    if (s >= duration) break;
    const e = Math.min(duration, s + len);
    // a last stretch shorter than half a stretch adds nothing the previous one did not hear
    if (i > 0 && e - s < len / 2) break;
    out.push({ i, s, e: +e.toFixed(3) });
    if (e >= duration) break;
  }
  return out;
}

/** The grid stretches a set of windows needs (for scoring only some windows, as the eval does). */
export function stretchesFor(windows, duration, opts = {}) {
  const grid = hearGrid(duration, opts);
  const min = opts.minOverlap ?? HEAR_MIN_OVERLAP;
  return grid.filter((g) => windows.some((w) => overlap(g, w) >= Math.min(min, (w.end - w.start) / 2)));
}

const overlap = (g, w) => Math.max(0, Math.min(g.e, w.end) - Math.max(g.s, w.start));

/**
 * A window's hearing score: the best score among the stretches that overlap it by at least
 * HEAR_MIN_OVERLAP seconds (or half the window, for a window shorter than 30 s). null when no
 * scored stretch qualifies. scores: [{ s, e, score }] with score in 0..1.
 */
export function windowHearing(win, scores, { minOverlap = HEAR_MIN_OVERLAP } = {}) {
  const need = Math.min(minOverlap, (win.end - win.start) / 2);
  let best = null;
  for (const g of scores || []) {
    if (typeof g.score !== "number") continue;
    if (overlap(g, win) >= need && (best == null || g.score > best)) best = g.score;
  }
  return best;
}

/** The pre-score with hearing in it, for drawing the shortlist. Without a hearing score, the pre-score. */
export function preWithHearing(pre, hear, w = HEAR_BLEND.shortlist) {
  if (typeof hear !== "number") return pre;
  return +((1 - w) * (pre ?? 0) + w * hear).toFixed(3);
}

/** The total with hearing in it. Without a hearing score, the usual blend (passed in as `plain`). */
export function blendWithHearing(judgeTotal, pre, hear, plain) {
  if (typeof hear !== "number" || typeof judgeTotal !== "number") return plain;
  const b = HEAR_BLEND;
  return +(b.judge * judgeTotal + b.pre * (pre ?? 0) + b.hear * hear).toFixed(3);
}

/**
 * The listener's question. One digit out: the score is read from the probabilities the model
 * gives the digits 1 to 9 at the first answer token, so one forward pass is enough and the
 * score is continuous (a model that hesitates between 3 and 7 says 5, not a coin flip).
 */
export const HEAR_PROMPT =
  "Listen to this 30-second stretch of a podcast or video. Would a social media editor cut this moment into a short clip to post? " +
  "Things that make people stop scrolling: laughter, a joke landing, playful banter or teasing, people talking over each other, " +
  "a raised or excited voice, gossip, a surprising story, a bold opinion. A calm explanation, a lecture, small talk, " +
  "silence or background music scores low. Answer with one digit from 1 (nothing worth posting) to 9 (would definitely post).";

/**
 * Read a 0..1 score from the digits' logits: softmax over the nine digit tokens, the expected
 * digit, mapped from 1..9 to 0..1. logits: { "1": x, ..., "9": x }.
 */
export function scoreFromDigitLogits(logits) {
  const ds = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].filter((d) => Number.isFinite(logits?.[d]));
  if (ds.length < 2) return null;
  const m = Math.max(...ds.map((d) => logits[d]));
  const ex = ds.map((d) => Math.exp(logits[d] - m));
  const z = ex.reduce((a, b) => a + b, 0);
  const expected = ds.reduce((s, d, i) => s + Number(d) * (ex[i] / z), 0);
  return +((expected - 1) / 8).toFixed(4);
}

/**
 * The cheap listener: no language model, only what the sound analysis already measures in a
 * stretch. Each feature is turned into its percentile within the recording, and the score is
 * their mean, so it says "louder, more laughter, more overlap than the rest of this recording",
 * never an absolute claim. features: [{ s, e, laugh, overlap, loudSpread }] (any may be null).
 */
export function cueScores(features, keys = ["laugh", "overlap", "loudSpread"]) {
  const pct = {};
  for (const k of keys) {
    const vals = features.map((f) => f[k]).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    pct[k] = (x) => {
      if (!Number.isFinite(x) || vals.length < 2) return null;
      let lo = 0;
      while (lo < vals.length && vals[lo] < x) lo++;
      let hi = lo;
      while (hi < vals.length && vals[hi] === x) hi++;
      return (lo + hi - 1) / 2 / (vals.length - 1); // mid-rank of ties
    };
  }
  return features.map((f) => {
    const ps = keys.map((k) => pct[k](f[k])).filter((x) => x != null);
    return { s: f.s, e: f.e, score: ps.length ? +(ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(4) : null };
  });
}
