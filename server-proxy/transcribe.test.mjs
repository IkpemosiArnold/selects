// POST /transcribe (Light mode): only short audio pieces, the gates in order (ingress, size and
// audio checks, then the quota), no audio or text in the log, and the browser's word shape.
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { asrFromEnv, audioSeconds, chainAsr, checkAudio, openAiCompatibleAsr, sniffAudio } from "./asr.mjs";
import { createMockWhisper } from "./mock-whisper.mjs";
import { createProxy } from "./server.mjs";

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));

/** A minimal Ogg Opus file: an OpusHead page and a last page whose granule says `sec` seconds. */
function ogg(sec = 10, pad = 2000) {
  const page = (granule, body) => {
    const h = Buffer.alloc(27);
    h.write("OggS", 0, "latin1");
    h.writeBigInt64LE(BigInt(granule), 6);
    h[26] = 1;
    return Buffer.concat([h, Buffer.from([body.length & 255]), body]);
  };
  return Buffer.concat([page(0, Buffer.from("OpusHead\x01\x01\x38\x01\x80\x3e\x00\x00\x00\x00\x00", "latin1")), Buffer.alloc(pad, 1), page(Math.round(sec * 48000), Buffer.alloc(10))]);
}
/** An MP4 with a video handler. */
const mp4Video = () => Buffer.concat([Buffer.from("\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2", "latin1"), Buffer.from("\x00\x00\x00\x21hdlr\x00\x00\x00\x00\x00\x00\x00\x00videVideoHandler\x00", "latin1"), Buffer.alloc(64)]);
const wav = (sec) => {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1");
  h.write("WAVE", 8, "latin1");
  h.writeUInt32LE(32000, 28);
  h.write("data", 36, "latin1");
  h.writeUInt32LE(32000 * sec, 40);
  return Buffer.concat([h, Buffer.alloc(100)]);
};

async function setup(opts = {}) {
  const mock = createMockWhisper();
  const base = `${await listen(mock.server)}/openai/v1`;
  const logs = [];
  const asr = opts.asr === undefined ? openAiCompatibleAsr({ name: "groq", base, key: "test-groq", model: "whisper-large-v3" }) : opts.asr;
  const proxy = createProxy({ key: "gemini-key", base: "http://127.0.0.1:1/v1beta", origins: ["http://localhost:4319"], log: (l) => logs.push(l), ...opts, asr });
  const url = await listen(proxy);
  const post = (body, { origin = "http://localhost:4319", type = "audio/ogg" } = {}) => fetch(`${url}/transcribe`, { method: "POST", headers: { "content-type": type, origin }, body });
  return { mock, url, logs, post, close: () => (mock.server.close(), proxy.close()) };
}

test("transcribe: an Opus piece comes back as words with punctuation, and nothing of it is logged", async () => {
  const s = await setup();
  try {
    const r = await s.post(ogg(12));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "http://localhost:4319");
    const j = await r.json();
    assert.deepEqual(j.words, [{ w: "Hello,", s: 0.1, e: 0.5 }, { w: "world.", s: 0.6, e: 1.1 }], "the browser's { w, s, e } shape");
    assert.equal(j.model, "whisper-large-v3");
    const sent = s.mock.seen.at(-1);
    assert.equal(sent.auth, "Bearer test-groq");
    assert.equal(sent.name, "audio.ogg");
    assert.equal(sent.fields.model, "whisper-large-v3");
    assert.equal(sent.fields.response_format, "verbose_json");
    assert.equal(sent.fields["timestamp_granularities[]"], "word,segment", "word times asked for");
    assert.equal(sent.fields.language, "en");
    assert.equal(s.logs.length, 1);
    assert.doesNotMatch(s.logs[0], /Hello|world/, "no words in the log");
    const h = await (await fetch(`${s.url}/healthz`)).json();
    assert.equal(h.light, true);
    assert.equal(h.counts.transcribed, 1);
  } finally {
    s.close();
  }
});

