#!/usr/bin/env node
// Exploratory, NOT pre-registered: does the head-to-head round order windows by Most Replayed
// better than the absolute judge it follows? It reuses eval/explore-exciting.mjs exactly
// where it can and changes nothing frozen:
//   - the same 19 videos, cached transcripts and random sample R per video (rebuilt with the
//     code that made v2, SELECTS_OLD_CORE, and checked against v2's own judge cache)
//   - the absolute judge is the social-worthiness judge of feat/exciting-judge, read from
//     explore-exciting's cache only (no new absolute calls); its 0.7/0.3 blend with the new
//     pre-score is what the app ranks by, so it is the baseline here
//   - the head-to-head round as the app runs it in Smart mode (src/core/judge.mjs headToHead):
//     the gate takes the best GATE_N distinct windows of R by that blend, they play 6 Swiss
//     rounds in both orders, and a Bradley-Terry fit orders them; the rest keep the blend's
//     order. R has 24 windows, so the gate is half of them (the app: 20 of about 36).
//   - the same metric: AUC against above-median replay intensity per video, the mean with a
//     95% percentile bootstrap over videos (10,000 resamples, seed 7), and a sign-flip test on
//     the paired per-video differences. No Holm correction: nothing here is pre-registered.
// Two views: the whole ranking of R (the head-to-head can only reorder the gated half, so this
// moves less), and inside the gated half (what the round decides).
//
//   SELECTS_OLD_CORE=<checkout> node eval/explore-h2h.mjs --phase judge   pairs (Gemini, free tier)
//   SELECTS_OLD_CORE=<checkout> node eval/explore-h2h.mjs --report        report from caches only
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { auc, aboveMedian, bootstrapCI, rng, signFlipTest } from "./metrics.mjs";
import { windowIntensity } from "./heatmap.mjs";
import { geminiKey, geminiRequest, rateLimiter, GEMMA4 } from "./llm-gemini.mjs";

const EVAL = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(EVAL, "..");
const CACHE = process.env.SELECTS_EVAL_CACHE || join(EVAL, "cache");
const OUT = process.env.SELECTS_EVAL_RESULTS || join(EVAL, "results");
const OLD = process.env.SELECTS_OLD_CORE;
const args = process.argv.slice(2);
const PHASE = args.includes("--report") ? "report" : args[args.indexOf("--phase") + 1] || "report";
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const SETTINGS = { minLen: 20, maxLen: 60, stride: 6 };
const R_SIZE = 24;
const R_SEED = 2026;
const NS = [8, 16];
const GATE_N = 12;
const MODEL = `gemini/${GEMMA4}`;
const readJson = (f, d = null) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const hashInt = (s) => parseInt(sha1(String(s)).slice(0, 8), 16);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!OLD) {
  console.error("Set SELECTS_OLD_CORE to a checkout of the commit eval v2 ran on (for example a git worktree of 3eb0794), so R is rebuilt exactly.");
  process.exit(1);
}
const imp = (root, m) => import(pathToFileURL(join(root, "src", "core", m)).href);
const oldSel = await imp(OLD, "select.mjs");
const oldQual = await imp(OLD, "quality.mjs");
const oldJudge = await imp(OLD, "judge.mjs");
const sel = await imp(ROOT, "select.mjs");
const jd = await imp(ROOT, "judge.mjs");
const hc = await imp(ROOT, "h2h-core.mjs");

/** R exactly as eval v2 drew it (run-eval-v2.mjs windowsFor), from the old code (as explore-exciting.mjs). */
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

/** The new pipeline's view of the same stretches (as explore-exciting.mjs). */
function newWindows(P, soundEvents) {
  const events = [...(P.events || []), ...(soundEvents || [])].sort((a, b) => a.s - b.s);
  const s = sel.selectCandidates({ words: P.words, events, loudness: P.loudness, settings: { ...SETTINGS, stride: 0, judgeN: 16 }, duration: P.end });
  return new Map(s.windows.map((w) => [`${w.start}|${w.end}`, w]));
}

