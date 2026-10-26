// Candidate windows: sentence-snapped sliding windows, windows around delivery peaks
// (laughter, applause, raised voices) with the setup before them, a rules prefilter, and a
// cheap pre-score used to shortlist what the (slow) judge reads.
import { deliveryContext, deliveryFeatures, markCues, peakWindows } from "./delivery.mjs";

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

/**
 * @param {string} sentence
 * @param {{soft?:boolean}} [opts] soft: the sentence was split on timing in an unpunctuated
 *   transcript, so its case carries no signal
 */
export function isDanglingOpener(sentence, { soft = false } = {}) {
  const t = sentence.trim();
  // a lowercase start means whisper's sentence began mid-thought (or the recording did)
  if (!soft && /^[a-z]/.test(t) && !/^(i|i'm|i've|i'd|i'll)\b/.test(t)) return true;
  // a first "sentence" that is only filler ("Okay.", "Right, so.") opens on nothing
  if (/^((okay|ok|so|right|um+|uh+|yeah|yes|alright|all right|cool|well|great|thanks|thank you)[\s,.!?]*)+$/i.test(t)) return true;
  return DANGLING_OPENERS.some((r) => r.test(t)) || BACK_REFERENCE.test(t);
}

/** @param {{soft?:boolean}} [opts] soft: ended at a pause in an unpunctuated transcript, not at a full stop */
export function isDanglingEnding(sentence, { soft = false } = {}) {
  const t = sentence.trim();
  if (!soft && !/[.!]["')\]]*$/.test(t) && !/\?["')\]]*$/.test(t)) return true; // whisper left it unpunctuated: probably mid-thought
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
 * moments louder than the talk's median (emphasis, laughter, applause), and laughter whisper
 * marked inside the window or just after it (`win.laughs`, from the non-speech events).
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
  // a question thrown to the listener ("is that too much?", "would you?") invites comments;
  // any other question ending usually means the answer comes after the clip
  add("questionEnding", /\?["')\]]*$/.test(last) ? (ASKS_LISTENER.test(last) ? 0.04 : -0.06) : 0);
  add("exclaim", /!["')\]]*$/.test(last) ? 0.03 : 0);
  const wps = words.length / Math.max(1, dur);
  add("pace", wps >= 2.0 && wps <= 3.6 ? 0.06 : wps < 1.4 ? -0.12 : 0);
  let pauses = 0;
  for (let i = 1; i < win.sentences.length; i++) if (win.sentences[i].s - win.sentences[i - 1].e > 1.0) pauses++;
  add("pauses", -Math.min(0.12, pauses * 0.03));
  const fillers = (win.text.match(FILLERS) || []).length / Math.max(1, words.length);
  add("filler", -Math.min(0.2, fillers * 4));
  // delivery (delivery.mjs): laughter in the window or just after it, a laugh or applause in
  // its second half (the payoff), raised voices, a faster pace than the recording's usual,
  // and quick back-and-forth lines. Without sound events, laughter whisper wrote down counts.
  const d = win.delivery;
  if (d) {
    if (d.laughs) add("laughter", Math.min(0.15, 0.04 * d.laughs + 0.2 * (d.laughP || 0)));
    if (d.late) add("lateBeat", 0.04);
    if (d.applause) add("applause", 0.03);
    if (d.energy) add("energy", Math.min(0.06, 0.02 * d.energy));
    if (d.rate != null) add("rate", d.rate >= 1.15 ? 0.03 : d.rate < 0.7 ? -0.03 : 0);
    if (d.exchanges >= 2) add("exchanges", Math.min(0.04, 0.01 * d.exchanges));
  } else if (win.laughs) add("laughter", Math.min(0.08, win.laughs * 0.04));
  // whisper's own confidence: never let the judge spend a call on words it did not really hear
  if (win.meanP != null) add("confidence", win.meanP < 0.8 ? -Math.min(0.35, (0.8 - win.meanP) * 1.2) : 0);
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

const LAUGH_AFTER = 1.5;
// sentences that set a moment up: a question, or an opener that starts a story, a topic or a turn
const SETUP_OPENERS = /^(so,? |okay,? |wait,? |now,? |but )?(have you ever|do you|did you|would you|are you|is it|what do you|what would|how do you|why do|i remember|one time|the first time|let me tell you|you know what|here'?s the thing|can i (say|tell)|imagine|picture this|so what|what if)\b/i;
/** A sentence that sets a moment up: a question, or an opener that starts a story, a topic or a turn. */
export const isSetup = (text) => /\?["')\]]*$/.test(String(text).trim()) || SETUP_OPENERS.test(String(text).trim());
// a question to the listener: "you", "anyone", "is that ...?", "would you ...?"
const ASKS_LISTENER = /\b(you|your|anyone|anybody|everyone|is that|isn'?t that|are we|would you|do you|have you|right)\b[^.!?]*\?["')\]]*$/i;

/**
 * Make sentence-snapped candidate windows.
 * For each start sentence (at least `stride` seconds after the previous start used) it takes
 * up to four end sentences, spread across the allowed length range (one near its short end,
 * where a setup-to-laugh beat usually fits), plus windows around delivery peaks
 * (delivery.mjs peakWindows: laughter, applause or raised voices, ending just after the beat
 * and starting on the setup before it). Then it drops windows that open on a dangling
 * reference or end mid-thought.
 * `events` are non-speech events (whisper's notes and the on-device sound analysis, sound.mjs);
 * `words` (speech words) give the confidence and the "(laughter)" marks in `cueText`.
 * @returns Candidate[] (unranked, with a `pre` score; time-ordered ids c_0001...)
 */
export function makeCandidates(sentences, { minLen = 20, maxLen = 60, stride = 6, keepRejected = false, loudness = null, words = null, events = null, peaks = true } = {}) {
  const ctx = loudnessContext(loudness);
  const dctx = deliveryContext({ sentences, events: events || [], loudness });
  // a laugh counts for the window it lands in, or the one it follows within LAUGH_AFTER seconds
  const laughs = (events || []).filter((e) => e.type === "laughter");
  const laughsIn = (s, e) => laughs.filter((x) => x.s >= s && x.s <= e + LAUGH_AFTER).length;
  const wins = [];
  let lastStart = -Infinity;
  const targets = [0.04, 0.15, 0.5, 0.9].map((f) => minLen + f * (maxLen - minLen));
  for (let i = 0; i < sentences.length; i++) {
    const s0 = sentences[i];
    // a setup (a question, or a sentence that opens a story or a turn) can always start a
    // window: the stride must not skip the line that sets the moment up
    if (s0.s < lastStart + stride && !isSetup(s0.text)) continue;
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
      wins.push({ start: s0.s, end: sentences[j].e, sentences: sents, text: sents.map((x) => x.text).join(" "), meanP: words ? windowMeanP(words, sents) : null, laughs: laughsIn(s0.s, sentences[j].e) });
    }
  }
  // windows around the beats; one that matches a sentence window only marks it as a peak window
  if (peaks && dctx.beats.length) {
    const have = new Map(wins.map((w) => [`${w.start}|${w.end}`, w]));
    for (const p of peakWindows(sentences, dctx.beats, { minLen, maxLen })) {
      const k = `${p.start}|${p.end}`;
      if (have.has(k)) {
        have.get(k).peak ??= p.peak;
        continue;
      }
      const w = { ...p, meanP: words ? windowMeanP(words, p.sentences) : null, laughs: laughsIn(p.start, p.end) };
      have.set(k, w);
      wins.push(w);
    }
    wins.sort((a, b) => a.start - b.start || a.end - b.end);
  }
  const out = [];
  for (const w of wins) {
    const s0 = w.sentences[0];
    const s1 = w.sentences[w.sentences.length - 1];
    let reject = null;
    if (isDanglingOpener(s0.text, { soft: !!s0.soft })) reject = "opens on a reference to earlier context";
    else if (isDanglingEnding(s1.text, { soft: !!s1.soft })) reject = "ends mid-thought";
    if (reject && !keepRejected) continue;
    if (dctx.beats.length || dctx.wps) w.delivery = deliveryFeatures(w, dctx);
    const cueText = dctx.beats.length && words ? markCues(words, dctx.beats, w.start, w.end) : null;
    out.push({
      id: null,
      rank: null,
      start: +w.start.toFixed(3),
      end: +w.end.toFixed(3),
      text: w.text,
      hook: s0.text,
      scores: null,
      total: null,
      reason: null,
      title: null,
      status: "proposed",
      trimmed: false,
      render: null,
      pre: preScore(w, ctx),
      preParts: w.preParts,
      ...(w.meanP != null ? { meanP: w.meanP } : {}),
      ...(w.delivery ? { delivery: w.delivery } : {}),
      ...(w.peak ? { peak: w.peak } : {}),
      ...(cueText ? { cueText } : {}),
      ...(reject ? { rejected: reject } : {}),
    });
  }
  out.forEach((c, i) => (c.id = `c_${String(i + 1).padStart(4, "0")}`));
  return out;
}

/** Mean word probability over a run of sentences (by their word indexes). */
function windowMeanP(words, sents) {
  const [i0] = sents[0].wordIdx || [];
  const i1 = sents[sents.length - 1].wordIdx?.[1];
  if (i0 == null || i1 == null) return null;
  let sum = 0;
  for (let i = i0; i <= i1; i++) sum += Number.isFinite(words[i]?.p) ? words[i].p : 1;
  return +(sum / (i1 - i0 + 1)).toFixed(3);
}

/** Temporal intersection over union of two {start, end} spans. */
export function iou(a, b) {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  return union > 0 ? inter / union : 0;
}

/**
 * The second stage's input: pick at most n windows for the judge (default 8, because the
 * judge is the slow step). First the best window in each of `segments` equal stretches of
 * the timeline (so one strong stretch cannot crowd out the rest of the video), then the best
 * remaining by pre-score, never keeping two windows that overlap by more than `maxIou`.
 * Segments: n/3. On inputs over 30 minutes, one per 10 minutes when that is more (never
 * more than n), and no stretch may hold more than `perSegment` picks (default twice its fair share, at least 3),
 * so a 2-hour sermon or podcast gets candidates from the whole of it. Up to 30 minutes
 * the picks are exactly as before (the eval measured those), except for windows around
 * a laugh or applause (`c.peak`, delivery.mjs): when there are some, the best of them, up to
 * `peakShare` of n, are taken first, each from a different beat, so a laugh the text rules
 * cannot see still reaches the judge. (Raised-voice peaks compete on the pre-score.)
 */
export function shortlist(cands, { n = 8, maxIou = 0.4, duration, minP = 0.45, perSegment, peakShare = 0.3 } = {}) {
  // drop windows whisper barely heard, as long as enough others are left to choose from
  const heard = cands.filter((c) => c.meanP == null || c.meanP >= minP);
  if (heard.length >= Math.min(n, cands.length) / 2 && heard.length >= 1) cands = heard;
  if (cands.length <= n) return cands.slice();
  const dur = duration ?? Math.max(...cands.map((c) => c.end));
  const byScore = cands.slice().sort((a, b) => b.pre - a.pre || a.start - b.start);
  const chosen = [];
  const ok = (c) => chosen.every((x) => iou(x, c) <= maxIou);
  const long = dur > LONG_INPUT_SEC;
  const buckets = Math.max(1, Math.min(n, Math.max(Math.ceil(n / 3), long ? Math.ceil(dur / LONG_SEGMENT_SEC) : 0)));
  const bucketOf = (c) => Math.min(buckets - 1, Math.floor((c.start / dur) * buckets));
  const cap = long ? perSegment ?? Math.max(3, Math.ceil((2 * n) / buckets)) : Infinity;
  const count = new Array(buckets).fill(0);
  const beatsUsed = new Set();
  for (const c of byScore) {
    if (chosen.length >= Math.floor(n * peakShare)) break;
    if (!c.peak || c.peak.type === "energy" || beatsUsed.has(c.peak.at) || !ok(c) || count[bucketOf(c)] >= cap) continue;
    chosen.push(c);
    beatsUsed.add(c.peak.at);
    count[bucketOf(c)]++;
  }
  for (let b = 0; b < buckets && chosen.length < n; b++) {
    if (count[b]) continue; // this stretch already has a peak window
    const best = byScore.find((c) => bucketOf(c) === b && ok(c));
    if (best) {
      chosen.push(best);
      count[b]++;
    }
  }
  for (const c of byScore) {
    if (chosen.length >= n) break;
    if (!chosen.includes(c) && ok(c) && count[bucketOf(c)] < cap) {
      chosen.push(c);
      count[bucketOf(c)]++;
    }
  }
  return chosen.sort((a, b) => a.start - b.start);
}

/** One segment of the shortlist per 10 minutes of video, at least. */
export const LONG_SEGMENT_SEC = 600;
/** Inputs longer than this cap how many picks one stretch of the timeline may hold. */
export const LONG_INPUT_SEC = 1800;
