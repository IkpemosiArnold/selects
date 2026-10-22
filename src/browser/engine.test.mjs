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
