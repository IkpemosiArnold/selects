// Audio-only jobs in the browser engine (a voice memo, a podcast): they follow the same
// frozen choices as a video, render as audiograms with the chosen background, and a format
// the browser cannot read is said plainly at the first step.
import assert from "node:assert/strict";
import { test } from "node:test";

await import("./test-env.mjs");
const { Engine } = await import("./engine.js");
const { fakeBackend, fakeRender, runOnce, seeded, DURATION } = await import("./test-fakes.mjs");
const { codecName, isWebKit, unreadableAudio } = await import("./media.js");

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

test("an audio-only job runs to review like a video, with no filmstrip", async () => {
  const s = await seeded(Engine, { audio: true });
  const { job } = await runOnce(Engine, s, fakeBackend({ model: "m" }));
  assert.equal(job.stage, "ready", job.error?.message);
  assert.equal(job.source.hasVideo, false);
  assert.ok(job.candidates.length > 0);
});

test("phone, Private mode: an audio job gets the same rule as a video (no in-tab judge, nothing downloads)", async () => {
  const s = await seeded(Engine, { audio: true });
  const device = fakeBackend({ id: "gemma3-wasm", model: "gemma-3-1b", cached: false });
  device.bytes = 721918496;
  const { job } = await runOnce(Engine, s, device, {}, { inTabJudge: async () => false });
  assert.equal(job.stage, "ready", job.error?.message);
  assert.equal(device.loads, 0, "the 722 MB judge is never loaded on a phone");
  assert.equal(job.judge.backend, "prescore");
});

test("the profile an audio job started with is frozen: a later mode switch does not change it", async () => {
  const s = await seeded(Engine, { audio: true });
  let profile = { mode: "smart", judgeRoute: "proxy", keyId: null };
  const backend = fakeBackend({ id: "gemini-proxy", model: "gemma-4-26b", where: "google" });
  const seen = [];
  const engine = new Engine({ store: s.store, getProfile: () => profile, getJudge: async (p) => (seen.push(p.mode), backend), render: fakeRender(), inTabJudge: async () => true });
  const job = await engine.createJob(s.file, {});
  profile = { mode: "private", judgeRoute: "device", keyId: null };
  await engine.idle(job.id);
  assert.ok(seen.length > 0 && seen.every((m) => m === "smart"), `every stage used the frozen mode: ${seen.join(", ")}`);
  assert.equal(engine.getJob(job.id).profile.mode, "smart");
});

test("render: an audio clip is rendered as an audiogram with the chosen background, and a new background marks it stale", async () => {
  const s = await seeded(Engine, { audio: true });
  const render = fakeRender();
  const { engine, job } = await runOnce(Engine, s, fakeBackend({ model: "m" }), {}, { render });
  const c = job.candidates[0];
  assert.throws(() => engine.patchJob(job.id, { audiogram: { bg: "dragon" } }), /must be one of/);
  assert.throws(() => engine.patchJob(job.id, { audiogram: { bg: "cover" } }), /background image first/);
  engine.patchJob(job.id, { audiogram: { bg: "frog" } });
  await engine.render(job.id, { ids: [c.id] });
  assert.deepEqual(render.seen[0].audiogram, { bg: "frog" });
  let now = engine.getJob(job.id).candidates.find((x) => x.id === c.id);
  assert.equal(now.render.status, "done");
  assert.equal(now.render.stale, false);
  engine.patchJob(job.id, { audiogram: { bg: "moon" } });
  now = engine.getJob(job.id).candidates.find((x) => x.id === c.id);
  assert.equal(now.render.stale, true, "the clip was made with another background");
  engine.patchJob(job.id, { audiogram: { bg: "frog" } });
  assert.equal(engine.getJob(job.id).candidates.find((x) => x.id === c.id).render.stale, false, "and back again");
  await engine.idle(job.id);
});

test("your own image: kept with the job on this device, chosen, and handed to the renderer", async () => {
  const s = await seeded(Engine, { audio: true });
  const render = fakeRender();
  const { engine, job } = await runOnce(Engine, s, fakeBackend({ model: "m" }), {}, { render });
  await assert.rejects(engine.setCover(job.id, new Blob(["x"], { type: "text/plain" })), /Choose an image/);
  const img = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  const after = await engine.setCover(job.id, img);
  assert.equal(after.settings.audiogram.bg, "cover");
  assert.ok(await s.store.part(s.key, "cover"), "saved on the device for a resumed job");
  await engine.render(job.id, { ids: [job.candidates[0].id] });
  assert.equal(render.seen[0].audiogram.bg, "cover");
  assert.equal(render.seen[0].audiogram.cover, img);
  // a preset again keeps the image for later
  engine.patchJob(job.id, { audiogram: { bg: "cat" } });
  assert.equal(engine.getJob(job.id).settings.audiogram.cover, "cover");
  engine.patchJob(job.id, { audiogram: { bg: "cover" } });
  assert.equal(engine.getJob(job.id).settings.audiogram.bg, "cover");
  await engine.idle(job.id);
});

test("the review meter reads the same loudness the render measures", async () => {
  const pcm = new Float32Array(Math.ceil(DURATION * 16000));
  for (let i = 16000 * 10; i < 16000 * 12; i++) pcm[i] = 0.4 * Math.sin(i / 3);
  const s = await seeded(Engine, { audio: true, pcm });
  const { engine, job } = await runOnce(Engine, s, fakeBackend({ model: "m" }));
  const env = await engine.levels(job.id, 9, 13);
  assert.equal(env.fps, 30);
  assert.equal(env.v.length, 120);
  assert.equal(Math.max(...env.v.slice(0, 29)), 0, "quiet before");
  assert.ok(env.v[45] > 0.9, "loud where the sound is");
});

test("a format this browser cannot read is said plainly, with what to do", () => {
  assert.equal(codecName("flac"), "FLAC");
  assert.equal(codecName("pcm-s16"), "WAV");
  assert.equal(isWebKit(IPHONE), true);
  assert.equal(isWebKit(CHROME), false);
  const phone = unreadableAudio("opus", { ua: IPHONE });
  assert.equal(phone.message, "This browser can't read Opus audio.");
  assert.match(phone.hint, /M4A/);
  assert.match(phone.hint, /Voice Memos/);
  assert.doesNotMatch(phone.hint, /Chrome/, "no browser to switch to on an iPhone: they are all WebKit");
  const lossless = unreadableAudio(null, { ua: CHROME });
  assert.match(lossless.message, /the sound in this file/);
  for (const e of [phone, lossless]) assert.doesNotMatch(e.message + e.hint, /—/);
});
