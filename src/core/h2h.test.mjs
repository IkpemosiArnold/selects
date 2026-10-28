import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyH2H, fitBradleyTerry, h2hCalls, h2hEstimateSec, h2hOn, H2H_DEFAULTS, PAIR_COST, pairKey, parsePairAnswer, swissPairs, tournament } from "./h2h-core.mjs";
import { rank } from "./rank.mjs";
import { orderByFaithful } from "./faithful-core.mjs";
import { headToHead } from "./judge.mjs";
import { buildTask, checkTaskShape, readTask, slimTask } from "./tasks.mjs";
import { judgmentSignature } from "./signatures.mjs";
import { estimateJob } from "./estimate.mjs";

const clip = (id, start, q, extra = {}) => ({ id, start, end: start + 30, text: `clip ${id} words`, hook: `clip ${id}`, q, total: 0.6, pre: 0.5, scores: { moment: 4, share: 3, hook: 3, standalone: 4 }, ...extra });
/** n clips 60 s apart with a hidden quality q (higher is better); their absolute totals all tie. */
const clips = (qs) => qs.map((q, i) => clip(`c${i}`, i * 60, q));

/** A stand-in judge: prefers the better clip; when the two are within `margin`, it says "A". */
const standIn = ({ margin = 0, calls = [] } = {}) => async (a, b) => {
  calls.push([a.id, b.id]);
  if (Math.abs(a.q - b.q) <= margin) return { first: "A", why: "shown first" };
  return a.q > b.q ? { first: "A", why: `${a.id} lands` } : { first: "B", why: `${b.id} lands` };
};

const spearman = (order, truth) => {
  const n = order.length;
  const pos = new Map(truth.map((x, i) => [x, i]));
  let d2 = 0;
  order.forEach((x, i) => (d2 += (i - pos.get(x)) ** 2));
  return 1 - (6 * d2) / (n * (n * n - 1));
};

// ---------------------------------------------------------------- parsing

test("parsePairAnswer reads the letter from JSON, near-JSON and plain text", () => {
  assert.deepEqual(parsePairAnswer({ first: "B", why: "A real laugh." }), { first: "B", why: "A real laugh." });
  assert.equal(parsePairAnswer({ first: "a" }).first, "A");
  assert.equal(parsePairAnswer({ winner: "Clip B" }).first, "B");
  assert.equal(parsePairAnswer({ choice: "clip a", reason: "hot take" }).why, "hot take");
  assert.equal(parsePairAnswer('```json\n{"first": "B", "why": "the confession"}\n```').first, "B");
  assert.equal(parsePairAnswer("B. It has the laugh.").first, "B");
  assert.equal(parsePairAnswer("Clip A, because it lands").first, "A");
  // cut off by the output budget: the letter comes first, so it survives
  const cut = parsePairAnswer('{"first": "A", "why": "the cooking story is funn');
  assert.equal(cut.first, "A");
  assert.match(cut.why, /^the cooking story/);
});

test("parsePairAnswer returns null when no clear choice can be read", () => {
  assert.equal(parsePairAnswer(null), null);
  assert.equal(parsePairAnswer({}), null);
  assert.equal(parsePairAnswer({ first: "C" }), null);
  assert.equal(parsePairAnswer({ first: "Both" }), null);
  assert.equal(parsePairAnswer("I cannot decide."), null);
  assert.equal(parsePairAnswer("Absolutely, the first one"), null, "a word that starts with A is not the letter");
});

test("the pair task: messages show A first, the answer reads, and the proxy shape check accepts it", () => {
  const prompts = { pairwise: fs.readFileSync(new URL("./prompts/pairwise.md", import.meta.url), "utf8") };
  const a = clip("a", 0, 1, { text: "first clip words" });
  const b = clip("b", 60, 1, { text: "second clip words", cueText: "second clip (laughter) words" });
  const t = buildTask({ kind: "pair", a, b }, prompts);
  assert.equal(t.messages.length, 2);
  const u = t.messages[1].content;
  assert.ok(u.indexOf("Clip A") < u.indexOf("Clip B"));
  assert.match(u, /first clip words[\s\S]*second clip \(laughter\) words/, "the judge's cue marks are shown");
  assert.deepEqual(t.schema.required, ["first", "why"]);
  assert.deepEqual(readTask({ kind: "pair" }, { data: { first: "B", why: "x" } }), { first: "B", why: "x" });
  assert.equal(readTask({ kind: "pair" }, { text: "no idea" }), null);
  assert.equal(checkTaskShape(slimTask({ kind: "pair", a, b })), null);
  assert.match(checkTaskShape({ kind: "pair", a }), /a and b/);
  assert.deepEqual(Object.keys(slimTask({ kind: "pair", a: { ...a, secret: 1 }, b })).sort(), ["a", "b", "kind"]);
  assert.equal(slimTask({ kind: "pair", a: { ...a, secret: 1 }, b }).a.secret, undefined);
});

