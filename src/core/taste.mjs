// Taste: learn what this creator posts from their own Post and Skip answers, on their device.
//
// A generic "what is viral" judge did not find one creator's picks (eval/results and
// notes/TASTE.md). So the review shows about ten distinct clips, the person marks each one
// Post or Skip, and a small model learns from those answers. It never sees words or audio:
// each answer keeps only the numbers the pipeline already computed for that window (the
// judge's sub-scores, the pre-score, the hearing score, laughter and the like, its length).
//
// The model is L2-regularised logistic regression over standardised features, fitted with a
// few Newton steps (fast enough to refit in the tab after every answer). It joins the ranking
// only when there are enough answers (TASTE_RULE.minLabels, with both Post and Skip present),
// and even then it is blended with the generic ranking at a weight that grows with the
// number of answers, so a handful of answers moves the order a little, never all of it.
//
// No Node imports: the desktop app, the CLI and the browser build share this file.

/** The numbers a label keeps, in this order. Words and audio are never stored. */
export const TASTE_FEATURES = [
  "moment", // judge sub-scores, 1 to 5 (null when no model judged the clip)
  "share",
  "hook",
  "standalone",
  "pre", // the text and delivery pre-score, 0 to 1
  "hear", // the hearing judge's score, 0 to 1 (null when hearing was off)
  "laughs", // laughs in or just after the window (capped at 3)
  "laughP", // the strongest laugh's confidence
  "lateBeat", // a laugh or applause in the second half (the payoff), 0 or 1
  "energy", // raised-voice peaks (capped at 4)
  "exchanges", // very short lines, a stand-in for quick turns between speakers (capped at 6)
  "pace", // speaking rate against the recording's usual
  "len", // length in minutes
  "peak", // the window was built around a laugh or a raised voice, 0 or 1
];

/**
 * When and how much the taste model counts. Fixed before any evaluation (see
 * eval/TASTE-PLAN.md; the private test's protocol stays with its data); not tuned on either.
 *   minLabels  answers needed before it joins the ranking (and at least one Post and one Skip)
 *   maxWeight  the most it can ever count against the generic ranking
 *   half       with this many answers in the smaller class, it counts half of maxWeight
 *   l2         ridge penalty on the standardised weights (in units of answers)
 */
export const TASTE_RULE = { minLabels: 8, maxWeight: 0.6, half: 8, l2: 4 };

/** Keep at most this many answers (the oldest go first). */
export const TASTE_MAX_LABELS = 2000;

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const cap = (x, hi) => (x == null ? null : Math.min(hi, x));

/** A candidate's feature values ({ name: number | null }), from what the pipeline already put on it. */
export function tasteFeatures(c) {
  const s = c?.scores && c.scores.moment != null ? c.scores : null;
  const d = c?.delivery || null;
  const start = num(c?.origStart) ?? num(c?.start);
  const end = num(c?.origEnd) ?? num(c?.end);
  return {
    moment: s ? num(Number(s.moment)) : null,
    share: s ? num(Number(s.share)) : null,
    hook: s ? num(Number(s.hook)) : null,
    standalone: s ? num(Number(s.standalone)) : null,
    pre: num(c?.pre),
    hear: num(c?.hear),
    laughs: d ? cap(d.laughs || 0, 3) : num(c?.laughs) != null ? cap(c.laughs, 3) : null,
    laughP: d ? num(d.laughP) ?? 0 : null,
    lateBeat: d ? (d.late ? 1 : 0) : null,
    energy: d ? cap(d.energy || 0, 4) : null,
    exchanges: d ? cap(d.exchanges || 0, 6) : null,
    pace: d && num(d.rate) != null ? Math.max(0.3, Math.min(2, d.rate)) : null,
    len: start != null && end != null ? +((end - start) / 60).toFixed(3) : null,
    peak: c?.peak ? 1 : 0,
  };
}

/**
 * One answer, as stored: { k, job, label, by, at, f }. `job` is the job's id (desktop) or
 * the video's content hash (browser), `k` names the clip within it, so answering the same
 * clip again replaces the answer. No text, no times, no audio.
 * label: "post" or "skip"; by: "review", "download" or "cli".
 */