test("transcribe: refuses video, non-audio, other origins, over-long and oversized pieces without spending quota", async () => {
  const s = await setup({ limits: { asrPerIpPerMinute: 1, asrBodyBytes: 64 * 1024, asrMaxSec: 180 } });
  try {
    assert.equal((await s.post(mp4Video(), { type: "audio/mp4" })).status, 400, "an MP4 with a video track");
    assert.equal((await s.post(Buffer.from("{\"kind\":\"judge\"}"), { type: "application/json" })).status, 400, "not audio");
    assert.equal((await s.post(ogg(400))).status, 400, "400 s of audio in one piece");
    assert.equal((await s.post(wav(200), { type: "audio/wav" })).status, 400, "an over-long WAV");
    assert.equal((await s.post(ogg(10, 100 * 1024))).status, 413, "over the size cap");
    assert.equal((await s.post(ogg(10), { origin: "https://evil.example" })).status, 403);
    assert.equal(s.mock.seen.length, 0, "none of them reached the model");
    assert.equal((await s.post(ogg(10))).status, 200, "the refusals did not use this visitor's one call a minute");
    const r = await s.post(ogg(10));
    assert.equal(r.status, 429);
    assert.equal((await r.json()).scope, "ip");
  } finally {
    s.close();
  }
});

test("transcribe: the global quota and the audio-seconds meter fail closed for everyone", async () => {
  const s = await setup({ limits: { asrGlobalPerMinute: 2 }, trustProxyHops: 1 });
  try {
    const from = (ip) => fetch(`${s.url}/transcribe`, { method: "POST", headers: { "content-type": "audio/ogg", "x-forwarded-for": ip }, body: ogg(10) });
    assert.equal((await from("1.1.1.1")).status, 200);
    assert.equal((await from("2.2.2.2")).status, 200);
    const r = await from("3.3.3.3");
    assert.equal(r.status, 429);
    const j = await r.json();
    assert.equal(j.scope, "global");
    assert.match(j.hint, /Private mode/);
  } finally {
    s.close();
  }
  // audio seconds: charged after each answer (at least 10 s, as hosted whisper bills)
  const t = await setup({ limits: { asrSecGlobalPerHour: 15 } });
  try {
    assert.equal((await t.post(ogg(5))).status, 200, "10 s charged");
    assert.equal((await t.post(ogg(5))).status, 200, "20 s charged: over the cap only after this one");
    const r = await t.post(ogg(5));
    assert.equal(r.status, 429);
    assert.equal((await r.json()).scope, "global");
    assert.equal(t.mock.seen.length, 2);
  } finally {
    t.close();
  }
});

test("transcribe: ingress limit refuses a flood before reading the body", async () => {
  const s = await setup({ limits: { asrIngressPerIpPerMinute: 2 } });
  try {
    await s.post(Buffer.from("junk junk junk"));
    await s.post(Buffer.from("junk junk junk"));
    const r = await s.post(ogg(10));
    assert.equal(r.status, 429);
    assert.equal((await r.json()).scope, "ingress");
  } finally {
    s.close();
  }
});

test("transcribe: not set up answers 503 and says what to do; the judge still works", async () => {
  const s = await setup({ asr: null });
  try {
    const r = await s.post(ogg(10));
    assert.equal(r.status, 503);
    assert.match((await r.json()).hint, /Private|Smart/);
    assert.equal((await (await fetch(`${s.url}/healthz`)).json()).light, false);
  } finally {
    s.close();
  }
});

