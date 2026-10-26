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

test("judgeCount: max(16, 2k), one per 75 s, capped by the time budget but never below what k needs", () => {
  assert.equal(judgeCount({ k: 5, duration: 360 }).n, 16);
  assert.equal(judgeCount({ k: 3, duration: 900 }).n, 16, "a 15-minute talk reads 16, as before");
  assert.equal(judgeCount({ k: 3, duration: 3060 }).n, 41, "a 51-minute podcast reads 41 windows (was 16)");
  assert.equal(judgeCount({ k: 30, duration: 3849 }).n, 60);
  assert.equal(judgeCount({ k: 5, duration: 7316 }).n, 98, "one per 75 s of a 2-hour video");
  // local Gemma at 70 s a call and a 20-minute budget: 17 calls, but 30 clips need 36
  const local = judgeCount({ k: 30, duration: 7316, secPerCall: 70, budgetSec: 1200 });
  assert.deepEqual([local.n, local.capped, local.floor], [36, true, 36]);
  // the default budget is half the video: 61 minutes of judging for a 2-hour video
  assert.equal(judgeCount({ k: 30, duration: 7316, secPerCall: 70 }).n, 52);
  // on-device Gemma at 100 s a call on a 51-minute podcast: half the length buys 15 windows, and it says how long
  const cpu = judgeCount({ k: 3, duration: 3060, secPerCall: 100 });
  assert.deepEqual([cpu.n, cpu.capped, cpu.estSec], [15, true, 1500]);
  assert.equal(judgeCount({ k: 3, duration: 360, secPerCall: 70 }).n, 8, "a 6-minute talk on local Gemma: 10 minutes of judging");
  assert.equal(judgeCount({ k: 3, duration: 360, secPerCall: 70, budgetSec: 1200 }).n, 16);
  assert.equal(judgeCount({ k: 3, duration: 360, secPerCall: 100, budgetSec: 1200 }).n, 12);
  // Smart mode at 3 s a call: the budget does not bind
  assert.equal(judgeCount({ k: 30, duration: 7316, secPerCall: 3 }).n, 98);
  const smart = judgeCount({ k: 3, duration: 3060, secPerCall: 3 });
  assert.deepEqual([smart.n, smart.capped, smart.estSec], [41, false, 123]);
  assert.equal(judgeCount({ k: 100, duration: 7316 }).n, JUDGE_MAX);
});

test("judgeCount keeps an explicit judgeN, raised only to what k clips need", () => {
  assert.deepEqual(judgeCount({ k: 5, judgeN: 8 }), { n: 8, auto: false, capped: false, floor: 6, estSec: null });
  assert.equal(judgeCount({ k: 5, judgeN: "", duration: 360 }).auto, true, "an empty field is auto");
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

test("one stretch where whisper looped does not fail a 2-hour transcript, and never becomes a clip", async () => {
  const { transcriptQuality } = await import("./quality.mjs");
  // varied speech: sentences of 6 to 13 words drawn from a few hundred made-up words, 2.5 words a second
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const vocab = Array.from({ length: 400 }, (_, i) => `w${(i * 7919) % 9973}`);
  const speech = (n) => {
    const out = [];
    let left = 0;
    for (let i = 0; i < n; i++) {
      if (!left) left = 6 + Math.floor(rnd() * 8);
      left--;
      const w = vocab[Math.floor(rnd() * vocab.length)];
      out.push({ w: (out.length && out[out.length - 1].w.endsWith(".")) || !out.length ? w.toUpperCase() : left ? w : `${w}.`, s: +(i * 0.4).toFixed(2), e: +(i * 0.4 + 0.3).toFixed(2), p: 0.93 });
    }
    return out;
  };
  const words = speech(18000);
  // 88 minutes in, whisper repeats one phrase for about 80 words (as on the real 2-hour run)
  const at = words.findIndex((w) => w.s > 88 * 60);
  const loop = "And we're going to take our data".split(" ");
  for (let i = 0; i < 96; i++) words[at + i].w = loop[i % loop.length];
  const q = transcriptQuality(words, { duration: 7316 });
  assert.ok(q.compression > 2.4, "the loop is seen");
  assert.notEqual(q.verdict, "unreliable", `verdict ${q.verdict}, score ${q.score}`);
  assert.ok(q.loops.length >= 1 && q.loops[0].s > 87 * 60 && q.loops[0].s < 90 * 60);
  const sel = selectCandidates({ words, settings: { k: 30 }, duration: 7316, exclude: q.loops });
  assert.ok(sel.shortlist.every((c) => !q.loops.some((x) => c.start < x.e && c.end > x.s)));
  // in a 10-minute transcript the same loop is 8% of the words, and still counts against it
  const short = speech(1500);
  const clean = transcriptQuality(short, { duration: 600 });
  for (let i = 0; i < 96; i++) short[200 + i].w = loop[i % loop.length];
  const loopy = transcriptQuality(short, { duration: 600 });
  assert.equal(clean.verdict, "good");
  assert.notEqual(loopy.verdict, "good");
  assert.ok(loopy.score < clean.score - 0.1, `${loopy.score} against ${clean.score}`);
});
