// Light mode in Node: which mode is suggested, the remote transcriber's pieces and fallbacks,
// the codec choice, and the engine's transcribe stage with a fake remote transcriber.
import assert from "node:assert/strict";
import { test } from "node:test";

await import("./test-env.mjs");
const { isIos, measureDownlink, suggestMode, wakeProxy } = await import("./light.js");
const { growingPcm, progressivePieces } = await import("./speech-chunks.js");
const { dueForPicks, preliminaryPicks } = await import("./preliminary.js");
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

test("mode: Light is the default whenever the speech model is not here and Light can run", () => {
  const plain = suggestMode({ connection: { effectiveType: "4g", downlink: 10 }, asrCached: false, asrBytes: 50e6 });
  assert.equal(plain.mode, "light", "even on a fast connection: Private is opt-in");
  assert.match(plain.reasons[0], /not in this browser yet/);
  assert.equal(suggestMode({ connection: { saveData: true, downlink: 10 }, asrCached: false }).reasons[0], "Data Saver is on");
  assert.match(suggestMode({ connection: { effectiveType: "3g", downlink: 5 }, asrCached: false }).reasons[0], /3G/);
  assert.match(suggestMode({ connection: { effectiveType: "4g", downlink: 1.2 }, asrCached: false }).reasons[0], /1.2 Mbps/);
  const slow = suggestMode({ connection: { effectiveType: "4g", downlink: 10 }, asrCached: false, asrBytes: 209e6 });
  assert.match(slow.reasons[0], /min to download/, "209 MB at 10 Mbps is about 167 s");
  assert.equal(slow.estSec, 167);
  const ios = suggestMode({ connection: null, ios: true, asrCached: null });
  assert.equal(ios.mode, "light");
  assert.ok(ios.reasons.includes("this is an iPhone or iPad"));
});

test("mode: Safari's 1 MB probe stands in for the speed the browser does not report", () => {
  const s = suggestMode({ connection: null, probeMbps: 0.8, asrCached: false, asrBytes: 140e6 });
  assert.equal(s.mbps, 0.8);
  assert.equal(s.estSec, 1400);
  assert.match(s.reasons[0], /0.8 Mbps/);
  assert.equal(suggestMode({ connection: { downlink: 5 }, probeMbps: 0.5, asrCached: false }).mbps, 5, "a reported speed wins");
});

test("mode: Private when the free transcriber is off and there is no own key", () => {
  assert.equal(suggestMode({ connection: { saveData: true }, ios: true, asrCached: false, lightAvailable: false }).mode, "private");
});

