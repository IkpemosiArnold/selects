// Ranking with non-maximum suppression on time overlap, and the interest curve.
import { iou } from "./candidates.mjs";

const score = (c) => (typeof c.total === "number" ? c.total : -1);

/**
 * Sort by judge total (ties broken by the cheap pre-score, then earlier start), then walk
 * down the list keeping a candidate only if it overlaps every kept one by at most `iou`.
 * Returns the top k with rank 1..k set. Does not mutate the input.
 */
export function rank(candidates, { k = 5, iou: maxIou = 0.3 } = {}) {
  const sorted = candidates
    .slice()
    .sort((a, b) => score(b) - score(a) || (b.pre ?? 0) - (a.pre ?? 0) || a.start - b.start);
  const kept = [];
  for (const c of sorted) {
    if (kept.length >= k) break;
    if (kept.every((x) => iou(x, c) <= maxIou)) kept.push(c);
  }
  return kept.map((c, i) => ({ ...c, rank: i + 1 }));
}

/**
 * Interest curve: one point every `step` seconds. Each point takes the best judge total of
 * any candidate covering that moment (0 where nothing was judged), then a 3-point moving
 * average smooths it so the line reads as a curve rather than a bar chart.
 */
export function curve(candidates, duration, { step = 5 } = {}) {
  const n = Math.max(1, Math.ceil(duration / step) + 1);
  const raw = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const t = Math.min(duration, i * step);
    for (const c of candidates) {
      if (typeof c.total === "number" && c.start <= t && t <= c.end && c.total > raw[i]) raw[i] = c.total;
    }
  }
  return raw.map((_, i) => {
    const win = raw.slice(Math.max(0, i - 1), Math.min(n, i + 2));
    const v = win.reduce((a, b) => a + b, 0) / win.length;
    return { t: +Math.min(duration, i * step).toFixed(2), v: +Math.max(0, Math.min(1, v)).toFixed(3) };
  });
}
