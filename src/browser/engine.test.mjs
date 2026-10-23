// The browser engine in Node, with a fake judge and renderer (test-fakes.mjs): what is reused
// when a saved job runs again, what is computed again, and what a person decided.
import assert from "node:assert/strict";
import { test } from "node:test";

await import("./test-env.mjs");
const { Engine } = await import("./engine.js");
const { fakeBackend, runOnce, seeded } = await import("./test-fakes.mjs");
const { windowKey } = await import("../core/decisions.mjs");

const judged = (job) => job.stages.judge.note || "";

test("cache: re-ranking with another judge model judges again, keeps approvals, and never transcribes again", async () => {
  const s = await seeded(Engine);
  const a = fakeBackend({ model: "gemma-a" });
  const one = await runOnce(Engine, s, a);
  assert.equal(one.job.stage, "ready", one.job.error?.message);
  assert.ok(a.count("judge") > 0);
  const pick = one.job.candidates[0];
  one.engine.patchCandidate(one.job.id, pick.id, { status: "approved" });
  await one.engine.idle(one.job.id);

  const b = fakeBackend({ model: "gemma-b" });
  const two = await runOnce(Engine, s, b);
  assert.equal(two.job.stage, "ready", two.job.error?.message);
  assert.ok(b.count("judge") > 0, "the new model judged the clips");
  assert.equal(two.job.judge.model, "gemma-b");
  assert.match(two.job.stages.transcribe.note, /saved on this device/, "the transcript was reused");
  assert.doesNotMatch(judged(two.job), /saved on this device/, "the old judgment was not reused");
  const again = two.job.candidates.find((c) => windowKey(c) === windowKey(pick));
  assert.equal(again?.status, "approved", "the approval came back on the same window");

  // the same model and settings again: everything is reused
  const c = fakeBackend({ model: "gemma-b" });
  const three = await runOnce(Engine, s, c);
  assert.match(judged(three.job), /saved on this device/);
  assert.equal(c.calls.length, 0, "no model call at all");
  assert.equal(three.job.candidates.find((x) => windowKey(x) === windowKey(pick))?.status, "approved");
});

test("cache: Made for, k and the length range are judgment inputs; the length range is a selection input", async () => {
  const s = await seeded(Engine);
  const a = fakeBackend({ model: "gemma-a" });
  await runOnce(Engine, s, a, { madeFor: "shorts" });

  const story = fakeBackend({ model: "gemma-a" });
  const r1 = await runOnce(Engine, s, story, { madeFor: "story" });
  assert.doesNotMatch(judged(r1.job), /saved on this device/, "story changes what the judge is told");
  assert.ok(story.calls.some((t) => t.kind === "judge" && t.madeFor === "story"));

  const k = fakeBackend({ model: "gemma-a" });
  const r2 = await runOnce(Engine, s, k, { madeFor: "story", k: 3 });
  assert.doesNotMatch(judged(r2.job), /saved on this device/, "k changes the ranking and the faithful checks");
  assert.match(r2.job.stages.candidates.note, /saved on this device/, "k alone keeps the shortlist");

  const len = fakeBackend({ model: "gemma-a" });
  const r3 = await runOnce(Engine, s, len, { madeFor: "story", k: 3, minLen: 25, maxLen: 45 });
  assert.doesNotMatch(r3.job.stages.candidates.note, /saved on this device/, "a new length range is a new selection");
  assert.ok(r3.job.candidates.every((c) => c.end - c.start <= 45 + 1e-6));
  assert.match(r3.job.stages.transcribe.note, /saved on this device/);
});

test("decisions: a decision survives a run that drops its window, and comes back with the window", async () => {
  const s = await seeded(Engine);
  const one = await runOnce(Engine, s, fakeBackend({ model: "m" }));
  const pick = one.job.candidates[0];
  one.engine.patchCandidate(one.job.id, pick.id, { status: "approved" });
  await one.engine.idle(one.job.id);

  // a length range that cannot hold that window
  const len = pick.end - pick.start;
  const narrow = len > 30 ? { minLen: 20, maxLen: Math.floor(len) - 2 } : { minLen: Math.ceil(len) + 2, maxLen: 60 };
  const two = await runOnce(Engine, s, fakeBackend({ model: "m" }), narrow);
  for (const c of two.job.candidates) {
    if (c.status === "approved") assert.equal(windowKey(c), windowKey(pick), `only the same window is approved, not ${c.id} (${c.start} to ${c.end})`);
  }
  const three = await runOnce(Engine, s, fakeBackend({ model: "m" }), { minLen: one.job.settings.minLen, maxLen: one.job.settings.maxLen });
  assert.equal(three.job.candidates.find((c) => windowKey(c) === windowKey(pick))?.status, "approved", "back with its window");
});

