#!/usr/bin/env node
// Selects eval runner. Compares clip pickers against labelled moments.
//
//   node eval/run-eval.mjs                         all videos, the default plan (see DEFAULT_PLAN)
//   node eval/run-eval.mjs --plan "qwen2.5:0.5b@8,gemma3-4b-hf:latest@8+list"
//   node eval/run-eval.mjs --only id1,id2          a subset of videos
//   node eval/run-eval.mjs --limit 4               the 4 shortest videos
//   node eval/run-eval.mjs --report                rebuild results from caches only (no whisper, no Ollama)
//   node eval/run-eval.mjs --start-after <ISO>     do not take the CPU lock before this time
//
// Every expensive step is cached under eval/cache/<videoId>/, so re-runs are cheap.
// Heavy steps (whisper, Ollama) take the shared CPU lock .selects/heavy.lock, waiting if
// another builder holds it.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { scoreVideo, bootstrapCI, pairedBootstrap, mean, bestIoU, tiou } from "./metrics.mjs";
import { randomScore } from "./methods/random.mjs";
import { spawnSync } from "node:child_process";
import { energyScore, loudnessEnvelope } from "./methods/energy.mjs";

const EVAL = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(EVAL, "..");
const CACHE = process.env.SELECTS_EVAL_CACHE || join(EVAL, "cache");
const RESULTS = process.env.SELECTS_EVAL_RESULTS || join(EVAL, "results");
const LOCK = join(ROOT, ".selects", "heavy.lock");
const RANDOM_SEEDS = 200;
const K = 5;
const SETTINGS = { minLen: 20, maxLen: 60 };

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const REPORT_ONLY = args.includes("--report");
const ONLY = opt("--only")?.split(",");
const LIMIT = opt("--limit") ? Number(opt("--limit")) : null;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const readJson = (f, d = null) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
function writeJson(f, data) {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f + ".tmp", JSON.stringify(data, null, 2) + "\n");
  renameSync(f + ".tmp", f);
}

// ---------- shared CPU lock ----------
// Fairness: after releasing, wait at least LOCK_GAP_MS before taking the lock again, so a
// builder polling every 60 s gets a turn. --start-after <ISO time> delays the first take.
let holding = false;
let lastRelease = 0;
const LOCK_GAP_MS = 90_000;
const START_AFTER = opt("--start-after") ? Date.parse(opt("--start-after")) : 0;
async function withHeavyLock(what, fn) {
  if (REPORT_ONLY) throw new Error(`--report: ${what} is not cached`);
  if (process.env.SELECTS_TEST_NO_LOCK) return fn();
  const notBefore = Math.max(START_AFTER, lastRelease + LOCK_GAP_MS);
  if (Date.now() < notBefore) {
    log(`yielding the CPU lock until ${new Date(notBefore).toISOString().slice(11, 19)} UTC before ${what}`);
    await sleep(notBefore - Date.now());
  }
  for (;;) {
    if (!existsSync(LOCK)) {
      mkdirSync(dirname(LOCK), { recursive: true });
      try {
        writeFileSync(LOCK, `eval-builder pid=${process.pid} since=${new Date().toISOString()} job=${what}\n`, { flag: "wx" });
        holding = true;
        break;
      } catch { /* someone took it between the check and the write */ }
    }
    const owner = readFileSync(LOCK, "utf8").trim();
    const m = /^eval-builder pid=(\d+)/.exec(owner);
    if (m && !isAlive(Number(m[1]))) { log(`removing stale eval lock: ${owner}`); rmSync(LOCK, { force: true }); continue; }
    log(`heavy.lock held (${owner}); waiting 60 s before ${what}`);
    await sleep(60_000);
  }
  try { return await fn(); } finally { rmSync(LOCK, { force: true }); holding = false; lastRelease = Date.now(); }
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { if (holding) rmSync(LOCK, { force: true }); process.exit(130); });
process.on("exit", () => { if (holding) rmSync(LOCK, { force: true }); });

// ---------- core modules (owned by the core builder) ----------
async function core() {
  const imp = (m) => import(join(ROOT, "src", "core", m)).catch((e) => { throw new Error(`core module src/core/${m} not available yet: ${e.message}`); });
  const [t, s, c, j, r, cfg] = await Promise.all(["transcribe.mjs", "sentences.mjs", "candidates.mjs", "judge.mjs", "rank.mjs", "config.mjs"].map(imp));
  return {
    transcribe: t.transcribe, toSentences: s.toSentences, makeCandidates: c.makeCandidates, shortlist: c.shortlist,
    judge: j.judge, listwise: j.listwise, promptVersion: j.loadPrompt ? j.loadPrompt().version : null,
    rank: r.rank, curve: r.curve, maxJudge: cfg.DEFAULT_SETTINGS?.judgeN ?? 8,
  };
}

