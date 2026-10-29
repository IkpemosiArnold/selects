#!/usr/bin/env node
// Exploratory, NOT pre-registered against eval v2's plan (eval/PLAN.md is unchanged). Its own
// plan was written before the run: eval/TASTE-PLAN.md. Does the taste loop (src/core/taste.mjs)
// learn at all? Most Replayed stands in for one creator's Post and Skip answers: within a
// video, a window above the median intensity is a Post. Same videos, same random sample R per
// video, same text judge answers and cues hearing scores as EXPLORE-hear.md, read from cache.
//
//   SELECTS_OLD_CORE=<checkout of 3eb0794> SELECTS_EVAL_CACHE=<cache> node eval/explore-taste.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { auc, aboveMedian, bootstrapCI, rng, signFlipTest } from "./metrics.mjs";
import { windowIntensity } from "./heatmap.mjs";
import { GEMMA4 } from "./llm-gemini.mjs";

const EVAL = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(EVAL, "..");
const CACHE = process.env.SELECTS_EVAL_CACHE || join(EVAL, "cache");
const OUT = process.env.SELECTS_EVAL_RESULTS || join(EVAL, "results");
const OLD = process.env.SELECTS_OLD_CORE;
const SETTINGS = { minLen: 20, maxLen: 60, stride: 6 };
const R_SIZE = 24;
const R_SEED = 2026;
const NS = [8, 16];
const MODEL = `gemini/${GEMMA4}`;
const REPEATS = 20;
const SPLIT_SEED = 4242;
const readJson = (f, d = null) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const hashInt = (s) => parseInt(sha1(String(s)).slice(0, 8), 16);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!OLD) {
  console.error("Set SELECTS_OLD_CORE to a checkout of the commit eval v2 ran on (3eb0794), so R is rebuilt exactly.");
  process.exit(1);
}
const imp = (root, m) => import(pathToFileURL(join(root, "src", "core", m)).href);
const oldSel = await imp(OLD, "select.mjs");
const oldQual = await imp(OLD, "quality.mjs");
const sel = await imp(ROOT, "select.mjs");
const jd = await imp(ROOT, "judge.mjs");
const hc = await imp(ROOT, "hear-core.mjs");
const hn = await imp(ROOT, "hear-node.mjs");
const T = await imp(ROOT, "taste.mjs");

/** R exactly as eval v2 drew it (the same function as explore-hear.mjs). */
function oldWindows(v, P) {
  const info = readJson(resolve(ROOT, v.heatmapPath)) || readJson(resolve(OLD, v.heatmapPath));
  const heat = (info.heatmap || []).filter((s) => s.start_time < P.end);
  const exclude = oldSel.loopExclusions(oldQual.transcriptQuality(P.words, { duration: P.end }));
  const sels = Object.fromEntries(NS.map((n) => [n, oldSel.selectCandidates({ words: P.words, events: P.events, loudness: P.loudness, settings: { ...SETTINGS, judgeN: n }, duration: P.end, exclude })]));
  const windows = sels[NS[0]].windows.map((w) => ({ ...w, intensity: windowIntensity(heat, w.start, Math.min(w.end, P.end)) })).filter((w) => w.intensity != null);
  const byId = new Map(windows.map((w) => [w.id, w]));
  const inShort = new Set(NS.flatMap((n) => sels[n].shortlist.map((c) => byId.get(c.id)).filter(Boolean).map((c) => c.id)));
  const pool = windows.filter((w) => !inShort.has(w.id));
  const r = rng(R_SEED + hashInt(v.id));
  return pool.map((w) => [r(), w]).sort((a, b) => a[0] - b[0]).slice(0, R_SIZE).map((x) => x[1]).sort((a, b) => a.start - b.start);
}

