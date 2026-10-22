import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanWords, wordsFromVerbose } from "./asr-words.mjs";

test("words get their punctuation back from the text (Groq's word entries have none)", () => {
  const words = wordsFromVerbose({
    text: " Hello, world. It's a well-known trick: $5 a day!",
    words: [
      { word: "Hello", start: 0, end: 0.4 },
      { word: "world", start: 0.5, end: 0.9 },
      { word: "It's", start: 1.2, end: 1.4 },
      { word: "a", start: 1.4, end: 1.5 },
      { word: "well", start: 1.5, end: 1.7 },
      { word: "known", start: 1.7, end: 2.0 },
      { word: "trick", start: 2.0, end: 2.4 },
      { word: "5", start: 2.6, end: 2.9 },
      { word: "a", start: 2.9, end: 3.0 },
      { word: "day", start: 3.0, end: 3.3 },
    ],
  });
  assert.deepEqual(words.map((w) => w.w), ["Hello,", "world.", "It's", "a", "well-known", "trick:", "$5", "a", "day!"]);
  const wk = words.find((w) => w.w === "well-known");
  assert.equal(wk.s, 1.5);
  assert.equal(wk.e, 2.0, "one token spanning two words keeps both words' time");
});

test("segment text is preferred to the top-level text, and unknown words keep their spelling", () => {
  const words = wordsFromVerbose({ text: "ignored", segments: [{ text: " Yes." }, { text: " Okay then." }], words: [{ word: "Yes", start: 0, end: 0.3 }, { word: "um", start: 0.4, end: 0.5 }, { word: "Okay", start: 0.6, end: 0.9 }, { word: "then", start: 0.9, end: 1.2 }] });
  assert.deepEqual(words.map((w) => w.w), ["Yes.", "um", "Okay", "then."]);
});

test("no word times means no transcript for Selects (segments alone are refused)", () => {
  assert.equal(wordsFromVerbose({ text: "Hello there.", segments: [{ start: 0, end: 1, text: "Hello there." }] }), null);
  assert.equal(wordsFromVerbose({ text: "Hello there.", words: [] }), null);
  assert.deepEqual(wordsFromVerbose({ text: "", words: [] }), [], "silence is an empty transcript, not an error");
});

test("cleanWords offsets, orders and repairs times", () => {
  const out = cleanWords([{ w: "a", s: 0, e: 0.2 }, { w: "b", s: 0.18, e: 0.05 }, { w: "", s: 1, e: 2 }, { w: "c", s: 1, e: 1.3 }], { offset: 10 });
  assert.deepEqual(out.map((w) => w.w), ["a", "b", "c"]);
  assert.ok(out.every((w, i) => w.e > w.s && (i === 0 || w.s >= out[i - 1].e)), "times never overlap or reverse");
  assert.equal(out[0].s, 10);
  assert.deepEqual(cleanWords([{ word: "x", start: 0, end: 0.5 }], { prevEnd: 3 }).length, 0, "a repeat from before the previous word is dropped");
});
