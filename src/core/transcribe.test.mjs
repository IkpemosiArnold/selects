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

test("loudnessFromWav gives one dBFS value per half second", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { loudnessFromWav } = await import("./transcribe.mjs");
  const rate = 16000;
  const n = rate * 2; // 1 s silence-ish, 1 s loud
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(i < rate ? 0 : Math.round(Math.sin(i / 5) * 16000), i * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  const f = path.join(os.tmpdir(), `selects-loud-${process.pid}.wav`);
  fs.writeFileSync(f, Buffer.concat([head, data]));
  const l = loudnessFromWav(f);
  fs.rmSync(f);
  assert.equal(l.step, 0.5);
  assert.equal(l.db.length, 4);
  assert.ok(l.db[0] < -100 && l.db[3] > -10, JSON.stringify(l.db));
});
