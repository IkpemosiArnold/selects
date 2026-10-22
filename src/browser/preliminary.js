// Early picks while the transcript is still arriving: after the first few minutes, the
// model-free first-stage score (sentence shape, pauses, laughter, loudness; the same
// selectCandidates the final ranking starts from) picks the best 1 to 3 windows from the text
// so far. They are previews only: shown in the page by seeking the video, never rendered
// until approved, and replaced by the judged ranking when it is ready. Pure, tested in Node.
import { selectCandidates } from "../core/select.mjs";

export const FIRST_AFTER_SEC = 180; // the first picks after about 3 minutes of transcript
export const EVERY_SEC = 60; // then refreshed about every minute of new transcript

const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) / Math.max(1e-6, Math.min(a.end - a.start, b.end - b.start));

/**
 * The best `n` windows wholly inside the transcript so far (`upTo` seconds heard), not
 * overlapping each other by more than a fifth. Windows that touch the edge of what is heard
 * are left out: their last sentence may not be finished yet.
 */
export function preliminaryPicks({ words, events = [], loudness = null, settings = {}, upTo, n = 3, edgeSec = 3 }) {
  if (!words?.length) return [];
  const sel = selectCandidates({ words, events, loudness, settings: { ...settings, judgeN: 8 }, duration: upTo });
  const done = sel.windows.filter((w) => w.end <= upTo - edgeSec);
  const out = [];
  for (const w of done.slice().sort((a, b) => b.pre - a.pre || a.start - b.start)) {
    if (out.length >= n) break;
    if (out.every((x) => overlap(x, w) <= 0.2)) out.push(w);
  }
  return out.map((w) => ({ id: w.id, start: w.start, end: w.end, text: w.text, hook: w.hook, pre: w.pre, preliminary: true }));
}

/**
 * When to recompute: the first time `upTo` passes firstAfter (or the whole recording is in,
 * if it is shorter), then every `every` seconds of new transcript, and once at the end.
 */
export function dueForPicks({ upTo, lastAt = null, duration, firstAfter = FIRST_AFTER_SEC, every = EVERY_SEC }) {
  const end = upTo >= duration - 1;
  if (lastAt == null) return upTo >= Math.min(firstAfter, duration - 1);
  return end ? lastAt < duration - 1 : upTo - lastAt >= every;
}
