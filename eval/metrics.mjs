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

// ---------- v2: per-window ranking metrics and tests ----------

/** Average ranks (1-based), ties get the mean rank. */
export function ranks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

/**
 * AUC: probability that a positive scores above a negative (ties count one half), computed
 * with the Mann-Whitney U statistic. null when either class is empty.
 */
export function auc(scores, positive) {
  const n1 = positive.filter(Boolean).length, n0 = positive.length - n1;
  if (!n1 || !n0) return null;
  const r = ranks(scores);
  let sum = 0;
  for (let i = 0; i < r.length; i++) if (positive[i]) sum += r[i];
  return (sum - (n1 * (n1 + 1)) / 2) / (n1 * n0);
}

/** Spearman rank correlation (Pearson on average ranks). null if either side is constant. */
export function spearman(x, y) {
  if (x.length < 3) return null;
  const rx = ranks(x), ry = ranks(y);
  const mx = mean(rx), my = mean(ry);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < rx.length; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my);
    sxx += (rx[i] - mx) ** 2;
    syy += (ry[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Above-median labels within one set (strictly above the median is positive). */
export function aboveMedian(values) {
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return values.map((v) => v > m);
}

/**
 * Two-sided sign-flip permutation test for mean(d) = 0 (paired differences, or a one-sample
 * test of x - mu). Exact over all 2^n sign patterns when n <= 20, else `iters` random flips.
 */
export function signFlipTest(d, { iters = 100000, seed = 11 } = {}) {
  const xs = d.filter((x) => x != null && !Number.isNaN(x));
  const n = xs.length;
  if (!n) return { n: 0, mean: null, p: null };
  const obs = Math.abs(xs.reduce((a, b) => a + b, 0));
  const eps = 1e-12;
  let extreme = 0, total = 0;
  if (n <= 20) {
    for (let mask = 0; mask < 1 << n; mask++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += mask & (1 << i) ? -xs[i] : xs[i];
      if (Math.abs(s) >= obs - eps) extreme++;
      total++;
    }
  } else {
    const r = rng(seed);
    for (let k = 0; k < iters; k++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += r() < 0.5 ? -xs[i] : xs[i];
      if (Math.abs(s) >= obs - eps) extreme++;
      total++;
    }
    extreme++; total++; // count the observed pattern itself
  }
  return { n, mean: obs === 0 ? 0 : mean(xs), p: extreme / total };
}

/** Holm step-down adjustment. Returns adjusted p-values in the input order. */
export function holm(ps) {
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(ps.length);
  let running = 0;
  order.forEach(([p, i], k) => {
    running = Math.max(running, Math.min(1, p * (ps.length - k)));
    out[i] = running;
  });
  return out;
}

/** Wilson score interval for k successes in n trials. */
export function wilson(k, n, z = 1.959964) {
  if (!n) return { p: null, lo: null, hi: null, n: 0 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, lo: (c - h) / d, hi: (c + h) / d, n };
}
