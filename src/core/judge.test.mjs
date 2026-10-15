import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildMessages, judge, loadPrompt } from "./judge.mjs";

const cand = (id, text) => ({ id, start: 0, end: 30, text, hook: text.split(".")[0] + "." });

test("the judge prompt has system and user parts and fills the clip in", () => {
  const p = loadPrompt();
  assert.match(p.system, /HOOK/);
  assert.match(p.system, /STANDALONE/);
  const m = buildMessages(cand("c_1", "Nobody tells you this. It works."));
  assert.equal(m[0].role, "system");
  assert.match(m[1].content, /Nobody tells you this\. It works\./);
  assert.match(m[1].content, /30 seconds/);
  assert.doesNotMatch(m[1].content, /\{\{/);
});

test("judge scores each candidate once and caches by model and text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selects-judge-"));
  let calls = 0;
  const request = async () => {
    calls++;
    return { data: { reason: "Opens on a claim — and lands it. Extra sentence.", hook: 5, standalone: 4, payoff: 9, clarity: 0 } };
  };
  const cs = [cand("c_1", "One. Two."), cand("c_2", "Three. Four.")];
  const progress = [];
  const out = await judge(cs, { model: "m", cacheDir: dir, request, onProgress: (p) => progress.push(p.progress) });
  assert.equal(calls, 2);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].scores, { hook: 5, standalone: 4, payoff: 5, clarity: 1 }, "scores clamped to 1..5");
  assert.equal(out[0].reason, "Opens on a claim, and lands it.", "one sentence, no dashes");
  assert.ok(out[0].total > 0 && out[0].total < 1);
  assert.deepEqual(progress, [0.5, 1]);
  assert.equal(out.stats.judged, 2);
  // second run hits the cache
  const again = await judge(cs, { model: "m", cacheDir: dir, request });
  assert.equal(calls, 2);
  assert.equal(again.stats.cached, 2);
  // a different model is a different cache key
  await judge(cs.slice(0, 1), { model: "other", cacheDir: dir, request });
  assert.equal(calls, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("judge retries once on invalid JSON", async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("bad json"), { retryable: true });
    return { hook: 3, standalone: 3, payoff: 3, clarity: 3, reason: "Fine" };
  };
  const out = await judge([cand("c_1", "A. B.")], { model: "m", request });
  assert.equal(calls, 2);
  assert.equal(out[0].total, 0.5);
  assert.equal(out[0].reason, "Fine.");
});
