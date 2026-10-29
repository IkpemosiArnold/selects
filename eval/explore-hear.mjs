#!/usr/bin/env node
// Exploratory, NOT pre-registered: does a judge that hears the audio rank windows by Most
// Replayed better than the text blend? Same videos, same random sample R per video, same AUC
// and bootstrap as explore-exciting.mjs (whose text judge answers it reads from cache only).
//
// Listeners (src/core/hear-node.mjs), each scoring 30 s stretches on a 15 s grid:
//   cues     laughter (YAMNet), overlapping voices (pyannote) and loudness spread, as
//            percentiles within the video's first 15 minutes (the cut v2 transcribed)
//   gemma3n  Gemma 3n E2B listening to each stretch R needs (when it is installed)
// A window's hearing score is its best overlapping stretch (hear-core.mjs windowHearing).
// The fused score is the app's: 0.5 judge + 0.15 pre-score + 0.35 hearing (HEAR_BLEND).
//
//   SELECTS_OLD_CORE=<checkout> SELECTS_EVAL_CACHE=<cache> SELECTS_EVAL_MEDIA=<repo with eval/media> \
//     node eval/explore-hear.mjs --phase cues|gemma3n     listen (local)
//   ... node eval/explore-hear.mjs --report                report from caches only
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { auc, aboveMedian, bootstrapCI, rng, signFlipTest } from "./metrics.mjs";
import { windowIntensity } from "./heatmap.mjs";
import { GEMMA4 } from "./llm-gemini.mjs";

const EVAL = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(EVAL, "..");
const CACHE = process.env.SELECTS_EVAL_CACHE || join(EVAL, "cache");
const MEDIA_ROOT = process.env.SELECTS_EVAL_MEDIA || ROOT;
const OUT = process.env.SELECTS_EVAL_RESULTS || join(EVAL, "results");
const OLD = process.env.SELECTS_OLD_CORE;
const args = process.argv.slice(2);
const PHASE = args.includes("--report") ? "report" : args[args.indexOf("--phase") + 1] || "report";
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const SETTINGS = { minLen: 20, maxLen: 60, stride: 6 };
const R_SIZE = 24;
const R_SEED = 2026;
const NS = [8, 16];
const MODEL = `gemini/${GEMMA4}`;
const LISTENERS = ["cues", "gemma3n"];
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

/** R exactly as eval v2 drew it (the same function as explore-exciting.mjs). */
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

