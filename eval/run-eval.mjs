#!/usr/bin/env node
// Selects eval runner. Compares clip pickers against labelled moments.
//
//   node eval/run-eval.mjs                         all videos, methods: random, energy, judge:<every local model in MODELS>
//   node eval/run-eval.mjs --only id1,id2          a subset of videos
//   node eval/run-eval.mjs --limit 4               the 4 shortest videos
//   node eval/run-eval.mjs --models gemma3-4b-hf:latest,qwen2.5:0.5b
//   node eval/run-eval.mjs --report                rebuild results from caches only (no whisper, no Ollama)
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
import { energyScore, loudnessEnvelope } from "./methods/energy.mjs";

const EVAL = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(EVAL, "..");
const CACHE = process.env.SELECTS_EVAL_CACHE || join(EVAL, "cache");
const RESULTS = process.env.SELECTS_EVAL_RESULTS || join(EVAL, "results");
const LOCK = join(ROOT, ".selects", "heavy.lock");
const RANDOM_SEEDS = 200;
const K = 5;
const SETTINGS = { minLen: 20, maxLen: 60 };
const DEFAULT_MODELS = ["gemma3-4b-hf:latest", "gemma3:1b", "qwen2.5:0.5b", "phi3:mini"];

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const REPORT_ONLY = args.includes("--report");
const ONLY = opt("--only")?.split(",");
const LIMIT = opt("--limit") ? Number(opt("--limit")) : null;
const MODELS_ARG = opt("--models")?.split(",");

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const readJson = (f, d = null) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
function writeJson(f, data) {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f + ".tmp", JSON.stringify(data, null, 2) + "\n");
  renameSync(f + ".tmp", f);
}

// ---------- shared CPU lock ----------
let holding = false;
async function withHeavyLock(what, fn) {
  if (REPORT_ONLY) throw new Error(`--report: ${what} is not cached`);
  if (process.env.SELECTS_TEST_NO_LOCK) return fn();
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
  try { return await fn(); } finally { rmSync(LOCK, { force: true }); holding = false; }
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
    judge: j.judge, rank: r.rank, curve: r.curve, maxJudge: cfg.DEFAULT_SETTINGS?.maxJudge ?? 36,
  };
}

async function ollamaModels() {
  try {
    const r = await fetch((process.env.SELECTS_OLLAMA_URL || "http://127.0.0.1:11434") + "/api/tags");
    return (await r.json()).models.map((m) => m.name);
  } catch { return []; }
}

