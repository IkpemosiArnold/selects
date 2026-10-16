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

// An unpunctuated transcript, the way whisper often writes casual or accented speech:
// lowercase, no full stops, phrases separated by short pauses, and one long stretch with
// no pause at all. Synthetic on purpose (real family footage stays out of the tests).
const PHRASES = [
  "we trained three times a week for a whole year",
  "nobody tells you how slow strength really is",
  "my coach said the first month is always the hardest one",
  "you lose muscle every decade after thirty",
  "most people quit in week two",
  "the trick is to show up even on bad days",
  "we tried something new and it worked",
  "it took me six months to see a real change",
  "lifting heavy is mostly about patience",
  "i was wrong about cardio for years",
];
function unpunctuated({ punctuate = false } = {}) {
  const text = [];
  const gaps = {};
  let n = 0;
  for (let i = 0; i < 60; i++) {
    let p = PHRASES[(i * 7) % PHRASES.length];
    if (punctuate) p = p[0].toUpperCase() + p.slice(1) + ".";
    const ws = p.split(" ");
    // phrases 20 to 27 run together with no pause: about 40 s of continuous speech
    if (i > 0 && !(i >= 21 && i <= 27)) gaps[n] = 0.6 + ((i * 13) % 5) * 0.1;
    text.push(...ws);
    n += ws.length;
  }
  return words(text.join(" "), { gaps });
}

test("toSentences splits an unpunctuated transcript at pauses and caps each sentence at about 12 s", () => {
  const ws = unpunctuated();
  const s = toSentences(ws);
  const longest = Math.max(...s.map((x) => x.e - x.s));
  assert.ok(longest <= 12.5, `longest sentence ${longest.toFixed(1)} s`);
  assert.ok(s.length >= 55, `${s.length} sentences`);
  // every word is in exactly one sentence, in order
  assert.deepEqual(s.flatMap((x) => ws.slice(x.wordIdx[0], x.wordIdx[1] + 1).map((w) => w.w)), ws.map((w) => w.w));
  for (const x of s) assert.equal(x.text, ws.slice(x.wordIdx[0], x.wordIdx[1] + 1).map((w) => w.w).join(" "));
  // the continuous stretch is split at its largest internal gap, never mid-word
  assert.ok(s.every((x) => x.wordIdx[1] >= x.wordIdx[0]));
});

test("an unpunctuated transcript still gives candidate windows at the usual density", async () => {
  const { makeCandidates } = await import("./candidates.mjs");
  const opts = { minLen: 20, maxLen: 60, stride: 6 };
  const plain = makeCandidates(toSentences(unpunctuated()), opts);
  const punct = makeCandidates(toSentences(unpunctuated({ punctuate: true })), opts);
  assert.ok(punct.length > 10, `${punct.length} windows from the punctuated text`);
  assert.ok(plain.length >= punct.length * 0.6, `${plain.length} windows unpunctuated against ${punct.length} punctuated`);
  for (const c of plain) {
    assert.ok(c.end - c.start >= 20 && c.end - c.start <= 60);
    assert.doesNotMatch(c.text, /\b(and|the|a|to|of)$/, "still never ends on a dangling word");
  }
});

test("a punctuated transcript keeps its punctuation-based sentences", () => {
  const ws = unpunctuated({ punctuate: true });
  const s = toSentences(ws);
  assert.equal(s.length, 60);
  assert.ok(s.every((x) => /\.$/.test(x.text)));
});
