// The selection stage, shared by the desktop app (job.mjs), the browser app (engine.js) and
// the eval (eval/run-eval-v2.mjs), so "we measured what ships" stays literally true.
// Pure and browser-safe: no Node imports.
import { makeCandidates, shortlist } from "./candidates.mjs";
import { speechOnly } from "./nonspeech.mjs";
import { toSentences } from "./sentences.mjs";

/**
 * The judge's default time budget when judgeN is auto: half the video's length, at least 10
 * minutes (on a CPU, local Gemma takes 40 to 80 s a window; Smart mode about 3 s).
 */
export const judgeBudgetSec = (duration) => Math.max(600, 0.5 * (duration || 0));
/** Never read more than this many windows in one job. */
export const JUDGE_MAX = 120;

/**
 * How many windows the judge reads. Auto (judgeN null or "auto"): max(16, 2k, one per 5
 * minutes of video), then capped by the time budget (judgeBudgetSec) at the model's measured speed, but never
 * below what k clips need (k plus a fifth). An explicit judgeN is kept, raised only to what
 * k clips need, since 30 clips cannot come out of 8 judged windows.
 * @param {{k?:number, duration?:number|null, judgeN?:number|string|null, secPerCall?:number|null, budgetSec?:number|null}} o
 * @returns {{n:number, auto:boolean, capped:boolean, floor:number}}
 */
export function judgeCount({ k = null, duration = null, judgeN = null, secPerCall = null, budgetSec = judgeBudgetSec(duration) } = {}) {
  const floor = k ? k + Math.ceil(k / 5) : 0;
  const explicit = judgeN != null && judgeN !== "auto" && Number.isFinite(Number(judgeN)) && Number(judgeN) > 0;
  if (explicit) return { n: Math.min(JUDGE_MAX, Math.max(Math.round(Number(judgeN)), floor)), auto: false, capped: false, floor };
  const want = Math.max(16, k ? 2 * k : 0, duration ? Math.ceil(duration / 300) : 0);
  let n = want;
  let capped = false;
  if (secPerCall > 0 && budgetSec > 0) {
    const fits = Math.max(floor, Math.floor(budgetSec / secPerCall));
    if (fits < n) {
      n = fits;
      capped = true;
    }
  }
  return { n: Math.min(JUDGE_MAX, Math.max(n, 1)), auto: true, capped, floor };
}

/**
 * Words -> sentences -> candidate windows (with the pre-score) -> the shortlist the judge reads.
 * Sentences and windows are built from speech only; non-speech events (laughter) and the
 * loudness track feed the pre-score.
 * @param {{ words: object[], events?: object[]|null, loudness?: {step:number, db:number[]}|null,
 *           settings?: { minLen?: number, maxLen?: number, stride?: number, judgeN?: number },
 *           duration?: number|null, judge?: { secPerCall?: number|null, budgetSec?: number|null } }} input
 *   judge: the judge's measured seconds per call and the time budget, for an auto judgeN
 *   exclude: [{ s, e }] stretches to keep out of the shortlist (whisper loops)
 * @returns {{ sentences: object[], windows: object[], shortlist: object[], judgeN: object }}
 */
export function selectCandidates({ words, events = null, loudness = null, settings = {}, duration = null, judge = {}, exclude = [] }) {
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
  const short = shortlist(usable, { n: count.n, duration: duration ?? undefined });
  return { sentences, windows, shortlist: short, judgeN: count };
}