async function ollamaModels() {
  try {
    const r = await fetch((process.env.SELECTS_OLLAMA_URL || "http://127.0.0.1:11434") + "/api/tags");
    return (await r.json()).models.map((m) => m.name);
  } catch { return []; }
}

// ---------- the experiment plan ----------
// Each entry is model@N: judge the N prefiltered windows with that model. "+list" also runs the
// listwise final round. The runner works through the plan in order, one entry across every
// video before the next, so the cheap sweep lands first and the slow Gemma runs follow.
export const DEFAULT_PLAN = "qwen2.5:0.5b@8,qwen2.5:0.5b@16,qwen2.5:0.5b@24,gemma3-4b-hf:latest@8+list,gemma3-4b-hf:latest@16,qwen2.5:0.5b@all";
export function parsePlan(str) {
  return str.split(",").filter(Boolean).map((e) => {
    const m = /^(.+)@(\d+|all)(\+list)?$/.exec(e.trim());
    if (!m) throw new Error(`bad plan entry "${e}" (want model@N, model@all or model@N+list)`);
    return { model: m[1], n: m[2] === "all" ? "all" : Number(m[2]), list: !!m[3] };
  });
}
const PLAN = parsePlan(opt("--plan") || DEFAULT_PLAN);
const short = (m) => m.replace(":latest", "").replace("gemma3-4b-hf", "gemma3-4b");