// ---------------------------------------------------------------- Bradley-Terry

test("fitBradleyTerry orders by wins, stays finite for an unbeaten clip, and is 0 with no games", () => {
  const games = [
    { first: 0, second: 1, y: 1 },
    { first: 1, second: 0, y: 0 },
    { first: 1, second: 2, y: 1 },
    { first: 2, second: 1, y: 0 },
    { first: 0, second: 2, y: 1 },
  ];
  const { s, h } = fitBradleyTerry(3, games);
  assert.ok(s[0] > s[1] && s[1] > s[2]);
  assert.ok(s.every(Number.isFinite));
  assert.ok(Math.abs(h) < 0.5, "a balanced design shows little first-position bias");
  assert.deepEqual(fitBradleyTerry(4, []).s, [0, 0, 0, 0]);
});

test("fitBradleyTerry: a first-position habit goes into h, not into the strengths", () => {
  // every pair asked in both orders, and the clip shown first always wins
  const games = [];
  for (const [i, j] of [[0, 1], [1, 2], [0, 2], [2, 3], [0, 3]]) games.push({ first: i, second: j, y: 1 }, { first: j, second: i, y: 1 });
  const { s, h } = fitBradleyTerry(4, games);
  assert.ok(h > 1, `h ${h}`);
  for (const x of s) assert.ok(Math.abs(x) < 1e-6, `strength ${x}`);
});

// ---------------------------------------------------------------- Swiss pairing

test("swissPairs pairs neighbours, never repeats a pair, and gives an odd one out a bye", () => {
  const met = new Set();
  const r1 = swissPairs([0, 1, 2, 3, 4], met);
  assert.deepEqual(r1, [[0, 1], [2, 3]]);
  for (const [a, b] of r1) met.add(pairKey(a, b));
  const r2 = swissPairs([0, 1, 2, 3, 4], met);
  assert.deepEqual(r2, [[0, 2], [1, 3]]);
  for (const [a, b] of r2) assert.ok(!met.has(pairKey(a, b)));
});

test("tournament recovers the hidden order from a reversed start, without rematches", async () => {
  const qs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; // absolute order (the seed) is worst first
  const items = clips(qs);
  const calls = [];
  const r = await tournament(items, standIn({ calls }), { rounds: 6, orders: "both", maxCalls: 150 });
  const truth = items.map((_, i) => i).sort((a, b) => qs[b] - qs[a]);
  assert.ok(spearman(r.order, truth) > 0.9, `spearman ${spearman(r.order, truth)}`);
  assert.equal(r.order[0], 11, "the best clip comes first");
  assert.equal(r.calls, 6 * 6 * 2);
  assert.equal(r.consistency, 1);
  const pairs = new Set();
  for (let i = 0; i < calls.length; i += 2) {
    const k = [calls[i][0], calls[i][1]].sort().join("|");
    assert.ok(!pairs.has(k), `rematch ${k}`);
    pairs.add(k);
    assert.deepEqual(calls[i + 1], [calls[i][1], calls[i][0]], "both orders are asked");
  }
});

// ---------------------------------------------------------------- position bias

