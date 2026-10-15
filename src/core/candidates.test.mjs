import assert from "node:assert/strict";
import { test } from "node:test";
import { iou, isDanglingEnding, isDanglingOpener, loudnessContext, makeCandidates, preScore, shortlist } from "./candidates.mjs";
import { toSentences } from "./sentences.mjs";
import { talk, words } from "./test/fixtures.mjs";

test("windows respect min and max length and start and end on sentence boundaries", () => {
  const sents = toSentences(talk(60));
  const c = makeCandidates(sents, { minLen: 20, maxLen: 60, stride: 6 });
  assert.ok(c.length > 10);
  const starts = new Set(sents.map((s) => s.s));
  const ends = new Set(sents.map((s) => s.e));
  for (const x of c) {
    const d = x.end - x.start;
    assert.ok(d >= 20 && d <= 60, `duration ${d}`);
    assert.ok(starts.has(x.start), "starts on a sentence start");
    assert.ok(ends.has(x.end), "ends on a sentence end");
    assert.equal(x.status, "proposed");
    assert.equal(x.rank, null);
    assert.match(x.id, /^c_\d{4}$/);
  }
});

test("stride spaces out window starts", () => {
  const sents = toSentences(talk(60));
  const c = makeCandidates(sents, { minLen: 20, maxLen: 60, stride: 15 });
  const starts = [...new Set(c.map((x) => x.start))].sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 15 - 1e-9);
});

test("prefilter drops windows that open on a dangling reference", () => {
  const openers = ["So as I said", "And then", "That one", "This one", "But", "Nobody tells you"];
  const sents = toSentences(talk(40, { opener: (i) => openers[i % openers.length] }));
  const kept = makeCandidates(sents, { minLen: 20, maxLen: 60, stride: 0 });
  for (const c of kept) assert.ok(!/^(So as I said|And then|That one|This one|But)\b/.test(c.hook), c.hook);
  assert.ok(kept.some((c) => c.hook.startsWith("Nobody")));
  const all = makeCandidates(sents, { minLen: 20, maxLen: 60, stride: 0, keepRejected: true });
  assert.ok(all.some((c) => c.rejected === "opens on a reference to earlier context"));
});

test("dangling opener and ending rules", () => {
  for (const s of ["So in other words, how much they lift.", "If that's the case, this is for you.", "Okay.", "Right, so.", "older, even if you lift, strength declines.", "So as I said, it matters.", "and that is why.", "That one was faster.", "This one broke.", "Like I said before, no.", "Which is why we stopped."])
    assert.ok(isDanglingOpener(s), s);
  for (const s of ["Nobody tells you this.", "The validator said yes.", "Why do we sleep?", "Thirty years of nothing."]) assert.ok(!isDanglingOpener(s), s);
  for (const s of ["and then we went to the", "We tried it and", "Let me show you on the next slide.", "There are three steps:"]) assert.ok(isDanglingEnding(s), s);
  for (const s of ["It worked.", "That is the whole trick!", "Would you do it again?"]) assert.ok(!isDanglingEnding(s), s);
});

test("windows that end mid-thought are dropped", () => {
  // the long pause makes "we went to the" its own unpunctuated sentence
  const ws = words(
    Array.from({ length: 12 }, () => "Lifting is mostly about showing up every week.").join(" ") + " and we went to the",
    { gaps: { 108: 2 } },
  );
  const c = makeCandidates(toSentences(ws), { minLen: 20, maxLen: 60, stride: 0 });
  for (const x of c) assert.ok(/[.!?]$/.test(x.text), x.text.slice(-30));
});

test("iou", () => {
  assert.equal(iou({ start: 0, end: 10 }, { start: 0, end: 10 }), 1);
  assert.equal(iou({ start: 0, end: 10 }, { start: 10, end: 20 }), 0);
  assert.equal(iou({ start: 0, end: 10 }, { start: 5, end: 15 }), 5 / 15);
});

test("shortlist covers the timeline and limits overlap", () => {
  const sents = toSentences(talk(200));
  const all = makeCandidates(sents, { minLen: 20, maxLen: 60, stride: 3 });
  const dur = sents[sents.length - 1].e;
  const s = shortlist(all, { n: 21, maxIou: 0.4, duration: dur });
  assert.equal(s.length, 21);
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) assert.ok(iou(s[i], s[j]) <= 0.4);
  // n/3 = 7 time buckets, each with at least one window starting in it
  const buckets = new Set(s.map((c) => Math.floor((c.start / dur) * 7)));
  assert.equal(buckets.size, 7);
  assert.equal(shortlist(all, { duration: dur }).length, 8, "default N is 8");
});

test("pre-score rewards hook phrases and loud moments, penalises soft openers", () => {
  const sent = (text, s, e) => ({ text, s, e });
  const win = (first) => ({ start: 0, end: 30, sentences: [sent(first, 0, 4), sent("We trained three times a week for a year and it worked.", 4, 30)], text: first + " We trained three times a week for a year and it worked." });
  const hook = preScore(win("Nobody tells you how slow strength really is."));
  const soft = preScore(win("So um this is the slide about the thing."));
  assert.ok(hook > soft + 0.15, `${hook} vs ${soft}`);
  const quiet = loudnessContext({ step: 0.5, db: Array(200).fill(-30) });
  const loudDb = Array(200).fill(-30);
  for (let i = 0; i < 60; i++) loudDb[i] = -18;
  const loud = loudnessContext({ step: 0.5, db: loudDb });
  const w = win("Nobody tells you how slow strength really is.");
  assert.ok(preScore(w, loud) > preScore(w, quiet));
});
