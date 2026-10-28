// Ranking with non-maximum suppression on time overlap, and the interest curve.
import { iou } from "./candidates.mjs";

const score = (c) => (typeof c.total === "number" ? c.total : -1);
const h2h = (c) => (Number.isFinite(c.h2hRank) ? c.h2hRank : Infinity);

/**
 * The ranking order: clips placed by the head-to-head round (h2hRank, h2h-core.mjs) first, in
 * that order; then by judge total, ties broken by the cheap pre-score, then the earlier start.
 */
export function byRank(a, b) {
  const ha = h2h(a);
  const hb = h2h(b);
  if (ha !== hb) return ha === Infinity ? 1 : hb === Infinity ? -1 : ha - hb;
  return score(b) - score(a) || (b.pre ?? 0) - (a.pre ?? 0) || a.start - b.start;
}

/**
 * Sort in the ranking order (byRank), then walk down the list keeping a candidate only if it
 * overlaps every kept one by at most `iou`. Returns the top k with rank 1..k set. Does not
 * mutate the input.
 */
export function rank(candidates, { k = 5, iou: maxIou = 0.3 } = {}) {
  const sorted = candidates.slice().sort(byRank);
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

/**
 * The quality bar: a clip is strong when its total is STRONG_TOTAL or more. Calibrated on the
 * jobs on this machine (notes/timings.md): a private phone video whose clips the judge itself called
 * weak topped out at 0.52 (0.40 to 0.52), the EMF talk scored 0.56 to 0.68, and the best clip
 * of each of the 6 eval videos scored 0.60 to 0.68.
 */
export const STRONG_TOTAL = 0.55;

/**
 * { strong, threshold, best, note } for the ranked picks. A misleading cut that nobody
 * accepted (demoted) never counts as strong.
 */
export function qualityVerdict(cands, { threshold = STRONG_TOTAL } = {}) {
  const totals = cands.map((c) => c.total).filter((t) => typeof t === "number");
  const best = totals.length ? Math.max(...totals) : null;
  const strong = cands.filter((c) => typeof c.total === "number" && c.total >= threshold && !c.demoted).length;
  const weak = cands.length - strong;
  let note;
  if (!cands.length) note = "No clips were found in this video.";
  else if (!strong) note = `No strong clips in this video. ${cands.length === 1 ? "This is the closest one" : `These are the closest ${cands.length}`}, with why.`;
  else if (!weak) note = `${strong} strong clip${strong === 1 ? "" : "s"}.`;
  else note = `${strong} strong clip${strong === 1 ? "" : "s"}. The other ${weak} ${weak === 1 ? "is" : "are"} weaker.`;
  return { strong, threshold, best, note };
}

/**
 * Apply the bar to the ranked picks: each gets `weak` (true below the bar), and when none is
 * strong only the closest `closest` (default 2) are kept. Returns { candidates, verdict }.
 */
export function applyQualityBar(cands, { threshold = STRONG_TOTAL, closest = 2 } = {}) {
  const marked = cands.map((c) => ({ ...c, weak: !(typeof c.total === "number" && c.total >= threshold && !c.demoted) }));
  const anyStrong = marked.some((c) => !c.weak);
  const kept = anyStrong ? marked : marked.slice(0, closest).map((c, i) => ({ ...c, rank: i + 1 }));
  return { candidates: kept, verdict: qualityVerdict(kept, { threshold }) };
}
