import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSegmentLines, segmentsToWords, wordsFromWhisperJson } from "./transcribe.mjs";

test("parseSegmentLines reads whisper's live stdout lines", () => {
  const out = parseSegmentLines("[00:00:01.230 --> 00:00:01.560]   Hello\nnoise\n[00:01:02.000 --> 00:01:02.400]  world.\n");
  assert.equal(out.length, 2);
  assert.equal(out[0].from, 1.23);
  assert.equal(out[1].from, 62);
  assert.equal(out[0].text, " Hello");
  assert.equal(out[1].text, "world.");
});

test("segmentsToWords glues punctuation and contractions, drops non-speech", () => {
  const segs = [
    { text: " I", from: 0, to: 0.2 },
    { text: " don", from: 0.2, to: 0.4 },
    { text: "'t", from: 0.4, to: 0.5 },
    { text: " know", from: 0.5, to: 0.8 },
    { text: ".", from: 0.8, to: 0.8 },
    { text: " [BLANK_AUDIO]", from: 1, to: 3 },
    { text: " (laughs)", from: 3, to: 4 },
    { text: " Yes", from: 4, to: 4.3 },
  ];
  const w = segmentsToWords(segs);
  assert.deepEqual(
    w.map((x) => x.w),
    ["I", "don't", "know.", "Yes"],
  );
  assert.equal(w[1].e, 0.5);
});

test("segmentsToWords gives zero-length words a little time", () => {
  const w = segmentsToWords([
    { text: " a", from: 1, to: 1 },
    { text: " b", from: 1.05, to: 1.3 },
  ]);
  assert.ok(w[0].e > w[0].s);
  assert.ok(w[0].e <= w[1].s);
});

test("wordsFromWhisperJson averages token probabilities", () => {
  const json = {
    transcription: [
      { text: " Hi", offsets: { from: 0, to: 300 }, tokens: [{ text: "[_BEG_]", p: 0.1 }, { text: " Hi", p: 0.8 }] },
      { text: " there.", offsets: { from: 300, to: 700 }, tokens: [{ text: " there", p: 0.9 }, { text: ".", p: 0.7 }] },
    ],
  };
  const w = wordsFromWhisperJson(json);
  assert.deepEqual(w, [
    { w: "Hi", s: 0, e: 0.3, p: 0.8 },
    { w: "there.", s: 0.3, e: 0.7, p: 0.8 },
  ]);
});
