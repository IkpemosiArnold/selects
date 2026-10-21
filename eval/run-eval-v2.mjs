#!/usr/bin/env node
// Selects eval v2. The plan (hypotheses, metrics, tests) is pre-registered in eval/PLAN.md.
//
//   node eval/run-eval-v2.mjs                  prep, then Gemini judging, then the report
//   node eval/run-eval-v2.mjs --phase prep     transcripts only (whisper, local, takes heavy.lock)
//   node eval/run-eval-v2.mjs --phase gemini   Gemma 4 through the Gemini API (judge, listwise, faithful)
//   node eval/run-eval-v2.mjs --phase qwen     qwen2.5 0.5B locally (takes heavy.lock)
//   node eval/run-eval-v2.mjs --phase pairs    build the blind preference pairs and cut their audio
//   node eval/run-eval-v2.mjs --report         rebuild results from caches only
//   --only id1,id2   --limit N
//
// Every model answer is cached (src/core/judge.mjs keeps judge-cache.json per video), so a
// crash or power loss resumes where it stopped.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import { auc, spearman, aboveMedian, signFlipTest, holm, wilson, bootstrapCI, mean, rng, scoreVideo, tiou, bestIoU } from "./metrics.mjs";
import { windowIntensity, heatmapToLabels } from "./heatmap.mjs";
import { energyScore } from "./methods/energy.mjs";
import { geminiKey, geminiRequest, rateLimiter, GEMMA4 } from "./llm-gemini.mjs";

const EVAL = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(EVAL, "..");
const CACHE = process.env.SELECTS_EVAL_CACHE || join(EVAL, "cache");
const OUT = process.env.SELECTS_EVAL_RESULTS || join(EVAL, "results");
const LOCK = join(ROOT, ".selects", "heavy.lock");
const K = 5;
const SETTINGS = { minLen: 20, maxLen: 60, stride: 6 };
const NS = [8, 16]; // 8: the app's default; 16: the Smart mode shortlist the plan names
const R_SIZE = 24;
const R_SEED = 2026;
const RANDOM_SEEDS = 200;
const RANGE_END = 900; // first 15 minutes
const GEMMA4_LABEL = `gemini/${GEMMA4}`;
const QWEN = "qwen2.5:0.5b";
const GEMMA3 = "gemma3-4b-hf:latest";

const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const REPORT_ONLY = args.includes("--report");
const PHASE = opt("--phase");
const ONLY = opt("--only")?.split(",");
const LIMIT = opt("--limit") ? Number(opt("--limit")) : null;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const readJson = (f, d = null) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
function writeJson(f, data) {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f + ".tmp", JSON.stringify(data, null, 2) + "\n");
  renameSync(f + ".tmp", f);
}
const hashInt = (s) => parseInt(createHash("sha1").update(String(s)).digest("hex").slice(0, 8), 16);

// ---------- shared CPU lock (fair: 90 s gap after each release) ----------
let holding = false;
let lastRelease = 0;
async function withHeavyLock(what, fn) {
  if (process.env.SELECTS_TEST_NO_LOCK) return fn();
  const notBefore = lastRelease + 90_000;
  if (Date.now() < notBefore) await sleep(notBefore - Date.now());
  for (;;) {
    if (!existsSync(LOCK)) {
      mkdirSync(dirname(LOCK), { recursive: true });
      try {
        writeFileSync(LOCK, `eval-builder pid=${process.pid} since=${new Date().toISOString()} job=${what}\n`, { flag: "wx" });
        holding = true;
        break;
      } catch {}
    }
    const owner = readFileSync(LOCK, "utf8").trim();
    const m = /^eval-builder pid=(\d+)/.exec(owner);
    if (m && !isAlive(Number(m[1]))) { rmSync(LOCK, { force: true }); continue; }
    log(`heavy.lock held (${owner.slice(0, 80)}); waiting 60 s before ${what}`);
    await sleep(60_000);
  }
  try { return await fn(); } finally { rmSync(LOCK, { force: true }); holding = false; lastRelease = Date.now(); }
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { if (holding) rmSync(LOCK, { force: true }); process.exit(130); });
process.on("exit", () => { if (holding) rmSync(LOCK, { force: true }); });

// ---------- core ----------
async function core() {
  const imp = (m) => import(join(ROOT, "src", "core", m));
  const [tr, sel, non, sen, pun, qual, jd, jc, rk, fa, cand] = await Promise.all(
    ["transcribe.mjs", "select.mjs", "nonspeech.mjs", "sentences.mjs", "punctuate.mjs", "quality.mjs", "judge.mjs", "judge-core.mjs", "rank.mjs", "faithful.mjs", "candidates.mjs"].map(imp),
  );
  return {
    transcribe: tr.transcribe, loudnessFromWav: tr.loudnessFromWav, selectCandidates: sel.selectCandidates,
    splitNonSpeech: non.splitNonSpeech, isSparsePunctuation: sen.isSparsePunctuation, toSentences: sen.toSentences,
    restorePunctuation: pun.restorePunctuation, transcriptQuality: qual.transcriptQuality,
    judge: jd.judge, listwise: jd.listwise, promptVersion: jd.loadPrompt().version,
    JUDGE_SCHEMA: jc.JUDGE_SCHEMA, listSchema: jc.listSchema, blend: jc.blend,
    rank: rk.rank, checkFaithful: fa.checkFaithful, FAITHFUL_SCHEMA: fa.FAITHFUL_SCHEMA, iou: cand.iou,
  };
}