export function labelRecord(job, c, label, { by = "review", at = new Date().toISOString() } = {}) {
  if (label !== "post" && label !== "skip") throw new Error(`label must be post or skip, not ${label}`);
  const f = tasteFeatures(c);
  for (const k of Object.keys(f)) if (f[k] != null) f[k] = +f[k].toFixed(4);
  return { k: `${job}:${c.id}`, job: String(job), label, by, at, f };
}

/** The label a review status means: approved is a Post, skipped a Skip, proposed takes the answer back. */
export const labelForStatus = (status) => (status === "approved" ? "post" : status === "skipped" ? "skip" : null);

/** Add or replace an answer (by `k`); label null removes it. Returns a new array, oldest first. */
export function upsertLabel(labels, rec, { max = TASTE_MAX_LABELS } = {}) {
  const rest = (labels || []).filter((x) => x.k !== rec.k);
  if (!rec.label) return rest;
  rest.push(rec);
  return rest.length > max ? rest.slice(rest.length - max) : rest;
}

/** Remove an answer by key. */
export const removeLabel = (labels, k) => (labels || []).filter((x) => x.k !== k);

/** How much the model counts with these counts (0 below the rule's minimum). */
export function tasteWeight(posts, skips, rule = TASTE_RULE) {
  if (posts + skips < rule.minLabels || !posts || !skips) return 0;
  const m = Math.min(posts, skips);
  return +(rule.maxWeight * (m / (m + rule.half))).toFixed(4);
}

/** { n, posts, skips, active, weight, need } for a set of answers, without fitting anything. */
export function tasteStatus(labels, rule = TASTE_RULE) {
  const ok = (labels || []).filter((x) => x && (x.label === "post" || x.label === "skip") && x.f);
  const posts = ok.filter((x) => x.label === "post").length;
  const skips = ok.length - posts;
  const weight = tasteWeight(posts, skips, rule);
  return { n: ok.length, posts, skips, active: weight > 0, weight, need: Math.max(0, rule.minLabels - ok.length) };
}

const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Solve A x = b (A symmetric positive definite, small) by Gaussian elimination with pivoting. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      if (f) for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * Fit the taste model on a set of answers. Returns
 *   { v, features, mean, std, w, b, n, posts, skips, active, weight }
 * `w` is null when there is nothing to fit (no answers, or only one class). Features that
 * never vary in the answers get weight 0. Missing values count as the answers' mean.
 * Posts and Skips weigh the same in total (balanced), so a person who skips most clips
 * does not teach the model that everything is a Skip.
 */
export function trainTaste(labels, { rule = TASTE_RULE, features = TASTE_FEATURES, iters = 30 } = {}) {
  const status = tasteStatus(labels, rule);
  const base = { v: 1, features, n: status.n, posts: status.posts, skips: status.skips, active: status.active, weight: status.weight };
  if (!status.posts || !status.skips) return { ...base, mean: null, std: null, w: null, b: 0 };
  const rows = labels.filter((x) => x && (x.label === "post" || x.label === "skip") && x.f);
  const d = features.length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (let j = 0; j < d; j++) {
    const vals = rows.map((r) => num(r.f[features[j]])).filter((x) => x != null);
    if (vals.length < 2) continue;
    const m = vals.reduce((a, x) => a + x, 0) / vals.length;
    const v = vals.reduce((a, x) => a + (x - m) ** 2, 0) / vals.length;
    mean[j] = m;
    std[j] = Math.sqrt(v);
  }
  const use = std.map((s) => s > 1e-9);
  const X = rows.map((r) => features.map((k, j) => (use[j] && num(r.f[k]) != null ? (r.f[k] - mean[j]) / std[j] : 0)));
  const y = rows.map((r) => (r.label === "post" ? 1 : 0));
  const n = rows.length;
  const cw = [n / (2 * (n - status.posts)), n / (2 * status.posts)]; // balanced: [skip, post]
  // parameters: d weights and a bias (last); the bias is not penalised
  let w = new Array(d + 1).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(d + 1).fill(0);
    const H = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const xi = [...X[i], 1];
      let z = 0;
      for (let j = 0; j <= d; j++) z += w[j] * xi[j];
      const p = sigmoid(z);
      const c = cw[y[i]];
      const r = c * (p - y[i]);
      const h = c * p * (1 - p);
      for (let j = 0; j <= d; j++) {
        g[j] += r * xi[j];
        for (let k = j; k <= d; k++) H[j][k] += h * xi[j] * xi[k];
      }
    }
    for (let j = 0; j <= d; j++) for (let k = 0; k < j; k++) H[j][k] = H[k][j];
    for (let j = 0; j < d; j++) {
      g[j] += rule.l2 * w[j];
      H[j][j] += rule.l2 + (use[j] ? 0 : 1); // an unused feature stays at 0
    }
    H[d][d] += 1e-6;
    const step = solve(H, g);
    if (!step) break;
    w = w.map((x, j) => x - step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-7) break;
  }
  const round = (x) => +x.toFixed(6);
  return { ...base, mean: mean.map(round), std: std.map(round), w: w.slice(0, d).map((x, j) => (use[j] ? round(x) : 0)), b: round(w[d]) };
}