async function main() {
  const manifest = readJson(join(EVAL, "datasets", "manifest.json"), []);
  const v2 = readJson(join(EVAL, "results", "results-v2.json"));
  const ids = v2.videos.map((v) => v.id).filter((id) => !ONLY || ONLY.includes(id));
  const limiter = rateLimiter({ rpm: 15, tpm: 14000 });
  const key = PHASE === "judge" ? geminiKey(ROOT) || geminiKey(resolve(ROOT, "..", "selects")) : null;
  const rows = [];
  let newCalls = 0;
  for (const id of ids) {
    const v = manifest.find((m) => m.id === id);
    const P = readJson(join(CACHE, id, "v2", "prep.json"));
    if (!v || !P) {
      log(`${id}: no v2 cache, skipped`);
      continue;
    }
    const exDir = join(CACHE, id, "explore-exciting");
    const dir = join(CACHE, id, "explore-h2h");
    mkdirSync(dir, { recursive: true });
    const sound = readJson(join(exDir, "sound.json"));
    const R = oldWindows(v, P);
    const oldCache = readJson(join(CACHE, id, "v2", "judge", "judge-cache.json"), {});
    const oldVer = oldJudge.loadPrompt().version;
    if (R.some((w) => !oldCache[sha1(`${MODEL}|${oldVer}|${w.text.trim()}`)])) {
      log(`${id}: R not reproduced, skipped`);
      continue;
    }
    const nw = newWindows(P, sound?.events);
    const cands = R.map((w) => {
      const n = nw.get(`${w.start}|${w.end}`);
      return { id: w.id, start: w.start, end: w.end, text: w.text, hook: w.hook, pre: n?.pre ?? null, intensity: w.intensity, ...(n?.cueText ? { cueText: n.cueText } : {}) };
    });
    // the absolute judge from explore-exciting's cache only: no new absolute calls here
    let judged;
    try {
      judged = await jd.judge(cands, { model: MODEL, cacheDir: exDir, request: async () => { throw new Error("not cached"); } });
    } catch (e) {
      log(`${id}: absolute judge not cached (${e.message.slice(0, 40)}), skipped`);
      continue;
    }
    let calls = 0;
    const ask = PHASE === "judge" ? geminiRequest({ key, schema: hc.PAIR_SCHEMA, maxTokens: 120, limiter, onCall: () => calls++ }) : async () => { throw Object.assign(new Error("not cached"), { status: 0 }); };
    const o = { ...hc.H2H_DEFAULTS.smart, n: GATE_N };
    const h = await jd.headToHead(judged, { model: MODEL, ...o, concurrency: 2, cacheDir: dir, request: ask });
    newCalls += calls;
    if (!h.summary || h.summary.failed) {
      log(`${id}: head-to-head not complete (${h.summary ? `${h.summary.failed} of ${h.summary.calls} pairs unanswered` : "fewer than 3 clips"})${PHASE === "report" ? ", run --phase judge" : ""}`);
      if (PHASE === "report" || !h.summary) continue;
    }
    const y = judged.map((c) => c.intensity);
    const pos = aboveMedian(y);
    const byId = new Map(h.candidates.map((c) => [c.id, c]));
    // the app's order: clips with an h2hRank first (in that order), then the blend
    const finalScore = judged.map((c) => {
      const x = byId.get(c.id);
      return Number.isFinite(x.h2hRank) ? 1000 - x.h2hRank : x.total;
    });
    const gated = judged.map((c, i) => i).filter((i) => Number.isFinite(byId.get(judged[i].id).h2hRank));
    const gpos = gated.map((i) => pos[i]);
    const both = gpos.some(Boolean) && gpos.some((p) => !p);
    const row = {
      id,
      n: judged.length,
      gated: gated.length,
      calls: h.summary.calls,
      firstBias: h.summary.firstBias,
      consistency: h.summary.consistency,
      blend: auc(judged.map((c) => c.total), pos),
      judge: auc(judged.map((c) => c.judgeTotal), pos),
      h2h: auc(finalScore, pos),
      gateBlend: both ? auc(gated.map((i) => judged[i].total), gpos) : null,
      gateH2H: both ? auc(gated.map((i) => byId.get(judged[i].id).h2hScore), gpos) : null,
    };
    rows.push(row);
    log(`${id}: AUC blend ${row.blend.toFixed(2)}, with head-to-head ${row.h2h.toFixed(2)}; inside the gate ${row.gateBlend?.toFixed(2) ?? "n/a"} vs ${row.gateH2H?.toFixed(2) ?? "n/a"}; ${calls} new calls, first-position bias ${row.firstBias}, both orders agree ${row.consistency}`);
  }
  log(`${newCalls} new pair calls in all`);
  const agg = {};
  for (const k of ["judge", "blend", "h2h", "gateBlend", "gateH2H"]) {
    const xs = rows.map((r) => r[k]).filter((x) => x != null);
    agg[k] = { ...bootstrapCI(xs, { iters: 10000, seed: 7 }), n: xs.length };
  }
  const paired = (a, b) => {
    const rs = rows.filter((r) => r[a] != null && r[b] != null);
    const d = rs.map((r) => r[a] - r[b]);
    return { n: d.length, ...signFlipTest(d), ci: bootstrapCI(d, { iters: 10000, seed: 7 }) };
  };
  const tests = { whole: paired("h2h", "blend"), gate: paired("gateH2H", "gateBlend") };
  const meanOf = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0) / Math.max(1, rows.filter((r) => r[k] != null).length);
  const out = { generatedAt: new Date().toISOString(), note: "Exploratory, not pre-registered (eval/PLAN.md is unchanged). R rebuilt with the v2 code and checked against v2's cache.", model: GEMMA4, gateN: GATE_N, h2h: { ...hc.H2H_DEFAULTS.smart, n: GATE_N }, calls: rows.reduce((s, r) => s + r.calls, 0), firstBias: +meanOf("firstBias").toFixed(3), consistency: +meanOf("consistency").toFixed(3), rows, aggregate: agg, tests };
  writeFileSync(join(OUT, "explore-h2h.json"), JSON.stringify(out, null, 2) + "\n");
  writeFileSync(join(OUT, "EXPLORE-h2h.md"), report(out));
  log("written eval/results/explore-h2h.json and EXPLORE-h2h.md");
}

