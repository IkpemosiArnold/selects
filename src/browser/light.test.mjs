// Light mode in Node: which mode is suggested, the remote transcriber's pieces and fallbacks,
// the codec choice, and the engine's transcribe stage with a fake remote transcriber.
import assert from "node:assert/strict";
import { test } from "node:test";

await import("./test-env.mjs");
const { isIos, suggestMode, wakeProxy } = await import("./light.js");
const { remoteTranscriber } = await import("./transcribers.js");
const { pickCodec, estimateBytes, SPEECH_CODECS } = await import("./encode.js");
const { Engine } = await import("./engine.js");
const { fakeBackend, fakeRender, DURATION } = await import("./test-fakes.mjs");
const { contentKey, createJobStore, memoryBackend } = await import("./store.js");
const { talk } = await import("../core/test/fixtures.mjs");

// ---------------------------------------------------------------- the mode choice

test("mode: Private stays the default when the speech model is already in this browser, even on 2G or an iPhone", () => {
  const s = suggestMode({ connection: { effectiveType: "2g", downlink: 0.2, saveData: true }, ios: true, asrCached: true });
  assert.equal(s.mode, "private");
});

test("mode: Light on Data Saver, 2G or 3G, under 1.5 Mbps, a slow download, or an iPhone", () => {
  assert.equal(suggestMode({ connection: { saveData: true, downlink: 10 }, asrCached: false }).mode, "light");
  assert.equal(suggestMode({ connection: { effectiveType: "3g", downlink: 5 }, asrCached: false }).mode, "light");
  assert.equal(suggestMode({ connection: { effectiveType: "slow-2g" }, asrCached: false }).mode, "light");
  assert.equal(suggestMode({ connection: { effectiveType: "4g", downlink: 1.2 }, asrCached: false }).mode, "light");
  const slow = suggestMode({ connection: { effectiveType: "4g", downlink: 10 }, asrCached: false, asrBytes: 209e6 });
  assert.equal(slow.mode, "light", "209 MB at 10 Mbps is about 167 s, over a minute");
  assert.match(slow.reasons[0], /min to download/);
  assert.equal(suggestMode({ connection: null, ios: true, asrCached: null }).mode, "light", "iPhone, no connection info (Safari)");
});

test("mode: Private on a fast connection, with no signal, or when the free transcriber is not set up", () => {
  assert.equal(suggestMode({ connection: { effectiveType: "4g", downlink: 10 }, asrCached: false, asrBytes: 50e6 }).mode, "private");
  assert.equal(suggestMode({ connection: null, asrCached: false }).mode, "private", "desktop Safari or Firefox: no information, no change");
  assert.equal(suggestMode({ connection: { saveData: true }, ios: true, asrCached: false, lightAvailable: false }).mode, "private");
});

test("isIos: iPhone, and iPad reporting itself as a Mac with touch", () => {
  assert.equal(isIos({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }), true);
  assert.equal(isIos({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 5 }), true);
  assert.equal(isIos({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 0 }), false);
  assert.equal(isIos({ userAgent: "Mozilla/5.0 (Linux; Android 14)" }), false);
});

test("wake: one GET /healthz per proxy, never throwing", async () => {
  const seen = [];
  const fetchImpl = async (u) => (seen.push(u), { ok: true, json: async () => ({ light: true }) });
  const a = await wakeProxy("https://proxy.example/", { fetchImpl });
  const b = await wakeProxy("https://proxy.example", { fetchImpl });
  assert.deepEqual(seen, ["https://proxy.example/healthz"]);
  assert.equal(a.light, true);
  assert.equal(a, b);
  const down = await wakeProxy("https://down.example", { fetchImpl: async () => { throw new Error("offline"); } });
  assert.deepEqual([down.ok, down.light], [false, false]);
});

// ---------------------------------------------------------------- codecs

test("codec: Opus first, then AAC, then MP3, then WAV with short pieces", () => {
  assert.equal(pickCodec({ opus: 48000, aac: 16000 }).codec, "opus");
  assert.equal(pickCodec({ opus: 48000 }).rate, 48000);
  assert.equal(pickCodec({ aac: 24000 }).codec, "aac");
  assert.equal(pickCodec({ mp3: 16000 }).codec, "mp3");
  const wav = pickCodec({});
  assert.equal(wav.codec, "pcm-s16");
  assert.ok(wav.maxSec <= 40, "WAV pieces stay under the proxy's size cap");
  const opus = SPEECH_CODECS[0];
  assert.ok(estimateBytes(opus, 240) < 0.6e6, `4 minutes of 16 kbps Opus is ${estimateBytes(opus, 240)} bytes`);
  assert.ok(estimateBytes(wav, wav.maxSec) < 1.5 * 1024 * 1024, "a WAV piece fits the proxy's 1.5 MB cap");
});

