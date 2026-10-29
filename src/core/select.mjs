// The selection stage, shared by the desktop app (job.mjs), the browser app (engine.js) and
// the eval (eval/run-eval-v2.mjs), so "we measured what ships" stays literally true.
// Pure and browser-safe: no Node imports.
import { makeCandidates, shortlist } from "./candidates.mjs";
import { speechOnly } from "./nonspeech.mjs";
import { toSentences } from "./sentences.mjs";
import { preWithHearing, windowHearing } from "./hear-core.mjs";

/**
 * The judge's default time budget when judgeN is auto: half the video's length, at least 10
 * minutes (on a CPU, local Gemma takes 40 to 80 s a window; Smart mode about 3 s).
 */
export const judgeBudgetSec = (duration) => Math.max(600, 0.5 * (duration || 0));
/** Above this share of looped words, a transcript's worst loop counts against all of it (quality.mjs). */
export const LOOP_SHARE = 0.02;

/**
 * The stretches to keep out of the shortlist: where whisper looped in an otherwise clean
 * transcript (transcriptQuality's `loops`). When loops cover more than LOOP_SHARE of the
 * words the transcript gate deals with it instead, so nothing is excluded (with --force on a
 * looping transcript, the person asked to judge it anyway). The app and the eval both use it.
 * @param {{loops?: {s:number, e:number}[], loopShare?: number}|null} q
 */
export function loopExclusions(q) {
  return q?.loops?.length && q.loopShare <= LOOP_SHARE ? q.loops : [];
}

/** Never read more than this many windows in one job. */
export const JUDGE_MAX = 120;

/**
 * How many windows the judge reads. Auto (judgeN null or "auto"): max(16, 2k, one per
 * PER_WINDOW_SEC of recording), so the whole of a long recording is read (a 51-minute
 * podcast: 41 windows, where one per 5 minutes gave 16), then capped by the time budget
 * (judgeBudgetSec) at the model's measured speed, but never below what k clips need (k plus a
 * fifth). Smart mode (about 3 s a call) is never capped below that; Gemma on a CPU (40 to
 * 100 s a call) is, and `estSec` says how long the judging will take. An explicit judgeN is
 * kept, raised only to what k clips need, since 30 clips cannot come out of 8 judged windows.
 * @param {{k?:number, duration?:number|null, judgeN?:number|string|null, secPerCall?:number|null, budgetSec?:number|null}} o
 * @returns {{n:number, auto:boolean, capped:boolean, floor:number, estSec:number|null}}
 */
export function judgeCount({ k = null, duration = null, judgeN = null, secPerCall = null, budgetSec = judgeBudgetSec(duration) } = {}) {
  const floor = k ? k + Math.ceil(k / 5) : 0;
  const explicit = judgeN != null && judgeN !== "auto" && judgeN !== "" && Number.isFinite(Number(judgeN)) && Number(judgeN) > 0;
  const est = (n) => (secPerCall > 0 ? Math.round(n * secPerCall) : null);
  if (explicit) {
    const n = Math.min(JUDGE_MAX, Math.max(Math.round(Number(judgeN)), floor));
    return { n, auto: false, capped: false, floor, estSec: est(n) };
  }
  const want = Math.max(16, k ? 2 * k : 0, duration ? Math.ceil(duration / PER_WINDOW_SEC) : 0);
  let n = want;
  let capped = false;
  if (secPerCall > 0 && budgetSec > 0) {
    const fits = Math.max(floor, Math.floor(budgetSec / secPerCall));
    if (fits < n) {
      n = fits;
      capped = true;
    }
  }
  n = Math.min(JUDGE_MAX, Math.max(n, 1));
  return { n, auto: true, capped, floor, estSec: est(n) };
}

/** Auto judgeN reads one window per this many seconds of recording (before the time budget). */
export const PER_WINDOW_SEC = 75;

/**
 * Words -> sentences -> candidate windows (with the pre-score) -> the shortlist the judge reads.
 * Sentences and windows are built from speech only; non-speech events (laughter) and the
 * loudness track feed the pre-score.
 * @param {{ words: object[], events?: object[]|null, loudness?: {step:number, db:number[]}|null,
 *           settings?: { minLen?: number, maxLen?: number, stride?: number, judgeN?: number },
 *           duration?: number|null, judge?: { secPerCall?: number|null, budgetSec?: number|null } }} input
 *   judge: the judge's measured seconds per call and the time budget, for an auto judgeN
 *   exclude: [{ s, e }] stretches to keep out of the shortlist (whisper loops)
 *   hearing: [{ s, e, score }] the hearing judge's stretch scores (hear-core.mjs), or null. When
 *     given, every window gets `hear` (its best overlapping stretch) and the shortlist is drawn
 *     by the pre-score mixed with it, so a moment that sounds alive can reach the judge even
 *     when its words look ordinary. Each window's own `pre` is unchanged.
 * @returns {{ sentences: object[], windows: object[], shortlist: object[], judgeN: object }}
 */
export function selectCandidates({ words, events = null, loudness = null, settings = {}, duration = null, judge = {}, exclude = [], hearing = null }) {
  const speech = speechOnly(words || []);
  const sentences = toSentences(speech);
  const windows = makeCandidates(sentences, {
    minLen: settings.minLen ?? 20,
    maxLen: settings.maxLen ?? 60,
    stride: settings.stride ?? 6,
    loudness,
    words: speech,
    events: events || [],
  });
  const count = judgeCount({ k: settings.k ?? null, duration, judgeN: settings.judgeN ?? null, secPerCall: judge.secPerCall ?? null, budgetSec: judge.budgetSec ?? settings.judgeBudgetSec ?? judgeBudgetSec(duration) });
  // stretches where whisper looped (transcriptQuality's `loops`) never become clips
  const usable = exclude?.length ? windows.filter((w) => !exclude.some((x) => w.start < x.e && w.end > x.s)) : windows;
  if (hearing?.length) for (const w of windows) w.hear = windowHearing(w, hearing);
  // with hearing, the shortlist is drawn on a mixed score; the windows it returns are the originals
  const byId = new Map(usable.map((w) => [w.id, w]));
  const pool = hearing?.length ? usable.map((w) => ({ ...w, pre: preWithHearing(w.pre, w.hear) })) : usable;
  const short = shortlist(pool, { n: count.n, duration: duration ?? undefined }).map((w) => byId.get(w.id));
  return { sentences, windows, shortlist: short, judgeN: count };
}
