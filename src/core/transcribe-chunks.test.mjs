// Chunked transcription: long recordings go through whisper in parts, each part is kept on
// disk, and a run that stops part way resumes from the part it was in.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeWhisperJson, planChunks, quietestIn, transcribe, wavInfo, writeWavSlice } from "./transcribe.mjs";

const RATE = 16000;

/** A 16-bit mono WAV of `sec` seconds: a tone, with silent gaps at the given times. */
function makeWav(file, sec, silences = []) {
  const n = Math.round(sec * RATE);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const quiet = silences.some(([a, b]) => t >= a && t < b);
    data.writeInt16LE(quiet ? 0 : Math.round(Math.sin(i / 5) * 8000), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
  return file;
}

/**
 * A stand-in for whisper-cli: reads -f and -of, writes -ojf style JSON with one word every
 * 10 s of its input (times relative to the input, as whisper does), logs each call, and
 * fails on the input named in FAKE_WHISPER_FAIL.
 */
function fakeWhisper(dir) {
  const bin = path.join(dir, "fake-whisper.cjs");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
const f = a[a.indexOf("-f") + 1];
const of = a[a.indexOf("-of") + 1];
fs.appendFileSync(process.env.FAKE_WHISPER_LOG, require("node:path").basename(f) + "\\n");
if (process.env.FAKE_WHISPER_FAIL && f.endsWith(process.env.FAKE_WHISPER_FAIL)) { process.stderr.write("killed"); process.exit(137); }
const bytes = fs.statSync(f).size - 44;
const sec = bytes / 2 / 16000;
const transcription = [];
for (let t = 1; t + 1 < sec; t += 10) transcription.push({ text: " word" + Math.round(t) + ".", offsets: { from: Math.round(t * 1000), to: Math.round((t + 0.5) * 1000) }, tokens: [{ text: " word", p: 0.9 }] });
fs.writeFileSync(of + ".json", JSON.stringify({ transcription }));
`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `selects-${name}-`));
}

test("planChunks keeps short recordings whole and cuts long ones at quiet moments", () => {
  assert.deepEqual(planChunks(300, { chunkSec: 600 }), [{ start: 0, end: 300 }]);
  assert.deepEqual(planChunks(880, { chunkSec: 600 }), [{ start: 0, end: 880 }]);
  const plan = planChunks(7316, { chunkSec: 600 });
  assert.equal(plan.length, 12);
  assert.equal(plan[0].start, 0);
  assert.equal(plan[plan.length - 1].end, 7316);
  for (let i = 1; i < plan.length; i++) assert.equal(plan[i].start, plan[i - 1].end, "parts touch, no gap and no overlap");
  // the quietest moment near each cut wins
  const q = planChunks(1800, { chunkSec: 600, quietest: (a, b) => a + 3 });
  assert.equal(q.length, 3);
  assert.equal(q[1].start, 600 - 15 + 3);
});

test("quietestIn finds a silent gap and writeWavSlice copies a range", () => {
  const dir = tmpDir("wav");
  const f = makeWav(path.join(dir, "a.wav"), 40, [[21.0, 22.0]]);
  const info = wavInfo(f);
  assert.equal(info.rate, RATE);
  assert.ok(Math.abs(info.seconds - 40) < 0.01);
  const t = quietestIn(f, info, 10, 30);
  assert.ok(t >= 21 && t <= 22, `quiet at ${t}`);
  const s = writeWavSlice(f, info, 5, 15, path.join(dir, "s.wav"));
  assert.ok(Math.abs(wavInfo(s).seconds - 10) < 0.01);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("mergeWhisperJson moves each part's times by its start", () => {
  const part = (from) => ({ transcription: [{ text: " hi", offsets: { from, to: from + 500 }, tokens: [{ text: " hi", p: 1 }] }] });
  const m = mergeWhisperJson([
    { json: part(1000), start: 0 },
    { json: part(1000), start: 600 },
  ]);
  assert.deepEqual(
    m.transcription.map((t) => t.offsets.from),
    [1000, 601000],
  );
});

test("a long transcription that stops part way resumes from the part it was in", async () => {
  const dir = tmpDir("chunks");
  const cacheDir = path.join(dir, "job");
  const bin = fakeWhisper(dir);
  const model = path.join(dir, "ggml-fake.bin");
  fs.writeFileSync(model, "x");
  const log = path.join(dir, "calls.log");
  process.env.FAKE_WHISPER_LOG = log;
  process.env.SELECTS_CHUNK_SEC = "60";
  const sec = 300; // five parts of about 60 s
  let extracted = 0;
  const extract = async (_video, wav) => {
    extracted++;
    return makeWav(wav, sec, [[59, 61], [119, 121], [179, 181], [239, 241]]);
  };
  const calls = () => fs.readFileSync(log, "utf8").trim().split("\n");
  try {
    // first run: whisper dies on the third part (as a SIGKILL of the job would stop it)
    process.env.FAKE_WHISPER_FAIL = "002.wav";
    await assert.rejects(transcribe("video.mp4", { cacheDir, duration: sec, bin, model, extract }), /whisper stopped/);
    assert.deepEqual(calls(), ["000.wav", "001.wav", "002.wav"]);
    assert.ok(fs.existsSync(path.join(cacheDir, "whisper-chunks", "000.json")));
    assert.ok(fs.existsSync(path.join(cacheDir, "whisper-chunks", "001.json")));
    assert.ok(!fs.existsSync(path.join(cacheDir, "whisper-chunks", "002.json")), "the part in progress is not kept");
    assert.ok(fs.existsSync(path.join(cacheDir, "audio.wav")), "the WAV stays for the resume");

    // resume: parts 0 and 1 are not transcribed again, and the audio is not extracted again
    delete process.env.FAKE_WHISPER_FAIL;
    const seen = [];
    const words = await transcribe("video.mp4", { cacheDir, duration: sec, bin, model, extract, onWords: (w) => seen.push(...w) });
    assert.deepEqual(calls(), ["000.wav", "001.wav", "002.wav", "002.wav", "003.wav", "004.wav"]);
    assert.equal(extracted, 1);
    // one word every 10 s of each part, times on the whole recording's clock, in order, no duplicates
    const starts = words.map((w) => w.s);
    assert.deepEqual(starts, starts.slice().sort((a, b) => a - b));
    assert.equal(new Set(starts).size, starts.length);
    assert.ok(starts[starts.length - 1] > 240, `last word at ${starts[starts.length - 1]}`);
    assert.equal(seen.length, words.length, "every word streamed once");
    // finished: the merged JSON is kept, the WAV and the parts are gone
    assert.ok(fs.existsSync(path.join(cacheDir, "whisper.json")));
    assert.ok(!fs.existsSync(path.join(cacheDir, "audio.wav")));
    assert.ok(!fs.existsSync(path.join(cacheDir, "whisper-chunks")));
  } finally {
    delete process.env.SELECTS_CHUNK_SEC;
    delete process.env.FAKE_WHISPER_FAIL;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a short recording still goes through whisper in one call", async () => {
  const dir = tmpDir("whole");
  const cacheDir = path.join(dir, "job");
  const bin = fakeWhisper(dir);
  const model = path.join(dir, "ggml-fake.bin");
  fs.writeFileSync(model, "x");
  process.env.FAKE_WHISPER_LOG = path.join(dir, "calls.log");
  try {
    const words = await transcribe("video.mp4", { cacheDir, duration: 45, bin, model, extract: async (_v, wav) => makeWav(wav, 45) });
    assert.deepEqual(fs.readFileSync(process.env.FAKE_WHISPER_LOG, "utf8").trim().split("\n"), ["audio.wav"]);
    assert.equal(words.length, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
