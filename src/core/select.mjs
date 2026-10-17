// The selection stage, shared by the desktop app (job.mjs), the browser app (engine.js) and
// the eval (eval/run-eval-v2.mjs), so "we measured what ships" stays literally true.
// Pure and browser-safe: no Node imports.
import { makeCandidates, shortlist } from "./candidates.mjs";
import { speechOnly } from "./nonspeech.mjs";
import { toSentences } from "./sentences.mjs";

/**
 * Words -> sentences -> candidate windows (with the pre-score) -> the shortlist the judge reads.
 * Sentences and windows are built from speech only; non-speech events (laughter) and the
 * loudness track feed the pre-score.
 * @param {{ words: object[], events?: object[]|null, loudness?: {step:number, db:number[]}|null,
 *           settings?: { minLen?: number, maxLen?: number, stride?: number, judgeN?: number },
 *           duration?: number|null }} input
 * @returns {{ sentences: object[], windows: object[], shortlist: object[] }}
 */
export function selectCandidates({ words, events = null, loudness = null, settings = {}, duration = null }) {
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
  const short = shortlist(windows, { n: settings.judgeN ?? 8, duration: duration ?? undefined });
  return { sentences, windows, shortlist: short };
}
