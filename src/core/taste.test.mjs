// Taste: the features a label keeps, the model and when it joins the ranking, and the
// labels file the desktop and CLI write (with a job run end to end on stand-in stages).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { applyTaste, labelForStatus, labelRecord, percentiles, TASTE_FEATURES, TASTE_RULE, tasteFeatures, tasteLine, tasteLogit, tasteStatus, tasteSummary, tasteWeight, trainTaste, upsertLabel } from "./taste.mjs";
import { rank } from "./rank.mjs";
import { talk } from "./test/fixtures.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "selects-taste-"));
process.env.SELECTS_HOME = home;
process.env.SELECTS_REUSE = "0";
const { createJob, loadJob, markPosted, retasteJob, runJob, tasteStatusFor, updateCandidate } = await import("./job.mjs");
const { checkFaithful } = await import("./faithful.mjs");
const { labelsFile, readLabels, recordDecision, resetLabels, writeLabels } = await import("./taste-node.mjs");

const SECRET = "the secret ingredient nobody mentions";
const cand = (id, o = {}) => ({
  id,
  start: o.start ?? 0,
  end: o.end ?? 40,
  text: `${SECRET} ${id}`,
  hook: SECRET,
  why: "A funny confession.",
  pre: o.pre ?? 0.5,
  scores: { moment: o.moment ?? 3, share: o.share ?? 3, hook: o.hook ?? 3, standalone: o.standalone ?? 4 },
  total: o.total ?? 0.5,
  delivery: { laughs: o.laughs ?? 0, laughP: 0, applause: 0, energy: o.energy ?? 0, late: false, rate: 1, exchanges: o.exchanges ?? 0 },
  ...(o.hear != null ? { hear: o.hear } : {}),
});

test("a label keeps the clip's numbers only: no words, no times, no audio", () => {
  const c = cand("c_0001", { moment: 5, laughs: 7, hear: 0.8 });
  const f = tasteFeatures(c);
  assert.deepEqual(Object.keys(f), TASTE_FEATURES);
  assert.equal(f.moment, 5);
  assert.equal(f.laughs, 3, "laughs are capped");
  assert.equal(f.hear, 0.8);
  assert.equal(f.len, 0.667, "length in minutes");
  const rec = labelRecord("j_1", c, "post", { at: "2026-10-29T00:00:00.000Z" });
  assert.equal(rec.k, "j_1:c_0001");
  const json = JSON.stringify(rec);
  assert.ok(!json.includes("ingredient") && !json.includes("funny"), "no words in the label");
  assert.ok(!("start" in rec) && !("end" in rec));
  for (const v of Object.values(rec.f)) assert.ok(v === null || typeof v === "number");
  assert.throws(() => labelRecord("j_1", c, "maybe"), /post or skip/);
  assert.equal(labelForStatus("approved"), "post");
  assert.equal(labelForStatus("skipped"), "skip");
  assert.equal(labelForStatus("proposed"), null);
});

test("answering a clip again replaces the answer; taking it back removes it; the oldest go past the cap", () => {
  const c = cand("c_1");
  let ls = upsertLabel([], labelRecord("j", c, "post"));
  ls = upsertLabel(ls, labelRecord("j", c, "skip"));
  assert.equal(ls.length, 1);
  assert.equal(ls[0].label, "skip");
  assert.deepEqual(upsertLabel(ls, { k: "j:c_1", label: null }), []);
  let many = [];
  for (let i = 0; i < 5; i++) many = upsertLabel(many, labelRecord("j", cand(`c_${i}`), "post"), { max: 3 });
  assert.deepEqual(many.map((x) => x.k), ["j:c_2", "j:c_3", "j:c_4"]);
});

test("the model joins only with enough answers of both kinds, and counts more as answers grow, never past the cap", () => {
  assert.equal(tasteWeight(7, 0), 0);
  assert.equal(tasteWeight(3, 4), 0, "7 answers is below the minimum of 8");
  assert.equal(tasteWeight(8, 0), 0, "only Posts: nothing to tell apart");
  const w4 = tasteWeight(4, 4);
  const w20 = tasteWeight(20, 30);
  assert.ok(w4 > 0 && w4 < w20 && w20 < TASTE_RULE.maxWeight, `${w4} < ${w20} < ${TASTE_RULE.maxWeight}`);
  assert.equal(tasteWeight(1000, 1000) < TASTE_RULE.maxWeight, true);
  const s = tasteStatus([labelRecord("j", cand("a"), "post")]);
  assert.deepEqual(s, { n: 1, posts: 1, skips: 0, active: false, weight: 0, need: 7 });
});

/** Answers where Posts have a high hook and many laughs, Skips the opposite (other features vary at random). */
function taught(n = 30, seed = 3) {
  let x = seed;
  const r = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out = [];
  for (let i = 0; i < n; i++) {
    const post = i % 2 === 0;
    const c = cand(`c_${i}`, { hook: post ? 4 + (r() < 0.5) : 1 + (r() < 0.5), laughs: post ? 2 : 0, moment: 1 + Math.floor(r() * 5), pre: r(), end: 20 + r() * 40 });
    out.push(labelRecord("j", c, post ? "post" : "skip"));
  }
  return out;
}