test("transcribe: an upstream quota error becomes 429 with the plain hint; a failover provider takes over", async () => {
  const quota = { id: "groq", model: "whisper-large-v3", transcribe: async () => { throw Object.assign(new Error("upstream 429"), { status: 429, transient: true }); } };
  const s = await setup({ asr: quota });
  try {
    const r = await s.post(ogg(10));
    assert.equal(r.status, 429);
    assert.match((await r.json()).hint, /Private mode/);
  } finally {
    s.close();
  }
  const backup = { id: "cloudflare", model: "@cf/openai/whisper-large-v3-turbo", transcribe: async () => ({ words: [{ w: "Hi.", s: 0, e: 0.3 }], duration: 1, model: "@cf/openai/whisper-large-v3-turbo" }) };
  const chain = chainAsr([quota, backup]);
  assert.equal((await chain.transcribe({})).model, "@cf/openai/whisper-large-v3-turbo");
  const refused = { id: "groq", transcribe: async () => { throw Object.assign(new Error("bad audio"), { status: 400 }); } };
  await assert.rejects(chainAsr([refused, backup]).transcribe({}), /bad audio/, "a refusal of the audio is not sent elsewhere");
});

test("audio checks and the provider choice from the environment", () => {
  assert.equal(sniffAudio(ogg(1)).kind, "ogg");
  assert.equal(sniffAudio(Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00\x00\x00", "latin1")).kind, "mp3");
  assert.equal(sniffAudio(Buffer.from("<html><body>hi</body></html>")), null);
  assert.ok(Math.abs(audioSeconds(ogg(42), "ogg") - 42) < 0.01);
  assert.equal(audioSeconds(wav(3), "wav"), 3);
  assert.equal(checkAudio(mp4Video()).ok, false);
  assert.equal(asrFromEnv({}), null, "no key: Light mode is off, nothing is paid for");
  assert.equal(asrFromEnv({ GROQ_API_KEY: "k" }).id, "groq");
  assert.equal(asrFromEnv({ GROQ_API_KEY: "k" }).model, "whisper-large-v3");
  assert.equal(asrFromEnv({ GROQ_API_KEY: "k", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }).id, "groq+cloudflare");
  assert.equal(asrFromEnv({ CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }).id, "cloudflare");
});

/** MPEG-2 Layer III frames at 16 kHz, 32 kbps (144 bytes, 36 ms each) for `sec` seconds. */
function mp3(sec) {
  const frame = Buffer.alloc(144);
  frame.set([0xff, 0xf3, 0x48, 0xc4]); // sync, MPEG-2, Layer III, no CRC; 32 kbps (index 4), 16 kHz (index 2); mono
  return Buffer.concat(Array.from({ length: Math.ceil(sec / 0.036) }, () => frame));
}

test("audio: an MP3 longer than the limit is refused; one of unknown length is refused", () => {
  assert.equal(checkAudio(mp3(240)).ok, false, "4 minutes of MP3 must not pass a 3-minute gate");
  const ok = checkAudio(mp3(60));
  assert.equal(ok.ok, true);
  assert.ok(Math.abs(ok.audio.sec - 60) < 0.1, `read ${ok.audio.sec} s`);
  const webmNoDuration = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 0x20)]);
  assert.equal(checkAudio(webmNoDuration).ok, false, "length unknown: refused");
});

test("providers: a JSON body that stalls after the headers times out and fails over", async () => {
  const stalled = async () => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "application/json" } });
  const groq = openAiCompatibleAsr({ name: "groq", base: "https://groq.example", key: "k", model: "whisper-large-v3", timeoutMs: 150, fetchImpl: stalled });
  const t0 = Date.now();
  await assert.rejects(groq.transcribe({ buf: Buffer.from("OggS"), mime: "audio/ogg", ext: "ogg" }), (e) => e.status === 0 && e.transient === true);
  assert.ok(Date.now() - t0 < 2000, "the deadline covers the body");
  const backup = { id: "cloudflare", model: "cf", transcribe: async () => ({ words: [{ w: "Hi.", s: 0, e: 0.3 }], duration: 1, model: "cf" }) };
  assert.equal((await chainAsr([groq, backup]).transcribe({ buf: Buffer.from("OggS"), mime: "audio/ogg", ext: "ogg" })).model, "cf");
});
