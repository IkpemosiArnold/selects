import { test } from "node:test";
import assert from "node:assert/strict";
import { selectCandidates } from "./select.mjs";
import { makeCandidates, shortlist } from "./candidates.mjs";
import { toSentences } from "./sentences.mjs";

// 3 minutes of speech: a full stop every 8 words, 2.5 words a second
function talk() {
  const words = [];
  const vocab = ["Nobody", "tells", "you", "the", "real", "reason", "it", "works"];
  for (let i = 0; i < 450; i++) words.push({ w: vocab[i % 8] + (i % 8 === 7 ? "." : ""), s: i * 0.4, e: i * 0.4 + 0.3, p: 0.9 });
  return words;
}

test("selectCandidates matches the hand-wired pipeline it replaces", () => {
  const words = talk();
  const loudness = { step: 0.5, db: Array.from({ length: 400 }, (_, i) => -30 + (i % 40 === 0 ? 12 : 0)) };
  const events = [{ type: "laughter", s: 60, e: 61 }];
  const settings = { minLen: 20, maxLen: 60, stride: 6, judgeN: 8 };
  const sel = selectCandidates({ words, events, loudness, settings, duration: 180 });
  const sentences = toSentences(words);
  const all = makeCandidates(sentences, { ...settings, loudness, words, events });
  assert.deepEqual(sel.windows, all);
  assert.deepEqual(sel.shortlist, shortlist(all, { n: 8, duration: 180 }));
  assert.equal(sel.sentences.length, sentences.length);
  assert.ok(sel.shortlist.length <= 8 && sel.shortlist.length > 0);
});

test("selectCandidates drops non-speech words and uses defaults", () => {
  const words = [{ w: "[MUSIC]", s: 0, e: 2, p: 1 }, ...talk().map((w) => ({ ...w, s: w.s + 2, e: w.e + 2 }))];
  const sel = selectCandidates({ words });
  assert.ok(sel.sentences.every((s) => !/MUSIC/.test(s.text)));
  assert.ok(sel.shortlist.length <= 8);
  assert.deepEqual(selectCandidates({ words: [] }), { sentences: [], windows: [], shortlist: [] });
});
