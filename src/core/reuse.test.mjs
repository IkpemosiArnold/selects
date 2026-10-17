// Transcript reuse: the fingerprint, the keys, and saving and loading a transcript.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "selects-reuse-"));
process.env.SELECTS_HOME = home;
const { languageKey, loadLanguage, loadTranscript, reuseEnabled, saveLanguage, saveTranscript, sourceFingerprint, transcriptKey } = await import("./reuse.mjs");
after(() => fs.rmSync(home, { recursive: true, force: true }));

test("the fingerprint reads the ends of the file, its size and mtime, not the middle", () => {
  const a = path.join(home, "a.bin");
  const big = Buffer.alloc(12 * 1024 * 1024, 7);
  fs.writeFileSync(a, big);
  const fixed = new Date("2026-10-16T12:00:00Z");
  fs.utimesSync(a, fixed, fixed);
  const f1 = sourceFingerprint(a); // no timing assertion: the shared test machine runs at load 500
  assert.match(f1, /^[0-9a-f]{20}$/);
  // a change in the middle (not read) with the same mtime keeps it; a change at the end does not
  big[6 * 1024 * 1024] = 1;
  fs.writeFileSync(a, big);
  fs.utimesSync(a, fixed, fixed);
  assert.equal(sourceFingerprint(a), f1);
  big[big.length - 1] = 1;
  fs.writeFileSync(a, big);
  fs.utimesSync(a, fixed, fixed);
  assert.notEqual(sourceFingerprint(a), f1);
  // a copy elsewhere with the same content and mtime is the same source
  const b = path.join(home, "b.bin");
  fs.copyFileSync(a, b);
  fs.utimesSync(b, fixed, fixed);
  assert.equal(sourceFingerprint(b), sourceFingerprint(a));
  const small = path.join(home, "s.bin");
  fs.writeFileSync(small, "tiny");
  assert.match(sourceFingerprint(small), /^[0-9a-f]{20}$/);
});

test("keys change with the model and settings that shape the result", () => {
  const base = { model: "/m/ggml-base.en.bin", language: "en" };
  const k = transcriptKey("f", base);
  assert.equal(transcriptKey("f", { ...base, model: "/other/dir/ggml-base.en.bin" }), k, "the model's folder does not matter");
  assert.notEqual(transcriptKey("f", { ...base, model: "ggml-small.en.bin" }), k);
  assert.notEqual(transcriptKey("f", { ...base, language: "yo" }), k);
  assert.notEqual(transcriptKey("f", { ...base, prompt: "A talk." }), k);
  assert.notEqual(transcriptKey("f", { ...base, preprocess: "clean" }), k);
  assert.notEqual(transcriptKey("g", base), k);
  const l = languageKey("f", { setting: "en", rule: "r1", model: "ggml-base.bin" });
  assert.notEqual(languageKey("f", { setting: "auto", rule: "r1", model: "ggml-base.bin" }), l);
  assert.notEqual(languageKey("f", { setting: "en", rule: "r2", model: "ggml-base.bin" }), l);
});

test("a saved transcript comes back with its events and loudness", () => {
  const job1 = path.join(home, "jobs", "j1");
  fs.mkdirSync(job1, { recursive: true });
  fs.writeFileSync(path.join(job1, "loudness.json"), JSON.stringify({ step: 0.5, db: [-20, -21] }));
  const words = [{ w: "Hello.", s: 0, e: 0.4, p: 0.9 }];
  Object.defineProperty(words, "events", { value: [{ type: "laughter", s: 1, e: 2 }], enumerable: false });
  assert.equal(loadTranscript("k1"), null);
  saveTranscript("k1", words, { jobDir: job1, meta: { job: "j1", sec: 120 } });
  const job2 = path.join(home, "jobs", "j2");
  const hit = loadTranscript("k1", { jobDir: job2 });
  assert.deepEqual(hit.words, words);
  assert.deepEqual(hit.words.events, [{ type: "laughter", s: 1, e: 2 }]);
  assert.equal(hit.meta.sec, 120);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(job2, "loudness.json"), "utf8")).db, [-20, -21]);
  saveLanguage("l1", { used: "en" });
  assert.deepEqual(loadLanguage("l1"), { used: "en" });
  assert.equal(loadLanguage("nope"), null);
});

test("reuse can be turned off per job or everywhere", () => {
  assert.equal(reuseEnabled({}), true);
  assert.equal(reuseEnabled({ reuse: false }), false);
  process.env.SELECTS_REUSE = "0";
  try {
    assert.equal(reuseEnabled({}), false);
  } finally {
    delete process.env.SELECTS_REUSE;
  }
});
