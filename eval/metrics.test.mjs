import { test } from "node:test";
import assert from "node:assert/strict";
import { tiou, bestIoU, hitAtK, precisionAtK, recallAtK, meanBestIoU, bootstrapCI, pairedBootstrap, rng, scoreVideo } from "./metrics.mjs";
import { heatmapToLabels } from "./heatmap.mjs";

const w = (start, end) => ({ start, end });

test("tiou: identical, disjoint, touching, nested, partial", () => {
  assert.equal(tiou(w(0, 10), w(0, 10)), 1);
  assert.equal(tiou(w(0, 10), w(20, 30)), 0);
  assert.equal(tiou(w(0, 10), w(10, 20)), 0);
  assert.equal(tiou(w(0, 40), w(10, 30)), 0.5);
  assert.ok(Math.abs(tiou(w(0, 30), w(10, 40)) - 0.5) < 1e-12);
  assert.ok(Math.abs(tiou(w(0, 30), w(15, 45)) - 1 / 3) < 1e-12);
  assert.equal(tiou(w(5, 5), w(0, 10)), 0);
});

test("bestIoU picks the best match and is 0 with no labels", () => {
  assert.equal(bestIoU(w(0, 10), [w(50, 60), w(0, 10)]), 1);
  assert.equal(bestIoU(w(0, 10), []), 0);
});

test("hit@k respects rank order and threshold", () => {
  const labels = [w(100, 140)];
  const preds = [w(0, 30), w(200, 230), w(300, 330), w(100, 140)];
  assert.equal(hitAtK(preds, labels, 3), 0);
  assert.equal(hitAtK(preds, labels, 5), 1);
  // IoU exactly 0.5 counts as a hit
  assert.equal(hitAtK([w(0, 40)], [w(10, 30)], 1, 0.5), 1);
  assert.equal(hitAtK([w(0, 30)], [w(15, 45)], 1, 0.5), 0);
});

test("precision@k divides by k; recall@k counts labels found", () => {
  const labels = [w(0, 30), w(100, 130)];
  const preds = [w(0, 30), w(500, 530)];
  assert.equal(precisionAtK(preds, labels, 2), 0.5);
  assert.equal(precisionAtK(preds, labels, 5), 0.2);
  assert.equal(recallAtK(preds, labels, 5), 0.5);
  assert.equal(recallAtK(preds, [], 5), 0);
});

test("meanBestIoU averages over the top k predictions", () => {
  const labels = [w(0, 40)];
  assert.equal(meanBestIoU([w(0, 40), w(10, 30)], labels, 2), 0.75);
  assert.equal(meanBestIoU([], labels, 5), 0);
});

test("scoreVideo bundles metrics", () => {
  const s = scoreVideo([w(0, 40)], [w(0, 40)]);
  assert.deepEqual(s, { hit3: 1, hit5: 1, p3: 1 / 3, p5: 0.2, r5: 1, miou5: 1 });
});

test("rng is deterministic per seed", () => {
  const a = rng(7), b = rng(7), c = rng(8);
  const xa = [a(), a(), a()], xb = [b(), b(), b()];
  assert.deepEqual(xa, xb);
  assert.notDeepEqual(xa, [c(), c(), c()]);
  for (const x of xa) assert.ok(x >= 0 && x < 1);
});

test("bootstrapCI brackets the mean and is null for tiny n", () => {
  const ci = bootstrapCI([0, 1, 0, 1, 1, 0, 1, 1]);
  assert.equal(ci.mean, 0.625);
  assert.ok(ci.lo <= ci.mean && ci.mean <= ci.hi);
  assert.ok(ci.lo >= 0 && ci.hi <= 1);
  assert.deepEqual(bootstrapCI([1, 0]), { mean: 0.5, lo: null, hi: null, n: 2 });
  const same = bootstrapCI([0.4, 0.4, 0.4, 0.4]);
  assert.equal(same.lo, 0.4);
  assert.equal(same.hi, 0.4);
});

test("pairedBootstrap reports mean difference", () => {
  const r = pairedBootstrap([1, 1, 1, 0], [0, 0, 1, 0]);
  assert.equal(r.diff, 0.5);
  assert.ok(r.lo <= 0.5 && r.hi >= 0.5);
});

function fakeHeatmap(duration, peaks) {
  const n = 100, step = duration / n;
  return Array.from({ length: n }, (_, i) => {
    const c = (i + 0.5) * step;
    let v = 0.2;
    for (const p of peaks) v = Math.max(v, p.v * Math.exp(-((c - p.t) ** 2) / (2 * p.w ** 2)));
    return { start_time: i * step, end_time: (i + 1) * step, value: v };
  });
}