// ---------- per-video pipeline ----------
export async function runVideo(v, C, models) {
  const dir = join(CACHE, v.id);
  mkdirSync(dir, { recursive: true });
  const timingsFile = join(dir, "timings.json");
  const timings = readJson(timingsFile, {});
  const media = resolve(ROOT, v.localPath);

  // 1. transcript
  const wordsFile = join(dir, "words.json");
  let words = readJson(wordsFile);
  if (!words) {
    if (!existsSync(media)) throw new Error(`media missing: ${v.localPath} (run node eval/fetch-datasets.mjs audio)`);
    words = await withHeavyLock(`transcribe ${v.id}`, async () => {
      log(`${v.id}: transcribing ${Math.round(v.duration / 60)} min of audio`);
      const t0 = Date.now();
      const w = await C.transcribe(media, { cacheDir: dir, onProgress: () => {} });
      timings.transcribeSec = (Date.now() - t0) / 1000;
      return w;
    });
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
  const out = { id: v.id, title: v.title, duration: v.duration, nWords: words.length, nCandidates: cands.length, labels, methods: {}, timings };
  const curves = { id: v.id, duration: v.duration, labels: v.labels, heatmap: v.heatmapPath ? readJson(resolve(ROOT, v.heatmapPath), {})?.heatmap ?? null : null, methods: {} };
  const pick = (scored) => C.rank(scored, { k: K }).map((c) => ({ id: c.id, start: c.start, end: c.end, total: c.total, hook: c.hook, reason: c.reason, scores: c.scores }));
  const evalPreds = (preds) => Object.fromEntries(Object.entries(labels).filter(([, ls]) => ls.length).map(([src, ls]) => [src, scoreVideo(preds, ls)]));

  // What the judge reads: the product's shortlist (time-bucketed best pre-scores), as in a real job.
  const short = C.shortlist ? C.shortlist(cands, { n: C.maxJudge, duration: v.duration }) : cands;
  out.nShortlist = short.length;

  // oracle: the best any picker could do choosing K windows from the pool it sees
  out.methods.oracle = { preds: [], metrics: oracle(cands, labels) };
  out.methods["oracle:shortlist"] = { preds: [], metrics: oracle(short, labels) };

  // prescore: the core's text rules alone (no LLM), ranking every candidate
  if (cands.length && typeof cands[0].pre === "number") {
    const pScored = cands.map((c) => ({ ...c, total: c.pre }));
    out.methods.prescore = { preds: pick(pScored), metrics: evalPreds(pick(pScored)) };
  }

  // random: chance level, averaged over many seeds
  const runs = [];
  for (let seed = 1; seed <= RANDOM_SEEDS; seed++) runs.push(evalPreds(pick(randomScore(cands, seed))));
  out.methods.random = { preds: pick(randomScore(cands, 1)), metrics: avgMetrics(runs), seeds: RANDOM_SEEDS };

  // energy: no-LLM heuristic
  const eScored = energyScore(cands, env, words);
  out.methods.energy = { preds: pick(eScored), metrics: evalPreds(pick(eScored)) };
  curves.methods.energy = C.curve(eScored, v.duration, { step: 5 });

  // judge:<model>
  for (const model of models) {
    const key = `judge:${model}`;
    const jf = join(dir, `judge-${model.replace(/[^a-z0-9.]+/gi, "_")}.json`);
    let judged = readJson(jf);
    if (!judged || judged.n !== short.length || judged.candidatesHash !== hashCands(short)) {
      judged = await withHeavyLock(`judge ${model} ${v.id}`, async () => {
        log(`${v.id}: judging ${short.length} shortlisted of ${cands.length} candidates with ${model}`);
        const t0 = Date.now();
        let last = 0;
        const res = await C.judge(short, {
          model,
          cacheDir: join(CACHE, "judge"),
          onProgress: (p) => { const now = Date.now(); if (now - last > 60_000) { last = now; log(`${v.id} ${model}: ${Math.round((p?.progress ?? p ?? 0) * 100)}%`); } },
        });
        const sec = (Date.now() - t0) / 1000;
        return { model, n: short.length, candidatesHash: hashCands(short), wallSec: sec, secPerCandidate: sec / short.length, judgedAt: new Date().toISOString(), candidates: res };
      });
      writeJson(jf, judged);
      log(`${v.id}: ${model} done in ${Math.round(judged.wallSec)} s (${judged.secPerCandidate.toFixed(1)} s per candidate)`);
    }
    const preds = pick(judged.candidates);
    out.methods[key] = { preds, metrics: evalPreds(preds), judgeSec: judged.wallSec, secPerCandidate: judged.secPerCandidate };
    curves.methods[key] = C.curve(judged.candidates, v.duration, { step: 5 });
  }
  writeJson(join(RESULTS, "curves", `${v.id}.json`), curves);
  return out;
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
        n: rows.length,
        hit3: bootstrapCI(col("hit3")), hit5: bootstrapCI(col("hit5")), p5: bootstrapCI(col("p5")), r5: bootstrapCI(col("r5")), miou5: bootstrapCI(col("miou5")),
        judgeMinPerVideo: m.startsWith("judge:") ? mean(rows.map((v) => v.methods[m].judgeSec / 60)) : null,
        secPerCandidate: m.startsWith("judge:") ? mean(rows.map((v) => v.methods[m].secPerCandidate)) : null,
      };
    }
    // paired comparisons on mean best IoU, same videos
    agg[src].paired = {};
    for (const m of methods.filter((x) => x.startsWith("judge:"))) {
      for (const base of ["energy", "random"]) {
        const rows = videos.filter((v) => v.methods[m]?.metrics?.[src] && v.methods[base]?.metrics?.[src]);
        if (rows.length < 3) continue;
        agg[src].paired[`${m} vs ${base}`] = pairedBootstrap(rows.map((v) => v.methods[m].metrics[src].miou5), rows.map((v) => v.methods[base].metrics[src].miou5));
      }
    }
  }
  return agg;
}