// ---------- per-video pipeline ----------
export async function runVideo(v, C, plan = []) {
  const dir = join(CACHE, v.id);
  mkdirSync(dir, { recursive: true });
  const timingsFile = join(dir, "timings.json");
  const timings = readJson(timingsFile, {});
  let media = resolve(ROOT, v.localPath);
  if (!existsSync(media)) throw new Error(`media missing: ${v.localPath} (run node eval/fetch-datasets.mjs fetch <id>)`);
  // Long videos are evaluated on their first part only (manifest evalRange); cut a small copy.
  if (v.evalRange) {
    const cut = join(dir, `eval-${v.evalRange[0]}-${v.evalRange[1]}${media.slice(media.lastIndexOf("."))}`);
    if (!existsSync(cut)) {
      const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-ss", String(v.evalRange[0]), "-t", String(v.evalRange[1] - v.evalRange[0]), "-i", media, "-vn", "-c:a", "copy", cut]);
      if (r.status !== 0) throw new Error(`could not cut ${v.id} to ${v.evalRange}: ${r.stderr}`);
    }
    media = cut;
  }

  // 1. transcript
  const wordsFile = join(dir, "words.json");
  let words = readJson(wordsFile);
  if (!words) {
    words = await withHeavyLock(`transcribe ${v.id}`, async () => {
      log(`${v.id}: transcribing ${Math.round(v.duration / 60)} min of audio`);
      const t0 = Date.now();
      const w = await C.transcribe(media, { cacheDir: dir, duration: v.duration, onProgress: () => {} });
      timings.transcribeSec = (Date.now() - t0) / 1000;
      return w;
    });
    if (words.length < 10 * (v.duration / 60)) {
      rmSync(join(dir, "whisper.json"), { force: true });
      throw new Error(`transcript nearly empty (${words.length} words for ${Math.round(v.duration / 60)} min): wrong audio track or not English?`);
    }
    writeJson(wordsFile, words);
    writeJson(timingsFile, timings);
    log(`${v.id}: ${words.length} words in ${Math.round(timings.transcribeSec)} s`);
  }

  // 2. candidates (cheap, deterministic)
  const t1 = Date.now();
  const sentences = C.toSentences(words);
  const cands = C.makeCandidates(sentences, SETTINGS);
  timings.candidatesSec = (Date.now() - t1) / 1000;
  timings.nCandidates = cands.length;

  // 3. loudness envelope (one ffmpeg decode, about a minute)
  const envFile = join(dir, "loudness.json");
  let env = readJson(envFile);
  if (!env) {
    const t0 = Date.now();
    env = await loudnessEnvelope(media);
    timings.loudnessSec = (Date.now() - t0) / 1000;
    writeJson(envFile, env);
  }
  writeJson(timingsFile, timings);

  const labels = { heatmap: v.labels.filter((l) => l.source === "heatmap"), human: v.labels.filter((l) => l.source === "human") };
  const out = { id: v.id, title: v.title, duration: v.duration, nWords: words.length, nCandidates: cands.length, labels, methods: {}, timings, judgeRuns: {} };
  const curves = { id: v.id, duration: v.duration, labels: v.labels, heatmap: v.heatmapPath ? readJson(resolve(ROOT, v.heatmapPath), {})?.heatmap ?? null : null, methods: {} };
  const pick = (scored) => C.rank(scored, { k: K }).map((c) => ({ id: c.id, start: c.start, end: c.end, total: c.total, judgeTotal: c.judgeTotal, pre: c.pre, hook: c.hook, reason: c.reason, scores: c.scores, listRank: c.listRank }));
  const evalPreds = (preds) => Object.fromEntries(Object.entries(labels).filter(([, ls]) => ls.length).map(([src, ls]) => [src, scoreVideo(preds, ls)]));
  const shortlistOf = (n) => (n === "all" ? cands.slice() : C.shortlist(cands, { n, duration: v.duration }));

  // no-LLM rows over all candidates
  out.methods.oracle = { preds: [], metrics: oracle(cands, labels) };
  const pScored = cands.map((c) => ({ ...c, total: c.pre }));
  out.methods.prescore = { preds: pick(pScored), metrics: evalPreds(pick(pScored)) };
  const runs = [];
  for (let seed = 1; seed <= RANDOM_SEEDS; seed++) runs.push(evalPreds(pick(randomScore(cands, seed))));
  out.methods.random = { preds: pick(randomScore(cands, 1)), metrics: avgMetrics(runs), seeds: RANDOM_SEEDS };
  const eScored = energyScore(cands, env, words);
  out.methods.energy = { preds: pick(eScored), metrics: evalPreds(pick(eScored)) };
  curves.methods.energy = C.curve(eScored, v.duration, { step: 5 });

  // per shortlist size: stage 1 alone, chance within the shortlist, and the ceiling
  const sizes = [...new Set([C.maxJudge, 4, 8, 12, 16, 24, 36, ...plan.map((p) => p.n)])];
  out.shortlistCeiling = {};
  for (const n of sizes) {
    const sl = shortlistOf(n);
    out.shortlistCeiling[n] = oracle(sl, labels);
    if (!plan.some((p) => p.n === n) && n !== C.maxJudge) continue;
    out.methods[`oracle:shortlist@${n}`] = { preds: [], metrics: oracle(sl, labels), n: sl.length };
    const sScored = sl.map((c) => ({ ...c, total: c.pre }));
    out.methods[`prefilter@${n}`] = { preds: pick(sScored), metrics: evalPreds(pick(sScored)), n: sl.length };
    const sRuns = [];
    for (let seed = 1; seed <= RANDOM_SEEDS; seed++) sRuns.push(evalPreds(pick(randomScore(sl, seed))));
    out.methods[`random:shortlist@${n}`] = { preds: [], metrics: avgMetrics(sRuns), n: sl.length };
  }
  out.nShortlist = shortlistOf(C.maxJudge).length;

  // judge runs from the plan (each cached; in --report mode only cached ones are used)
  const jdir = join(dir, "judge");
  mkdirSync(jdir, { recursive: true });
  for (const p of plan) {
    const sl = shortlistOf(p.n);
    const tag = `${p.model}@${p.n}`;
    const jf = join(dir, `judge-${p.model.replace(/[^a-z0-9.]+/gi, "_")}-n${p.n}.json`);
    let run = readJson(jf);
    const fresh = run && run.candidatesHash === hashCands(sl) && run.promptVersion === C.promptVersion;
    if (!fresh) {
      if (REPORT_ONLY || p.skip) continue; // not judged yet: leave these rows out for this video
      run = await withHeavyLock(`judge ${tag} ${v.id}`, async () => {
        log(`${v.id}: judging ${sl.length} of ${cands.length} windows with ${p.model}`);
        const t0 = Date.now();
        let last = 0;
        const res = await C.judge(sl, {
          model: p.model,
          cacheDir: jdir,
          onProgress: (q) => { const now = Date.now(); if (now - last > 120_000) { last = now; log(`${v.id} ${tag}: ${q.done}/${q.total}`); } },
        });
        return { model: p.model, n: p.n, size: sl.length, candidatesHash: hashCands(sl), promptVersion: C.promptVersion, wallSec: (Date.now() - t0) / 1000, newCalls: res.stats?.judged ?? null, judgedAt: new Date().toISOString(), candidates: res };
      });
      writeJson(jf, run);
      log(`${v.id}: ${tag} done in ${Math.round(run.wallSec)} s (${run.newCalls} new calls)`);
    }
    if (p.list && !run.listwise) {
      if (REPORT_ONLY || p.skip) { /* leave the listwise row out */ } else {
        run.listwise = await withHeavyLock(`listwise ${tag} ${v.id}`, async () => {
          const t0 = Date.now();
          const lw = await C.listwise(run.candidates, { model: p.model, n: 4, cacheDir: jdir });
          return { order: lw.order, complete: lw.complete ?? true, sec: (Date.now() - t0) / 1000, candidates: lw.candidates };
        });
        writeJson(jf, run);
        log(`${v.id}: listwise ${tag} done in ${Math.round(run.listwise.sec)} s`);
      }
    }
    // judge:<model>@N ranks by the model's own score; shipped:<model>@N by Selects' blend with the pre-score
    const byJudge = run.candidates.map((c) => ({ ...c, total: c.judgeTotal ?? c.total }));
    out.methods[`judge:${tag}`] = { preds: pick(byJudge), metrics: evalPreds(pick(byJudge)), n: sl.length };
    out.methods[`shipped:${tag}`] = { preds: pick(run.candidates), metrics: evalPreds(pick(run.candidates)), n: sl.length };
    if (run.listwise) out.methods[`shipped+list:${tag}`] = { preds: pick(run.listwise.candidates), metrics: evalPreds(pick(run.listwise.candidates)), n: sl.length };
    out.judgeRuns[tag] = { model: p.model, n: p.n, size: sl.length, wallSec: run.wallSec, newCalls: run.newCalls, listwiseSec: run.listwise?.sec ?? null };
    curves.methods[`judge:${tag}`] = C.curve(byJudge, v.duration, { step: 5 });
  }
  out.calls = judgeCalls(jdir);
  writeJson(join(RESULTS, "curves", `${v.id}.json`), curves);
  return out;
}

