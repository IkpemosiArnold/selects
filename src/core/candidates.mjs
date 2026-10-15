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
  /^(so,? )?(in other words|which means|that means|this means|in that case|because of that|for that reason)\b/i,
  /^(so,? )?if (that|this|so)('s| is| was|,)/i,
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
  // a lowercase start means whisper's sentence began mid-thought (or the recording did)
  if (/^[a-z]/.test(t) && !/^(i|i'm|i've|i'd|i'll)\b/.test(t)) return true;
  // a first "sentence" that is only filler ("Okay.", "Right, so.") opens on nothing
  if (/^((okay|ok|so|right|um+|uh+|yeah|yes|alright|all right|cool|well|great|thanks|thank you)[\s,.!?]*)+$/i.test(t)) return true;
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

// Phrases that editors reach for when they look for a hook.
const HOOK_PHRASES = /\b(the truth is|nobody tells you|no one tells you|here'?s the thing|the problem is|the secret|turns out|it turns out|what if|i was wrong|most people|the reason|the biggest|the one thing|you'?ve been|stop doing|the mistake|i learned|the first time|i realised|i realized)\b/i;
const CONTRAST = /\b(but|actually|instead|however|except|turns out|until|whereas|in fact)\b/gi;
const NUMBER = /\b(\d[\d,.]*|one|two|three|four|five|ten|hundred|thousand|million|percent)\b/i;

const median = (a) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/** Precompute talk-level loudness stats once for preScore. */
export function loudnessContext(loudness) {
  if (!loudness?.db?.length) return null;
  const speech = loudness.db.filter((d) => d > -60);
  const src = speech.length ? speech : loudness.db;
  const sorted = src.slice().sort((a, b) => a - b);
  return { ...loudness, median: median(src), p95: sorted[Math.floor(sorted.length * 0.95)] };
}

/**
 * The cheap first stage: a 0..1 score from text, timing and loudness, no LLM.
 * Rewards a short opener with a hook phrase, question or number; contrast inside the
 * window (a turn is where the point usually is); a steady pace without long pauses;
 * and moments louder than the talk's median (emphasis, laughter, applause).
 * Penalises soft openers, question endings and filler.
 */
export function preScore(win, ctx = null) {
  const first = win.sentences[0].text;
  const last = win.sentences[win.sentences.length - 1].text;
  const words = win.text.split(/\s+/).filter(Boolean);
  const dur = win.end - win.start;
  const firstWords = first.split(/\s+/).length;
  let s = 0.45;
  const parts = {};
  const add = (k, v) => {
    if (!v) return;
    parts[k] = +v.toFixed(3);
    s += v;
  };
  add("openerLength", firstWords >= 4 && firstWords <= 18 ? 0.08 : firstWords > 30 ? -0.08 : 0);
  add("hookPhrase", HOOK_PHRASES.test(first) ? 0.15 : HOOK_PHRASES.test(win.sentences.slice(0, 2).map((x) => x.text).join(" ")) ? 0.06 : 0);
  add("hookWords", HOOKY.test(first) ? 0.05 : 0);
  add("openingQuestion", /\?["')\]]*$/.test(first) ? 0.06 : 0);
  add("number", NUMBER.test(win.text) ? 0.03 : 0);
  add("contrast", Math.min(0.08, ((win.text.match(CONTRAST) || []).length) * 0.02));
  add("softOpener", SOFT_OPENERS.test(first.trim()) ? -0.06 : 0);
  add("questionEnding", /\?["')\]]*$/.test(last) ? -0.08 : 0);
  add("exclaim", /!["')\]]*$/.test(last) ? 0.03 : 0);
  const wps = words.length / Math.max(1, dur);
  add("pace", wps >= 2.0 && wps <= 3.6 ? 0.06 : wps < 1.4 ? -0.12 : 0);
  let pauses = 0;
  for (let i = 1; i < win.sentences.length; i++) if (win.sentences[i].s - win.sentences[i - 1].e > 1.0) pauses++;
  add("pauses", -Math.min(0.12, pauses * 0.03));
  const fillers = (win.text.match(FILLERS) || []).length / Math.max(1, words.length);
  add("filler", -Math.min(0.2, fillers * 4));
  if (ctx?.db?.length) {
    const i0 = Math.floor(win.start / ctx.step);
    const i1 = Math.min(ctx.db.length, Math.ceil(win.end / ctx.step));
    // speech bins only: silent gaps between sentences would drag the mean far down
    const seg = ctx.db.slice(i0, i1).filter((d) => d > -60);
    if (seg.length) {
      // median against median: dB means are dragged down by every short dip
      add("loudness", Math.max(-0.08, Math.min(0.08, (median(seg) - ctx.median) / 10)));
      // a burst louder than 95% of the talk: emphasis, laughter or applause
      const share = seg.filter((d) => d >= ctx.p95).length / seg.length;
      add("peak", Math.min(0.06, Math.max(0, (share - 0.05) * 0.6)));
    }
  }
  const score = Math.max(0, Math.min(1, +s.toFixed(3)));
  Object.defineProperty(win, "preParts", { value: parts, enumerable: false, configurable: true });
  return score;
}

/**
 * Make sentence-snapped candidate windows.
 * For each start sentence (at least `stride` seconds after the previous start used) it takes
 * up to three end sentences, spread across the allowed length range, then drops windows
 * that open on a dangling reference or end mid-thought.
 * @returns Candidate[] (unranked, with a `pre` score; time-ordered ids c_0001...)
 */
export function makeCandidates(sentences, { minLen = 20, maxLen = 60, stride = 6, keepRejected = false, loudness = null } = {}) {
  const ctx = loudnessContext(loudness);
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
      pre: preScore(w, ctx),
      preParts: w.preParts,
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
 * The second stage's input: pick at most n windows for the judge (default 8, because the
 * judge is the slow step). First the best window in each of n/3 equal time buckets (so one
 * strong stretch cannot crowd out the rest of the video), then the best remaining by
 * pre-score, never keeping two windows that overlap by more than `maxIou`.
 */
export function shortlist(cands, { n = 8, maxIou = 0.4, duration } = {}) {
  if (cands.length <= n) return cands.slice();
  const dur = duration ?? Math.max(...cands.map((c) => c.end));
  const byScore = cands.slice().sort((a, b) => b.pre - a.pre || a.start - b.start);
  const chosen = [];
  const ok = (c) => chosen.every((x) => iou(x, c) <= maxIou);
  const buckets = Math.max(1, Math.ceil(n / 3));
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