// ---------- 1. transcript, as a job builds it ----------
async function prep(v, C) {
  const dir = join(CACHE, v.id, "v2");
  mkdirSync(dir, { recursive: true });
  const prepFile = join(dir, "prep.json");
  const have = readJson(prepFile);
  if (have) return have;
  if (REPORT_ONLY) return null;
  const end = Math.min(v.fullDuration || v.duration, RANGE_END);
  let media = resolve(ROOT, v.localPath);
  if (!existsSync(media)) throw new Error(`media missing: ${v.localPath}`);
  const ext = media.slice(media.lastIndexOf("."));
  const cut = join(dir, `cut-0-${Math.round(end)}${ext}`);
  if (!existsSync(cut)) {
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-t", String(end), "-i", media, "-vn", "-c:a", "copy", cut]);
    if (r.status !== 0) throw new Error(`could not cut ${v.id}: ${r.stderr}`);
  }
  // reuse v1's whisper output when v1 transcribed exactly the same cut
  const v1 = join(CACHE, v.id, "whisper.json");
  // v1 transcribed the whole file when it was short, or its own 0-900 s cut
  const full = v.fullDuration || v.duration;
  const v1cut = full <= RANGE_END ? true : existsSync(join(CACHE, v.id, `eval-0-${RANGE_END}${ext}`)) && end === RANGE_END;
  if (!existsSync(join(dir, "whisper.json")) && existsSync(v1) && v1cut) copyFileSync(v1, join(dir, "whisper.json"));
  const t0 = Date.now();
  let raw;
  if (existsSync(join(dir, "whisper.json"))) raw = await C.transcribe(cut, { cacheDir: dir, duration: end, language: "en" });
  else raw = await withHeavyLock(`transcribe ${v.id}`, () => { log(`${v.id}: transcribing ${Math.round(end / 60)} min`); return C.transcribe(cut, { cacheDir: dir, duration: end, language: "en" }); });
  const transcribeSec = (Date.now() - t0) / 1000;
  // loudness track (the core writes it only when whisper runs)
  let loudness = readJson(join(dir, "loudness.json"));
  if (!loudness) {
    const wav = join(dir, "loud.wav");
    spawnSync("ffmpeg", ["-v", "error", "-y", "-i", cut, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
    loudness = C.loudnessFromWav(wav);
    rmSync(wav, { force: true });
    writeJson(join(dir, "loudness.json"), loudness);
  }
  const split = C.splitNonSpeech(raw);
  let words = split.words;
  const events = [...(raw.events || []), ...split.events].sort((a, b) => a.s - b.s);
  let punctuation = null;
  if (C.isSparsePunctuation(words)) {
    const r = C.restorePunctuation(words);
    words = r.words;
    punctuation = r.info;
  }
  const quality = C.transcriptQuality(words, { duration: end });
  const foreign = events.filter((e) => e.type === "foreign").length;
  const wpm = words.length / (end / 60);
  const exclude = wpm < 60 ? `only ${Math.round(wpm)} words a minute (dubbed or not English?)` : foreign > 5 ? `${foreign} foreign-language markers (dubbed audio?)` : quality.verdict === "unreliable" ? "whisper's transcript is unreliable" : null;
  const out = { id: v.id, end, transcribeSec: existsSync(v1) && v1cut ? null : transcribeSec, words, events, loudness, punctuation, quality, exclude };
  writeJson(prepFile, out);
  log(`${v.id}: ${words.length} words, punctuation ${punctuation ? (punctuation.restored ? "restored" : `not restored (${punctuation.reason})`) : "fine"}, quality ${quality.verdict}${exclude ? `, EXCLUDED: ${exclude}` : ""}`);
  return out;
}

// ---------- 2. windows, shortlists, the random sample R ----------
function windowsFor(v, P, C) {
  const info = readJson(resolve(ROOT, v.heatmapPath));
  const heat = (info.heatmap || []).filter((s) => s.start_time < P.end);
  const sels = Object.fromEntries(NS.map((n) => [n, C.selectCandidates({ words: P.words, events: P.events, loudness: P.loudness, settings: { ...SETTINGS, judgeN: n }, duration: P.end })]));
  const windows = sels[NS[0]].windows.map((w) => ({ ...w, intensity: windowIntensity(heat, w.start, Math.min(w.end, P.end)) })).filter((w) => w.intensity != null);
  const byId = new Map(windows.map((w) => [w.id, w]));
  const short = Object.fromEntries(NS.map((n) => [n, sels[n].shortlist.map((c) => byId.get(c.id)).filter(Boolean)]));
  const inShort = new Set(NS.flatMap((n) => short[n].map((c) => c.id)));
  const pool = windows.filter((w) => !inShort.has(w.id));
  const r = rng(R_SEED + hashInt(v.id));
  const R = pool.map((w) => [r(), w]).sort((a, b) => a[0] - b[0]).slice(0, R_SIZE).map((x) => x[1]).sort((a, b) => a.start - b.start);
  const labels = heatmapToLabels(info.heatmap, { rangeEnd: P.end < (info.duration || Infinity) ? P.end : null });
  return { windows, short, R, labels, heat };
}

// ---------- 3. judging ----------
let limiter = null;
function gemReq(C, schema, maxTokens = 256) {
  limiter ||= rateLimiter({ rpm: 28, tpm: 14000 });
  return geminiRequest({ key: geminiKey(ROOT), schema, maxTokens, limiter });
}

async function judgeSet(v, C, set, model, { local = false } = {}) {
  const dir = join(CACHE, v.id, "v2", "judge");
  mkdirSync(dir, { recursive: true });
  const request = model === GEMMA4_LABEL ? gemReq(C, C.JUDGE_SCHEMA) : undefined;
  const run = () => C.judge(set, { model: model === GEMMA4_LABEL ? GEMMA4_LABEL : model, cacheDir: dir, request });
  if (local) return withHeavyLock(`judge ${model} ${v.id}`, run);
  return run();
}

/** Look answers up in the judge cache without calling the model (for Gemma 3 4B, too slow to re-run). */
function cachedOnly(v, C, set, model) {
  const cache = readJson(join(CACHE, v.id, "v2", "judge", "judge-cache.json"), {});
  const sha1 = (s) => createHash("sha1").update(s).digest("hex");
  return set.map((c) => cache[sha1(`${model}|${C.promptVersion}|${c.text.trim()}`)] ? c : null).filter(Boolean).length;
}

async function listwiseFor(v, C, judged) {
  const dir = join(CACHE, v.id, "v2", "judge");
  const top = C.rank(judged, { k: 4, iou: 0.3 });
  const letters = top.map((_, i) => String.fromCharCode(65 + i));
  const request = gemReq(C, C.listSchema(letters), 400);
  return C.listwise(judged, { model: GEMMA4_LABEL, n: 4, cacheDir: dir, request });
}

// ---------- 4. per-video metrics ----------
function rankMetrics(set, scoreOf) {
  const s = set.map(scoreOf);
  if (s.some((x) => x == null)) return null;
  const y = set.map((w) => w.intensity);
  return { auc: auc(s, aboveMedian(y)), rho: spearman(s, y), n: set.length };
}

function pickTop(C, scored) {
  return C.rank(scored, { k: K }).map((c) => ({ id: c.id, start: c.start, end: c.end, total: c.total, judgeTotal: c.judgeTotal, pre: c.pre, hook: c.hook, text: c.text, reason: c.reason, intensity: c.intensity }));
}

function oracle(pool, labels) {
  const best = labels.map((l) => pool.reduce((b, c) => Math.max(b, tiou(c, l)), 0));
  const reach = best.filter((x) => x >= 0.5).length;
  return { hit3: reach ? 1 : 0, hit5: reach ? 1 : 0, miou5: mean(best.sort((a, b) => b - a).slice(0, K)) };
}

async function evaluate(v, C, P, phase) {
  const W = windowsFor(v, P, C);
  const { windows, short, R, labels } = W;
  const out = { id: v.id, title: v.title, channel: v.channel, url: v.url, end: P.end, nWindows: windows.length, nR: R.length, nLabels: labels.length, words: P.words.length, punctuation: P.punctuation?.restored ?? null, quality: P.quality?.verdict, rank: {}, top: {}, judged: {}, faithful: null, cost: {} };
  const energy = energyScore(windows, { hop: P.loudness.step, db: P.loudness.db }, P.words);
  const eById = new Map(energy.map((w) => [w.id, w.total]));
  // rules methods over all windows and on R
  for (const [name, f] of [["prescore", (w) => w.pre], ["energy", (w) => eById.get(w.id)]]) {
    out.rank[name] = { all: rankMetrics(windows, f), R: rankMetrics(R, f) };
  }
  // random: mean over seeds
  const rAll = [], rR = [];
  for (let s = 1; s <= RANDOM_SEEDS; s++) {
    const g = rng(s * 7919 + hashInt(v.id));
    const sc = new Map(windows.map((w) => [w.id, g()]));
    rAll.push(rankMetrics(windows, (w) => sc.get(w.id)));
    rR.push(rankMetrics(R, (w) => sc.get(w.id)));
  }
  const avg = (xs) => ({ auc: mean(xs.map((x) => x.auc).filter((x) => x != null)), rho: mean(xs.map((x) => x.rho).filter((x) => x != null)) });
  out.rank.random = { all: avg(rAll), R: avg(rR) };

  // top-k (v1 metric) for the rules methods
  const prefTop = pickTop(C, windows.map((w) => ({ ...w, total: w.pre })));
  out.top.prescore = { picks: prefTop, ...scoreVideo(prefTop, labels) };
  const enTop = pickTop(C, energy.map((w) => ({ ...w, intensity: windows.find((x) => x.id === w.id)?.intensity })));
  out.top.energy = { picks: enTop, ...scoreVideo(enTop, labels) };
  for (const n of NS) {
    const t = pickTop(C, short[n].map((w) => ({ ...w, total: w.pre })));
    out.top[`prefilter@${n}`] = { picks: t, ...scoreVideo(t, labels) };
    out.top[`ceiling@${n}`] = oracle(short[n], labels);
  }
  out.top.ceiling = oracle(windows, labels);
  const runs = [];
  for (let s = 1; s <= RANDOM_SEEDS; s++) { const g = rng(s); runs.push(scoreVideo(pickTop(C, windows.map((w) => ({ ...w, total: g() }))), labels)); }
  out.top.random = Object.fromEntries(Object.keys(runs[0]).map((k) => [k, mean(runs.map((r) => r[k]))]));

  // model judges on J = shortlists + R
  const J = [...new Map([...NS.flatMap((n) => short[n]), ...R].map((w) => [w.id, w])).values()];
  out.nJudged = J.length;
  out.rank.prescore.J = rankMetrics(J, (w) => w.pre);
  out.rank.energy.J = rankMetrics(J, (w) => eById.get(w.id));
  for (const model of [GEMMA4_LABEL, QWEN]) {
    const isGem = model === GEMMA4_LABEL;
    let judged = null;
    const want = !REPORT_ONLY && ((isGem && phase === "gemini") || (!isGem && phase === "qwen"));
    if (want) {
      const t0 = Date.now();
      judged = await judgeSet(v, C, J, model, { local: !isGem });
      out.cost[model] = { wallSec: (Date.now() - t0) / 1000 };
    } else {
      // from cache only: a request that refuses, so judge() returns only if every answer is cached
      try {
        judged = await C.judge(J, { model, cacheDir: join(CACHE, v.id, "v2", "judge"), request: async () => { throw Object.assign(new Error("not cached"), { notCached: true }); } });
      } catch { judged = null; }
    }
    if (!judged) continue;
    const jt = new Map(judged.map((c) => [c.id, c]));
    const key = isGem ? "gemma4" : "qwen";
    out.rank[key] = { R: rankMetrics(R, (w) => jt.get(w.id)?.judgeTotal), J: rankMetrics(J, (w) => jt.get(w.id)?.judgeTotal) };
    // exploratory: each rubric dimension alone, and the shipped blend with the pre-score
    for (const dim of ["hook", "standalone", "payoff", "clarity"]) out.rank[`${key}:${dim}`] = { R: rankMetrics(R, (w) => jt.get(w.id)?.scores?.[dim]) };
    out.rank[`${key}:blend`] = { R: rankMetrics(R, (w) => jt.get(w.id)?.total), J: rankMetrics(J, (w) => jt.get(w.id)?.total) };
    out.judged[key] = judged.map((c) => ({ id: c.id, judgeTotal: c.judgeTotal, total: c.total, scores: c.scores, reason: c.reason }));
    for (const n of NS) {
      const sj = short[n].map((w) => jt.get(w.id));
      const own = pickTop(C, sj.map((c) => ({ ...c, intensity: windows.find((x) => x.id === c.id).intensity, total: c.judgeTotal })));
      out.top[`${key}@${n}`] = { picks: own, ...scoreVideo(own, labels) };
      const blend = pickTop(C, sj.map((c) => ({ ...c, intensity: windows.find((x) => x.id === c.id).intensity })));
      out.top[`${key}-blend@${n}`] = { picks: blend, ...scoreVideo(blend, labels) };
      if (isGem) {
        let lw = null;
        if (want) lw = await listwiseFor(v, C, sj);
        else { try { lw = await C.listwise(sj, { model: GEMMA4_LABEL, n: 4, cacheDir: join(CACHE, v.id, "v2", "judge"), request: async () => { throw new Error("not cached"); } }); } catch { lw = null; } }
        if (lw) {
          const shipped = pickTop(C, lw.candidates.map((c) => ({ ...c, intensity: windows.find((x) => x.id === c.id).intensity })));
          out.top[`shipped@${n}`] = { picks: shipped, ...scoreVideo(shipped, labels), listwiseComplete: lw.complete };
        }
      }
    }
  }
  // Gemma 3 4B: coverage of cached answers only
  out.gemma3Cached = cachedOnly(v, C, J, GEMMA3);

  // faithful check on the shipped top 5 (16-window shortlist)
  const ship = out.top["shipped@16"]?.picks;
  const ffile = join(CACHE, v.id, "v2", "faithful.json");
  if (ship?.length && (REPORT_ONLY || phase !== "gemini")) out.faithful = readJson(ffile);
  // the sentence before and after each pick, so a person can judge the check
  if (out.faithful) {
    const sents = C.toSentences(P.words);
    for (const f of out.faithful) {
      f.before ??= [...sents].reverse().find((x) => x.e <= f.start + 0.05)?.text ?? null;
      f.after ??= sents.find((x) => x.s >= f.end - 0.05)?.text ?? null;
    }
  }
  else if (ship?.length) {
    const fdir = join(CACHE, v.id, "v2", "judge");
    const full = ship.map((p) => windows.find((w) => w.id === p.id));
    const request = phase === "gemini" && !REPORT_ONLY ? gemReq(C, C.FAITHFUL_SCHEMA, 400) : async () => { throw new Error("not cached"); };
    try {
      const fr = await C.checkFaithful(full, { words: P.words, model: GEMMA4_LABEL, mode: "model", cacheDir: fdir, request });
      out.faithful = fr.candidates.map((c) => ({ id: c.id, start: c.start, end: c.end, text: c.text, verdict: c.faithful?.verdict ?? null, issue: c.faithful?.issue ?? null, note: c.faithful?.note ?? c.faithful?.reason ?? null, source: c.faithful?.by ?? null, error: c.faithful?.error ?? null, raw: c.faithful ?? null }));
      writeJson(ffile, out.faithful);
    } catch (e) {
      out.faithful = null;
      out.faithfulError = e.message;
    }
  }
  return { out, W };
}

// ---------- 5. aggregate and test ----------
function aggregate(videos) {
  const A = { n: videos.length, rank: {}, top: {}, tests: {} };
  const col = (f) => videos.map(f).filter((x) => x != null && !Number.isNaN(x));
  for (const m of [...new Set(videos.flatMap((v) => Object.keys(v.rank)))]) {
    for (const set of ["all", "R", "J"]) {
      const a = col((v) => v.rank[m]?.[set]?.auc);
      if (!a.length) continue;
      const r = col((v) => v.rank[m]?.[set]?.rho);
      A.rank[`${m}|${set}`] = { n: a.length, auc: bootstrapCI(a, { iters: 10000, seed: 7 }), rho: bootstrapCI(r, { iters: 10000, seed: 7 }) };
    }
  }
  const tops = [...new Set(videos.flatMap((v) => Object.keys(v.top)))];
  for (const t of tops) {
    const rows = videos.filter((v) => v.top[t]);
    A.top[t] = { n: rows.length, hit3: bootstrapCI(rows.map((v) => v.top[t].hit3), { iters: 10000, seed: 7 }), hit5: bootstrapCI(rows.map((v) => v.top[t].hit5), { iters: 10000, seed: 7 }), miou5: bootstrapCI(rows.map((v) => v.top[t].miou5), { iters: 10000, seed: 7 }) };
  }
  // pre-registered tests
  const paired = (a, b, set = "R") => {
    const rows = videos.filter((v) => v.rank[a]?.[set]?.auc != null && v.rank[b]?.[set]?.auc != null);
    const d = rows.map((v) => v.rank[a][set].auc - v.rank[b][set].auc);
    return { ...signFlipTest(d), ci: bootstrapCI(d, { iters: 10000, seed: 7 }) };
  };
  const vsChance = (a, set) => {
    const d = videos.map((v) => v.rank[a]?.[set]?.auc).filter((x) => x != null).map((x) => x - 0.5);
    return { ...signFlipTest(d), ci: bootstrapCI(d, { iters: 10000, seed: 7 }) };
  };
  const T = A.tests;
  T.H1 = { label: "Gemma 4 AUC on R above chance", ...vsChance("gemma4", "R") };
  T.H2 = { label: "Gemma 4 minus pre-score, AUC on R", ...paired("gemma4", "prescore") };
  T.H3 = { label: "Pre-score AUC over all windows above chance", ...vsChance("prescore", "all") };
  T.H4 = { label: "Gemma 4 minus energy, AUC on R", ...paired("gemma4", "energy") };
  const prim = ["H1", "H2", "H3", "H4"].filter((h) => T[h].p != null);
  const adj = holm(prim.map((h) => T[h].p));
  prim.forEach((h, i) => (T[h].pHolm = adj[i]));
  T.H5 = { label: "Gemma 4 minus qwen 0.5B, AUC on R", ...paired("gemma4", "qwen") };
  // exploratory power check: videos needed for 80% power at the observed paired effect
  const d = videos.filter((v) => v.rank.gemma4?.R?.auc != null).map((v) => v.rank.gemma4.R.auc - v.rank.prescore.R.auc);
  const g = videos.filter((v) => v.rank.gemma4?.R?.auc != null).map((v) => v.rank.gemma4.R.auc - 0.5);
  const need = (xs) => { const m = mean(xs); const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); return m ? Math.ceil(((1.96 + 0.84) * sd / Math.abs(m)) ** 2) : null; };
  A.power = { gemma4VsChance: need(g), gemma4VsPrescore: need(d) };
  const h6 = videos.filter((v) => v.top["shipped@16"] && v.top["prefilter@16"]);
  T.H6 = { label: "Shipped (16) minus prefilter alone (16), hit@3", ...signFlipTest(h6.map((v) => v.top["shipped@16"].hit3 - v.top["prefilter@16"].hit3)) };
  return A;
}

// ---------- 6. preference pairs ----------
function buildPairs(evals, C) {
  const pairs = [];
  for (const { out, W } of evals) {
    const a = out.top["shipped@16"]?.picks?.[0];
    if (!a) continue;
    const g = rng(4242 + hashInt(out.id));
    const len = a.end - a.start;
    const randomPool = W.windows.filter((w) => Math.abs(w.end - w.start - len) <= 8 && tiou(w, a) === 0);
    const b = randomPool.length ? randomPool[Math.floor(g() * randomPool.length)] : null;
    if (b) pairs.push({ video: out.id, title: out.title, kind: "vs-random", selects: a, other: b });
    const p = out.top.prescore?.picks?.[0];
    if (p && tiou(p, a) < 0.3) pairs.push({ video: out.id, title: out.title, kind: "vs-prescore", selects: a, other: W.windows.find((w) => w.id === p.id) });
  }
  // cap at 30: every vs-random pair first, then vs-prescore pairs in a seeded order
  const g = rng(99);
  const vr = pairs.filter((p) => p.kind === "vs-random");
  const vp = pairs.filter((p) => p.kind === "vs-prescore").map((p) => [g(), p]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  const chosen = [...vr, ...vp].slice(0, 30);
  return chosen.map((p) => {
    // stable ids, so ratings stay attached to the right pair if the set is rebuilt
    const id = `p-${p.video}-${p.kind === "vs-random" ? "r" : "s"}`;
    const flip = rng(777 + hashInt(id))() < 0.5; // which side Selects is on
    const side = (w) => ({ start: +w.start.toFixed(2), end: +w.end.toFixed(2), text: w.text });
    return { id, video: p.video, title: p.title, kind: p.kind, selectsSide: flip ? "B" : "A", A: side(flip ? p.other : p.selects), B: side(flip ? p.selects : p.other) };
  });
}

function cutPairAudio(pairs, manifest) {
  const dir = join(EVAL, "media", "prefer");
  mkdirSync(dir, { recursive: true });
  for (const p of pairs) {
    const v = manifest.find((m) => m.id === p.video);
    for (const s of ["A", "B"]) {
      const f = join(dir, `${p.id}-${s}.m4a`);
      if (existsSync(f)) continue;
      spawnSync("ffmpeg", ["-v", "error", "-y", "-ss", String(p[s].start), "-t", String(p[s].end - p[s].start), "-i", resolve(ROOT, v.localPath), "-vn", "-ac", "1", "-c:a", "aac", "-b:a", "64k", f]);
    }
  }
}

// ---------- 7. report ----------
const pct = (x) => (x == null || Number.isNaN(x) ? "n/a" : `${Math.round(x * 100)}%`);
const f2 = (x) => (x == null || Number.isNaN(x) ? "n/a" : x.toFixed(2));
const f3 = (x) => (x == null || Number.isNaN(x) ? "n/a" : x.toFixed(3));
const ci = (c, f = f2) => (!c || c.mean == null ? "n/a" : c.lo == null ? f(c.mean) : `${f(c.mean)} (${f(c.lo)} to ${f(c.hi)})`);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const pv = (p) => (p == null ? "n/a" : p < 0.001 ? "< 0.001" : p.toFixed(3));

// Country on each channel's YouTube About page (checked 21 Oct 2026). Five pages list none, so these use
// where the organisation is: BCiZc0n6COY (Cambridge lectures, UK), C5FzMblXU4M (James Randi Educational
// Foundation, US), CBYhVcO4WgI (Y Combinator, US), JXm0-ilIknE (Blender, Netherlands), luM2Y4otHUY (University of Ghana).
const CHANNEL_COUNTRY = {
  G9NabGlnDCs: "Gibraltar", "ASvx-QG6o04": "United States", "Yiaatr-Noh0": "India", Gij3hiWXJ88: "United States",
  Aj0nf3rKG_E: "United States", BCiZc0n6COY: "United Kingdom", C5FzMblXU4M: "United States", CBYhVcO4WgI: "United States",
  "JXm0-ilIknE": "Netherlands", MSgoeuMqUmU: "United States", VoRbPxyo2uU: "Switzerland", "iqm-XEqpayc": "United States",
  k4715CJ0Ii8: "United Kingdom", luM2Y4otHUY: "Ghana", "tExPpuk-UQ8": "Canada", uFyk5UOyNqI: "United States",
  vRVV1hq9WXE: "Nigeria", wBoEsrpnPHA: "United States", xlAyUkscaFg: "Nigeria", _iUeydyJc20: "Kenya",
};

export function report(videos, A, { excluded = [], prefer = null, v1 = null } = {}) {
  const L = [];
  L.push("# Selects eval results", "");
  L.push(`v2, generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC by \`node eval/run-eval-v2.mjs --report\`. The plan, hypotheses and tests were committed before judging: [eval/PLAN.md](../PLAN.md).`, "");
  L.push(`**n = ${videos.length} videos** (the first 15 minutes of each, ${videos.reduce((s, v) => s + v.nWindows, 0)} candidate windows in total, ${videos.reduce((s, v) => s + v.nR, 0)} in the random sample R that the models judged).${excluded.length ? ` Excluded before judging: ${excluded.map((e) => `${e.id} (${e.reason.replace("whisper's transcript is unreliable", "the app's own transcript-quality gate rated it unreliable, so a real job would stop before judging")})`).join("; ")}.` : ""}`, "");
  L.push("## Headline: does the model rank windows the way viewers replay them?", "");
  L.push("AUC is the chance that a window viewers replayed more than the video's median scores higher than one they replayed less (0.5 is a coin flip). Spearman rho is the rank correlation with replay intensity. Mean over videos, 95% bootstrap interval.", "");
  L.push("| Method | windows | n videos | AUC (95% CI) | Spearman rho (95% CI) |", "|---|---|---|---|---|");
  const names = { random: "random (mean of 200 seeds)", energy: "energy: loudness and pace, no words", prescore: "Selects stage 1 rules (pre-score)", gemma4: "**Gemma 4 26B-A4B** (Gemini API)", qwen: "qwen2.5 0.5B (local)" };
  for (const set of ["R", "all"]) for (const m of ["random", "energy", "prescore", "gemma4", "qwen"]) {
    const a = A.rank[`${m}|${set}`];
    if (a) L.push(`| ${names[m]} | ${set === "R" ? "random sample R" : "all windows"} | ${a.n} | ${ci(a.auc)} | ${ci(a.rho)} |`);
  }
  L.push("");
  L.push("## Pre-registered hypotheses", "");
  L.push("| | Hypothesis | n | effect (95% CI) | p | p (Holm) | result |", "|---|---|---|---|---|---|---|");
  for (const h of ["H1", "H2", "H3", "H4", "H5", "H6"]) {
    const t = A.tests[h];
    if (!t || t.p == null) { L.push(`| ${h} | ${t?.label ?? ""} | 0 | not run | | | |`); continue; }
    const p = t.pHolm ?? t.p;
    const verdict = p < 0.05 && t.mean > 0 ? "supported" : p < 0.05 && t.mean < 0 ? "opposite direction" : "not supported at this n";
    L.push(`| ${h} | ${t.label} | ${t.n} | ${t.ci ? ci(t.ci, f3) : f3(t.mean)} | ${pv(t.p)} | ${t.pHolm != null ? pv(t.pHolm) : "-"} | ${verdict} |`);
  }
  if (prefer) {
    for (const k of ["vs-random", "vs-prescore"]) {
      const r = prefer[k];
      if (!r) continue;
      L.push(`| ${k === "vs-random" ? "H7" : "H8"} | Raters prefer Selects' top pick ${k === "vs-random" ? "to a random window" : "to the pre-score's top pick"} | ${r.n} decisive of ${r.total} | ${pct(r.p)} (${pct(r.lo)} to ${pct(r.hi)}) | | | ${r.n === 0 ? "no ratings yet" : r.lo > 0.5 ? "supported" : r.hi < 0.5 ? "opposite direction" : "not supported at this n"} |`);
    }
  } else L.push("| H7, H8 | Blind preference test | 0 | waiting for ratings | | | |");
  L.push("", "Effects are mean differences in AUC (H2, H4, H5), AUC minus 0.5 (H1, H3), or hit@3 difference (H6). p is a two-sided sign-flip permutation test over videos; H1 to H4 are Holm-corrected.", "");

  L.push("## Exploratory (not pre-registered)", "");
  L.push("| Analysis | windows | n | AUC (95% CI) | rho (95% CI) |", "|---|---|---|---|---|");
  const ex = [["gemma4:hook", "R", "Gemma 4, hook score alone"], ["gemma4:standalone", "R", "Gemma 4, standalone score alone"], ["gemma4:payoff", "R", "Gemma 4, payoff score alone"], ["gemma4:clarity", "R", "Gemma 4, clarity score alone"], ["gemma4:blend", "R", "Gemma 4 blended with the pre-score (what the app ranks by)"], ["gemma4", "J", "Gemma 4 on the shortlist plus R"], ["prescore", "J", "pre-score on the shortlist plus R"], ["qwen:blend", "R", "qwen 0.5B blended with the pre-score"]];
  for (const [m, set, label] of ex) { const a = A.rank[`${m}|${set}`]; if (a) L.push(`| ${label} | ${set} | ${a.n} | ${ci(a.auc)} | ${ci(a.rho)} |`); }
  if (A.power) L.push("", `Power: at the effects observed here, about ${A.power.gemma4VsChance ?? "n/a"} videos would give 80% power for Gemma 4 against chance, and about ${A.power.gemma4VsPrescore ?? "n/a"} for Gemma 4 against the pre-score (two-sided, alpha 0.05, normal approximation).`);
  L.push("");
  L.push("## Top picks against replay peaks (v1 metric)", "");
  L.push("| Method | n | hit@3 (95% CI) | hit@5 | mean best IoU (95% CI) |", "|---|---|---|---|---|");
  const tn = { random: "random", energy: "energy", prescore: "pre-score over all windows", "prefilter@8": "prefilter alone (8)", "prefilter@16": "prefilter alone (16)", "gemma4@8": "Gemma 4 score only (8)", "gemma4@16": "Gemma 4 score only (16)", "gemma4-blend@16": "Gemma 4 blend (16)", "shipped@8": "**Selects as shipped** (8, blend + listwise)", "shipped@16": "**Selects Smart mode** (16, blend + listwise)", "qwen@16": "qwen 0.5B score only (16)", "ceiling@8": "ceiling: best of the 8", "ceiling@16": "ceiling: best of the 16", ceiling: "ceiling: best of all windows" };
  for (const [k, name] of Object.entries(tn)) { const a = A.top[k]; if (a) L.push(`| ${name} | ${a.n} | ${ci(a.hit3, pct)} | ${pct(a.hit5.mean)} | ${ci(a.miou5)} |`); }
  L.push("");

  // faithful
  const fl = videos.flatMap((v) => (v.faithful || []).map((f) => ({ ...f, video: v.id })));
  if (fl.length) {
    const flagged = fl.filter((f) => f.verdict && f.verdict !== "faithful");
    const w = wilson(flagged.length, fl.length);
    L.push("## Faithful cuts", "", `The check flagged ${flagged.length} of ${fl.length} top picks (${pct(w.p)}, 95% CI ${pct(w.lo)} to ${pct(w.hi)}) as "check" or "misleading". By issue: ${Object.entries(flagged.reduce((m, f) => ((m[f.issue || "none"] = (m[f.issue || "none"] || 0) + 1), m), {})).map(([k, n]) => `${k} ${n}`).join(", ") || "none"}. Its precision is not measured yet: it needs a person to mark the sample in eval/results/faithful-review.md.`, "");
  }

  // cost
  L.push("## Cost and time", "");
  const calls = videos.reduce((s, v) => s + (v.calls?.gemma4?.n || 0), 0);
  L.push(`Gemma 4 through the Gemini API: ${calls} fresh calls logged, free tier, $0. Rate-limited to 28 requests a minute. See the per-video \`calls\` in results-v2.json.`, "");

  // best and worst
  const withShip = videos.filter((v) => v.rank.gemma4?.R?.auc != null).sort((a, b) => b.rank.gemma4.R.auc - a.rank.gemma4.R.auc);
  if (withShip.length) {
    L.push("## Best and worst videos for Gemma 4 (AUC on R)", "");
    for (const v of [withShip[0], withShip[withShip.length - 1]]) {
      const t = v.top["shipped@16"]?.picks?.[0];
      L.push(`- **${v.title}** (${v.channel}): AUC ${f2(v.rank.gemma4.R.auc)}, pre-score ${f2(v.rank.prescore.R.auc)}.${t ? ` Selects' top pick, ${mmss(t.start)} to ${mmss(t.end)}: "${(t.hook || "").slice(0, 140)}"${t.reason ? ` Gemma: "${t.reason}"` : ""}` : ""}`);
    }
    L.push("");
  }

  L.push("## Per video", "");
  L.push("| Video | windows | punctuation restored | Gemma 4 AUC (R) | pre-score AUC (R) | energy AUC (R) | shipped hit@3 |", "|---|---|---|---|---|---|---|");
  for (const v of videos) L.push(`| [${v.title.replace(/\|/g, "/").slice(0, 55)}](${v.url}) | ${v.nWindows} | ${v.punctuation ? "yes" : "no"} | ${f2(v.rank.gemma4?.R?.auc)} | ${f2(v.rank.prescore?.R?.auc)} | ${f2(v.rank.energy?.R?.auc)} | ${v.top["shipped@16"] ? v.top["shipped@16"].hit3 : "n/a"} |`);
  L.push("");

  L.push("## Caveats", "");
  L.push("- **Most Replayed is a proxy** for what people rewatch or seek to. It is not a judgement of which moment makes the best short, and replays cluster around visual moments an audio-only picker cannot see.");
  L.push("- **The heatmap is coarse:** about 100 segments per video, so each value covers 9 to 54 s of the full video. Window intensities that overlap the same segments are not independent.");
  L.push("- **R is a random sample of 24 windows per video** outside the shortlists, so model AUCs measure ranking across the whole talk, not only among the strong candidates. AUC among the shortlist alone (column J in results-v2.json) is reported separately.");
  L.push("- **Videos are not a random sample of talks.** They are the CC BY videos with heatmaps that YouTube search returned, filtered to English audio.");
  const byCountry = videos.reduce((m, v) => { const c = CHANNEL_COUNTRY[v.id] || "not recorded"; m[c] = (m[c] || 0) + 1; return m; }, {});
  L.push(`- **Where the channels are based** (the country on each channel's YouTube About page, checked 21 Oct 2026; for the five channels that list none, where the organisation is): ${Object.entries(byCountry).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c, n]) => `${c} ${n}`).join(", ")}. Four of the ${videos.length} videos have African speakers: two Nigerian channels, a University of Ghana lecture, and a Nigerian news commentary on a channel registered in the United States. No Kenyan channel is in the final set; the one candidate (3MenArmy Kenya) was excluded before judging because its transcript failed the quality gate.`);
  L.push("- **n videos is the unit of inference.** Per-window AUCs are averaged within a video first, so long videos do not count more.");
  L.push("- Gemma 3 4B is not in v2: at about 75 s per window on this laptop it could not judge 40 windows for 20 videos in time. v1 has its numbers.");
  L.push("");
  if (v1) L.push("## v1 (16 Oct, n = 6, hit@k only)", "", v1, "");
  return L.join("\n");
}

// ---------- main ----------
async function main() {
  const manifest = readJson(join(EVAL, "datasets", "manifest.json"), []);
  let todo = [...manifest].sort((a, b) => a.id.localeCompare(b.id));
  if (ONLY) todo = todo.filter((v) => ONLY.includes(v.id));
  if (LIMIT) todo = todo.slice(0, LIMIT);
  const C = await core();
  const phases = REPORT_ONLY ? ["report"] : PHASE ? [PHASE] : ["prep", "gemini", "report"];
  log(`v2: ${todo.length} videos, phases ${phases.join(", ")}, prompt ${C.promptVersion}`);
  const preps = new Map();
  const excluded = [];
  for (const v of todo) {
    try {
      const P = phases.includes("prep") || !REPORT_ONLY ? await prep(v, C) : readJson(join(CACHE, v.id, "v2", "prep.json"));
      if (!P) continue;
      if (P.exclude) { excluded.push({ id: v.id, reason: P.exclude }); continue; }
      preps.set(v.id, P);
    } catch (e) { log(`${v.id}: prep failed: ${e.message}`); }
  }
  if (phases.length === 1 && phases[0] === "prep") return log("prep done");
  const evals = [];
  for (const v of todo.filter((x) => preps.has(x.id))) {
    try {
      const phase = phases.includes("gemini") ? "gemini" : phases.includes("qwen") ? "qwen" : "report";
      const { out, W } = await evaluate(v, C, preps.get(v.id), phase);
      out.calls = callStats(v.id);
      evals.push({ out, W });
      log(`${v.id}: gemma4 AUC(R) ${f2(out.rank.gemma4?.R?.auc)}, prescore ${f2(out.rank.prescore?.R?.auc)}, energy ${f2(out.rank.energy?.R?.auc)}`);
    } catch (e) { log(`${v.id}: ${e.message}`); }
    writeOut(evals, excluded);
  }
  if (phases.includes("pairs") || phases.includes("gemini")) {
    const pairs = buildPairs(evals, C);
    writeJson(join(OUT, "prefer-pairs.json"), pairs);
    cutPairAudio(pairs, manifest);
    log(`${pairs.length} preference pairs written`);
  }
  writeFaithfulReview(evals);
  writeOut(evals, excluded);
  log("done");
}

function callStats(id) {
  const f = join(CACHE, id, "v2", "judge", "judge-calls.jsonl");
  if (!existsSync(f)) return {};
  const rows = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const g = rows.filter((r) => r.model === GEMMA4_LABEL);
  const q = rows.filter((r) => r.model === QWEN);
  const s = (rs) => ({ n: rs.length, wallSec: mean(rs.map((r) => r.wallSec).filter(Number.isFinite)), promptTokens: mean(rs.map((r) => r.promptTokens).filter(Number.isFinite)), outTokens: mean(rs.map((r) => r.outTokens).filter(Number.isFinite)) });
  return { gemma4: s(g), qwen: s(q) };
}

function preferResults() {
  const pairs = readJson(join(OUT, "prefer-pairs.json"), []);
  const f = join(OUT, "prefer-ratings.jsonl");
  if (!pairs.length || !existsSync(f)) return null;
  const rows = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // latest answer per rater and pair
  const last = new Map();
  for (const r of rows) last.set(`${r.rater}|${r.pair}`, r);
  const out = {};
  for (const kind of ["vs-random", "vs-prescore"]) {
    let win = 0, lose = 0, neither = 0;
    for (const r of last.values()) {
      const p = pairs.find((x) => x.id === r.pair);
      if (!p || p.kind !== kind) continue;
      if (r.choice === "neither") neither++;
      else if (r.choice === p.selectsSide) win++;
      else lose++;
    }
    const w = wilson(win, win + lose);
    out[kind] = { ...w, n: win + lose, total: win + lose + neither, win, lose, neither, raters: new Set([...last.values()].map((r) => r.rater)).size };
  }
  return out;
}

function writeFaithfulReview(evals) {
  const all = evals.flatMap(({ out }) => (out.faithful || []).map((f) => ({ ...f, video: out.id, title: out.title })));
  const flagged = all.filter((f) => f.verdict && f.verdict !== "faithful");
  const clean = all.filter((f) => f.verdict === "faithful");
  const g = rng(31);
  const pickN = (xs, n) => xs.map((x) => [g(), x]).sort((a, b) => a[0] - b[0]).slice(0, n).map((x) => x[1]);
  const sample = [...pickN(flagged, 10), ...pickN(clean, 20 - Math.min(10, flagged.length))].map((x) => [g(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  writeJson(join(OUT, "faithful-sample.json"), sample);
  const L = ["# Faithful cuts: is the check right?", "", "For each clip, read the quote and decide whether it, cut out on its own, still says what the speaker meant. Then fill in the last line with **right** (the check's verdict is correct) or **wrong**. The check's verdict is shown so you can judge it; try to decide what you think first.", ""];
  sample.forEach((f, i) => {
    L.push(`## ${i + 1}. ${f.title} (${mmss(f.start)} to ${mmss(f.end)})`, "", f.before ? `Just before (not in the clip): *${f.before}*` : "", "", `> ${f.text}`, "", f.after ? `Just after (not in the clip): *${f.after}*` : "", "", `Check says: **${f.verdict}**${f.issue ? ` (${f.issue})` : ""}${f.note ? `: ${f.note}` : ""}`, "", "Your mark (right or wrong): ", "");
  });
  writeFileSync(join(OUT, "faithful-review.md"), L.join("\n"));
}

function writeOut(evals, excluded) {
  const videos = evals.map((e) => e.out);
  const A = aggregate(videos);
  const prefer = preferResults();
  const v1 = existsSync(join(OUT, "RESULTS-v1.md")) ? `See [RESULTS-v1.md](RESULTS-v1.md) for the full v1 report. Its headline: the shipped 8-window shortlist could reach at most 67% hit@3, and no judge beat the prefilter alone at that n.` : null;
  writeJson(join(OUT, "results-v2.json"), { generatedAt: new Date().toISOString(), plan: "eval/PLAN.md", settings: SETTINGS, ns: NS, rSize: R_SIZE, rSeed: R_SEED, model: GEMMA4, excluded, aggregate: A, prefer, videos });
  writeFileSync(join(OUT, "RESULTS.md"), report(videos, A, { excluded, prefer, v1 }));
}

export { aggregate, buildPairs, windowsFor };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