const pct = (x) => (x == null || Number.isNaN(x) ? "n/a" : `${Math.round(x * 100)}%`);
const f2 = (x) => (x == null || Number.isNaN(x) ? "n/a" : x.toFixed(2));
const ci = (c, fmt = pct) => (c.lo == null ? fmt(c.mean) : `${fmt(c.mean)} (${fmt(c.lo)} to ${fmt(c.hi)})`);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export function report(videos, agg, manifest) {
  const L = [];
  L.push("# Selects eval results", "");
  L.push(`Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by \`node eval/run-eval.mjs\`. Machine: Intel i5-7360U (2 cores, 2017), 16 GB, no GPU.`, "");
  L.push(`Videos scored: **n = ${videos.length}** of ${manifest.length} in the manifest. Each method picks its top ${K} clips (20 to 60 s) from the same candidate windows.`, "");
  for (const src of ["heatmap", "human"]) {
    const rows = Object.entries(agg[src]).filter(([k]) => k !== "paired");
    if (!rows.length) { if (src === "human") L.push("## Against human picks", "", "No human labels yet. Run `node eval/label.mjs` and mark 5 moments per video.", ""); continue; }
    L.push(src === "heatmap" ? "## Against YouTube Most Replayed peaks (proxy labels)" : "## Against human picks (Arnold)", "");
    L.push("| Method | n | hit@3 | hit@5 (95% CI) | precision@5 | recall@5 | mean best IoU (95% CI) | judge time per video | s per candidate |");
    L.push("|---|---|---|---|---|---|---|---|---|");
    const order = (k) => ({ random: 0, energy: 1, prescore: 2, "oracle:shortlist": 8, oracle: 9 })[k] ?? 3;
    for (const [m, a] of rows.sort((x, y) => order(x[0]) - order(y[0]))) {
      const name = { oracle: "ceiling: best possible from all candidates", "oracle:shortlist": "ceiling: best possible from the judge's shortlist", random: `random (mean of ${RANDOM_SEEDS} seeds)`, energy: "energy (loudness + speech rate, no LLM)", prescore: "text rules only (Selects pre-score, no LLM)" }[m] ?? `${m} (shortlist + judge)`;
      L.push(`| ${name} | ${a.n} | ${pct(a.hit3.mean)} | ${ci(a.hit5)} | ${pct(a.p5.mean)} | ${pct(a.r5.mean)} | ${ci(a.miou5, f2)} | ${a.judgeMinPerVideo == null ? "-" : a.judgeMinPerVideo.toFixed(1) + " min"} | ${a.secPerCandidate == null ? "-" : a.secPerCandidate.toFixed(1)} |`);
    }
    L.push("");
    const paired = Object.entries(agg[src].paired || {});
    if (paired.length) {
      L.push("Paired difference in mean best IoU on the same videos (bootstrap 95% CI; an interval that crosses 0 means no clear difference):", "");
      for (const [k, p] of paired) L.push(`- ${k}: ${p.diff >= 0 ? "+" : ""}${f2(p.diff)} (${f2(p.lo)} to ${f2(p.hi)}), n = ${p.n}`);
      L.push("");
    }
  }

  L.push("## Wall time per video and stage", "");
  const models = [...new Set(videos.flatMap((v) => Object.keys(v.methods).filter((m) => m.startsWith("judge:"))))];
  L.push(`| Video | length | candidates (judged) | transcribe | ${models.map((m) => m.replace("judge:", "judge ")).join(" | ")} |`);
  L.push(`|---|---|---|---|${models.map(() => "---").join("|")}|`);
  for (const v of videos) {
    L.push(`| ${v.title.slice(0, 60)} | ${mmss(v.duration)} | ${v.nCandidates} (${v.nShortlist}) | ${v.timings.transcribeSec ? mmss(v.timings.transcribeSec) : "n/a"} | ${models.map((m) => (v.methods[m] ? mmss(v.methods[m].judgeSec) : "-")).join(" | ")} |`);
  }
  L.push("");

  const best = models.map((m) => [m, agg.heatmap[m]?.miou5?.mean ?? -1]).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (best) {
    const byIou = videos.filter((v) => v.methods[best]?.metrics?.heatmap).sort((a, b) => b.methods[best].metrics.heatmap.miou5 - a.methods[best].metrics.heatmap.miou5);
    const ex = (v, label) => {
      const p = v.methods[best].preds[0];
      const lab = v.labels.heatmap.reduce((b, l) => (tiou(p, l) > tiou(p, b) ? l : b), v.labels.heatmap[0]);
      L.push(`**${label}: ${v.title}** (mean best IoU ${f2(v.methods[best].metrics.heatmap.miou5)})`, "");
      L.push(`- ${best} top pick: ${mmss(p.start)} to ${mmss(p.end)}, best IoU with any peak ${f2(bestIoU(p, v.labels.heatmap))}. Hook: "${(p.hook || "").slice(0, 160)}"${p.reason ? ` Reason: "${p.reason}"` : ""}`);
      if (lab) L.push(`- Nearest replay peak: ${mmss(lab.start)} to ${mmss(lab.end)} (peak height ${lab.weight})`);
      L.push("");
    };
    L.push(`## Best and worst examples (${best})`, "");
    if (byIou.length) ex(byIou[0], "Best");
    if (byIou.length > 1) ex(byIou[byIou.length - 1], "Worst");
  }

  L.push("## How to read this, and caveats", "");
  L.push(`- **n is small (${videos.length} videos).** Confidence intervals are percentile bootstrap over videos; with n this small they are wide, and a difference whose interval crosses zero is not a finding.`);
  L.push("- **Most Replayed is a proxy.** It records where viewers rewatch or seek to, which is not the same as where a good standalone short is. Replays also gather around slides, demos and jokes that need visual context, which an audio-only picker cannot see.");
  L.push("- **The heatmap is coarse.** YouTube gives about 100 segments per video (one per 9 to 27 s here), so label boundaries are only accurate to a segment. Hit at IoU 0.5 is strict against such labels; the mean best IoU column and the \"best possible from candidate pool\" row show how much is reachable at all.");
  L.push(`- **Random is the chance level**, averaged over ${RANDOM_SEEDS} seeds on the same candidate windows, so it is not a single lucky or unlucky draw.`);
  L.push("- **The judge reads a shortlist**, as Selects does in a real job: the cheap text pre-score picks about 36 windows spread over the video, and only those go to the model. The judge rows therefore measure the shipped pipeline (pre-score shortlist, then model). The shortlist ceiling row shows what that shortlist can reach at best.");
  L.push("- **Energy** scores loudness, loudness variation and words per second, the signals cheap clippers use. It does not read the words.");
  L.push("- Judge models run locally through Ollama on CPU. Time is wall time on this laptop while other work may share the CPU; treat it as an order of magnitude.");
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
  const models = (MODELS_ARG || DEFAULT_MODELS).filter((m) => REPORT_ONLY || installed.includes(m));
  log(`videos: ${todo.length}; judge models: ${models.join(", ") || "none"}${REPORT_ONLY ? " (report only)" : ""}`);

  const prev = readJson(join(RESULTS, "results.json"), { videos: [] });
  const done = new Map(prev.videos.map((v) => [v.id, v]));
  for (const v of todo) {
    try {
      done.set(v.id, await runVideo(v, C, models));
    } catch (e) {
      log(`${v.id}: ${e.message}`);
      if (!REPORT_ONLY && /not available yet/.test(e.message)) throw e;
    }
    const videos = [...done.values()].filter((x) => manifest.some((m) => m.id === x.id));
    const agg = aggregate(videos);
    writeJson(join(RESULTS, "results.json"), { generatedAt: new Date().toISOString(), k: K, iouThreshold: 0.5, settings: SETTINGS, randomSeeds: RANDOM_SEEDS, aggregate: agg, videos });
    writeFileSync(join(RESULTS, "RESULTS.md"), report(videos, agg, manifest));
  }
  log("done");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