test("cache: the answer cache keys on everything the model sees", async () => {
  const { faithfulRound, listwiseRound } = await import("./judge.js");
  const words = (await import("./test-fakes.mjs")).WORDS;
  const llm = fakeBackend({ id: "memo-test", model: "memo-1" });
  const c = { id: "c_1", start: words[0].s, end: words[30].e, text: words.slice(0, 31).map((w) => w.w).join(" "), hook: "Point 0 is that we tried something new and it worked." };
  await faithfulRound([c], llm, { words });
  await faithfulRound([c], llm, { words });
  assert.equal(llm.count("faithful"), 1, "the same question is asked once");
  // the same clip with other context words is another question
  await faithfulRound([c], llm, { words: words.map((w, i) => (i === 33 ? { ...w, w: "However," } : w)) });
  assert.equal(llm.count("faithful"), 2, "a different sentence after the clip is a new call");
  // listwise: the model is told each clip's length, so the same words cut longer are a new question
  const mk = (id, start, end) => ({ id, start, end, text: "Start here. Then the middle part. The end of it all.", hook: "Start here.", total: 0.5, scores: { hook: 3, standalone: 3, payoff: 3, clarity: 3 } });
  const top = (len) => [mk("a", 0, len), mk("b", 100, 130), mk("c", 200, 230)];
  await listwiseRound(top(30), llm, { n: 3 });
  await listwiseRound(top(30).map((c) => ({ ...c, id: `${c.id}2`, pre: 0.9 })), llm, { n: 3 });
  assert.equal(llm.count("listwise"), 1, "fields the model never sees do not split the cache");
  await listwiseRound(top(45), llm, { n: 3 });
  assert.equal(llm.count("listwise"), 2, "a clip of another length is a new call");
  // another model behind the same backend id is another answer
  const other = fakeBackend({ id: "memo-test", model: "memo-2" });
  await faithfulRound([c], other, { words });
  assert.equal(other.count("faithful"), 1);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A caption edit that turns "tried" into `to` in the first cue inside the clip. */
function fixCaption(engine, id, c, to) {
  const cues = engine.getCaptions(id).cues;
  const i = cues.findIndex((q) => q.s >= c.start - 1e-6 && q.e <= c.end + 1e-6 && / tried /.test(` ${q.text} `));
  assert.ok(i >= 0, "a cue inside the clip says tried");
  engine.putCaptions(id, cues.map((q, j) => ({ s: q.s, e: q.e, text: j === i ? q.text.replace("tried", to) : q.text })));
}

// each test below uses its own model name: the page-wide answer cache would otherwise answer for it
test("kit: corrected captions reach the posting kit", async () => {
  const s = await seeded(Engine);
  const llm = fakeBackend({ model: "kit-corrected" });
  const { engine, job } = await runOnce(Engine, s, llm);
  const c = job.candidates[0];
  engine.patchCandidate(job.id, c.id, { status: "approved" });
  fixCaption(engine, job.id, c, "tested Jedidiah's plan");
  await engine.render(job.id, { ids: [c.id] });
  await engine.idle(job.id);
  const kit = engine.getKit(job.id, c.id);
  assert.match(kit.captionText, /tested Jedidiah's plan/, "the kit is written from the corrected words");
  const asked = llm.calls.filter((t) => t.kind === "kit");
  assert.equal(asked.length, 1);
  assert.match(asked[0].candidate.text, /tested Jedidiah's plan/);
  assert.equal(engine.getJob(job.id).candidates.find((x) => x.id === c.id).text, c.text, "the candidate itself is not rewritten");
});

test("kit: a caption fix after rendering rewrites that clip's kit and no other", async () => {
  const s = await seeded(Engine);
  const llm = fakeBackend({ model: "kit-invalidate" });
  const { engine, job } = await runOnce(Engine, s, llm);
  const x = job.candidates[0];
  const y = job.candidates.find((c) => c.start >= x.end || c.end <= x.start);
  assert.ok(y, "two clips that do not overlap");
  await engine.render(job.id, { ids: [x.id, y.id] });
  await engine.idle(job.id);
  const before = { x: engine.getKit(job.id, x.id), y: engine.getKit(job.id, y.id), calls: llm.count("kit") };
  fixCaption(engine, job.id, x, "tested Jedidiah's plan");
  await engine.idle(job.id);
  const after = { x: engine.getKit(job.id, x.id), y: engine.getKit(job.id, y.id) };
  assert.match(after.x.captionText, /Jedidiah/, "the fixed clip's kit follows the captions");
  assert.doesNotMatch(before.x.captionText, /Jedidiah/);
  assert.equal(after.y.captionText, before.y.captionText, "the other clip's kit is untouched");
  assert.equal(llm.count("kit"), before.calls + 1, "one new kit call, for the clip that changed");
  assert.equal(engine.getJob(job.id).candidates.find((c) => c.id === x.id).render.kitStatus, "done");
});

test("render: a clip is ready the moment its MP4 is stored; its kit follows with its own status", async () => {
  const s = await seeded(Engine);
  let release;
  const gate = new Promise((r) => (release = r));
  const llm = fakeBackend({ model: "kit-gated", gates: { kit: gate } });
  const { engine, job } = await runOnce(Engine, s, llm);
  const c = job.candidates[0];
  const events = [];
  engine.on(job.id, (type, data) => type === "render" && data.id === c.id && events.push({ ...data }));
  try {
    const out = await Promise.race([engine.render(job.id, { ids: [c.id] }), sleep(3000).then(() => "still waiting")]);
    assert.notEqual(out, "still waiting", "render() does not wait for the posting kit");
    const now = engine.getJob(job.id).candidates.find((x) => x.id === c.id);
    assert.equal(now.render.status, "done");
    assert.ok(engine.clipUrl(job.id, c.id), "the MP4 can be played and saved");
    assert.ok(["pending", "running"].includes(now.render.kitStatus), `kit ${now.render.kitStatus}`);
    assert.throws(() => engine.getKit(job.id, c.id), /still being written/);
    assert.ok(events.some((e) => e.status === "done" && e.kitStatus !== "done"), "a done event went out before the kit");
  } finally {
    release();
  }
  await engine.idle(job.id);
  const done = engine.getJob(job.id).candidates.find((x) => x.id === c.id);
  assert.equal(done.render.kitStatus, "done");
  assert.match(engine.getKit(job.id, c.id).title, /^About:/);
  assert.equal(events.at(-1).kitStatus, "done");
});

test("render: a kit that fails says so, keeps a plain kit, and can be tried again", async () => {
  const s = await seeded(Engine);
  const fail = ["kit"];
  const llm = fakeBackend({ model: "kit-fails", fail });
  const { engine, job } = await runOnce(Engine, s, llm);
  const c = job.candidates[0];
  await engine.render(job.id, { ids: [c.id] });
  await engine.idle(job.id);
  let now = engine.getJob(job.id).candidates.find((x) => x.id === c.id);
  assert.equal(now.render.status, "done", "the MP4 is fine");
  assert.equal(now.render.kitStatus, "error");
  assert.ok(now.render.kitError);
  assert.equal(engine.getKit(job.id, c.id).title, c.hook.replace(/[.!?]+$/, "").slice(0, 60), "a plain kit to copy meanwhile");
  fail.length = 0;
  await engine.retryKit(job.id, c.id);
  await engine.idle(job.id);
  now = engine.getJob(job.id).candidates.find((x) => x.id === c.id);
  assert.equal(now.render.kitStatus, "done");
  assert.match(engine.getKit(job.id, c.id).title, /^About:/);
});

// ---------------------------------------------------------------- Smart mode down

/** Pretend the browser reports this connection (Network Information API). */
function fakeConnection(c) {
  const had = Object.getOwnPropertyDescriptor(globalThis.navigator, "connection");
  Object.defineProperty(globalThis.navigator, "connection", { value: c, configurable: true });
  return () => (had ? Object.defineProperty(globalThis.navigator, "connection", had) : delete globalThis.navigator.connection);
}

test("smart mode down, private model not saved: nothing downloads; the person chooses", async () => {
  const restore = fakeConnection({ downlink: 10, effectiveType: "4g", type: "cellular", saveData: false });
  try {
    const s = await seeded(Engine);
    const smart = fakeBackend({ id: "gemini-proxy", model: "smart-down", where: "google", failLoad: Object.assign(new Error("The Smart mode server did not wake up."), { hint: "Try again in a minute." }) });
    const device = fakeBackend({ id: "gemma4-webgpu", model: "device-not-saved", cached: false });
    device.bytes = 2003697664;
    const { engine, job } = await runOnce(Engine, s, smart, {}, { getFallback: async () => device });
    assert.equal(device.loads, 0, "no surprise download");
    assert.equal(job.stage, "error");
    assert.equal(job.error.code, "smart_unavailable");
    assert.deepEqual(job.error.choices.map((c) => c.id), ["retry", "preliminary", "download"]);
    const dl = job.error.choices.find((c) => c.id === "download");
    assert.equal(dl.bytes, device.bytes, "the size of what would download");
    assert.equal(dl.estSec, Math.round((device.bytes * 8) / 10e6), "an estimate at the speed the browser reports");
    assert.equal(dl.metered, true, "mobile data is flagged");
    assert.match(dl.warning, /mobile data/i);

    // use the preliminary ranking now: no model at all
    await engine.chooseJudge(job.id, "preliminary");
    await engine.idle(job.id);
    let now = engine.getJob(job.id);
    assert.equal(now.stage, "ready", now.error?.message);
    assert.equal(now.judge.backend, "prescore");
    assert.ok(now.candidates.length > 0);
    assert.ok(now.candidates.every((c) => c.judgedOn === "prescore"));
    assert.equal(device.loads, 0);
    assert.match(now.stages.transcribe.note, /saved on this device/);

    // or download the private model, now that the person said so
    await engine.chooseJudge(job.id, "download");
    await engine.idle(job.id);
    now = engine.getJob(job.id);
    assert.equal(now.stage, "ready", now.error?.message);
    assert.equal(device.loads, 1);
    assert.equal(now.judge.backend, "gemma4-webgpu");
    assert.ok(device.count("judge") > 0);
  } finally {
    restore();
  }
});

test("smart mode down, private model already saved: it falls back and says so plainly", async () => {
  const s = await seeded(Engine);
  const smart = fakeBackend({ id: "gemini-proxy", model: "smart-down-2", where: "google", failLoad: new Error("The Smart mode server did not wake up.") });
  const device = fakeBackend({ id: "gemma3-wasm", model: "device-saved", cached: true });
  const { job } = await runOnce(Engine, s, smart, {}, { getFallback: async () => device });
  assert.equal(job.stage, "ready", job.error?.message);
  assert.equal(job.judge.backend, "gemma3-wasm");
  assert.match(job.judge.note, /already saved in this browser/);
});

test("smart mode slow on one clip, private model not saved: that clip keeps its first-stage score, nothing downloads", async () => {
  const s = await seeded(Engine);
  const smart = fakeBackend({ id: "gemini-proxy", model: "smart-flaky", where: "google", fail: ["judge"] });
  const device = fakeBackend({ id: "gemma4-webgpu", model: "device-not-saved-2", cached: false });
  const { job } = await runOnce(Engine, s, smart, {}, { getFallback: async () => device });
  assert.equal(job.stage, "ready", job.error?.message);
  assert.equal(device.loads, 0, "no surprise download");
  assert.ok(job.candidates.some((c) => /Smart mode could not judge this clip/.test(c.reason)));
});

test("phone, Private mode: no in-tab judge, nothing downloads, ranked by the first-stage score and the cut checks", async () => {
  for (const cached of [false, true]) {
    const s = await seeded(Engine);
    const device = fakeBackend({ id: "gemma3-wasm", model: "gemma-3-1b", cached });
    device.bytes = 721918496;
    const { job } = await runOnce(Engine, s, device, {}, { inTabJudge: async () => false });
    assert.equal(job.stage, "ready", job.error?.message);
    assert.equal(device.loads, 0, `the judge is never loaded in a phone's tab (saved: ${cached})`);
    assert.equal(device.calls.length, 0);
    assert.equal(job.judge.backend, "prescore");
    assert.ok(job.candidates.length > 0);
    assert.ok(job.candidates.every((c) => c.judgedOn === "prescore"));
    assert.equal(job.faithful?.mode, "rules", "the cut checks still ran");
    assert.match(job.judge.note, /phone/);
    assert.doesNotMatch(job.judge.note, /—/);
  }
});

test("phone, Smart mode down: no offer to download the private model, and no fallback to it", async () => {
  const s = await seeded(Engine);
  const smart = fakeBackend({ id: "gemini-proxy", model: "smart-down", where: "google", failLoad: new Error("The Smart mode server did not wake up.") });
  const device = fakeBackend({ id: "gemma3-wasm", model: "gemma-3-1b", cached: true });
  const { job } = await runOnce(Engine, s, smart, {}, { getFallback: async () => device, inTabJudge: async () => false });
  assert.equal(device.loads, 0);
  assert.equal(job.error?.code, "smart_unavailable");
  assert.deepEqual(job.error.choices.map((c) => c.id), ["retry", "preliminary"]);
});

test("computer, Private mode: the in-tab judge runs as before", async () => {
  const s = await seeded(Engine);
  const device = fakeBackend({ id: "gemma3-wasm", model: "gemma-3-1b", cached: false });
  const { job } = await runOnce(Engine, s, device, {}, { inTabJudge: async () => true });
  assert.equal(job.stage, "ready", job.error?.message);
  assert.equal(device.loads, 1);
  assert.ok(device.count("judge") > 0);
});
