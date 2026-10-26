#!/usr/bin/env node
// Exploratory, NOT pre-registered: does the social-worthiness judge and the delivery
// features (laughter, raised voices, pace) rank windows by Most Replayed better or worse than
// the v2 rubric? It reuses eval v2 exactly where it can and changes nothing frozen:
//   - the same 19 videos, the same cached transcripts (eval/cache/<id>/v2/prep.json)
//   - the same random sample R per video, rebuilt with the code that made v2 (SELECTS_OLD_CORE,
//     a checkout of the commit v2 ran on), and checked: every R window must hit v2's own
//     judge cache, or the video is reported as not reproduced
//   - the same metric (AUC against above-median replay intensity, per video, then the mean
//     with a 95% percentile bootstrap over videos, 10,000 resamples, seed 7), and a sign-flip
//     test on the paired per-video differences. No Holm correction: none of this is a
//     pre-registered hypothesis, and the report says so.
// New here: Gemma 4 26B (the Smart mode judge) with the new rubric on the R windows, the new
// pre-score, and their 0.7/0.3 blend, with the sound events of each video's first 15 minutes.
//
//   SELECTS_OLD_CORE=<checkout> node eval/explore-exciting.mjs --phase sound   YAMNet over the cuts (local)
//   SELECTS_OLD_CORE=<checkout> node eval/explore-exciting.mjs --phase judge   new judge on R (Gemini, free tier)
//   SELECTS_OLD_CORE=<checkout> node eval/explore-exciting.mjs --report        report from caches only
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { auc, aboveMedian, bootstrapCI, mean, rng, signFlipTest } from "./metrics.mjs";
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
const jc = await imp(ROOT, "judge-core.mjs");

/** R exactly as eval v2 drew it (run-eval-v2.mjs windowsFor), from the old code. */
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
  const R = pool.map((w) => [r(), w]).sort((a, b) => a[0] - b[0]).slice(0, R_SIZE).map((x) => x[1]).sort((a, b) => a.start - b.start);
  return { R, heat };
}

/** The new pipeline's view of the same stretches: its windows (with delivery, cue marks and the new pre-score), matched by start and end. */
function newWindows(P, soundEvents) {
  const events = [...(P.events || []), ...(soundEvents || [])].sort((a, b) => a.s - b.s);
  // stride 0: every sentence start, so every v2 window is among them (a window's pre-score and
  // marks do not depend on which other windows exist)
  const s = sel.selectCandidates({ words: P.words, events, loudness: P.loudness, settings: { ...SETTINGS, stride: 0, judgeN: 16 }, duration: P.end });
  return new Map(s.windows.map((w) => [`${w.start}|${w.end}`, w]));
}

async function main() {
  const manifest = readJson(join(EVAL, "datasets", "manifest.json"), []);
  const v2 = readJson(join(OUT, "results-v2.json"));
  const ids = v2.videos.map((v) => v.id).filter((id) => !ONLY || ONLY.includes(id));
  const limiter = rateLimiter({ rpm: 12, tpm: 12000 });
  const key = PHASE === "judge" ? geminiKey(ROOT) || geminiKey(resolve(ROOT, "..", "selects")) : null;
  const rows = [];
  for (const id of ids) {
    const v = manifest.find((m) => m.id === id);
    const P = readJson(join(CACHE, id, "v2", "prep.json"));
    if (!v || !P) {
      log(`${id}: no v2 cache, skipped`);
      continue;
    }
    const dir = join(CACHE, id, "explore-exciting");
    mkdirSync(dir, { recursive: true });
    // sound events of the first 15 minutes (the cut v2 transcribed)
    let sound = readJson(join(dir, "sound.json"));
    if (!sound && PHASE === "sound") {
      const { ensureSound } = await imp(ROOT, "sound-node.mjs");
      const cut = join(CACHE, id, "v2", `cut-0-${Math.round(P.end)}${v.localPath.slice(v.localPath.lastIndexOf("."))}`);
      sound = await ensureSound(dir, existsSync(cut) ? cut : resolve(ROOT, v.localPath), { words: P.words, duration: P.end });
      log(`${id}: sound ${sound.by}, ${sound.events.length} events (${sound.events.filter((e) => e.type === "laughter").length} laughter) in ${sound.sec} s`);
    }
    if (PHASE === "sound") continue;
    const { R } = oldWindows(v, P);
    // the old judge's answers for R, from v2's own cache: every one must be there
    const oldCache = readJson(join(CACHE, id, "v2", "judge", "judge-cache.json"), {});
    const oldVer = oldJudge.loadPrompt().version;
    const oldHits = R.map((w) => oldCache[sha1(`${MODEL}|${oldVer}|${w.text.trim()}`)]);
    if (oldHits.some((h) => !h)) {
      log(`${id}: R not reproduced (${oldHits.filter((h) => !h).length} of ${R.length} windows missing from v2's cache), skipped`);
      continue;
    }
    const nw = newWindows(P, sound?.events);
    const RR = R.map((w, i) => {
      const n = nw.get(`${w.start}|${w.end}`);
      return { ...w, oldJudge: oldJudge.combine(oldHits[i].scores), oldPre: w.pre, newPre: n?.pre ?? null, cueText: n?.cueText ?? null };
    });
    // the new judge on the same windows, with the same marks the app would send
    let judged = null;
    const ask = PHASE === "judge" ? geminiRequest({ key, schema: jc.JUDGE_SCHEMA, maxTokens: 300, limiter }) : async () => { throw new Error("not cached"); };
    try {
      judged = await jd.judge(RR.map((w) => ({ id: w.id, start: w.start, end: w.end, text: w.text, hook: w.hook, pre: w.newPre, ...(w.cueText ? { cueText: w.cueText } : {}) })), { model: MODEL, cacheDir: dir, request: ask });
    } catch (e) {
      log(`${id}: new judge not complete (${e.message.slice(0, 60)})`);
    }
    const y = RR.map((w) => w.intensity);
    const pos = aboveMedian(y);
    const A = (s) => (s.some((x) => x == null) ? null : auc(s, pos));
    const row = {
      id,
      n: RR.length,
      marked: RR.filter((w) => w.cueText).length,
      laughter: (sound?.events || []).filter((e) => e.type === "laughter").length,
      sound: sound?.by ?? null,
      oldJudge: A(RR.map((w) => w.oldJudge)),
      oldBlend: A(RR.map((w) => jc.blend(w.oldJudge, w.oldPre))),
      oldPre: A(RR.map((w) => w.oldPre)),
      newPre: A(RR.map((w) => w.newPre)),
      newJudge: judged ? A(judged.map((c) => c.judgeTotal)) : null,
      newBlend: judged ? A(judged.map((c) => c.total)) : null,
    };
    rows.push(row);
    log(`${id}: AUC old judge ${row.oldJudge?.toFixed(2)}, new judge ${row.newJudge?.toFixed(2) ?? "n/a"}, old pre ${row.oldPre?.toFixed(2)}, new pre ${row.newPre?.toFixed(2)}`);
  }
  if (PHASE === "sound") return;
  const agg = {};
  for (const k of ["oldJudge", "newJudge", "oldBlend", "newBlend", "oldPre", "newPre"]) {
    const xs = rows.map((r) => r[k]).filter((x) => x != null);
    agg[k] = { ...bootstrapCI(xs, { iters: 10000, seed: 7 }), n: xs.length };
  }
  const paired = (a, b) => {
    const rs = rows.filter((r) => r[a] != null && r[b] != null);
    const d = rs.map((r) => r[a] - r[b]);
    return { n: d.length, ...signFlipTest(d), ci: bootstrapCI(d, { iters: 10000, seed: 7 }) };
  };
  const tests = { judge: paired("newJudge", "oldJudge"), blend: paired("newBlend", "oldBlend"), pre: paired("newPre", "oldPre") };
  const out = { generatedAt: new Date().toISOString(), note: "Exploratory, not pre-registered (eval/PLAN.md is unchanged). R rebuilt with the v2 code and checked against v2's cache.", model: GEMMA4, rows, aggregate: agg, tests };
  writeFileSync(join(OUT, "explore-exciting.json"), JSON.stringify(out, null, 2) + "\n");
  writeFileSync(join(OUT, "EXPLORE-exciting.md"), report(out));
  log("written eval/results/explore-exciting.json and EXPLORE-exciting.md");
}

