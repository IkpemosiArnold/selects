import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chooseLanguage, decideLanguage, sampleRanges } from "./language.mjs";

test("samples are spread over a long video, one sample for a short one", () => {
  const r = sampleRanges(600);
  assert.equal(r.length, 3);
  assert.ok(r[0].start < r[1].start && r[1].start < r[2].start && r[2].start + r[2].dur <= 600);
  assert.deepEqual(sampleRanges(40), [{ start: 0, dur: 40 }]);
});

test("auto picks the language whisper decodes most confidently, and reports the margin", () => {
  const res = chooseLanguage(
    [
      { code: "yo", meanP: 0.41, words: 60 },
      { code: "en", meanP: 0.72, words: 80 },
    ],
    { setting: "auto", detected: { code: "yo", p: 0.88 } },
  );
  assert.equal(res.used, "en");
  assert.equal(res.decided, "compare");
  assert.equal(res.margin, 0.31);
  assert.match(res.warning, /quick guess was Yoruba \(p = 0\.88\)/);
});

test("a non-English decode that comes out as English text cannot win (the accent trap)", () => {
  // measured on 16 Oct: elderly Nigerian speaker, English speech, multilingual base
  const res = chooseLanguage(
    [
      { code: "en", meanP: 0.65, words: 76, englishShare: 0.513 },
      { code: "yo", meanP: 0.798, words: 79, englishShare: 0.519 },
    ],
    { setting: "auto", detected: { code: "yo", p: 0.9 } },
  );
  assert.equal(res.used, "en");
  assert.match(res.warning, /asked to write Yoruba it wrote English/);
  // real Yoruba text has almost no English function words, so Yoruba can still win
  const yo = chooseLanguage(
    [
      { code: "en", meanP: 0.4, words: 60, englishShare: 0.3 },
      { code: "yo", meanP: 0.7, words: 70, englishShare: 0.01 },
    ],
    { setting: "auto", detected: { code: "yo", p: 0.9 } },
  );
  assert.equal(yo.used, "yo");
});

test("englishShare counts common English function words", async () => {
  const { englishShare } = await import("./language.mjs");
  assert.ok(englishShare("and then she said that the market was full of people".split(" ")) >= 0.3);
  assert.ok(englishShare("Ẹ kú àárọ̀ ọmọ mi, ṣé dáadáa ni".split(" ")) < 0.05);
});

test("an explicit setting is kept, with a warning only when another language is clearly better", () => {
  const clear = chooseLanguage([{ code: "en", meanP: 0.35, words: 40 }, { code: "fr", meanP: 0.8, words: 40 }], { setting: "en", detected: { code: "fr", p: 0.97 } });
  assert.equal(clear.used, "en");
  assert.match(clear.warning, /French decoded with more confidence/);
  const close = chooseLanguage([{ code: "en", meanP: 0.7, words: 40 }, { code: "yo", meanP: 0.66, words: 40 }], { setting: "en", detected: { code: "yo", p: 0.88 } });
  assert.equal(close.used, "en");
  assert.match(close.warning, /Using English/);
});

test("a language that decodes to almost nothing does not win", () => {
  const res = chooseLanguage([{ code: "yo", meanP: 0.99, words: 2 }, { code: "en", meanP: 0.6, words: 50 }], { setting: "auto" });
  assert.equal(res.used, "en");
});

test("no warning when the detector agrees with the setting", () => {
  assert.equal(chooseLanguage([], { setting: "en", detected: { code: "en", p: 0.9 } }).warning, null);
});

test("decideLanguage decodes each candidate once, then caches", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selects-lang-"));
  const calls = [];
  const deps = {
    model: "/fake/ggml-base.bin",
    extractAudio: async (_v, wav) => fs.writeFileSync(wav, "x"),
    detectLanguage: async () => ({ code: "yo", p: 0.88 }),
    decode: async (_wav, code) => {
      calls.push(code);
      const p = code === "en" ? 0.7 : 0.3;
      return Array.from({ length: 30 }, (_, i) => ({ w: "w", s: i, e: i + 0.5, p }));
    },
  };
  const res = await decideLanguage("/fake.mov", { duration: 165, setting: "en", cacheDir: dir, deps });
  assert.deepEqual(calls.sort(), ["en", "yo"]);
  assert.equal(res.used, "en");
  assert.equal(res.detected.code, "yo");
  assert.equal(res.margin, 0.4);
  assert.ok(!fs.existsSync(path.join(dir, "langcheck.wav")), "the sample WAV is deleted");
  await decideLanguage("/fake.mov", { duration: 165, setting: "en", cacheDir: dir, deps });
  assert.equal(calls.length, 2, "second call is served from language.json");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("decideLanguage creates a missing cacheDir before writing samples", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "selects-lang-dir-"));
  const dir = path.join(root, "a", "b");
  const deps = {
    model: "/fake/ggml-base.bin",
    extractAudio: async (_v, wav) => fs.writeFileSync(wav, "x"),
    detectLanguage: async () => ({ code: "en", p: 0.9 }),
    decode: async () => [],
  };
  const res = await decideLanguage("/fake.mov", { duration: 60, setting: "en", cacheDir: dir, deps });
  assert.equal(res.used, "en");
  assert.ok(fs.existsSync(path.join(dir, "language.json")));
  fs.rmSync(root, { recursive: true, force: true });
});