// ---------------------------------------------------------------- the remote transcriber

const RATE = 16000;
const fakeEncode = async (pcm) => ({ blob: new Blob([new Uint8Array(10)]), bytes: Math.round(pcm.length / 8), sec: pcm.length / RATE, mime: "audio/ogg", ext: "ogg" });
const codec = async () => ({ codec: "opus", format: "ogg" });
/** A sender that answers each piece with one word per second of audio, relative to the piece. */
function fakeSender({ failAt = null, fail = null, slow = {} } = {}) {
  let n = 0;
  const s = {
    id: "fake",
    sent: [],
    async wake() {},
    async send(piece) {
      const i = n++;
      s.sent.push(piece.sec);
      if (slow[i]) await new Promise((r) => setTimeout(r, slow[i]));
      if (failAt != null && i >= failAt) throw fail;
      return { words: Array.from({ length: Math.floor(piece.sec) }, (_, k) => ({ w: `w${i}_${k}`, s: k, e: k + 0.5 })), duration: piece.sec };
    },
  };
  return s;
}

test("remote: pieces are sent compressed, and words come back in order on the recording's clock", async () => {
  const pcm = new Float32Array(RATE * 200).fill(0.1);
  const sender = fakeSender({ slow: { 0: 40 } }); // the first piece answers last
  const t = remoteTranscriber({ sender, encode: fakeEncode, codec, regions: null });
  const chunks = [];
  const res = await t.transcribe(pcm, { onChunk: (c) => chunks.push(c) });
  assert.deepEqual(chunks.map((c) => c.i), chunks.map((_, i) => i), "handed back in order");
  assert.equal(chunks[0].words[0].s, 0);
  assert.ok(res.words.every((w, i) => i === 0 || w.s >= res.words[i - 1].e), "monotonic times");
  const second = chunks[1].words[0];
  assert.ok(Math.abs(second.s - chunks[0].processed) < 1e-6, "the second piece's words start at its own place in the recording");
  assert.equal(res.doneSec, 200);
  assert.equal(res.bytes, chunks[chunks.length - 1].bytes, "bytes sent are counted");
  assert.ok(res.bytes > 0);
  assert.ok(sender.sent[0] <= 30, "a short first piece");
});

test("remote: a network blip is retried once; a busy quota stops with how far it got", async () => {
  const pcm = new Float32Array(RATE * 200).fill(0.1);
  let blips = 0;
  const flaky = fakeSender();
  const send = flaky.send;
  flaky.send = async (p) => {
    if (blips++ === 0) throw Object.assign(new Error("net"), { status: 0, transient: true });
    return send(p);
  };
  const ok = await remoteTranscriber({ sender: flaky, encode: fakeEncode, codec, regions: null, retryMs: 1 }).transcribe(pcm);
  assert.equal(ok.doneSec, 200);

  const busy = Object.assign(new Error("Too many requests."), { status: 429, busy: true, scope: "global" });
  const t = remoteTranscriber({ sender: fakeSender({ failAt: 1, fail: busy }), encode: fakeEncode, codec, regions: null, concurrency: 1 });
  await assert.rejects(t.transcribe(pcm), (e) => {
    assert.equal(e.busy, true);
    assert.ok(e.doneSec > 0 && e.doneSec <= 30, `kept the first piece (${e.doneSec} s)`);
    assert.ok(e.words.length > 0);
    return true;
  });
});

// ---------------------------------------------------------------- the engine's Light stage

async function probedOnly() {
  const store = createJobStore(memoryBackend());
  const file = new File([new Uint8Array(4096).fill(9)], "talk.mp4", { lastModified: 2 });
  const key = await contentKey(file);
  const job = new Engine({ store }).newJob(file, {});
  job.source = { ...job.source, duration: DURATION, width: 1920, height: 1080, uprightWidth: 1920, uprightHeight: 1080, fps: 25, audioStreams: [{ channels: 2 }] };
  Object.assign(job.stages.probe, { status: "done", progress: 1 });
  await store.saveStage(key, job, "probe");
  return { store, file };
}

