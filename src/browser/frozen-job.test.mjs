// A job runs with the choices it started with: switching mode while it runs affects only new
// jobs. A Private job never sends anything to Google, whatever the page is switched to.
import assert from "node:assert/strict";
import { test } from "node:test";

await import("./test-env.mjs");
const mem = new Map();
globalThis.sessionStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { createBrowserApi } = await import("./api.js");
const { fakeBackend, fakeRender, WORDS, DURATION } = await import("./test-fakes.mjs");
const { contentKey } = await import("./store.js");

/** The adapter with stand-in judges, and a video whose probe and transcript are saved. */
async function setup(mode) {
  const device = fakeBackend({ id: "gemma3-wasm", model: "device-judge", where: "device", cached: true });
  const google = fakeBackend({ id: "gemini-key", model: "gemma-smart", where: "google" });
  const api = createBrowserApi({ mode, smart: { proxyUrl: null }, deps: { privateBackend: async () => device, geminiKeyBackend: () => google, proxyBackend: () => google, engine: { render: fakeRender(), inTabJudge: async () => true } } });
  const file = new File([new Uint8Array(4096).fill(3)], "talk.mp4", { lastModified: 3 });
  const key = await contentKey(file);
  const job = api.engine.newJob(file, {});
  job.source = { ...job.source, duration: DURATION, width: 1920, height: 1080, uprightWidth: 1920, uprightHeight: 1080, fps: 25, audioStreams: [{ channels: 2 }] };
  for (const s of ["probe", "transcribe"]) Object.assign(job.stages[s], { status: "done", progress: 1 });
  await api.engine.store.saveStage(key, job, "probe");
  await api.engine.store.saveStage(key, job, "transcribe", { words: WORDS, events: [], loudness: null });
  return { api, file, device, google };
}

/** Count every network call that would reach Google. */
function watchGoogle() {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (/googleapis|gemini|google/.test(String(url))) calls.push(String(url));
    return real(url, init);
  };
  return { calls, restore: () => (globalThis.fetch = real) };
}

test("a Private job stays Private when the page is switched to Smart mid-job", async () => {
  mem.clear();
  const { api, file, device, google } = await setup("private");
  const net = watchGoogle();
  try {
    const job = await api.createJob(file, {});
    api.setMode("smart", { key: "gemini-AAA" }); // the person switches while the job runs
    await api.engine.idle(job.id);
    const done = await api.getJob(job.id);
    assert.equal(done.stage, "ready", done.error?.message);
    assert.equal(google.calls.length, 0, "the Google judge was never asked");
    assert.equal(net.calls.length, 0, "no network call to Google");
    assert.ok(device.count("judge") > 0, "judged on the device, as the job started");
    assert.equal(done.judge.where, "device");
  } finally {
    net.restore();
  }
});

test("a job started in Smart mode keeps Smart mode when the page is switched to Private; new jobs use the new mode", async () => {
  mem.clear();
  const { api, file, device, google } = await setup("smart");
  api.setMode("smart", { key: "gemini-AAA" });
  const job = await api.createJob(file, {});
  api.setMode("private");
  await api.engine.idle(job.id);
  assert.equal((await api.getJob(job.id)).judge.where, "google");
  assert.ok(google.count("judge") > 0);
  assert.equal(device.count("judge"), 0);
});

test("a Smart job whose key is replaced mid-run stops plainly instead of using the new key", async () => {
  mem.clear();
  const { api, file, google } = await setup("smart");
  api.setMode("smart", { key: "gemini-AAA" });
  const job = await api.createJob(file, {});
  api.setMode("smart", { key: "gemini-BBB" });
  await api.engine.idle(job.id);
  const done = await api.getJob(job.id);
  assert.equal(done.stage, "error");
  assert.match(done.error.message, /Gemini key this job started with was removed or replaced/);
  assert.equal(google.count("judge"), 0);
  assert.ok(!JSON.stringify(done).includes("gemini-AAA") && !JSON.stringify(done).includes("gemini-BBB"), "the saved job holds fingerprints, never keys");
});