// Per-call Ollama stats written by src/core/judge.mjs (judge-calls.jsonl in its cacheDir),
// grouped by model and kind (per-window judge call or listwise round).
function judgeCalls(dir) {
  const f = join(dir, "judge-calls.jsonl");
  if (!existsSync(f)) return {};
  const rows = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.failed);
  const out = {};
  for (const r of rows) {
    const key = `${r.model}|${r.kind || "window"}`;
    (out[key] ||= []).push(r);
  }
  const avg = (rs, k) => { const xs = rs.map((r) => r[k]).filter((x) => typeof x === "number"); return xs.length ? mean(xs) : null; };
  return Object.fromEntries(Object.entries(out).map(([k, rs]) => [k, { n: rs.length, wallSec: avg(rs, "wallSec"), loadSec: avg(rs, "loadSec"), words: avg(rs, "words"), promptTokens: avg(rs, "promptTokens"), promptTokPerSec: avg(rs, "promptTokPerSec"), outTokens: avg(rs, "outTokens"), outTokPerSec: avg(rs, "outTokPerSec") }]));
}

function hashCands(cands) {
  let h = 0;
  for (const c of cands) for (const ch of `${c.start}-${c.end}|`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(16);
}

function avgMetrics(runs) {
  const out = {};
  for (const src of Object.keys(runs[0] || {})) {
    out[src] = {};
    for (const m of Object.keys(runs[0][src])) out[src][m] = mean(runs.map((r) => r[src][m]));
  }
  return out;
}

// Greedy upper bound: for each label, the best IoU any candidate in the pool reaches.
export function oracle(cands, labels) {
  const out = {};
  for (const [src, ls] of Object.entries(labels)) {
    if (!ls.length) continue;
    const best = ls.map((l) => cands.reduce((b, c) => Math.max(b, tiou(c, l)), 0));
    const reachable = best.filter((x) => x >= 0.5).length;
    out[src] = { hit3: reachable ? 1 : 0, hit5: reachable ? 1 : 0, p3: Math.min(reachable, 3) / 3, p5: Math.min(reachable, K) / K, r5: Math.min(reachable, K) / ls.length, miou5: mean(best.slice().sort((a, b) => b - a).slice(0, K)) };
  }
  return out;
}

// ---------- aggregate and report ----------
const isJudgeKey = (m) => /^(judge|shipped|shipped\+list):/.test(m);
export function aggregate(videos) {
  const methods = [...new Set(videos.flatMap((v) => Object.keys(v.methods)))];
  const agg = {};
  for (const src of ["heatmap", "human"]) {
    agg[src] = {};
    for (const m of methods) {
      const rows = videos.filter((v) => v.methods[m]?.metrics?.[src]);
      if (!rows.length) continue;
      const col = (k) => rows.map((v) => v.methods[m].metrics[src][k]);
      agg[src][m] = {
        n: rows.length, videos: rows.map((v) => v.id),
        hit3: bootstrapCI(col("hit3")), p3: bootstrapCI(col("p3")), hit5: bootstrapCI(col("hit5")), p5: bootstrapCI(col("p5")), r5: bootstrapCI(col("r5")), miou5: bootstrapCI(col("miou5")),
      };
    }
    // paired comparisons on the same videos: hit@3 and mean best IoU
    agg[src].paired = {};
    const pair = (a, b) => {
      const rows = videos.filter((v) => v.methods[a]?.metrics?.[src] && v.methods[b]?.metrics?.[src]);
      if (rows.length < 3) return;
      const g = (m, k) => rows.map((v) => v.methods[m].metrics[src][k]);
      agg[src].paired[`${a} vs ${b}`] = { miou5: pairedBootstrap(g(a, "miou5"), g(b, "miou5")), hit3: pairedBootstrap(g(a, "hit3"), g(b, "hit3")), n: rows.length };
    };
    for (const m of methods.filter((x) => x.startsWith("judge:"))) {
      const n = m.split("@")[1];
      pair(m, `prefilter@${n}`);
      pair(m, "random");
    }
    const judged = methods.filter((x) => x.startsWith("judge:"));
    for (const a of judged) for (const b of judged) if (a < b && a.split("@")[1] === b.split("@")[1]) pair(a, b);
    for (const m of methods.filter((x) => x.startsWith("shipped+list:"))) pair(m, m.replace("shipped+list:", "shipped:"));
    for (const m of methods.filter((x) => x.startsWith("shipped:"))) pair(m, m.replace("shipped:", "judge:"));
  }
  // judge cost per model from Ollama's counters, pooled over videos
  agg.cost = {};
  for (const v of videos) for (const [k, c] of Object.entries(v.calls || {})) {
    const a = (agg.cost[k] ||= { n: 0, sums: {} });
    for (const f of ["wallSec", "loadSec", "words", "promptTokens", "promptTokPerSec", "outTokens", "outTokPerSec"]) if (c[f] != null) { a.sums[f] = (a.sums[f] || 0) + c[f] * c.n; a.sums[f + "N"] = (a.sums[f + "N"] || 0) + c.n; }
    a.n += c.n;
  }
  for (const a of Object.values(agg.cost)) for (const f of ["wallSec", "loadSec", "words", "promptTokens", "promptTokPerSec", "outTokens", "outTokPerSec"]) a[f] = a.sums[f + "N"] ? a.sums[f] / a.sums[f + "N"] : null;
  return agg;
}

const pct = (x) => (x == null || Number.isNaN(x) ? "n/a" : `${Math.round(x * 100)}%`);
const f2 = (x) => (x == null || Number.isNaN(x) ? "n/a" : x.toFixed(2));
const ci = (c, fmt = pct) => (!c ? "n/a" : c.lo == null ? fmt(c.mean) : `${fmt(c.mean)} (${fmt(c.lo)} to ${fmt(c.hi)})`);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const signed = (x) => (x >= 0 ? "+" : "") + f2(x);

function methodName(m) {
  const fixed = {
    oracle: "ceiling: best possible from all windows",
    random: `random over all windows (mean of ${RANDOM_SEEDS} seeds)`,
    energy: "energy: loudness + speech rate, no LLM",
    prescore: "text rules over all windows, no LLM",
  };
  if (fixed[m]) return fixed[m];
  const [kind, rest] = m.split(/:(.+)/);
  const [model, n] = (rest || kind).split("@");
  const N = n === "all" ? "all" : n;
  if (m.startsWith("oracle:shortlist@")) return `ceiling: best possible from the ${N} prefiltered windows`;
  if (m.startsWith("prefilter@")) return `**prefilter alone** (top ${N} by text rules, no LLM)`;
  if (m.startsWith("random:shortlist@")) return `random from the ${N} prefiltered windows`;
  if (kind === "judge") return `**prefilter + ${short(model)}** (${N} windows, model score only)`;
  if (kind === "shipped") return `prefilter + ${short(model)}, shipped blend 0.7 model + 0.3 text rules (${N})`;
  if (kind === "shipped+list") return `prefilter + ${short(model)}, shipped blend + listwise round (${N})`;
  return m;
}

export function report(videos, agg, manifest, plan = PLAN) {
  const L = [];
  const N0 = videos[0]?.nShortlist ?? 8;
  const models = [...new Set(plan.map((p) => p.model))];
  const ns = [...new Set(plan.map((p) => p.n))];
  L.push("# Selects eval results", "");
  L.push(`Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by \`node eval/run-eval.mjs\`. Machine: Intel i5-7360U (2 cores, 2017), 16 GB, no GPU, on battery power at times.`, "");
  L.push(`Videos: **n = ${videos.length}** (manifest: ${manifest.length}). Every method picks its top ${K} clips (20 to 60 s) from the same sentence-snapped candidate windows. A pick hits when its time overlap with a label is IoU 0.5 or more. Rows marked with a smaller n are still running.`, "");

  // headline table
  const src = "heatmap";
  const A = agg[src];
  const head = ["random", "energy", `prefilter@${N0}`, `random:shortlist@${N0}`, ...models.flatMap((m) => [`judge:${m}@${N0}`]), ...models.flatMap((m) => [`shipped:${m}@${N0}`, `shipped+list:${m}@${N0}`]), `oracle:shortlist@${N0}`, "oracle"].filter((m) => A[m]);
  const table = (keys) => {
    L.push("| Method | n | hit@3 (95% CI) | precision@3 | hit@5 | recall@5 | mean best IoU (95% CI) |", "|---|---|---|---|---|---|---|");
    for (const m of keys) { const a = A[m]; L.push(`| ${methodName(m)} | ${a.n} | ${ci(a.hit3)} | ${pct(a.p3.mean)} | ${pct(a.hit5.mean)} | ${pct(a.r5.mean)} | ${ci(a.miou5, f2)} |`); }
    L.push("");
  };
  L.push(`## Headline: against YouTube Most Replayed peaks (${N0} windows judged, the shipped default)`, "");
  table(head);

  // shortlist-size sweep
  const sweepN = ns.filter((n) => A[`prefilter@${n}`]);
  if (sweepN.length) {
    L.push("## Quality against time: how many windows the model reads", "");
    L.push("hit@3 / mean best IoU for each shortlist size, and estimated judge minutes per video (N windows times the measured seconds per call for that model on this laptop).", "");
    const cols = ["windows judged", "ceiling", "prefilter alone", ...models.map((m) => short(m)), ...models.map((m) => `${short(m)} min/video`)];
    L.push(`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`);
    for (const n of sweepN) {
      const cell = (k) => (A[k] ? `${pct(A[k].hit3.mean)} / ${f2(A[k].miou5.mean)}${A[k].n < videos.length ? ` (n=${A[k].n})` : ""}` : "not run");
      const size = n === "all" ? mean(videos.map((v) => v.nCandidates)) : n;
      const est = (m) => { const c = agg.cost[`${m}|window`]; return c?.wallSec && plan.some((p) => p.model === m && p.n === n) ? `${(size * c.wallSec / 60).toFixed(n === "all" ? 0 : 1)}` : "-"; };
      L.push(`| ${n === "all" ? `all (${Math.round(size)} on average)` : n} | ${cell(`oracle:shortlist@${n}`)} | ${cell(`prefilter@${n}`)} | ${models.map((m) => cell(`judge:${m}@${n}`)).join(" | ")} | ${models.map(est).join(" | ")} |`);
    }
    L.push("");
  }

  // paired
  const paired = Object.entries(A.paired || {});
  if (paired.length) {
    L.push("## Paired differences on the same videos", "", "Bootstrap 95% CI over videos. An interval that includes 0 means no clear difference at this n.", "");
    L.push("| Comparison | n | hit@3 difference | mean best IoU difference |", "|---|---|---|---|");
    for (const [k, p] of paired) L.push(`| ${k.replace(/gemma3-4b-hf:latest/g, "gemma3-4b")} | ${p.n} | ${signed(p.hit3.diff)} (${f2(p.hit3.lo)} to ${f2(p.hit3.hi)}) | ${signed(p.miou5.diff)} (${f2(p.miou5.lo)} to ${f2(p.miou5.hi)}) |`);
    L.push("");
  }

  // human labels
  if (Object.keys(agg.human).filter((k) => k !== "paired").length) {
    L.push("## Against human picks (Arnold)", "");
    const H = agg.human;
    L.push("| Method | n | hit@3 | hit@5 | mean best IoU |", "|---|---|---|---|---|");
    for (const m of Object.keys(H).filter((k) => k !== "paired")) L.push(`| ${methodName(m)} | ${H[m].n} | ${ci(H[m].hit3)} | ${pct(H[m].hit5.mean)} | ${ci(H[m].miou5, f2)} |`);
    L.push("");
  } else L.push("## Against human picks", "", "No human labels yet. Run `node eval/label.mjs` and mark 5 moments per video.", "");

  // ceiling by shortlist size, no LLM
  const withCeil = videos.filter((v) => v.shortlistCeiling);
  if (withCeil.length) {
    const cn = Object.keys(withCeil[0].shortlistCeiling).filter((n) => n !== "all").sort((a, b) => a - b);
    L.push("## Ceiling by shortlist size (no LLM)", "", "The best any judge could do if it were perfect, by how many prefiltered windows it reads (mean over videos):", "");
    L.push(`| windows | ${cn.join(" | ")} | all |`, `|---|${cn.map(() => "---").join("|")}|---|`);
    const row = (label, k, f) => `| ${label} | ${cn.map((n) => f(mean(withCeil.map((v) => v.shortlistCeiling[n]?.heatmap?.[k] ?? 0)))).join(" | ")} | ${f(mean(withCeil.map((v) => v.methods.oracle.metrics.heatmap?.[k] ?? 0)))} |`;
    L.push(row("ceiling hit@3", "hit3", pct), row("ceiling recall@5", "r5", pct), row("ceiling mean best IoU", "miou5", f2), "");
  }

  // wall time
  L.push("## Wall time per video", "");
  const tags = plan.map((p) => `${p.model}@${p.n}`);
  const cols = ["Video", "evaluated length", "windows", "transcribe", ...tags.map((t) => `judge ${short(t)}`)];
  L.push(`| ${cols.join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`);
  for (const v of videos) {
    const title = v.title.replace(/\|/g, "/").slice(0, 50);
    L.push(`| ${title} | ${mmss(v.duration)} | ${v.nCandidates} | ${v.timings.transcribeSec ? mmss(v.timings.transcribeSec) : "n/a"} | ${tags.map((t) => { const r = v.judgeRuns?.[t]; return r ? `${mmss(r.wallSec)}${r.listwiseSec ? ` + ${Math.round(r.listwiseSec)} s list` : ""}` : "-"; }).join(" | ")} |`);
  }
  L.push("", "Judge times are measured wall time for that run. A larger shortlist reuses cached calls for windows a smaller one already judged, so use the per-call cost below for estimates.", "");

  const costRows = Object.entries(agg.cost);
  if (costRows.length) {
    const f1 = (x) => (x == null ? "n/a" : x.toFixed(1));
    L.push("## Judge cost per call (Ollama's own counters)", "");
    L.push("| Model | call | calls | words in | prompt tokens | prompt tok/s | output tokens | output tok/s | load s | wall s per call | cost |", "|---|---|---|---|---|---|---|---|---|---|---|");
    for (const [k, r] of costRows) { const [m, kind] = k.split("|"); L.push(`| ${short(m)} | ${kind === "listwise" ? "listwise round" : "one window"} | ${r.n} | ${f1(r.words)} | ${f1(r.promptTokens)} | ${f1(r.promptTokPerSec)} | ${f1(r.outTokens)} | ${f1(r.outTokPerSec)} | ${f1(r.loadSec)} | ${f1(r.wallSec)} | $0, local |`); }
    L.push("", "Only fresh calls are logged; cache hits cost nothing. Load is the model being read into memory, mostly on a model's first call.", "");
  }

  // examples
  const exKey = [...models].reverse().map((m) => `judge:${m}@${N0}`).find((k) => A[k]);
  if (exKey) {
    const byIou = videos.filter((v) => v.methods[exKey]?.metrics?.heatmap).sort((a, b) => b.methods[exKey].metrics.heatmap.miou5 - a.methods[exKey].metrics.heatmap.miou5);
    const centre = (w) => (w.start + w.end) / 2;
    const ex = (v, label) => {
      const p = v.methods[exKey].preds[0];
      if (!p) return;
      const lab = v.labels.heatmap.reduce((b, l) => (Math.abs(centre(l) - centre(p)) < Math.abs(centre(b) - centre(p)) ? l : b), v.labels.heatmap[0]);
      L.push(`**${label}: ${v.title}** (mean best IoU ${f2(v.methods[exKey].metrics.heatmap.miou5)})`, "");
      L.push(`- Top pick: ${mmss(p.start)} to ${mmss(p.end)}, best IoU with any replay peak ${f2(bestIoU(p, v.labels.heatmap))}. Opens: "${(p.hook || "").slice(0, 160)}"${p.reason ? ` Model's reason: "${p.reason}"` : ""}`);
      if (lab) L.push(`- Nearest replay peak: ${mmss(lab.start)} to ${mmss(lab.end)} (peak height ${lab.weight})`);
      L.push("");
    };
    L.push(`## Best and worst examples (${methodName(exKey).replace(/\*/g, "")})`, "");
    if (byIou.length) ex(byIou[0], "Best");
    if (byIou.length > 1) ex(byIou[byIou.length - 1], "Worst");
  }

  L.push("## How to read this, and caveats", "");
  L.push(`- **n is small (${videos.length} video${videos.length === 1 ? "" : "s"}).** Confidence intervals are percentile bootstrap over videos (2,000 resamples); with n this small they are wide, and a difference whose interval includes zero is not a finding.`);
  L.push("- **Most Replayed is a proxy.** It records where viewers rewatch or seek to, which is not the same as where a good standalone short is. Replays also gather around slides, demos and jokes that need visual context, which an audio-only picker cannot see.");
  L.push("- **The heatmap is coarse.** YouTube gives about 100 segments per video (one per 6 to 27 s for these videos), so label boundaries are only accurate to a segment. Hit at IoU 0.5 is strict against such labels; mean best IoU and the ceiling rows show how much is reachable at all.");
  L.push(`- **Random is the chance level**, averaged over ${RANDOM_SEEDS} seeds on the same windows, so it is not a single lucky or unlucky draw.`);
  L.push(`- **Two stages.** Selects first keeps ${N0} windows with cheap text rules spread over the video, then the model scores only those. With ${N0} windows and k = 5, any picker takes most of the shortlist, so hit@3 and precision@3 separate "prefilter alone" from "prefilter + model" better than hit@5. "Model score only" ranks by the model's rubric score; "shipped blend" is what the app ranks by (0.7 model score + 0.3 text-rule score).`);
  const thin = videos.filter((v) => v.nCandidates < 20);
  if (thin.length) L.push(`- **Few candidate windows** for ${thin.map((v) => `${v.title.slice(0, 40)} (${v.nCandidates})`).join(", ")}: whisper returned little punctuation, so most windows failed the "ends mid-thought" rule.`);
  L.push("- **Energy** scores loudness, loudness variation and words per second, the signals cheap clippers use. It does not read the words.");
  L.push("- Judge models run locally through Ollama on CPU. Times are wall time on this laptop with other apps open; treat them as an order of magnitude.");
  L.push("- Videos longer than 20 minutes are evaluated on their first 15 minutes, with labels from the heatmap inside that range.");
  L.push("- Videos are Creative Commons BY on YouTube; see `eval/datasets/manifest.json` for each URL and licence.");
  L.push("");
  return L.join("\n");
}

// ---------- main ----------
async function main() {
  const manifest = readJson(join(EVAL, "datasets", "manifest.json"), []);
  if (!manifest.length) throw new Error("eval/datasets/manifest.json is empty; run node eval/fetch-datasets.mjs first");
  let todo = [...manifest].sort((a, b) => a.duration - b.duration);
  if (ONLY) todo = todo.filter((v) => ONLY.includes(v.id));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  const C = await core();
  const installed = await ollamaModels();
  const plan = REPORT_ONLY ? PLAN : PLAN.filter((p) => installed.includes(p.model) || (log(`skipping ${p.model}: not installed in Ollama`), false));
  log(`videos: ${todo.length}; plan: ${plan.map((p) => `${p.model}@${p.n}${p.list ? "+list" : ""}`).join(", ")}${REPORT_ONLY ? " (report only)" : ""}`);

  const done = new Map();
  const write = () => {
    const videos = todo.map((v) => done.get(v.id)).filter(Boolean);
    const agg = aggregate(videos);
    writeJson(join(RESULTS, "results.json"), { generatedAt: new Date().toISOString(), k: K, iouThreshold: 0.5, settings: SETTINGS, judgeN: C.maxJudge, promptVersion: C.promptVersion, plan, randomSeeds: RANDOM_SEEDS, aggregate: agg, videos });
    writeFileSync(join(RESULTS, "RESULTS.md"), report(videos, agg, manifest, plan));
  };
  // Pass 0 transcribes every video and scores the no-LLM methods (every plan entry is used
  // only if already cached). Pass i runs plan entry i on every video; earlier ones come from cache.
  const passes = REPORT_ONLY ? [plan.length] : [0, ...plan.map((_, i) => i + 1)];
  for (const upto of passes) {
    const stepPlan = plan.map((p, i) => ({ ...p, skip: i >= upto }));
    for (const v of todo) {
      try {
        done.set(v.id, await runVideo(v, C, stepPlan));
      } catch (e) {
        log(`${v.id}: ${e.message}`);
        if (!REPORT_ONLY && /not available yet/.test(e.message)) throw e;
      }
      write();
    }
  }
  log("done");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