async function main() {
  const manifest = readJson(join(EVAL, "datasets", "manifest.json"), []);
  const v2 = readJson(join(OUT, "results-v2.json"));
  const ids = v2.videos.map((v) => v.id).filter((id) => !ONLY || ONLY.includes(id));
  const rows = [];
  const speed = { gemma3n: [], cues: [] };
  for (const id of ids) {
    const v = manifest.find((m) => m.id === id);
    const P = readJson(join(CACHE, id, "v2", "prep.json"));
    if (!v || !P) continue;
    const exDir = join(CACHE, id, "explore-exciting");
    const sound = readJson(join(exDir, "sound.json"));
    const dir = join(CACHE, id, "explore-hear");
    mkdirSync(dir, { recursive: true });
    const R = oldWindows(v, P);
    const nw = newWindows(P, sound?.events);
    const cands = R.map((w) => {
      const n = nw.get(`${w.start}|${w.end}`);
      return { id: w.id, start: w.start, end: w.end, text: w.text, hook: w.hook, pre: n?.pre ?? null, intensity: w.intensity, ...(n?.cueText ? { cueText: n.cueText } : {}) };
    });
    // the text judge, from explore-exciting's cache only
    let judged;
    try {
      judged = await jd.judge(cands, { model: MODEL, cacheDir: exDir, request: async () => { throw new Error("not cached"); } });
    } catch (e) {
      log(`${id}: text judge not cached, skipped`);
      continue;
    }
    const cut = join(CACHE, id, "v2", `cut-0-${Math.round(P.end)}${v.localPath.slice(v.localPath.lastIndexOf("."))}`);
    const source = existsSync(cut) ? cut : resolve(MEDIA_ROOT, v.localPath);
    const hear = {};
    const { hearStretches, listenerStatus } = await imp(ROOT, "hear-node.mjs");
    for (const l of LISTENERS) {
      // cues: the whole grid of the cut (its percentiles are within the video); gemma3n: only what R needs
      const stretches = l === "cues" ? hc.hearGrid(P.end) : hc.stretchesFor(R, P.end);
      const cacheOnly = PHASE !== l;
      if (!cacheOnly && !listenerStatus(l).ok) {
        log(`${id}: ${l} cannot run: ${listenerStatus(l).why}`);
        continue;
      }
      const have = readJson(join(dir, `hear-${l}.json`), {});
      const { stretchKey } = await imp(ROOT, "hear-node.mjs");
      if (cacheOnly && !stretches.every((g) => have[stretchKey(l, g)])) continue;
      if (!existsSync(source)) {
        log(`${id}: no media at ${source}`);
        continue;
      }
      const t0 = Date.now();
      const scores = await hearStretches(dir, source, stretches, { listener: l, soundFrames: sound?.frames ?? null, onProgress: (p) => p.done % 10 === 0 && log(`${id} ${l}: ${p.done} of ${p.total}, ${p.secPer} s each`) });
      if (!cacheOnly) log(`${id}: ${l} ${stretches.length} stretches in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      for (const s of scores) if (s.sec != null) speed[l].push(s.sec);
      hear[l] = scores;
    }
    if (PHASE !== "report") continue;
    const y = cands.map((w) => w.intensity);
    const pos = aboveMedian(y);
    const A = (s) => (s.some((x) => x == null || Number.isNaN(x)) ? null : auc(s, pos));
    const row = { id, n: cands.length, textJudge: A(judged.map((c) => c.judgeTotal)), textBlend: A(judged.map((c) => c.total)), pre: A(cands.map((c) => c.pre)) };
    for (const l of LISTENERS) {
      if (!hear[l]) continue;
      const h = judged.map((c) => hc.windowHearing(c, hear[l]));
      row[`hear_${l}`] = A(h);
      row[`fused_${l}`] = A(judged.map((c, i) => hc.blendWithHearing(c.judgeTotal, c.pre, h[i], c.total)));
    }
    rows.push(row);
    log(`${id}: text blend ${row.textBlend?.toFixed(2)}, ${LISTENERS.filter((l) => row[`hear_${l}`] != null).map((l) => `${l} ${row[`hear_${l}`].toFixed(2)} fused ${row[`fused_${l}`].toFixed(2)}`).join(", ")}`);
  }
  if (PHASE !== "report") return;
  const keys = ["textJudge", "textBlend", "pre", ...LISTENERS.flatMap((l) => [`hear_${l}`, `fused_${l}`])];
  const agg = {};
  for (const k of keys) {
    const xs = rows.map((r) => r[k]).filter((x) => x != null);
    agg[k] = { ...bootstrapCI(xs, { iters: 10000, seed: 7 }), n: xs.length };
  }
  const paired = (a, b) => {
    const rs = rows.filter((r) => r[a] != null && r[b] != null);
    const d = rs.map((r) => r[a] - r[b]);
    return d.length ? { n: d.length, ...signFlipTest(d), ci: bootstrapCI(d, { iters: 10000, seed: 7 }) } : { n: 0 };
  };
  const tests = {};
  for (const l of LISTENERS) {
    tests[`fused_${l}`] = paired(`fused_${l}`, "textBlend");
    tests[`hear_${l}`] = paired(`hear_${l}`, "textBlend");
  }
  const sp = Object.fromEntries(Object.entries(speed).filter(([, xs]) => xs.length).map(([l, xs]) => [l, { n: xs.length, median: xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] }]));
  const out = { generatedAt: new Date().toISOString(), note: "Exploratory, not pre-registered (eval/PLAN.md is unchanged).", model: GEMMA4, blend: hc.HEAR_BLEND, speed: sp, rows, aggregate: agg, tests };
  writeFileSync(join(OUT, "explore-hear.json"), JSON.stringify(out, null, 2) + "\n");
  writeFileSync(join(OUT, "EXPLORE-hear.md"), report(out));
  log("written eval/results/explore-hear.json and EXPLORE-hear.md");
}

const f2 = (x) => (x == null || Number.isNaN(x) ? "n/a" : x.toFixed(2));
const ci = (c) => (!c || c.mean == null ? "n/a" : `${f2(c.mean)} (${f2(c.lo)} to ${f2(c.hi)})`);
const pv = (p) => (p == null ? "n/a" : p < 0.001 ? "< 0.001" : p.toFixed(3));

export function report(o) {
  const A = o.aggregate;
  const L = ["# Exploratory: a judge that hears, against Most Replayed", ""];
  L.push(`Generated ${o.generatedAt.slice(0, 16).replace("T", " ")} UTC by \`node eval/explore-hear.mjs --report\`. **Not pre-registered.** The v2 plan, hypotheses and thresholds ([PLAN.md](../PLAN.md)) are unchanged. Same videos and the same random sample R per video as [EXPLORE-exciting.md](EXPLORE-exciting.md), the same text judge (its cached answers: ${o.model} through the Gemini API, free tier), the same AUC and bootstrap (10,000 resamples, seed 7).`, "");
  L.push(`Hearing: each listener scores 30 s stretches on a 15 s grid, and a window takes its best overlapping stretch. The fused score is the one the app uses when hearing is on: ${o.blend.judge} judge + ${o.blend.pre} pre-score + ${o.blend.hear} hearing. Every window of R is judged here, so the hearing score's other job in the app (drawing the shortlist) is not measured.`, "");
  L.push("| Method | n videos | AUC on R (95% CI) |", "|---|---|---|");
  const names = { textJudge: "Text judge score only", textBlend: "Text blend (0.7 judge + 0.3 pre-score), the baseline", pre: "Pre-score (with delivery)", hear_cues: "Hearing only: cues (laughter, overlap, loudness spread)", fused_cues: "Fused with cues", hear_gemma3n: "Hearing only: Gemma 3n E2B", fused_gemma3n: "Fused with Gemma 3n" };
  for (const k of Object.keys(names)) if (A[k]?.n) L.push(`| ${names[k]} | ${A[k].n} | ${ci(A[k])} |`);
  L.push("", "| Paired difference (minus the text blend) | n | mean (95% CI) | sign-flip p |", "|---|---|---|---|");
  for (const [k, t] of Object.entries(o.tests)) if (t.n) L.push(`| ${names[k]} | ${t.n} | ${ci(t.ci)} | ${pv(t.p)} |`);
  const sp = Object.entries(o.speed || {}).map(([l, s]) => `${l} ${s.median} s per 30 s stretch (median of ${s.n})`);
  if (sp.length) L.push("", `Speed on a 2017 MacBook Pro (i5-7360U, CPU only): ${sp.join("; ")}.`);
  if (!A.hear_gemma3n?.n) L.push("", "Gemma 3n: not measured here. Its 4.6 GB of weights could not be downloaded on this connection during the work (see notes/HEARING.md).");
  L.push("", "Caveats: Most Replayed measures what viewers rewatch in a long video, not what makes a good short, and most of these videos are talks and lectures with little laughter or banter, which is what the listener is for. A null result here does not show that hearing is useless for picking posts, and a positive one would not show it is better at that.");
  return L.join("\n") + "\n";
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