function newWindows(P, soundEvents) {
  const events = [...(P.events || []), ...(soundEvents || [])].sort((a, b) => a.s - b.s);
  const s = sel.selectCandidates({ words: P.words, events, loudness: P.loudness, settings: { ...SETTINGS, stride: 0, judgeN: 16 }, duration: P.end });
  return new Map(s.windows.map((w) => [`${w.start}|${w.end}`, w]));
}

/** Per video: the R windows with judge answers, pre-score, delivery, hearing and the Most Replayed label. */
async function loadVideos() {
  const manifest = readJson(join(EVAL, "datasets", "manifest.json"), []);
  const v2 = readJson(join(OUT, "results-v2.json"));
  const videos = [];
  for (const id of v2.videos.map((v) => v.id)) {
    const v = manifest.find((m) => m.id === id);
    const P = readJson(join(CACHE, id, "v2", "prep.json"));
    if (!v || !P) continue;
    const exDir = join(CACHE, id, "explore-exciting");
    const sound = readJson(join(exDir, "sound.json"));
    const R = oldWindows(v, P);
    const nw = newWindows(P, sound?.events);
    const cands = R.map((w) => {
      const n = nw.get(`${w.start}|${w.end}`);
      return { id: w.id, start: w.start, end: w.end, text: w.text, hook: w.hook, pre: n?.pre ?? null, intensity: w.intensity, ...(n?.delivery ? { delivery: n.delivery } : {}), ...(n?.peak ? { peak: n.peak } : {}), ...(n?.cueText ? { cueText: n.cueText } : {}) };
    });
    let judged;
    try {
      judged = await jd.judge(cands, { model: MODEL, cacheDir: exDir, request: async () => { throw new Error("not cached"); } });
    } catch {
      log(`${id}: text judge not cached, skipped`);
      continue;
    }
    let hearing = null;
    const dir = join(CACHE, id, "explore-hear");
    const have = readJson(join(dir, "hear-cues.json"), {});
    const grid = hc.hearGrid(P.end);
    if (grid.every((g) => have[hn.stretchKey("cues", g)])) hearing = await hn.hearStretches(dir, null, grid, { listener: "cues", soundFrames: sound?.frames ?? null });
    const pos = aboveMedian(cands.map((c) => c.intensity));
    const items = judged.map((c, i) => ({ id: c.id, start: c.start, end: c.end, pre: c.pre, scores: c.scores, judgeTotal: c.judgeTotal, total: c.total, delivery: c.delivery, peak: c.peak, hearScore: hearing ? hc.windowHearing(c, hearing) : null, y: pos[i] }));
    videos.push({ id, items });
    log(`${id}: ${items.length} windows, ${items.filter((x) => x.y).length} above the median${hearing ? ", cues cached" : ", no cues"}`);
  }
  return videos;
}

// ---------------------------------------------------------------- the loop

/** The candidate as the app would have it: hearing only in the "with hearing" arm. */
const asCand = (it, withHear) => ({ ...it, hear: withHear ? it.hearScore : null });

/** Answers from items, labelled by `y` (or a rule). */
const answers = (vid, items, withHear, yOf) => items.map((it) => T.labelRecord(vid, asCand(it, withHear), yOf(it) ? "post" : "skip", { at: "2026-10-29T00:00:00.000Z" }));

/** AUCs on one video's held-out items for the generic total, the shipped blend and taste alone. */
function score(model, test, withHear, yOf) {
  const cs = test.map((it) => asCand(it, withHear));
  const y = test.map(yOf);
  const blended = T.applyTaste(cs, model);
  return {
    generic: auc(cs.map((c) => c.total), y),
    blend: auc(blended.map((c) => (typeof c.order === "number" ? c.order : c.total)), y),
    alone: model?.w ? auc(cs.map((c) => T.tasteLogit(model, c)), y) : null,
    weight: model?.weight ?? 0,
    answers: model?.n ?? 0,
  };
}

