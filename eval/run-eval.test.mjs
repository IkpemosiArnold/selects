// Fixture test for the runner: a fake core (same signatures as notes/CONTRACTS.md) and a
// generated 2-minute audio file, so the pipeline is checked before src/core lands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "selects-run-eval-"));
process.env.SELECTS_EVAL_CACHE = join(dir, "cache");
process.env.SELECTS_EVAL_RESULTS = join(dir, "results");
process.env.SELECTS_TEST_NO_LOCK = "1";
const { runVideo, aggregate, report, oracle, parsePlan } = await import("./run-eval.mjs");

const tiou = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) / (Math.max(a.end, b.end) - Math.min(a.start, b.start));
const fakeCore = {
  transcribe: async () => Array.from({ length: 240 }, (_, i) => ({ w: i % 10 === 9 ? "end." : "word", s: i * 0.5, e: i * 0.5 + 0.4, p: 0.9 })),
  toSentences: (words) => { const out = []; for (let i = 0; i < words.length; i += 10) out.push({ s: words[i].s, e: words[Math.min(i + 9, words.length - 1)].e, text: "x", wordIdx: [i, i + 9] }); return out; },
  makeCandidates: () => { const out = []; for (let t = 0; t + 30 <= 120; t += 10) out.push({ id: `c_${t}`, start: t, end: t + 30, text: "x", hook: "x", rank: null, status: "proposed", pre: t === 40 ? 0.8 : 0.5 }); return out; },
  shortlist: (cands, { n }) => cands.slice(0, n),
  maxJudge: 8,
  judge: async (cands) => cands.map((c) => ({ ...c, judgeTotal: c.start === 40 ? 0.9 : 0.1, total: c.start === 40 ? 0.8 : 0.2, scores: { hook: 3, standalone: 3, payoff: 3, clarity: 3 }, reason: "test" })),
  listwise: async (cands) => ({ candidates: cands.map((c) => ({ ...c, total: c.total * 0.85 })), order: [], complete: true }),
  promptVersion: "test",
  rank: (cands, { k }) => { const kept = []; for (const c of [...cands].sort((a, b) => b.total - a.total)) { if (kept.every((x) => tiou(x, c) < 0.3)) kept.push(c); if (kept.length === k) break; } return kept.map((c, i) => ({ ...c, rank: i + 1 })); },
  curve: (cands, duration, { step }) => Array.from({ length: Math.ceil(duration / step) }, (_, i) => ({ t: i * step, v: 0 })),
};

test("runVideo scores random, energy and a judge against labels", async () => {
  const audio = join(dir, "a.wav");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=120", "-ar", "8000", "-y", audio]);
  const v = { id: "fixture", title: "Fixture", duration: 120, localPath: audio, labels: [{ start: 40, end: 70, source: "heatmap", weight: 1 }] };
  try {
    const plan = parsePlan("fake-model@8+list,fake-model@all");
    const out = await runVideo(v, fakeCore, plan);
    assert.equal(out.nCandidates, 10);
    assert.equal(out.methods["judge:fake-model@8"].metrics.heatmap.hit3, 1);
    assert.equal(out.methods["judge:fake-model@all"].n, 10);
    assert.ok(out.methods["shipped+list:fake-model@8"]);
    assert.equal(out.methods.oracle.metrics.heatmap.hit5, 1);
    assert.equal(out.nShortlist, 8);
    assert.equal(out.methods["prefilter@8"].metrics.heatmap.hit3, 1);
    const r = out.methods.random.metrics.heatmap.p3;
    assert.ok(r > 0 && r < 1, `random chance level ${r}`);
    assert.ok(existsSync(join(dir, "results", "curves", "fixture.json")));
    const agg = aggregate([out]);
    assert.equal(agg.heatmap["judge:fake-model@8"].n, 1);
    const md = report([out], agg, [v], plan);
    assert.match(md, /n = 1/);
    assert.match(md, /prefilter \+ fake-model/);
    assert.doesNotMatch(md, /\$\{/);
    // second run comes from cache, no new judge call
    let called = false;
    const again = await runVideo(v, { ...fakeCore, judge: async () => { called = true; return []; } }, plan);
    assert.equal(called, false);
    assert.equal(again.methods["judge:fake-model@8"].metrics.heatmap.hit3, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oracle reports what the candidate pool can reach", () => {
  const cands = [{ start: 0, end: 30 }, { start: 100, end: 130 }];
  const o = oracle(cands, { heatmap: [{ start: 0, end: 30 }, { start: 500, end: 530 }] });
  assert.equal(o.heatmap.hit5, 1);
  assert.equal(o.heatmap.r5, 0.5);
});

test("parsePlan reads model@N, model@all and +list", () => {
  assert.deepEqual(parsePlan("a:b@8,c@all,d@16+list"), [{ model: "a:b", n: 8, list: false }, { model: "c", n: "all", list: false }, { model: "d", n: 16, list: true }]);
  assert.throws(() => parsePlan("nope"));
});
