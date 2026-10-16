import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPunctuation, loadPunctuation, mergeToken, punctModel, restorePunctuation } from "./punctuate.mjs";

test("mergeToken keeps whisper's spelling, takes the model's casing and sentence end", () => {
  assert.equal(mergeToken("forget", "Forget"), "Forget");
  assert.equal(mergeToken("myths", "myths."), "myths.");
  assert.equal(mergeToken("don't", "don't?"), "don't?");
  assert.equal(mergeToken("NASA", "nasa."), "NASA.", "whisper's capitals stay");
  assert.equal(mergeToken("end.", "end,"), "end.", "whisper's own punctuation wins");
  assert.equal(mergeToken("cat", "dog."), "cat", "a different word is ignored");
});

test("applyPunctuation works in chunks and skips a chunk the model re-tokenised", () => {
  const words = "so how are you i am fine thank you".split(" ").map((w, i) => ({ w, s: i, e: i + 0.5, p: 0.9 }));
  const fake = { addPunct: () => "So how are you? I am fine. Thank you." };
  const r = applyPunctuation(words, fake);
  assert.equal(r.words.map((w) => w.w).join(" "), "So how are you? I am fine. Thank you.");
  assert.equal(r.words[4].s, 4, "times are untouched");
  assert.equal(words[0].w, "so", "the input is not changed");
  const split = applyPunctuation(words, { addPunct: () => "So how are you? I'm fine." });
  assert.equal(split.changed, 0);
});

test("restorePunctuation explains itself when the model is missing", () => {
  const words = [{ w: "hi", s: 0, e: 1, p: 1 }];
  const r = restorePunctuation(words, { load: () => ({ punct: null, reason: "the punctuation model is not installed" }) });
  assert.equal(r.words, words);
  assert.deepEqual(r.info, { restored: false, model: null, changed: 0, sec: 0, reason: "the punctuation model is not installed" });
});

test("the real model, when installed, ends sentences", { skip: !punctModel() && "punctuation model not installed" }, () => {
  const { punct, reason } = loadPunctuation();
  if (!punct) return assert.ok(reason);
  const out = punct.addPunct("how are you i am fine thank you");
  assert.match(out, /[.?]/);
});
