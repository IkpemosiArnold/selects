import assert from "node:assert/strict";
import { test } from "node:test";
import { iou, isDanglingEnding, isDanglingOpener, makeCandidates, shortlist } from "./candidates.mjs";
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
  for (const s of ["So as I said, it matters.", "and that is why.", "That one was faster.", "This one broke.", "Like I said before, no.", "Which is why we stopped."])
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
  const s = shortlist(all, { n: 20, maxIou: 0.4, duration: dur });
  assert.equal(s.length, 20);
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) assert.ok(iou(s[i], s[j]) <= 0.4);
  // every tenth of the video has at least one window starting in it
  const buckets = new Set(s.map((c) => Math.floor((c.start / dur) * 10)));
  assert.ok(buckets.size >= 9, `covered ${buckets.size} of 10`);
});