const f2 = (x) => (x == null || Number.isNaN(x) ? "n/a" : x.toFixed(2));
const ci = (c) => (!c || c.mean == null ? "n/a" : `${f2(c.mean)} (${f2(c.lo)} to ${f2(c.hi)})`);
const pv = (p) => (p == null ? "n/a" : p < 0.001 ? "< 0.001" : p.toFixed(3));

export function report(o) {
  const A = o.aggregate;
  const L = ["# Exploratory: the social-worthiness judge against Most Replayed", ""];
  L.push(`Generated ${o.generatedAt.slice(0, 16).replace("T", " ")} UTC by \`node eval/explore-exciting.mjs --report\`. **Not pre-registered.** The v2 plan, hypotheses and thresholds ([PLAN.md](../PLAN.md)) are unchanged, and nothing here replaces a v2 result. Same videos, same random sample R per video (rebuilt with the v2 code and checked against v2's own judge cache), same AUC, same bootstrap (10,000 resamples, seed 7). Judge: ${o.model} through the Gemini API, free tier.`, "");
  L.push("| Method | n videos | AUC on R (95% CI) |", "|---|---|---|");
  const names = { oldJudge: "v2 rubric, Gemma 4 score only", newJudge: "new rubric, Gemma 4 score only", oldBlend: "v2: 0.7 judge + 0.3 v2 pre-score", newBlend: "new: 0.7 judge + 0.3 new pre-score", oldPre: "v2 pre-score", newPre: "new pre-score (with delivery)" };
  for (const k of Object.keys(names)) L.push(`| ${names[k]} | ${A[k].n} | ${ci(A[k])} |`);
  L.push("", "| Paired difference (new minus v2) | n | mean (95% CI) | sign-flip p |", "|---|---|---|---|");
  for (const [k, label] of [["judge", "judge score"], ["blend", "blend"], ["pre", "pre-score"]]) {
    const t = o.tests[k];
    L.push(`| ${label} | ${t.n} | ${ci(t.ci)} | ${pv(t.p)} |`);
  }
  const marked = o.rows.reduce((s, r) => s + r.marked, 0);
  const n = o.rows.reduce((s, r) => s + r.n, 0);
  L.push("", `Sound: ${o.rows.filter((r) => r.sound === "yamnet").length} of ${o.rows.length} videos analysed with YAMNet; ${o.rows.reduce((s, r) => s + r.laughter, 0)} laughter events in all; ${marked} of ${n} R windows carried a "(laughter)" or "(louder)" mark.`, "");
  L.push("Caveats: Most Replayed measures what viewers rewatch in a long video, not what makes a good short; most of these 19 videos are talks and lectures, where the new rubric's target (laughs, banter, hot takes) is rare. A null result here does not show the new judge is worse at picking posts, and a positive one does not show it is better at that. The new rubric was written after a person named the moments they would post from one private recording; that recording is not part of this set.");
  return L.join("\n") + "\n";
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
