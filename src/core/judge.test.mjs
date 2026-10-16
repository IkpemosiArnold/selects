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
  const curly = '{"hook": 3, "standalone": 3, "payoff": 2, "clarity": 4, "reason": "The low-risk claim is intriguing, but the shift to them needs clarification.\u201d} 11 words. 11 words. 11.';
  assert.equal(salvageJudge(curly).reason, "The low-risk claim is intriguing, but the shift to them needs clarification.");
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

test("blend mixes judge and pre-score 0.7 / 0.3", async () => {
  const { blend } = await import("./judge.mjs");
  assert.equal(blend(1, 0), 0.7);
  assert.equal(blend(0.5, 1), 0.65);
  assert.equal(blend(0.5, undefined), 0.5);
});

test("listwise orders the top distinct clips from first and last sentences only", async () => {
  const { listwise, buildListMessages, parseListAnswer } = await import("./judge.mjs");
  const mk = (id, start, total, text) => ({ id, start, end: start + 30, total, pre: 0.5, hook: text.split(". ")[0] + ".", text });
  const cs = [
    mk("c1", 0, 0.7, "First one opens. Middle bit that is long. It ends here."),
    mk("c2", 5, 0.69, "Overlaps c1 heavily. So it is not in the round."),
    mk("c3", 100, 0.6, "Third opens. Then it lands the point."),
    mk("c4", 200, 0.5, "Fourth opens. Then fades."),
  ];
  const msgs = buildListMessages([cs[0], cs[2]]);
  assert.match(msgs[1].content, /Clip A \(30 s\)\nFirst: "First one opens\."\nLast: "It ends here\."/);
  assert.doesNotMatch(msgs[1].content, /Middle bit/);
  let seen;
  const request = async (m) => {
    seen = m[1].content;
    return { data: { ranking: [{ clip: "C", reason: "Best hook" }, { clip: "A", reason: "Solid" }, { clip: "B", reason: "Fades" }] } };
  };
  const lw = await listwise(cs, { model: "m", n: 4, request });
  assert.doesNotMatch(seen, /Overlaps c1/, "overlapping windows are not compared");
  assert.deepEqual(lw.order, ["c4", "c1", "c3"]);
  const byId = Object.fromEntries(lw.candidates.map((c) => [c.id, c]));
  assert.equal(byId.c4.listRank, 1);
  assert.equal(byId.c4.total, +(0.85 * 0.5 + 0.15).toFixed(3));
  assert.equal(byId.c2.total, +(0.85 * 0.69).toFixed(3), "not in the round: scaled, no bonus");
  // a cut-off answer still yields an order; missing letters keep their place at the end
  const p = parseListAnswer('{"ranking":[{"clip":"B","reason":"x"},{"clip":"B"},{"clip":"A","reason":"cut', ["A", "B", "C"]);
  assert.deepEqual(p.order, ["B", "A", "C"]);
  assert.equal(p.complete, false);
});

test("judge and listwise create a missing cacheDir before logging calls", async () => {
  const { listwise } = await import("./judge.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "selects-judge-dir-"));
  const stats = { wallSec: 1, promptTokens: 10, promptSec: 0.5, outTokens: 5, outSec: 0.5 };
  try {
    const dir1 = path.join(root, "not", "there", "yet");
    await judge([cand("c_1", "One. Two.")], { model: "m", cacheDir: dir1, request: async () => ({ data: { hook: 3, standalone: 3, payoff: 3, clarity: 3, reason: "Fine." }, stats }) });
    const lines = fs.readFileSync(path.join(dir1, "judge-calls.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).id, "c_1");

    // a failed call is logged too, and that can be the very first write
    const dir2 = path.join(root, "fails", "first");
    await assert.rejects(judge([cand("c_2", "Three.")], { model: "m", cacheDir: dir2, request: async () => { throw Object.assign(new Error("Ollama returned 500"), { stats }); } }), /500/);
    assert.match(fs.readFileSync(path.join(dir2, "judge-calls.jsonl"), "utf8"), /"failed":"Ollama returned 500"/);

    const dir3 = path.join(root, "listwise", "dir");
    const mk = (id, start, total) => ({ id, start, end: start + 30, total, pre: 0.5, hook: "Opens.", text: "Opens. Ends." });
    await listwise([mk("a", 0, 0.7), mk("b", 100, 0.6)], { model: "m", n: 2, cacheDir: dir3, request: async () => ({ data: { ranking: [{ clip: "B", reason: "x" }, { clip: "A", reason: "y" }] }, stats }) });
    assert.match(fs.readFileSync(path.join(dir3, "judge-calls.jsonl"), "utf8"), /"kind":"listwise"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
