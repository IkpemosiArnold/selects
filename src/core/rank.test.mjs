import assert from "node:assert/strict";
import { test } from "node:test";
import { combine, WEIGHTS } from "./judge.mjs";
import { curve, rank } from "./rank.mjs";

const c = (id, start, end, total, pre = 0.5) => ({ id, start, end, total, pre, rank: null });

test("rank keeps the best and suppresses heavy overlaps (NMS)", () => {
  const cands = [c("a", 0, 40, 0.9), c("b", 5, 45, 0.85), c("c", 100, 140, 0.8), c("d", 200, 230, 0.4), c("e", 130, 170, 0.7)];
  const r = rank(cands, { k: 3, iou: 0.3 });
  assert.deepEqual(
    r.map((x) => x.id),
    ["a", "c", "e"],
  ); // b overlaps a heavily; e overlaps c by 10/70 < 0.3
  assert.deepEqual(
    r.map((x) => x.rank),
    [1, 2, 3],
  );
  assert.equal(cands[0].rank, null, "input not mutated");
});

test("rank breaks ties with the pre-score, and puts unjudged last", () => {
  const r = rank([c("x", 0, 30, 0.5, 0.2), c("y", 100, 130, 0.5, 0.9), c("z", 200, 230, null)], { k: 3 });
  assert.deepEqual(
    r.map((x) => x.id),
    ["y", "x", "z"],
  );
});

test("rank returns fewer than k when overlaps leave nothing", () => {
  const r = rank([c("a", 0, 40, 0.9), c("b", 1, 41, 0.8)], { k: 5, iou: 0.3 });
  assert.equal(r.length, 1);
});

test("curve has a point every step, stays in 0..1, and peaks where the best clip is", () => {
  const cur = curve([c("a", 50, 80, 0.9), c("b", 0, 30, 0.3)], 120, { step: 5 });
  assert.equal(cur.length, 25);
  assert.equal(cur[0].t, 0);
  assert.equal(cur[cur.length - 1].t, 120);
  for (const p of cur) assert.ok(p.v >= 0 && p.v <= 1);
  const peak = cur.reduce((a, b) => (b.v > a.v ? b : a));
  assert.ok(peak.t >= 50 && peak.t <= 80, `peak at ${peak.t}`);
  assert.equal(cur.find((p) => p.t === 110).v, 0);
});

test("combine maps 1..5 rubric scores to 0..1 with hook weighted most", () => {
  assert.equal(combine({ hook: 5, standalone: 5, payoff: 5, clarity: 5 }), 1);
  assert.equal(combine({ hook: 1, standalone: 1, payoff: 1, clarity: 1 }), 0);
  const hookHeavy = combine({ hook: 5, standalone: 1, payoff: 1, clarity: 1 });
  const clarityHeavy = combine({ hook: 1, standalone: 1, payoff: 1, clarity: 5 });
  assert.ok(hookHeavy > clarityHeavy);
  assert.equal(+Object.values(WEIGHTS).reduce((a, b) => a + b, 0).toFixed(6), 1);
});

test("quality bar: strong clips counted, weak ones marked; with none strong only the closest 2 stay", async () => {
  const { applyQualityBar, qualityVerdict, STRONG_TOTAL } = await import("./rank.mjs");
  assert.equal(STRONG_TOTAL, 0.55);
  const mk = (id, total, extra = {}) => ({ id, total, rank: null, reason: `Reason ${id}.`, ...extra });
  // the EMF talk's three picks: all strong
  const emf = applyQualityBar([mk("a", 0.683), mk("b", 0.629), mk("c", 0.557)]);
  assert.deepEqual(emf.verdict, { strong: 3, threshold: 0.55, best: 0.683, note: "3 strong clips." });
  assert.ok(emf.candidates.every((c) => c.weak === false));
  // the family video's picks (0.40 to 0.52): none strong, the closest 2 kept with their reasons
  const fam = applyQualityBar([mk("a", 0.524), mk("b", 0.466), mk("c", 0.403)]);
  assert.equal(fam.verdict.strong, 0);
  assert.match(fam.verdict.note, /^No strong clips in this video\. These are the closest 2, with why\.$/);
  assert.deepEqual(fam.candidates.map((c) => [c.id, c.rank, c.weak]), [["a", 1, true], ["b", 2, true]]);
  const mixed = qualityVerdict([mk("a", 0.6), mk("b", 0.5)]);
  assert.equal(mixed.note, "1 strong clip. The other 1 is weaker.");
  // a misleading cut nobody accepted is never strong
  assert.equal(qualityVerdict([mk("a", 0.7, { demoted: true })]).strong, 0);
  assert.match(qualityVerdict([mk("a", 0.3)]).note, /This is the closest one/);
  assert.equal(qualityVerdict([]).note, "No clips were found in this video.");
});
