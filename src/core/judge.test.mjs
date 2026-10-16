import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildMessages, judge, loadPrompt } from "./judge.mjs";

const cand = (id, text) => ({ id, start: 0, end: 30, text, hook: text.split(".")[0] + "." });

test("the judge prompt has system and user parts and fills the clip in", () => {
  const p = loadPrompt();
  assert.match(p.system, /hook/);
  assert.match(p.system, /standalone/);
  assert.ok(p.system.split(/\s+/).length < 190, "rubric stays short (under about 250 tokens)");
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

test("salvageJudge keeps the scores from an answer cut off in the reason", async () => {
  const { salvageJudge } = await import("./judge.mjs");
  const cut = '{"hook": 4, "standalone": 2, "payoff": 3, "clarity": 4, "reason": "Opens on a strong claim about strength but the ending trails off into';
  const s = salvageJudge(cut);
  assert.deepEqual([s.hook, s.standalone, s.payoff, s.clarity], [4, 2, 3, 4]);
  assert.equal(s.reason, "Opens on a strong claim about strength but the ending trails off");
  assert.equal(salvageJudge('{"hook":1,"standalone":1,"payoff":1,"clarity":1,"reason":"Ends on the promise of a').reason, "Ends on the promise");
  assert.equal(salvageJudge('{"reason": "Long reason first and then nothing'), null);
});

test("judge uses a salvaged answer instead of failing the job", async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    throw Object.assign(new Error("bad json"), { retryable: true, content: '{"hook":5,"standalone":4,"payoff":4,"clarity":3,"reason":"Lands the number at the' });
  };
  const out = await judge([cand("c_1", "A. B.")], { model: "m", request });
  assert.equal(calls, 1);
  assert.deepEqual(out[0].scores, { hook: 5, standalone: 4, payoff: 4, clarity: 3 });
  assert.equal(out[0].reason, "Lands the number.");
});