/** A remote transcriber that returns the fixture talk's words, or fails as told. */
function fakeRemote({ fail = null, failAfterSec = 0 } = {}) {
  const words = talk(120);
  return {
    id: "remote:fake",
    model: "whisper-large-v3",
    where: "remote",
    calls: 0,
    async prepare() {},
    async transcribe(pcm, { onChunk, from = 0 } = {}) {
      this.calls++;
      const end = pcm.length / RATE;
      if (fail) {
        const kept = words.filter((w) => w.e <= failAfterSec);
        if (kept.length) onChunk?.({ words: kept, processed: failAfterSec, i: 0, n: 2, bytes: 1000 });
        throw Object.assign(fail, { doneSec: failAfterSec, words: kept });
      }
      const ws = words.filter((w) => w.s >= from);
      onChunk?.({ words: ws, processed: end, i: 0, n: 1, bytes: 250000 });
      return { words: ws, bytes: 250000, pieces: 3, codec: "opus", doneSec: end };
    },
  };
}

async function runLight(remote, { cached = false, deviceCalls = [] } = {}) {
  const s = await probedOnly();
  const engine = new Engine({ store: s.store, getJudge: async () => fakeBackend({ id: "gemini-proxy", model: "gemma-smart", where: "google" }), getTranscriber: async () => remote, render: fakeRender() });
  engine.lightHooks = {
    decode: async () => new Float32Array(Math.ceil(DURATION * RATE)),
    cached: async () => cached,
    device: () => ({ id: "device", where: "device", model: "whisper-base", async prepare() {}, async transcribe(pcm, { from = 0, onChunk } = {}) {
      deviceCalls.push(from);
      const ws = talk(120).filter((w) => w.s >= from);
      onChunk?.({ words: ws, processed: pcm.length / RATE });
      return { words: ws, doneSec: pcm.length / RATE };
    } }),
  };
  const job = await engine.createJob(s.file, {});
  await engine.idle(job.id);
  return { engine, job: engine.getJob(job.id), s };
}

test("light: the remote transcript feeds the same pipeline, and says what was sent", async () => {
  const remote = fakeRemote();
  const { job, engine } = await runLight(remote);
  assert.equal(job.stage, "ready", job.error?.message);
  assert.equal(job.asr.where, "remote");
  assert.equal(job.asr.sentBytes, 250000);
  assert.match(job.stages.transcribe.note, /0\.25 MB of audio sent/);
  assert.ok(engine.getWords(job.id).length > 100);
  assert.ok(job.candidates.length > 0);
});

test("light: free transcriber busy, speech model not saved here: nothing downloads, the person chooses", async () => {
  const busy = Object.assign(new Error("Too many requests."), { status: 429, busy: true, hint: "Light mode is at capacity for everyone right now." });
  const deviceCalls = [];
  const { job, engine } = await runLight(fakeRemote({ fail: busy, failAfterSec: 60 }), { cached: false, deviceCalls });
  assert.equal(job.stage, "error");
  assert.equal(job.error.code, "light_busy");
  assert.equal(job.error.message, "The free transcriber is busy right now. Use your own free key, or transcribe on this phone.");
  assert.deepEqual(job.error.choices.map((c) => c.id), ["retry", "key", "device"]);
  assert.ok(job.error.choices.find((c) => c.id === "device").bytes > 100e6, "the device choice says how big the download is");
  assert.equal(deviceCalls.length, 0, "no surprise download");

  // the person chooses to transcribe on the device
  await engine.chooseJudge(job.id, "device");
  await engine.idle(job.id);
  const now = engine.getJob(job.id);
  assert.equal(now.stage, "ready", now.error?.message);
  assert.equal(now.asr.where, "device");
});

test("light: free transcriber busy, speech model already saved: carries on on the device from where it stopped", async () => {
  const busy = Object.assign(new Error("Too many requests."), { status: 429, busy: true });
  const deviceCalls = [];
  const { job, engine } = await runLight(fakeRemote({ fail: busy, failAfterSec: 60 }), { cached: true, deviceCalls });
  assert.equal(job.stage, "ready", job.error?.message);
  assert.deepEqual(deviceCalls, [60], "the device starts where the free transcriber stopped");
  assert.equal(job.asr.where, "remote+device");
  assert.match(job.asr.note, /busy/);
  const words = engine.getWords(job.id);
  assert.ok(words.every((w, i) => i === 0 || w.s >= words[i - 1].s), "one transcript, in order, no repeats");
});
