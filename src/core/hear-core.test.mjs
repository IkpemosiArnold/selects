import { test } from "node:test";
import assert from "node:assert/strict";
import { HEAR_BLEND, blendWithHearing, cueScores, hearGrid, preWithHearing, scoreFromDigitLogits, stretchesFor, windowHearing } from "./hear-core.mjs";

test("hearGrid: 30 s stretches every 15 s, the last one cut at the end", () => {
  const g = hearGrid(100);
  assert.deepEqual(g.map((x) => [x.s, x.e]), [[0, 30], [15, 45], [30, 60], [45, 75], [60, 90], [75, 100]]);
  assert.deepEqual(hearGrid(0), []);
  assert.deepEqual(hearGrid(10).map((x) => [x.s, x.e]), [[0, 10]]);
});

test("hearGrid: the last stretch ends at the end and is never shorter than half a stretch", () => {
  const g = hearGrid(92);
  assert.deepEqual(g.at(-1), { i: 5, s: 75, e: 92 });
  assert.ok(g.every((x) => x.e - x.s >= 15));
});

test("windowHearing: the best stretch that overlaps the window by at least 15 s", () => {
  const scores = [{ s: 0, e: 30, score: 0.2 }, { s: 15, e: 45, score: 0.9 }, { s: 30, e: 60, score: 0.5 }];
  // [20, 50]: overlaps 0-30 by 10 s (too little), 15-45 by 25 s and 30-60 by 20 s
  assert.equal(windowHearing({ start: 20, end: 50 }, scores), 0.9);
  // [0, 22]: a short window needs half its length (11 s): 0-30 (22 s) and 15-45 (7 s, too little)
  assert.equal(windowHearing({ start: 0, end: 22 }, scores), 0.2);
  assert.equal(windowHearing({ start: 100, end: 130 }, scores), null);
  assert.equal(windowHearing({ start: 20, end: 50 }, [{ s: 15, e: 45, score: null }]), null);
});

test("every window of 20 s or more on a full grid gets a hearing score", () => {
  const grid = hearGrid(600).map((g) => ({ ...g, score: 0.5 }));
  for (let s = 0; s + 20 <= 600; s += 3.7) for (const len of [20, 33, 60]) if (s + len <= 600) assert.equal(windowHearing({ start: s, end: s + len }, grid), 0.5, `${s}+${len}`);
});

test("stretchesFor: only the stretches some window needs", () => {
  const need = stretchesFor([{ start: 100, end: 130 }], 600);
  assert.deepEqual(need.map((g) => g.s), [90, 105]);
});

test("scoreFromDigitLogits: the expected digit, from 1..9 to 0..1", () => {
  assert.equal(scoreFromDigitLogits({ 1: 50, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 }), 0);
  assert.equal(scoreFromDigitLogits({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 50 }), 1);
  assert.equal(scoreFromDigitLogits({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 }), 0.5);
  // torn between 3 and 7: in the middle, not a coin flip
  assert.equal(scoreFromDigitLogits({ 1: -20, 2: -20, 3: 5, 4: -20, 5: -20, 6: -20, 7: 5, 8: -20, 9: -20 }), 0.5);
  assert.equal(scoreFromDigitLogits({}), null);
});

test("cueScores: percentiles within the recording, averaged over the features there are", () => {
  const f = [
    { s: 0, e: 30, laugh: 0.0, overlap: 0.1, loudSpread: 2 },
    { s: 15, e: 45, laugh: 0.5, overlap: 0.3, loudSpread: 6 },
    { s: 30, e: 60, laugh: 0.1, overlap: 0.2, loudSpread: 4 },
  ];
  const s = cueScores(f);
  assert.deepEqual(s.map((x) => x.score), [0, 1, 0.5]);
  // a missing feature is left out of that stretch's mean, not counted as zero
  const s2 = cueScores([{ s: 0, e: 30, laugh: null, overlap: 0.1 }, { s: 15, e: 45, laugh: null, overlap: 0.3 }], ["laugh", "overlap"]);
  assert.deepEqual(s2.map((x) => x.score), [0, 1]);
  // ties share the middle rank
  assert.deepEqual(cueScores([{ laugh: 0 }, { laugh: 0 }, { laugh: 1 }], ["laugh"]).map((x) => x.score), [0.25, 0.25, 1]);
});

test("the blends: hearing joins when it is there, and changes nothing when it is not", () => {
  assert.equal(preWithHearing(0.6, null), 0.6);
  assert.equal(preWithHearing(0.6, 1), +(0.5 * 0.6 + 0.5).toFixed(3));
  assert.equal(blendWithHearing(0.8, 0.5, null, 0.71), 0.71);
  const t = blendWithHearing(0.8, 0.5, 1, 0.71);
  assert.equal(t, +(HEAR_BLEND.judge * 0.8 + HEAR_BLEND.pre * 0.5 + HEAR_BLEND.hear).toFixed(3));
  assert.equal(HEAR_BLEND.judge + HEAR_BLEND.pre + HEAR_BLEND.hear, 1);
});