test("a judge that always answers A moves no clip in both orders, and barely any when each pair is asked once", async () => {
  const items = clips([5, 1, 9, 3, 7, 2]);
  const both = await tournament(items, async () => ({ first: "A", why: "" }), { rounds: 4, orders: "both", maxCalls: 100 });
  assert.deepEqual(both.order, [0, 1, 2, 3, 4, 5], "the absolute order stays");
  assert.ok(both.h > 1, `h ${both.h}`);
  assert.equal(both.consistency, 0);
  // asked once, a clip shown first one time more than second keeps a small edge: the price of half the calls
  const once = await tournament(items, async () => ({ first: "A", why: "" }), { rounds: 4, orders: "alternate", maxCalls: 100 });
  assert.ok(once.h > 1, `h ${once.h}`);
  for (const x of once.s) assert.ok(Math.abs(x) < 0.3, `strength ${x}`);
  // a real result moves a clip further than that edge
  const real = await tournament(items, standIn(), { rounds: 4, orders: "alternate", maxCalls: 100 });
  assert.ok(Math.max(...real.s) > 0.5);
});

test("alternate orders: each clip is shown first about as often as second", async () => {
  const items = clips([1, 2, 3, 4, 5, 6, 7, 8]);
  const calls = [];
  await tournament(items, standIn({ calls }), { rounds: 6, orders: "alternate", maxCalls: 100 });
  const first = new Map();
  const second = new Map();
  for (const [a, b] of calls) {
    first.set(a, (first.get(a) || 0) + 1);
    second.set(b, (second.get(b) || 0) + 1);
  }
  for (const c of items) assert.ok(Math.abs((first.get(c.id) || 0) - (second.get(c.id) || 0)) <= 2, c.id);
});

test("a position-biased judge on near-equals still finds the clear order", async () => {
  const qs = [3, 1, 8, 6, 2, 7, 5, 4];
  const items = clips(qs);
  const r = await tournament(items, standIn({ margin: 1 }), { rounds: 5, orders: "both", maxCalls: 100 });
  const truth = items.map((_, i) => i).sort((a, b) => qs[b] - qs[a]);
  assert.ok(spearman(r.order, truth) > 0.8, `spearman ${spearman(r.order, truth)}`);
});

// ---------------------------------------------------------------- the budget

test("the budget cap: never more calls than maxCalls, and only whole pairs in both orders", async () => {
  const items = clips(Array.from({ length: 20 }, (_, i) => i));
  for (const [orders, maxCalls] of [["both", 7], ["both", 150], ["alternate", 12], ["alternate", 5]]) {
    const calls = [];
    const r = await tournament(items, standIn({ calls }), { rounds: 6, orders, maxCalls });
    assert.ok(r.calls <= maxCalls, `${orders} ${maxCalls}: ${r.calls}`);
    assert.equal(r.calls, calls.length);
    if (orders === "both") assert.equal(r.calls % 2, 0);
    assert.equal(r.calls, h2hCalls({ n: 20, rounds: 6, orders, maxCalls }));
  }
  assert.equal(h2hCalls(H2H_DEFAULTS.smart), 120, "Smart mode: 20 clips, 6 rounds, both orders");
  assert.equal(h2hCalls(H2H_DEFAULTS.device), 12, "device: 8 clips, 3 rounds, once each");
  assert.equal(h2hCalls({ n: 3, rounds: 6, orders: "both" }), 4, "3 clips: 2 rounds of one pair");
  assert.equal(h2hEstimateSec(H2H_DEFAULTS.device, 50), Math.round(12 * 50 * PAIR_COST));
  assert.equal(h2hEstimateSec(H2H_DEFAULTS.device, null), null);
});

test("failed or unreadable answers are left out of the fit, and an abort stops the round", async () => {
  const items = clips([1, 2, 3, 4]);
  let n = 0;
  const flaky = async (a, b) => {
    n++;
    if (n % 3 === 0) throw new Error("timeout");
    if (n % 3 === 1) return null;
    return a.q > b.q ? { first: "A", why: "" } : { first: "B", why: "" };
  };
  const r = await tournament(items, flaky, { rounds: 3, orders: "both" });
  assert.equal(r.calls, 12);
  assert.equal(r.failed, 8);
  assert.equal(r.games.length, 4);
  const ac = new AbortController();
  await assert.rejects(tournament(items, async () => (ac.abort(), { first: "A" }), { rounds: 3, signal: ac.signal }), (e) => e.name === "AbortError");
});

// ---------------------------------------------------------------- ranking