test("heatmapToLabels finds peaks, ignores the intro bump, keeps 20-60 s windows", () => {
  const hm = fakeHeatmap(1800, [{ t: 5, v: 1, w: 20 }, { t: 600, v: 0.9, w: 15 }, { t: 1200, v: 0.7, w: 10 }]);
  const labels = heatmapToLabels(hm);
  assert.ok(labels.length >= 2);
  assert.ok(labels.every((l) => l.source === "heatmap"));
  assert.ok(labels.every((l) => l.end - l.start >= 20 - 1e-9 && l.end - l.start <= 60 + 1e-9));
  assert.ok(labels.every((l) => l.start >= 30), "intro peak excluded");
  assert.ok(labels.some((l) => l.start <= 600 && l.end >= 600));
  assert.ok(labels.some((l) => l.start <= 1200 && l.end >= 1200));
  for (let i = 1; i < labels.length; i++) assert.ok(labels[i].start >= labels[i - 1].end, "no overlap");
});

test("heatmapToLabels returns [] for missing heatmap", () => {
  assert.deepEqual(heatmapToLabels(null), []);
  assert.deepEqual(heatmapToLabels([]), []);
});

test("heatmapToLabels with rangeEnd keeps labels inside the range", () => {
  const hm = fakeHeatmap(2400, [{ t: 300, v: 0.8, w: 15 }, { t: 600, v: 0.9, w: 15 }, { t: 1800, v: 1, w: 15 }]);
  const labels = heatmapToLabels(hm, { rangeEnd: 900 });
  assert.ok(labels.length >= 2);
  assert.ok(labels.every((l) => l.end <= 900));
  assert.ok(labels.some((l) => l.start <= 600 && l.end >= 600));
});

import { ranks, auc, spearman, aboveMedian, signFlipTest, holm, wilson } from "./metrics.mjs";

test("ranks average ties", () => {
  assert.deepEqual(ranks([10, 20, 20, 5]), [2, 3.5, 3.5, 1]);
});

test("auc: perfect, reversed, tied, chance", () => {
  assert.equal(auc([1, 2, 3, 4], [false, false, true, true]), 1);
  assert.equal(auc([4, 3, 2, 1], [false, false, true, true]), 0);
  assert.equal(auc([1, 1, 1, 1], [false, true, false, true]), 0.5);
  assert.equal(auc([1, 2], [true, true]), null);
  // one positive at the middle of three negatives
  assert.equal(auc([1, 3, 2, 4], [false, false, true, false]), 1 / 3);
});

test("spearman: monotone, reversed, constant", () => {
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [10, 20, 30, 40]) - 1) < 1e-12);
  assert.ok(Math.abs(spearman([1, 2, 3, 4], [4, 3, 2, 1]) + 1) < 1e-12);
  assert.equal(spearman([1, 1, 1], [1, 2, 3]), null);
});

test("aboveMedian splits strictly above the median", () => {
  assert.deepEqual(aboveMedian([1, 2, 3, 4]), [false, false, true, true]);
  assert.deepEqual(aboveMedian([1, 2, 3]), [false, false, true]);
});

test("signFlipTest: exact p for small n, and a clear effect", () => {
  // all four positive: only the all-plus and all-minus patterns are as extreme -> 2/16
  const r = signFlipTest([1, 1, 1, 1]);
  assert.equal(r.p, 2 / 16);
  assert.equal(signFlipTest([1, -1, 1, -1]).p, 1);
  const big = signFlipTest(Array.from({ length: 30 }, () => 0.2), { iters: 2000 });
  assert.ok(big.p < 0.01);
  assert.equal(signFlipTest([]).p, null);
});

test("holm adjusts in step-down order", () => {
  const adj = holm([0.01, 0.04, 0.03]);
  assert.ok(Math.abs(adj[0] - 0.03) < 1e-12);
  assert.ok(Math.abs(adj[2] - 0.06) < 1e-12);
  assert.ok(Math.abs(adj[1] - 0.06) < 1e-12);
});

test("wilson interval", () => {
  const w = wilson(20, 30);
  assert.ok(w.lo > 0.48 && w.lo < 0.5 && w.hi > 0.8 && w.hi < 0.82, JSON.stringify(w));
  assert.equal(wilson(0, 0).p, null);
});

import { windowIntensity } from "./heatmap.mjs";
test("windowIntensity is the time-weighted mean of overlapping segments", () => {
  const hm = [{ start_time: 0, end_time: 10, value: 0 }, { start_time: 10, end_time: 20, value: 1 }];
  assert.equal(windowIntensity(hm, 5, 15), 0.5);
  assert.equal(windowIntensity(hm, 10, 20), 1);
  assert.equal(windowIntensity(hm, 7.5, 17.5), 0.75);
  assert.equal(windowIntensity(hm, 30, 40), null);
});
