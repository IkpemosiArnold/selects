// Metrics for comparing predicted clip windows against labelled moments.
// All windows are { start, end } in seconds. Pure functions, no I/O.

/** Temporal intersection over union of two windows. 0 when they do not overlap. */
export function tiou(a, b) {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  if (inter <= 0) return 0;
  const union = Math.max(a.end, b.end) - Math.min(a.start, b.start);
  return union > 0 ? inter / union : 0;
}

/** Best IoU of one window against a list of windows. */
export function bestIoU(win, others) {
  let best = 0;
  for (const o of others) best = Math.max(best, tiou(win, o));
  return best;
}

/**
 * hit@k: 1 if any of the first k predictions has IoU >= thr with any label, else 0.
 * predictions must already be in rank order (best first).
 */
export function hitAtK(preds, labels, k, thr = 0.5) {
  return preds.slice(0, k).some((p) => bestIoU(p, labels) >= thr) ? 1 : 0;
}

/** precision@k: share of the first k predictions that hit a label. Divides by k, so missing predictions count as misses. */
export function precisionAtK(preds, labels, k, thr = 0.5) {
  if (k <= 0) return 0;
  let hits = 0;
  for (const p of preds.slice(0, k)) if (bestIoU(p, labels) >= thr) hits++;
  return hits / k;
}

/** recall@k: share of labels matched (IoU >= thr) by at least one of the first k predictions. */
export function recallAtK(preds, labels, k, thr = 0.5) {
  if (!labels.length) return 0;
  const top = preds.slice(0, k);
  let found = 0;
  for (const l of labels) if (bestIoU(l, top) >= thr) found++;
  return found / labels.length;
}

/** Mean over the first k predictions of each prediction's best IoU with any label. */
export function meanBestIoU(preds, labels, k) {
  const top = preds.slice(0, k);
  if (!top.length) return 0;
  return top.reduce((s, p) => s + bestIoU(p, labels), 0) / top.length;
}

/** All metrics for one video and one method. */
export function scoreVideo(preds, labels, { thr = 0.5 } = {}) {
  return {
    hit3: hitAtK(preds, labels, 3, thr),
    hit5: hitAtK(preds, labels, 5, thr),
    p3: precisionAtK(preds, labels, 3, thr),
    p5: precisionAtK(preds, labels, 5, thr),
    r5: recallAtK(preds, labels, 5, thr),
    miou5: meanBestIoU(preds, labels, 5),
  };
}

/** Small seeded PRNG (mulberry32). Returns a function giving floats in [0, 1). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
}

/**
 * Percentile bootstrap confidence interval for the mean of per-video values.
 * Returns { mean, lo, hi, n }. With n < 3 the interval is not meaningful and lo/hi are null.
 */
export function bootstrapCI(values, { iters = 2000, alpha = 0.05, seed = 42 } = {}) {
  const n = values.length;
  const m = mean(values);
  if (n < 3) return { mean: m, lo: null, hi: null, n };
  const r = rng(seed);
  const means = new Float64Array(iters);
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += values[Math.floor(r() * n)];
    means[i] = s / n;
  }
  means.sort();
  const q = (p) => means[Math.min(iters - 1, Math.max(0, Math.floor(p * iters)))];
  return { mean: m, lo: q(alpha / 2), hi: q(1 - alpha / 2), n };
}

/**
 * Paired bootstrap: probability-style check that method A beats method B on the same videos.
 * Returns { diff, lo, hi } for mean(A - B).
 */
export function pairedBootstrap(a, b, opts = {}) {
  const d = a.map((x, i) => x - b[i]);
  const ci = bootstrapCI(d, opts);
  return { diff: ci.mean, lo: ci.lo, hi: ci.hi, n: ci.n };
}