const shuffle = (xs, r) => xs.map((x) => [r(), x]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
const avg = (xs) => {
  const v = xs.filter((x) => x != null && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** One simulation: rows per video, each with the mean AUC per arm over the repeats. */
function simulate(videos, kind, { withHear = false, yOf = (it) => it.y } = {}) {
  const per = new Map(videos.map((v) => [v.id, { generic: [], blend: [], alone: [], weight: [], answers: [] }]));
  const push = (id, s) => {
    for (const k of Object.keys(s)) per.get(id)[k].push(s[k]);
  };
  if (kind === "next") {
    for (const v of videos) {
      const train = videos.filter((o) => o !== v).flatMap((o) => answers(o.id, o.items, withHear, yOf));
      push(v.id, score(T.trainTaste(train), v.items, withHear, yOf));
    }
  } else {
    for (let rep = 0; rep < REPEATS; rep++) {
      const r = rng(SPLIT_SEED + rep);
      const split = new Map(videos.map((v) => {
        const s = shuffle(v.items, r);
        const h = Math.floor(s.length / 2);
        return [v.id, { train: s.slice(0, h), test: s.slice(h) }];
      }));
      if (kind === "half") {
        const model = T.trainTaste(videos.flatMap((v) => answers(v.id, split.get(v.id).train, withHear, yOf)));
        for (const v of videos) push(v.id, score(model, split.get(v.id).test, withHear, yOf));
      } else if (kind === "one") {
        for (const v of videos) push(v.id, score(T.trainTaste(answers(v.id, split.get(v.id).train, withHear, yOf)), split.get(v.id).test, withHear, yOf));
      }
    }
  }
  return videos.map((v) => {
    const p = per.get(v.id);
    return { id: v.id, generic: avg(p.generic), blend: avg(p.blend), alone: avg(p.alone), weight: avg(p.weight), answers: avg(p.answers) };
  });
}

function summarise(rows) {
  const ci = (k) => {
    const xs = rows.map((r) => r[k]).filter((x) => x != null);
    return { ...bootstrapCI(xs, { iters: 10000, seed: 7 }), n: xs.length };
  };
  const rs = rows.filter((r) => r.blend != null && r.generic != null);
  const d = rs.map((r) => r.blend - r.generic);
  const da = rows.filter((r) => r.alone != null && r.generic != null).map((r) => r.alone - r.generic);
  return {
    generic: ci("generic"),
    blend: ci("blend"),
    alone: ci("alone"),
    weight: avg(rows.map((r) => r.weight)),
    answers: avg(rows.map((r) => r.answers)),
    diff: { n: d.length, ...signFlipTest(d), ci: bootstrapCI(d, { iters: 10000, seed: 7 }) },
    diffAlone: { n: da.length, ...signFlipTest(da), ci: bootstrapCI(da, { iters: 10000, seed: 7 }) },
  };
}

async function main() {
  const videos = await loadVideos();
  const control = (it) => (it.scores?.hook ?? 0) >= 4;
  const sims = {
    half: simulate(videos, "half"),
    next: simulate(videos, "next"),
    one: simulate(videos, "one"),
    halfHear: simulate(videos.filter((v) => v.items.every((it) => it.hearScore != null)), "half", { withHear: true }),
    control: simulate(videos, "half", { yOf: control }),
  };
  const agg = Object.fromEntries(Object.entries(sims).map(([k, rows]) => [k, summarise(rows)]));
  // what the model leans on when fitted on every answer (for the write-up)
  const all = T.trainTaste(videos.flatMap((v) => answers(v.id, v.items, false, (it) => it.y)));
  const weights = Object.fromEntries(all.features.map((f, j) => [f, all.w[j]]));
  const out = { generatedAt: new Date().toISOString(), plan: "eval/TASTE-PLAN.md", note: "Exploratory; its plan was written before the run.", model: GEMMA4, rule: T.TASTE_RULE, repeats: REPEATS, videos: videos.length, sims, aggregate: agg, weightsAll: weights };
  writeFileSync(join(OUT, "explore-taste.json"), JSON.stringify(out, null, 2) + "\n");
  writeFileSync(join(OUT, "EXPLORE-taste.md"), report(out));
  log("written eval/results/explore-taste.json and EXPLORE-taste.md");
  console.log(report(out));
}

const f2 = (x) => (x == null || Number.isNaN(x) ? "n/a" : x.toFixed(2));
const ci = (c) => (!c || c.mean == null ? "n/a" : `${f2(c.mean)} (${f2(c.lo)} to ${f2(c.hi)})`);
const pv = (p) => (p == null ? "n/a" : p < 0.001 ? "< 0.001" : p.toFixed(3));

export function report(o) {
  const A = o.aggregate;
  const L = ["# Exploratory: learning a creator's taste, with Most Replayed as the creator", ""];
  L.push(`Generated ${o.generatedAt.slice(0, 16).replace("T", " ")} UTC by \`node eval/explore-taste.mjs\`. The plan was written and committed before the run: [TASTE-PLAN.md](../TASTE-PLAN.md). The v2 plan ([PLAN.md](../PLAN.md)) is unchanged. Same ${o.videos} videos and the same random sample R per video (24 windows) as [EXPLORE-hear.md](EXPLORE-hear.md), the same cached text judge answers (${o.model} through the Gemini API, free tier), the same AUC and bootstrap (10,000 resamples, seed 7).`, "");
  L.push(`The model is src/core/taste.mjs as committed before the run: L2 logistic regression over the judge's sub-scores, the pre-score, laughter, pace, length and the like (never words), blended with the generic ranking at TASTE_RULE's weight (${o.rule.maxWeight} x m / (m + ${o.rule.half}), m the smaller of Posts and Skips, from ${o.rule.minLabels} answers). Labels: within each video, a window above the median Most Replayed intensity is a Post. Every AUC is on held-out windows only; ${o.repeats} random splits per simulation where there is a split.`, "");
  const sims = [
    ["half", "A. Half of each video held out, one model from the other halves of all videos"],
    ["next", "B. The next video: fitted on the other 18 videos, scored on this one"],
    ["one", "C. One video, 12 answers: fitted on its own half, scored on the other half"],
    ["halfHear", "A with the cues hearing score as a feature (secondary)"],
    ["control", "Control: labels from a rule (Post when the judge's hook score is 4 or 5), as A"],
  ];
  L.push("| Simulation | answers in a fit | taste weight | Generic AUC | Taste blend AUC | Taste alone AUC | Blend minus generic (95% CI) | sign-flip p |", "|---|---|---|---|---|---|---|---|");
  for (const [k, name] of sims) {
    const a = A[k];
    if (!a) continue;
    L.push(`| ${name} | ${Math.round(a.answers)} | ${f2(a.weight)} | ${ci(a.generic)} | ${ci(a.blend)} | ${ci(a.alone)} | ${ci(a.diff.ci)} | ${pv(a.diff.p)} |`);
  }
  L.push("", "Taste alone minus generic: " + sims.filter(([k]) => A[k]).map(([k]) => `${k} ${ci(A[k].diffAlone.ci)}`).join("; ") + ".");
  const w = Object.entries(o.weightsAll).filter(([, x]) => Math.abs(x) >= 0.01).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  L.push("", `Fitted on every answer of all ${o.videos} videos, the model leans on: ${w.map(([f, x]) => `${f} ${x > 0 ? "+" : ""}${x.toFixed(2)}`).join(", ") || "nothing"} (weights on standardised features).`);
  L.push("", "Caveats: Most Replayed is what viewers rewatch in a long video, not what one creator posts, and every method so far scores about 0.50 to 0.56 on it. A null result here does not show the loop is useless for one person's taste, and a positive one would not show it finds any one creator's picks. The control shows only that the loop can learn a pattern that is in its features.");
  return L.join("\n") + "\n";
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