test("probe: times a 1 MB range request; a timeout is a slow answer, an error is no answer", async () => {
  let t = 0;
  const now = () => t;
  const ok = await measureDownlink("https://x/model", { now, fetchImpl: async (u, o) => {
    assert.equal(o.headers.range, "bytes=0-1048575");
    t = 4000; // 1 MiB in 4 s
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(1 << 20) };
  } });
  assert.equal(ok, 2.1);
  assert.equal(await measureDownlink("https://x/model", { fetchImpl: async () => { throw new Error("offline"); } }), null);
  const slow = await measureDownlink("https://x/model", { timeoutMs: 10, fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted")))) });
  assert.ok(slow > 0 && slow < 1000, "a timeout says the speed is under 1 MB per timeout");
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
    async transcribe(pcm, { onChunk, from = 0, audio = null } = {}) {
      this.calls++;
      if (audio) await audio.wait(Infinity); // progressive: the whole decode, for simplicity
      const end = (audio ? audio.length : pcm.length) / RATE;
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

// ---------------------------------------------------------------- progressive

test("progressive: pieces are cut and sent while the audio is still arriving", async () => {
  const audio = growingPcm(RATE * 200);
  const block = new Float32Array(RATE * 10).fill(0.1);
  const cut = [];
  const reader = (async () => {
    for await (const p of progressivePieces(audio, RATE)) cut.push({ ...p, heard: audio.length / RATE });
  })();
  for (let i = 0; i < 20; i++) {
    audio.append(block);
    await new Promise((r) => setTimeout(r, 1));
  }
  audio.finish();
  await reader;
  assert.ok(cut[0].end / RATE <= 30, "a 30 s first piece");
  assert.ok(cut[0].heard < 60, `the first piece went out after ${cut[0].heard} s of 200 s had been read`);
  assert.equal(cut[cut.length - 1].end, RATE * 200, "the last piece ends at the end");
  for (let i = 1; i < cut.length; i++) assert.equal(cut[i].start, cut[i - 1].end);
});

test("progressive: the remote transcriber streams from growing audio", async () => {
  const audio = growingPcm(RATE * 200);
  const sender = fakeSender();
  const t = remoteTranscriber({ sender, encode: fakeEncode, codec, regions: null });
  const firsts = [];
  const run = t.transcribe(null, { audio, onChunk: (c) => firsts.push({ i: c.i, read: audio.length / RATE }) });
  for (let i = 0; i < 20; i++) {
    audio.append(new Float32Array(RATE * 10).fill(0.1));
    await new Promise((r) => setTimeout(r, 2));
  }
  audio.finish();
  const res = await run;
  assert.ok(firsts[0].read < 200, `the first words came back after ${firsts[0].read} s of audio was read`);
  assert.equal(res.doneSec, 200);
  assert.ok(res.words.length > 150);
});

test("early picks: the best windows inside what has been heard, not overlapping, refreshed each minute", () => {
  const words = talk(120);
  const upTo = 200;
  const heard = words.filter((w) => w.e <= upTo);
  const picks = preliminaryPicks({ words: heard, upTo });
  assert.ok(picks.length >= 1 && picks.length <= 3);
  assert.ok(picks.every((p) => p.end <= upTo - 3 && p.preliminary));
  for (const a of picks) for (const b of picks) if (a !== b) assert.ok(Math.min(a.end, b.end) - Math.max(a.start, b.start) <= 0.2 * Math.min(a.end - a.start, b.end - b.start) + 1e-6);
  assert.equal(dueForPicks({ upTo: 100, duration: 600 }), false);
  assert.equal(dueForPicks({ upTo: 181, duration: 600 }), true);
  assert.equal(dueForPicks({ upTo: 200, lastAt: 181, duration: 600 }), false);
  assert.equal(dueForPicks({ upTo: 245, lastAt: 181, duration: 600 }), true);
  assert.equal(dueForPicks({ upTo: 120, duration: 120 }), true, "a short video gets its picks at the end");
});

test("light: early picks are published while the transcript arrives", async () => {
  const words = talk(120);
  const remote = {
    id: "remote:fake", model: "whisper-large-v3", where: "remote", async prepare() {},
    async transcribe(pcm, { onChunk, audio } = {}) {
      await audio.wait(Infinity);
      for (const at of [120, 240, DURATION]) onChunk({ words: words.filter((w) => w.s >= at - 120 && w.s < at), processed: at, bytes: 1000 });
      return { words, bytes: 3000, pieces: 3, codec: "opus", doneSec: DURATION };
    },
  };
  const s = await probedOnly();
  const engine = new Engine({ store: s.store, getJudge: async () => fakeBackend({ id: "gemini-proxy", model: "g", where: "google" }), getTranscriber: async () => remote, render: fakeRender() });
  engine.lightHooks = { decode: async () => new Float32Array(Math.ceil(DURATION * RATE)), cached: async () => false };
  const seen = [];
  const job = await engine.createJob(s.file, {});
  engine.on(job.id, (type, data) => type === "preliminary" && seen.push(data));
  await engine.idle(job.id);
  assert.equal(engine.getJob(job.id).stage, "ready");
  assert.ok(seen.length >= 1, "at least one round of early picks");
  assert.equal(seen[0].upTo, 240, "the first after 3 minutes or more had been heard");
  assert.ok(seen[0].picks.every((p) => p.end <= 240));
});

test("light: a transcript made through the shared transcriber is reused with the person's own key", async () => {
  const s = await probedOnly();
  const first = { ...fakeRemote(), id: "remote:proxy" };
  const make = (remote) => {
    const e = new Engine({ store: s.store, getJudge: async () => fakeBackend({ id: "gemini-proxy", model: "g", where: "google" }), getTranscriber: async () => remote, render: fakeRender() });
    e.lightHooks = { decode: async () => new Float32Array(Math.ceil(DURATION * RATE)), cached: async () => false };
    return e;
  };
  const a = make(first);
  const j1 = await a.createJob(s.file, {});
  await a.idle(j1.id);
  assert.equal(first.calls, 1);
  const second = { ...fakeRemote(), id: "remote:groq-key" };
  const b = make(second);
  const j2 = await b.createJob(s.file, {});
  await b.idle(j2.id);
  assert.equal(second.calls, 0, "no second transcription");
  assert.match(b.getJob(j2.id).stages.transcribe.note, /saved on this device/);
});

test("cache check: the device's speech model files, finished in the resumable store or saved the old way", async () => {
  const { speechFileUrls, speechModelCached } = await import("./light.js");
  const { MODELS } = await import("./models.js");
  const tiny = speechFileUrls(MODELS.whisperTiny, "wasm");
  assert.deepEqual(tiny.map((u) => u.split("/resolve/main/")[1]), ["onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"]);
  for (const u of [...tiny, ...speechFileUrls(MODELS.whisper, "wasm")]) assert.ok(MODELS[u.includes("tiny") ? "whisperTiny" : "whisper"].files[u.split("/resolve/main/")[1]], `${u} is a pinned file`);
  const store = (done) => ({ info: async (url) => (done.includes(url) ? { bytes: 10, meta: { done: true, size: 10 } } : { bytes: 4, meta: { size: 10 } }) });
  const none = async () => ({ match: async () => undefined });
  assert.equal(await speechModelCached(MODELS.whisperTiny, "wasm", { openStore: async () => store(tiny), openLegacy: none }), true);
  assert.equal(await speechModelCached(MODELS.whisperTiny, "wasm", { openStore: async () => store([tiny[0]]), openLegacy: none }), false, "half a model is not cached");
  const legacy = async () => ({ match: async (u) => (tiny.includes(u) ? new Response("x") : undefined) });
  assert.equal(await speechModelCached(MODELS.whisperTiny, "wasm", { openStore: async () => null, openLegacy: legacy }), true, "a copy from before resumable downloads counts");
});