test("applyH2H: rank() puts the head-to-head order first and keeps totals; faithful ordering agrees", async () => {
  const items = clips([1, 9, 5]).map((c, i) => ({ ...c, total: [0.9, 0.6, 0.7][i] }));
  const other = clip("x", 500, 0, { total: 0.95, scores: null }); // not in the round, even with a high total
  const r = await tournament(items, standIn(), { rounds: 3, orders: "both" });
  const out = applyH2H([...items, other], items, r);
  const ranked = rank(out, { k: 10 });
  assert.deepEqual(ranked.map((c) => c.id), ["c1", "c2", "c0", "x"]);
  assert.deepEqual(ranked.map((c) => c.total), [0.6, 0.7, 0.9, 0.95]);
  assert.equal(ranked[0].h2hRank, 1);
  assert.match(ranked[0].h2hRecord, /^\d+-\d+$/);
  assert.deepEqual(orderByFaithful(ranked).map((c) => c.id), ["c1", "c2", "c0", "x"]);
  // a second round replaces the first's marks
  const again = applyH2H(out, [items[0], items[2]], { order: [0, 1], s: [0, 0], wins: [0, 0], losses: [0, 0], why: [null, null] });
  assert.equal(again.find((c) => c.id === "c1").h2hRank, undefined);
});

test("headToHead: the gate is the top n distinct judged clips, answers are cached, a re-run makes no calls", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selects-h2h-"));
  const judged = [
    ...clips([3, 8, 5, 1, 9, 6]).map((c, i) => ({ ...c, total: 0.9 - i * 0.05 })),
    clip("overlap", 5, 10, { total: 0.88 }), // overlaps c0 heavily: NMS keeps only one of them
    clip("unjudged", 900, 10, { scores: null, total: 0.99 }),
  ];
  const seen = [];
  const request = async (messages) => {
    const u = messages[1].content;
    const a = u.match(/Clip A[^\n]*\n(clip \S+)/)[1].split(" ")[1];
    const b = u.match(/Clip B[^\n]*\n(clip \S+)/)[1].split(" ")[1];
    seen.push([a, b]);
    const q = (id) => judged.find((c) => c.id === id).q;
    return { data: { first: q(a) > q(b) ? "A" : "B", why: "It lands" } };
  };
  const r = await headToHead(judged, { model: "m", n: 4, rounds: 3, orders: "both", maxCalls: 100, cacheDir: dir, request });
  assert.equal(r.summary.clips, 4);
  const played = r.candidates.filter((c) => c.h2hRank).map((c) => c.id).sort();
  assert.deepEqual(played, ["c0", "c1", "c2", "c3"], "the top 4 distinct by total; the overlap and the unjudged clip stay out");
  assert.equal(r.candidates.find((c) => c.h2hRank === 1).id, "c1");
  assert.equal(seen.length, r.summary.calls);
  const before = seen.length;
  const again = await headToHead(judged, { model: "m", n: 4, rounds: 3, orders: "both", maxCalls: 100, cacheDir: dir, request });
  assert.equal(seen.length, before, "every answer came from the cache");
  assert.deepEqual(again.summary.order, r.summary.order);
  const log = fs.readFileSync(path.join(dir, "judge-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(log.every((x) => x.kind === "pair"));
  assert.equal((await headToHead(judged.slice(0, 2), { model: "m", request })).summary, null, "fewer than 3 clips: no round");
});

test("settings: off unless asked; the judgment signature changes only when it runs; the estimate counts it", () => {
  assert.equal(h2hOn({}), false);
  assert.equal(h2hOn({ h2h: true }), true);
  const base = { selection: "s", judge: { backend: "b", model: "m" }, prompts: { pairwise: "p" } };
  assert.equal(judgmentSignature({ ...base, settings: {} }), judgmentSignature({ ...base, settings: { h2h: false } }));
  assert.notEqual(judgmentSignature({ ...base, settings: {} }), judgmentSignature({ ...base, settings: { h2h: true } }));
  assert.notEqual(judgmentSignature({ ...base, settings: { h2h: true } }), judgmentSignature({ ...base, prompts: { pairwise: "q" }, settings: { h2h: true } }));
  const o = { duration: 3000, judgeN: 40, k: 5 };
  const off = estimateJob({ ...o, smart: true }).stages.judge;
  const on = estimateJob({ ...o, smart: true, h2h: true }).stages.judge;
  assert.equal(on - off, Math.round(120 * 4 * PAIR_COST) - 8);
});