/** The model's score for a candidate (a logit: higher means more like what this person posts). */
export function tasteLogit(model, c) {
  if (!model?.w) return 0;
  const f = tasteFeatures(c);
  let z = model.b || 0;
  model.features.forEach((k, j) => {
    const x = num(f[k]);
    if (x == null || !model.std[j]) return;
    z += model.w[j] * ((x - model.mean[j]) / model.std[j]);
  });
  return z;
}

/** Mid-rank percentiles (0..1) of a list of numbers; one value gives 0.5. */
export function percentiles(xs) {
  const n = xs.length;
  if (n < 2) return xs.map(() => 0.5);
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(n);
  for (let i = 0; i < n; ) {
    let j = i;
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
    const p = (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out[idx[k][1]] = p;
    i = j + 1;
  }
  return out;
}

/**
 * Blend the taste model into a job's judged candidates. Each candidate with a total gets
 *   taste  0..1, how much it looks like what this person posts (for display and logs)
 *   order  (1 - weight) x percentile(total) + weight x percentile(taste), what the ranking sorts by
 * `total` (the generic score, which the quality bar reads) is left as it is. Without an
 * active model, `taste` and `order` are removed, so the generic order stands.
 * `weight` may be passed to override the model's own (the eval uses it); 0 turns it off.
 */
export function applyTaste(cands, model, { weight = model?.weight ?? 0 } = {}) {
  const strip = (c) => {
    if (c.order === undefined && c.taste === undefined) return c;
    const { order: _o, taste: _t, ...rest } = c;
    return rest;
  };
  if (!model?.w || !(weight > 0)) return cands.map(strip);
  const scored = cands.map((c, i) => [c, i]).filter(([c]) => typeof c.total === "number");
  const z = scored.map(([c]) => tasteLogit(model, c));
  const pg = percentiles(scored.map(([c]) => c.total));
  const pt = percentiles(z);
  const out = cands.map(strip);
  scored.forEach(([c, i], k) => {
    out[i] = { ...out[i], taste: +sigmoid(z[k]).toFixed(3), order: +((1 - weight) * pg[k] + weight * pt[k]).toFixed(4) };
  });
  return out;
}

/** What the review says about the model: { n, posts, skips, active, weight, need }. */
export const tasteSummary = (model) => (model ? { n: model.n, posts: model.posts, skips: model.skips, active: !!(model.active && model.w), weight: model.active && model.w ? model.weight : 0, need: Math.max(0, TASTE_RULE.minLabels - model.n) } : null);

/** The quiet line the review shows, or null with no answers yet. */
export function tasteLine(s) {
  if (!s || !s.n) return null;
  if (s.active) return `Learning from your ${s.n} pick${s.n === 1 ? "" : "s"}`;
  if (s.n < TASTE_RULE.minLabels) return `${s.n} pick${s.n === 1 ? "" : "s"} so far. Your taste joins the ranking at ${TASTE_RULE.minLabels}`;
  return s.posts ? "Skip one clip too, so Selects can learn the difference" : "Post one clip too, so Selects can learn the difference";
}
