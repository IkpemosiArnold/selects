import assert from "node:assert/strict";
import { test } from "node:test";
import { snapTrim, toSentences } from "./sentences.mjs";
import { words } from "./test/fixtures.mjs";

test("toSentences splits on . ! and ?", () => {
  const ws = words("Hello there. How are you? I am fine! Great.");
  const s = toSentences(ws);
  assert.deepEqual(
    s.map((x) => x.text),
    ["Hello there.", "How are you?", "I am fine!", "Great."],
  );
  assert.deepEqual(s[1].wordIdx, [2, 4]);
  assert.equal(s[0].s, ws[0].s);
  assert.equal(s[0].e, ws[1].e);
});

test("toSentences ends an unpunctuated sentence at a long pause", () => {
  const ws = words("this has no full stop then a long silence follows here", { gaps: { 6: 2 } });
  const s = toSentences(ws);
  assert.equal(s.length, 2);
  assert.equal(s[0].text, "this has no full stop then");
});

test("toSentences keeps a trailing quote with its sentence end", () => {
  const s = toSentences(words('He said "stop." Then left.'));
  assert.equal(s.length, 2);
});

test("toSentences handles empty input", () => {
  assert.deepEqual(toSentences([]), []);
});

test("snapTrim snaps start and end to the nearest sentence boundaries", () => {
  const ws = words("One two three. Four five six. Seven eight nine. Ten eleven twelve.");
  const s = toSentences(ws);
  // ask for a start inside sentence 2 and an end inside sentence 3
  const r = snapTrim(ws, s[1].s + 0.3, s[2].e - 0.3);
  assert.equal(r.start, s[1].s);
  assert.equal(r.end, s[2].e);
});

test("snapTrim never returns end before start, and swaps reversed input", () => {
  const ws = words("One two three. Four five six. Seven eight nine.");
  const s = toSentences(ws);
  const r = snapTrim(ws, s[2].s, s[0].e); // reversed
  assert.ok(r.end > r.start);
  const r2 = snapTrim(ws, s[2].s + 0.1, s[2].s + 0.2);
  assert.equal(r2.start, s[2].s);
  assert.equal(r2.end, s[2].e);
});

test("snapTrim with no words returns the input", () => {
  assert.deepEqual(snapTrim([], 3, 9), { start: 3, end: 9 });
});
