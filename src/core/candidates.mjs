// Candidate windows: sentence-snapped sliding windows, a rules prefilter, and a cheap
// pre-score used to shortlist what the (slow) judge reads.

// Openers that point back at something the viewer of a short never saw.
const DANGLING_OPENERS = [
  /^(and|but|or|nor|because|cause|'cause|which|whereas|plus|also|anyway|anyways|although|though)\b/i,
  /^(so,? )?(as|like) (i|we|you) (said|mentioned|showed|discussed|saw|heard|can see)\b/i,
  /^(so,? )?(that|this|those|these|the same) (one|ones|thing|things|part|bit|point|slide|example|case|guy|picture|graph|chart)\b/i,
  /^(so,? )?(that|this|it)('s| is| was)? (why|what|how|because|where|when)\b/i,
  /^(so,? )?(the )?(next|previous|last|other) (slide|one|point|thing)\b/i,
  /^(again|then|otherwise|meanwhile|similarly|likewise|besides|furthermore|moreover|however)\b/i,
  /^(yes|yeah|no|nope|exactly|right|correct)[,.!]/i,
];
const BACK_REFERENCE = /\b(as i (said|mentioned)|like i said|i mentioned (earlier|before)|earlier on|earlier i|the previous slide|last slide|i just (said|showed|mentioned)|we just (saw|said|talked))\b/i;

// Openers that are not fatal but usually weaker (talk filler or a bare pronoun subject).
const SOFT_OPENERS = /^(so|then|well|okay|ok|um|uh|erm|now|and so|it|they|he|she|that|this|these|those|there)\b/i;

// Endings that promise more instead of landing.
const DANGLING_ENDINGS = /\b(next slide|moving on|let'?s move on|let me show you|i'?ll show you|we'?ll see|we'?ll get to|more on that later|in a (minute|second|moment)|as we'?ll see)\b[^.!?]*[.!?]?$/i;
const DANGLING_LAST_WORD = /^(and|but|or|so|because|the|a|an|of|to|with|for|that|which|like|if|then|um|uh)$/i;

const FILLERS = /\b(um+|uh+|erm|you know|i mean|sort of|kind of|basically|actually|like,)\b/gi;
const HOOKY = /\b(you|your|never|nobody|no one|everyone|secret|mistake|wrong|truth|problem|why|how|what if|turns out|surprising|actually|stop|don'?t|best|worst|first|only|real|lie|myth|\d+)\b/i;

export function isDanglingOpener(sentence) {
  const t = sentence.trim();
  return DANGLING_OPENERS.some((r) => r.test(t)) || BACK_REFERENCE.test(t);
}

export function isDanglingEnding(sentence) {
  const t = sentence.trim();
  if (!/[.!]["')\]]*$/.test(t) && !/\?["')\]]*$/.test(t)) return true; // whisper left it unpunctuated: probably mid-thought
  if (/(\.\.\.|…|:|,)$/.test(t)) return true;
  const last = t.replace(/[.!?"')\]]+$/, "").split(/\s+/).pop() || "";
  if (DANGLING_LAST_WORD.test(last)) return true;
  return DANGLING_ENDINGS.test(t);
}

/**
 * A cheap 0..1 score from text alone (no LLM). Rewards a short punchy opener, a steady
 * speaking pace, little filler and a closing statement; penalises soft openers and
 * question endings. Used only to decide which windows the judge reads.
 */
export function preScore(win) {
  const first = win.sentences[0].text;
  const last = win.sentences[win.sentences.length - 1].text;
  const words = win.text.split(/\s+/).filter(Boolean);
  const dur = win.end - win.start;
  const firstWords = first.split(/\s+/).length;
  let s = 0.5;
  if (firstWords >= 4 && firstWords <= 18) s += 0.12;
  else if (firstWords > 30) s -= 0.1;
  if (HOOKY.test(first)) s += 0.1;
  if (/\?["')\]]*$/.test(first)) s += 0.06; // opening on a question is a classic hook
  if (SOFT_OPENERS.test(first.trim())) s -= 0.1;
  if (/\?["')\]]*$/.test(last)) s -= 0.08; // ends on a question: a setup with no answer
  if (/!["')\]]*$/.test(last)) s += 0.04;
  const wps = words.length / Math.max(1, dur);
  if (wps >= 2.0 && wps <= 3.6) s += 0.08;
  else if (wps < 1.4) s -= 0.12; // long silences: probably slides, demos or applause
  const fillers = (win.text.match(FILLERS) || []).length / Math.max(1, words.length);
  s -= Math.min(0.2, fillers * 4);
  return Math.max(0, Math.min(1, +s.toFixed(3)));
}

/**
 * Make sentence-snapped candidate windows.
 * For each start sentence (at least `stride` seconds after the previous start used) it takes
 * up to three end sentences, spread across the allowed length range, then drops windows
 * that open on a dangling reference or end mid-thought.
 * @returns Candidate[] (unranked, with a `pre` score; time-ordered ids c_0001...)
 */
export function makeCandidates(sentences, { minLen = 20, maxLen = 60, stride = 6, keepRejected = false } = {}) {
  const wins = [];
  let lastStart = -Infinity;
  const targets = [0.15, 0.5, 0.9].map((f) => minLen + f * (maxLen - minLen));
  for (let i = 0; i < sentences.length; i++) {
    const s0 = sentences[i];
    if (s0.s < lastStart + stride) continue;
    const ends = [];
    for (let j = i; j < sentences.length; j++) {
      const dur = sentences[j].e - s0.s;
      if (dur > maxLen) break;
      if (dur >= minLen) ends.push(j);
    }
    if (!ends.length) continue;
    lastStart = s0.s;
    const picked = new Set();
    for (const t of targets) {
      let best = ends[0];
      for (const j of ends) if (Math.abs(sentences[j].e - s0.s - t) < Math.abs(sentences[best].e - s0.s - t)) best = j;
      picked.add(best);
    }
    for (const j of [...picked].sort((a, b) => a - b)) {
      const sents = sentences.slice(i, j + 1);
      wins.push({ start: s0.s, end: sentences[j].e, sentences: sents, text: sents.map((x) => x.text).join(" ") });
    }
  }
  const out = [];
  for (const w of wins) {
    const first = w.sentences[0].text;
    const last = w.sentences[w.sentences.length - 1].text;
    let reject = null;
    if (isDanglingOpener(first)) reject = "opens on a reference to earlier context";
    else if (isDanglingEnding(last)) reject = "ends mid-thought";
    if (reject && !keepRejected) continue;
    out.push({
      id: null,
      rank: null,
      start: +w.start.toFixed(3),
      end: +w.end.toFixed(3),
      text: w.text,
      hook: first,
      scores: null,
      total: null,
      reason: null,
      title: null,
      status: "proposed",
      trimmed: false,
      render: null,
      pre: preScore(w),
      ...(reject ? { rejected: reject } : {}),
    });
  }
  out.forEach((c, i) => (c.id = `c_${String(i + 1).padStart(4, "0")}`));
  return out;
}

/** Temporal intersection over union of two {start, end} spans. */
export function iou(a, b) {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  return union > 0 ? inter / union : 0;
}

/**
 * Pick at most n windows for the judge: first the best window in each of n/2 equal time
 * buckets (so the whole video is covered), then the best remaining by pre-score, never
 * keeping two windows that overlap by more than `maxIou`.
 */
export function shortlist(cands, { n = 36, maxIou = 0.4, duration } = {}) {
  if (cands.length <= n) return cands.slice();
  const dur = duration ?? Math.max(...cands.map((c) => c.end));
  const byScore = cands.slice().sort((a, b) => b.pre - a.pre || a.start - b.start);
  const chosen = [];
  const ok = (c) => chosen.every((x) => iou(x, c) <= maxIou);
  const buckets = Math.max(1, Math.floor(n / 2));
  for (let b = 0; b < buckets; b++) {
    const lo = (b * dur) / buckets;
    const hi = ((b + 1) * dur) / buckets;
    const best = byScore.find((c) => c.start >= lo && c.start < hi && ok(c));
    if (best) chosen.push(best);
  }
  for (const c of byScore) {
    if (chosen.length >= n) break;
    if (!chosen.includes(c) && ok(c)) chosen.push(c);
  }
  return chosen.sort((a, b) => a.start - b.start);
}