test("the model learns what the answers have in common", () => {
  const m = trainTaste(taught());
  assert.equal(m.active, true);
  const j = (k) => m.features.indexOf(k);
  assert.ok(m.w[j("hook")] > 0.3, `hook weight ${m.w[j("hook")]}`);
  assert.ok(m.w[j("laughs")] > 0.3, `laughs weight ${m.w[j("laughs")]}`);
  assert.equal(m.w[j("hear")], 0, "a feature no answer has stays at 0");
  assert.ok(Math.abs(m.w[j("moment")]) < Math.abs(m.w[j("hook")]), "noise weighs less than the signal");
  assert.ok(tasteLogit(m, cand("x", { hook: 5, laughs: 2 })) > tasteLogit(m, cand("y", { hook: 1 })));
  // round trip through JSON, as the file and IndexedDB keep it
  const back = JSON.parse(JSON.stringify(m));
  assert.equal(tasteLogit(back, cand("x", { hook: 5 })).toFixed(6), tasteLogit(m, cand("x", { hook: 5 })).toFixed(6));
});

test("few answers shrink the model: the same signal moves the weights less", () => {
  const few = trainTaste(taught(8));
  const many = trainTaste(taught(80));
  const h = few.features.indexOf("hook");
  assert.ok(few.weight < many.weight);
  assert.ok(Math.abs(few.w[h]) < Math.abs(many.w[h]), `${few.w[h]} < ${many.w[h]}`);
});

test("applying the model: the generic total is kept for the quality bar, the order moves toward the person's taste", () => {
  const cands = [cand("a", { total: 0.8, hook: 1 }), cand("b", { total: 0.7, hook: 5, laughs: 2, start: 100, end: 140 }), cand("c", { total: 0.6, hook: 2, start: 200, end: 240 })];
  const off = applyTaste(cands, null);
  assert.ok(off.every((c) => c.order === undefined && c.taste === undefined));
  assert.deepEqual(rank(off, { k: 3, iou: 0 }).map((c) => c.id), ["a", "b", "c"]);
  const m = trainTaste(taught(60));
  const on = applyTaste(cands, m, { weight: 0.6 });
  assert.deepEqual(on.map((c) => c.total), [0.8, 0.7, 0.6], "totals unchanged");
  assert.ok(on.every((c) => typeof c.order === "number" && c.taste >= 0 && c.taste <= 1));
  assert.equal(rank(on, { k: 3, iou: 0 })[0].id, "b", "the clip like the Posts comes first");
  assert.deepEqual(rank(applyTaste(on, m, { weight: 0 }), { k: 3, iou: 0 }).map((c) => c.id), ["a", "b", "c"], "weight 0 takes the blend off again");
  assert.deepEqual(percentiles([3, 1, 2, 2]), [1, 0, 0.5, 0.5]);
});

test("the quiet line", () => {
  assert.equal(tasteLine(null), null);
  assert.equal(tasteLine(tasteStatus([])), null);
  assert.match(tasteLine({ n: 3, posts: 1, skips: 2, active: false }), /^3 picks so far\. Your taste joins the ranking at 8$/);
  assert.equal(tasteLine({ n: 12, posts: 4, skips: 8, active: true }), "Learning from your 12 picks");
  assert.match(tasteLine({ n: 9, posts: 9, skips: 0, active: false }), /Skip one clip too/);
  assert.ok(!/\u2014/.test(tasteLine({ n: 3, active: false })), "no em dashes");
});

test("rank: no overlaps first, filling to k with light overlaps only when there are too few distinct moments", () => {
  const c = (id, s, e, total) => ({ id, start: s, end: e, total, pre: 0 });
  const cands = [c("a", 0, 40, 0.9), c("b", 30, 70, 0.8), c("c", 100, 140, 0.7), c("d", 5, 45, 0.6)];
  assert.deepEqual(rank(cands, { k: 3, iou: 0 }).map((x) => x.id), ["a", "c"]);
  const filled = rank(cands, { k: 3, iou: 0, fill: 0.3 });
  assert.deepEqual(filled.map((x) => x.id), ["a", "b", "c"], "b overlaps a by 10 s of 70 (0.14), d by 35 of 45, so b fills");
  assert.deepEqual(filled.map((x) => x.rank), [1, 2, 3]);
  assert.deepEqual(rank(cands, { k: 2, iou: 0, fill: 0.3 }).map((x) => x.id), ["a", "c"], "no fill when there are enough");
  assert.equal(rank([{ ...c("x", 0, 10, 0.1), order: 0.9 }, c("y", 20, 30, 0.8)], { k: 2, iou: 0 })[0].id, "x", "the taste order wins over the total");
});

// ------------------------------------------------------------------ the labels file and a job