const f2 = (x) => (x == null || Number.isNaN(x) ? "n/a" : x.toFixed(2));
const ci = (c) => (!c || c.mean == null ? "n/a" : `${f2(c.mean)} (${f2(c.lo)} to ${f2(c.hi)})`);
const pv = (p) => (p == null ? "n/a" : p < 0.001 ? "< 0.001" : p.toFixed(3));

export function report(o) {
  const A = o.aggregate;
  const L = ["# Exploratory: the head-to-head round against Most Replayed", ""];
  L.push(`Generated ${o.generatedAt.slice(0, 16).replace("T", " ")} UTC by \`node eval/explore-h2h.mjs --report\`. **Not pre-registered.** The v2 plan, hypotheses and thresholds ([PLAN.md](../PLAN.md)) are unchanged. Same videos and the same random sample R per video as [EXPLORE-exciting.md](EXPLORE-exciting.md), the same absolute judge (its cached answers), the same AUC and bootstrap (10,000 resamples, seed 7). Judge: ${o.model} through the Gemini API, free tier.`, "");
  L.push(`The head-to-head round as the app runs it in Smart mode: the best ${o.gateN} distinct windows of R by the absolute blend (half of R's 24) play ${o.h2h.rounds} Swiss rounds in both orders, ordered by a Bradley-Terry fit with a first-position term; the rest keep the blend's order. ${o.calls} pair calls in all.`, "");
  L.push("| Method | n videos | AUC (95% CI) |", "|---|---|---|");
  L.push(`| Absolute judge score only | ${A.judge.n} | ${ci(A.judge)} |`);
  L.push(`| Absolute blend (0.7 judge + 0.3 pre-score), the baseline | ${A.blend.n} | ${ci(A.blend)} |`);
  L.push(`| Blend, then head-to-head on the top ${o.gateN} | ${A.h2h.n} | ${ci(A.h2h)} |`);
  L.push(`| Inside the gate: the blend's order | ${A.gateBlend.n} | ${ci(A.gateBlend)} |`);
  L.push(`| Inside the gate: the head-to-head order | ${A.gateH2H.n} | ${ci(A.gateH2H)} |`);
  L.push("", "| Paired difference (head-to-head minus blend) | n | mean (95% CI) | sign-flip p |", "|---|---|---|---|");
  L.push(`| whole ranking of R | ${o.tests.whole.n} | ${ci(o.tests.whole.ci)} | ${pv(o.tests.whole.p)} |`);
  L.push(`| inside the gate | ${o.tests.gate.n} | ${ci(o.tests.gate.ci)} | ${pv(o.tests.gate.p)} |`);
  L.push("", `Position bias: the fitted first-position term averaged ${o.firstBias} on the logit scale (the clip shown first won about ${Math.round(100 / (1 + Math.exp(-o.firstBias)))}% of evenly matched pairs), and the two orders of one pair agreed ${Math.round(o.consistency * 100)}% of the time. Asking both orders is what keeps that habit out of the ranking. "Inside the gate" leaves out videos whose gated windows were all above or all below the median.`, "");
  L.push("Caveats: Most Replayed measures what viewers rewatch in a long video, not what makes a good short, and most of these videos are talks and lectures. The gate here is half of a random sample, not the best windows of a video, so the round compares ordinary windows, not near-equals at the top.");
  return L.join("\n") + "\n";
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
