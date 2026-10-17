// The shortlist on long inputs: how many windows the judge reads scales with k and the
// length, and the picks come from the whole timeline, not one hot stretch.
import assert from "node:assert/strict";
import test from "node:test";
import { iou, shortlist } from "./candidates.mjs";
import { JUDGE_MAX, judgeCount, selectCandidates } from "./select.mjs";

/** Windows every 20 s over `dur` seconds; the first `hot` seconds score far higher. */
function windows(dur, { hot = 0, len = 40 } = {}) {
  const out = [];
  let i = 0;
  for (let s = 5; s + len < dur; s += 20) {
    const noise = ((i * 7919) % 100) / 1000; // deterministic jitter, 0 to 0.099
    out.push({ id: `c_${String(++i).padStart(4, "0")}`, start: s, end: s + len, pre: (s < hot ? 0.8 : 0.4) + noise, text: "x" });
  }
  return out;
}

// the shortlist as it was before long inputs were handled, to show short videos are unchanged
function oldShortlist(cands, { n = 8, maxIou = 0.4, duration, minP = 0.45 } = {}) {
  const heard = cands.filter((c) => c.meanP == null || c.meanP >= minP);
  if (heard.length >= Math.min(n, cands.length) / 2 && heard.length >= 1) cands = heard;
  if (cands.length <= n) return cands.slice();
  const dur = duration ?? Math.max(...cands.map((c) => c.end));
  const byScore = cands.slice().sort((a, b) => b.pre - a.pre || a.start - b.start);
  const chosen = [];
  const ok = (c) => chosen.every((x) => iou(x, c) <= maxIou);
  const buckets = Math.max(1, Math.ceil(n / 3));
  for (let b = 0; b < buckets; b++) {
    const lo = (b * dur) / buckets;
    const hi = ((b + 1) * dur) / buckets;
    const best = byScore.find((c) => c.start >= lo && c.start < hi && ok(c));
    if (best) chosen.push(best);
  }
  for (const c of byScore) {
    if (chosen.length >= n) break;
    if (!chosen.includes(c) && ok(c)) chosen.push(c);
  }
  return chosen.sort((a, b) => a.start - b.start);
}

test("judgeCount: max(16, 2k), one per 5 minutes, capped by the time budget but never below what k needs", () => {
  assert.equal(judgeCount({ k: 5, duration: 360 }).n, 16);
  assert.equal(judgeCount({ k: 30, duration: 3849 }).n, 60);
  assert.equal(judgeCount({ k: 5, duration: 7316 }).n, 25, "one per 5 minutes of a 2-hour video");
  // local Gemma at 70 s a call and a 20-minute budget: 17 calls, but 30 clips need 36
  const local = judgeCount({ k: 30, duration: 7316, secPerCall: 70, budgetSec: 1200 });
  assert.deepEqual([local.n, local.capped, local.floor], [36, true, 36]);
  // the default budget is half the video: 61 minutes of judging for a 2-hour video
  assert.equal(judgeCount({ k: 30, duration: 7316, secPerCall: 70 }).n, 52);
  assert.equal(judgeCount({ k: 3, duration: 360, secPerCall: 70 }).n, 8, "a 6-minute talk on local Gemma: 10 minutes of judging");
  assert.equal(judgeCount({ k: 3, duration: 360, secPerCall: 70, budgetSec: 1200 }).n, 16);
  assert.equal(judgeCount({ k: 3, duration: 360, secPerCall: 100, budgetSec: 1200 }).n, 12);
  // Smart mode at 3 s a call: the budget does not bind
  assert.equal(judgeCount({ k: 30, duration: 7316, secPerCall: 3 }).n, 60);
  assert.equal(judgeCount({ k: 100, duration: 7316 }).n, JUDGE_MAX);
});

test("judgeCount keeps an explicit judgeN, raised only to what k clips need", () => {
  assert.deepEqual(judgeCount({ k: 5, judgeN: 8 }), { n: 8, auto: false, capped: false, floor: 6 });
  assert.equal(judgeCount({ k: 30, judgeN: 8 }).n, 36);
  assert.equal(judgeCount({ judgeN: 8 }).n, 8, "no k (the eval): exactly as asked");
  assert.equal(judgeCount({ k: 5, judgeN: "auto", duration: 360 }).n, 16);
});

test("on a 2-hour video the shortlist covers the whole timeline, even when one stretch scores far higher", () => {
  const dur = 7316;
  const cands = windows(dur, { hot: 1200 }); // the first 20 minutes look best to the pre-score
  const n = 60;
  const short = shortlist(cands, { n, duration: dur });
  assert.equal(short.length, n);
  const tenMin = new Set(short.map((c) => Math.floor(c.start / 600)));
  assert.equal(tenMin.size, Math.ceil(dur / 600), `every 10-minute stretch has a pick: ${[...tenMin]}`);
  // the shortlist's own segments: n/3 = 20 of about 6 minutes, each holding at most 2 x 3
  const seg = (c) => Math.min(19, Math.floor((c.start / dur) * 20));
  const per = new Array(20).fill(0);
  for (const c of short) per[seg(c)]++;
  assert.ok(per.every((x) => x >= 1 && x <= 6), `per segment: ${per}`);
  for (let i = 0; i < short.length; i++) for (let j = i + 1; j < short.length; j++) assert.ok(iou(short[i], short[j]) <= 0.4);
  // the hot stretch still gets more than its share: quality counts, within the cap
  assert.ok(short.filter((c) => c.start < 1200).length > (n * 1200) / dur);
  // the old shortlist put nearly everything in the hot stretch
  const old = oldShortlist(cands, { n, duration: dur });
  assert.ok(old.filter((c) => c.start < 1200).length > short.filter((c) => c.start < 1200).length);
});

test("up to 30 minutes the shortlist picks exactly what it picked before", () => {
  for (const [dur, n] of [[360, 8], [1500, 8], [1800, 16], [1677, 16], [900, 4]]) {
    const cands = windows(dur, { hot: dur / 3 });
    assert.deepEqual(shortlist(cands, { n, duration: dur }).map((c) => c.id), oldShortlist(cands, { n, duration: dur }).map((c) => c.id), `${dur} s, n ${n}`);
  }
});

test("selectCandidates reports the judge count it used", () => {
  const words = [];
  const vocab = ["Nobody", "tells", "you", "the", "real", "reason", "it", "works"];
  for (let i = 0; i < 450; i++) words.push({ w: vocab[i % 8] + (i % 8 === 7 ? "." : ""), s: i * 0.4, e: i * 0.4 + 0.3, p: 0.9 });
  const sel = selectCandidates({ words, settings: { k: 5 }, duration: 180, judge: { secPerCall: 100, budgetSec: 1200 } });
  assert.equal(sel.judgeN.n, 12);
  assert.ok(sel.shortlist.length <= 12);
});
