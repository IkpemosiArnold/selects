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
