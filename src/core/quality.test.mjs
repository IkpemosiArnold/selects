import assert from "node:assert/strict";
import { test } from "node:test";
import { maxChunkCompression, meanPIn, repeatShare, transcriptQuality } from "./quality.mjs";
import { words } from "./test/fixtures.mjs";

const withP = (ws, f) => ws.map((w, i) => ({ ...w, p: f(i) }));

test("a confident transcript is good", () => {
  const ws = withP(words("Nobody tells you this. Lifting heavy is mostly about showing up every week for months and months."), () => 0.93);
  const q = transcriptQuality(ws);
  assert.equal(q.verdict, "good");
  assert.equal(q.hint, null);
  assert.equal(q.lowShare, 0);
});

test("many low-confidence words make it unreliable, with a hint", () => {
  const ws = withP(words("so the man went to the place and they said the thing to him again later on that day"), (i) => (i % 2 ? 0.2 : 0.55));
  const q = transcriptQuality(ws);
  assert.equal(q.verdict, "unreliable");
  assert.match(q.hint, /small\.en/);
  assert.ok(q.lowShare >= 0.45);
});

test("middling confidence is shaky", () => {
  const ws = withP(words("we went to the market early and bought some fresh tomatoes for the stew tonight"), (i) => (i % 10 === 0 ? 0.45 : 0.82));
  assert.equal(transcriptQuality(ws).verdict, "shaky");
});

test("hallucination loops are caught by repetition", () => {
  const loop = Array.from({ length: 30 }, () => "and then I").join(" ");
  assert.ok(repeatShare(loop.split(" ")) > 0.8);
  const ws = withP(words(loop), () => 0.9);
  const q = transcriptQuality(ws);
  assert.notEqual(q.verdict, "good");
  assert.ok(maxChunkCompression(loop.split(" ")) > 2.4);
});

test("no words is unreliable", () => {
  assert.equal(transcriptQuality([]).verdict, "unreliable");
});

test("meanPIn averages the words inside a span", () => {
  const ws = withP(words("a b c d", { wps: 1 }), (i) => [1, 0.5, 0.5, 1][i]);
  assert.equal(meanPIn(ws, 0.9, 2.9), 0.5);
  assert.equal(meanPIn(ws, 10, 20), null);
});