const video = path.join(home, "talk.mp4");
const WORDS = talk(240);
const deps = {
  probe: async (p) => ({ path: p, name: "talk.mp4", duration: WORDS[WORDS.length - 1].e + 1, width: 1920, height: 1080, fps: 25 }),
  thumbs: async () => null,
  decideLanguage: async (_p, { setting }) => ({ setting, used: "en", detected: null, compared: [], margin: null, decided: "setting", warning: null, sec: 0 }),
  transcribe: async () => WORDS,
  listwise: async (cands) => ({ candidates: cands, order: [], reasons: {} }),
  faithful: (cands, o) => checkFaithful(cands, { ...o, mode: "rules" }),
  // earlier clips score higher; every fourth one has a "hook" of 5 (what this person posts)
  judge: async (cands) => cands.map((c, i) => ({ ...c, scores: { moment: 3, share: 3, hook: i % 4 === 0 ? 5 : 2, standalone: 4 }, judgeTotal: 0.9 - i * 0.01, total: 0.9 - i * 0.01, why: "Good." })),
};
before(() => fs.writeFileSync(video, "not really a video"));
after(() => fs.rmSync(home, { recursive: true, force: true }));

test("Post and Skip in the review write the labels file; taking an answer back or --yes do not leave one", async () => {
  const job = await runJob(createJob(video, { k: 10, model: "mock", qualityGate: false, kit: "plain" }).id, { deps });
  assert.ok(job.candidates.length >= 8, `${job.candidates.length} clips`);
  assert.equal(job.taste.n, 0);
  const file = labelsFile();
  assert.equal(file, path.join(home, "taste", "labels.json"));
  const [a, b, c] = job.candidates;
  updateCandidate(job.id, a.id, { status: "approved" });
  updateCandidate(job.id, b.id, { status: "skipped" });
  updateCandidate(job.id, c.id, { status: "approved" });
  updateCandidate(job.id, c.id, { status: "proposed" });
  updateCandidate(job.id, job.candidates[3].id, { status: "approved" }, { label: false });
  const ls = readLabels(file);
  assert.deepEqual(ls.map((x) => [x.k, x.label]), [[`${job.id}:${a.id}`, "post"], [`${job.id}:${b.id}`, "skip"]]);
  const raw = fs.readFileSync(file, "utf8");
  for (const cc of job.candidates) assert.ok(!raw.includes(cc.hook), "no words in the file");
  markPosted(job.id, job.candidates[4].id);
  assert.equal(readLabels(file).find((x) => x.k.endsWith(job.candidates[4].id)).by, "download");
  assert.deepEqual(tasteStatusFor(), { n: 3, posts: 2, skips: 1, active: false, weight: 0, need: 5 });
  resetLabels(file);
  assert.equal(readLabels(file).length, 0);
});

test("a labels file teaches the ranking (--labels), and a judged job can be ranked again without judging", async () => {
  const file = path.join(home, "mine.json");
  // someone who posts the clips with a strong hook and skips the rest
  const posts = [];
  for (let i = 0; i < 30; i++) posts.push(labelRecord("old", cand(`p${i}`, { hook: i % 3 === 0 ? 5 : 2 }), i % 3 === 0 ? "post" : "skip"));
  writeLabels(file, posts);
  const off = await runJob(createJob(video, { k: 6, model: "mock", qualityGate: false, kit: "plain", taste: "off", labels: file }).id, { deps });
  assert.equal(off.taste, null, "taste off: the file is not read");
  assert.ok(off.candidates.every((c) => c.order === undefined));
  // the default file has no answers yet, so the generic order stands
  const plain = await runJob(createJob(video, { k: 6, model: "mock", qualityGate: false, kit: "plain" }).id, { deps });
  assert.equal(plain.taste.active, false);
  assert.ok(plain.candidates.every((c) => c.order === undefined));
  assert.deepEqual(plain.candidates.map((c) => c.id), off.candidates.map((c) => c.id));
  const mine = await runJob(createJob(video, { k: 6, model: "mock", qualityGate: false, kit: "plain", labels: file }).id, { deps });
  assert.equal(mine.taste.active, true);
  assert.equal(mine.taste.n, 30);
  // how many clips with a strong hook (what this person posts) make the six
  const strong = (j) => j.candidates.filter((c) => c.scores.hook === 5).length;
  assert.ok(strong(mine) > strong(plain), `strong-hook clips in the top 6: ${strong(mine)} with taste, ${strong(plain)} without`);
  // the same plain job, ranked again with the file
  const again = retasteJob(plain.id, { labels: file });
  assert.equal(again.taste.active, true);
  assert.equal(strong(again), strong(mine));
  assert.equal(loadJob(plain.id).settings.labels, file);
  // and answers in this job go to that file, not the default one
  updateCandidate(mine.id, mine.candidates[0].id, { status: "skipped" });
  assert.equal(readLabels(file).length, 31);
  assert.equal(readLabels(labelsFile()).length, 0);
  assert.equal(readLabels(file).at(-1).by, "cli");
  assert.equal(recordDecision(path.join(home, "no", "such", "\0bad"), "j", cand("z"), "approved"), null, "a file that cannot be written never fails a decision");
});

test("the summary the review reads", () => {
  assert.equal(tasteSummary(null), null);
  const s = tasteSummary(trainTaste(taught(20)));
  assert.equal(s.active, true);
  assert.equal(s.n, 20);
  assert.ok(s.weight > 0);
});
