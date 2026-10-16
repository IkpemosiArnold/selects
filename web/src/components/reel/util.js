import { api } from "../../lib/api.js";
import { toSentences } from "../../lib/sentences.js";

export const RUBRIC = [
  ["hook", "Hook"],
  ["standalone", "Stands alone"],
  ["payoff", "Payoff"],
  ["clarity", "Clarity"],
];

/** The filmstrip still nearest t (one per few seconds, already on disk). */
export function thumbAt(job, t) {
  const th = job?.thumbs;
  if (!th?.count) return null;
  const n = Math.min(th.count, Math.max(1, Math.floor((t || 0) / (th.interval || 1)) + 1));
  return api.thumbUrl(job.id, n);
}

/** Candidates in the order the model ranked them; ones it did not rank go last, by time. */
export function byRank(cands) {
  return [...(cands || [])].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.start - b.start);
}

/** The clip's first sentence, from the reviewed captions when they were edited. */
export function firstLine(c, capWords, edited) {
  if (!edited || !capWords?.length) return c.hook || c.text || "";
  const ws = capWords.filter((w) => (w.s + w.e) / 2 >= c.start && (w.s + w.e) / 2 <= c.end);
  if (!ws.length) return c.hook || "";
  return toSentences(ws)[0]?.text || c.hook;
}

export const clipName = (c) => (c?.rank ? `Clip ${c.rank}` : "Your clip");
