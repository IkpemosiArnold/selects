#!/usr/bin/env node
// Where a person's own picks rank, with and without the hearing judge, on one recording.
// Made for a private recording: everything it writes goes to --out (keep that outside the
// repo), the audio is only decoded on this computer, and the only thing that leaves it is the
// text of shortlisted windows, for the Smart mode text judge (as the app sends it).
//
//   node eval/hear-picks.mjs --job <job dir> --picks <picks.json> --out <dir> --phase prep
//        --phase cues      the cheap listener over the whole recording (local)
//        --phase gemma3n   Gemma 3n over the whole recording (local, slow)
//        --phase text      the text judge on the shortlists (Gemini API, text only)
//        --report          ranks and hits, from the caches only
//
// The metric (written before the hearing judge ran): <out>/METRIC.md. In short: rank every
// candidate window, turn the ranking into distinct clips (NMS, iou 0.3), and find the first
// clip that covers half of each pick (or starts and ends within 10 s of it).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { selectCandidates, loopExclusions } from "../src/core/select.mjs";
import { transcriptQuality } from "../src/core/quality.mjs";
import { shortlist } from "../src/core/candidates.mjs";
import { rank } from "../src/core/rank.mjs";
import { blend } from "../src/core/judge-core.mjs";
import { hearGrid, windowHearing, preWithHearing, blendWithHearing, HEAR_BLEND } from "../src/core/hear-core.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const PHASE = args.includes("--report") ? "report" : arg("--phase", "report");
const JOB = arg("--job");
const OUT = arg("--out");
const PICKS = arg("--picks");
const MODEL = "gemini/gemma-4-26b-a4b-it";
const readJson = (f, d = null) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!JOB || !OUT || !PICKS) {
  console.error("Usage: node eval/hear-picks.mjs --job <job dir> --picks <picks.json> --out <dir> [--phase prep|cues|gemma3n|text | --report]");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const job = readJson(join(JOB, "job.json"));
const source = job.source.path;
const duration = job.source.duration;

/** A clip matches a pick when it covers half of it, or starts and ends within 10 s of it. */
export function matches(clip, pick) {
  const inter = Math.max(0, Math.min(clip.end, pick.end) - Math.max(clip.start, pick.start));
  return inter >= 0.5 * (pick.end - pick.start) || (Math.abs(clip.start - pick.start) <= 10 && Math.abs(clip.end - pick.end) <= 10);
}

function windowsFile() {
  return join(OUT, "windows.json");
}

async function prep() {
  const words = readJson(join(JOB, "words.json"));
  const whisperEvents = readJson(join(JOB, "events.json"), []);
  const loudness = readJson(join(JOB, "loudness.json"), null);
  const { ensureSound } = await import("../src/core/sound-node.mjs");
  const { speechOnly } = await import("../src/core/nonspeech.mjs");
  const t0 = Date.now();
  const sound = await ensureSound(OUT, source, { words: speechOnly(words), duration });
  log(`sound: ${sound.by}, ${sound.events.length} events, ${sound.events.filter((e) => e.type === "laughter").length} laughter (${((Date.now() - t0) / 1000).toFixed(0)} s, cached after the first run)`);
  const events = [...whisperEvents, ...sound.events].sort((a, b) => a.s - b.s);
  const exclude = loopExclusions(transcriptQuality(words, { duration }));
  const sel = selectCandidates({ words, events, loudness, settings: { minLen: 20, maxLen: 60, stride: 6, k: 5 }, duration, judge: { secPerCall: 3 }, exclude });
  const usable = exclude.length ? sel.windows.filter((w) => !exclude.some((x) => w.start < x.e && w.end > x.s)) : sel.windows;
  const slim = (w) => ({ id: w.id, start: w.start, end: w.end, pre: w.pre, text: w.text, hook: w.hook, ...(w.cueText ? { cueText: w.cueText } : {}), ...(w.meanP != null ? { meanP: w.meanP } : {}), ...(w.peak ? { peak: w.peak } : {}) });
  writeFileSync(windowsFile(), JSON.stringify({ judgeN: sel.judgeN, windows: usable.map(slim), shortlistT: sel.shortlist.map((c) => c.id) }));
  log(`windows: ${usable.length} usable of ${sel.windows.length}; text shortlist ${sel.shortlist.length} (judgeN ${sel.judgeN.n})`);
}

async function listen(listener) {
  const { hearStretches } = await import("../src/core/hear-node.mjs");
  const sound = readJson(join(OUT, "sound.json"));
  const grid = hearGrid(duration);
  const t0 = Date.now();
  const rows = await hearStretches(OUT, source, grid, {
    listener,
    soundFrames: sound?.frames ?? null,
    onProgress: (p) => p.done % 10 === 0 && log(`${listener}: ${p.done} of ${p.total} stretches, ${p.secPer} s each`),
  });
  writeFileSync(join(OUT, `scores-${listener}.json`), JSON.stringify(rows.map((r) => ({ s: r.s, e: r.e, score: r.score, ...(r.sec != null ? { sec: r.sec } : {}), ...(r.top != null ? { top: r.top } : {}), ...(r.laugh != null ? { laugh: r.laugh, overlap: r.overlap, loudSpread: r.loudSpread } : {}) }))));
  log(`${listener}: ${rows.length} stretches scored in ${((Date.now() - t0) / 1000).toFixed(0)} s this run`);
}

/** The shortlists the text judge reads: T (the app's) and, per listener, F (drawn with hearing). */
function shortlists(W, hearBy) {
  const n = W.judgeN.n;
  const out = { T: W.shortlistT };
  for (const [listener, scores] of Object.entries(hearBy)) {
    const ws = W.windows.map((w) => ({ ...w, hear: windowHearing(w, scores) }));
    const mixed = ws.map((w) => ({ ...w, pre: preWithHearing(w.pre, w.hear) }));
    out[listener] = shortlist(mixed, { n, duration }).map((c) => c.id);
  }
  return out;
}

function hearingScores() {
  const by = {};
  for (const l of ["cues", "gemma3n"]) {
    const s = readJson(join(OUT, `scores-${l}.json`));
    if (s?.length && s.every((r) => typeof r.score === "number")) by[l] = s;
  }
  return by;
}

async function text() {
  const W = readJson(windowsFile());
  const lists = shortlists(W, hearingScores());
  const ids = [...new Set(Object.values(lists).flat())];
  const byId = new Map(W.windows.map((w) => [w.id, w]));
  const { judge } = await import("../src/core/judge.mjs");
  const { geminiKey, geminiRequest, rateLimiter } = await import("./llm-gemini.mjs");
  const { JUDGE_SCHEMA } = await import("../src/core/judge-core.mjs");
  const key = geminiKey(ROOT) || geminiKey(resolve(ROOT, "..", "selects"));
  const ask = geminiRequest({ key, schema: JUDGE_SCHEMA, maxTokens: 300, limiter: rateLimiter({ rpm: 12, tpm: 12000 }) });
  const cands = ids.map((id) => byId.get(id)).map((w) => ({ id: w.id, start: w.start, end: w.end, text: w.text, hook: w.hook, pre: w.pre, ...(w.cueText ? { cueText: w.cueText } : {}) }));
  log(`text judge: ${cands.length} shortlisted windows (T ${lists.T.length}${Object.keys(lists).filter((k) => k !== "T").map((k) => `, F-${k} ${lists[k].length}`).join("")})`);
  const judged = await judge(cands, { model: MODEL, cacheDir: OUT, request: ask, onProgress: (p) => p.done % 10 === 0 && log(p.note) });
  writeFileSync(join(OUT, "judged.json"), JSON.stringify(judged.map((c) => ({ id: c.id, judgeTotal: c.judgeTotal, scores: c.scores, why: c.why }))));
}

/** Rank `scored` ([{ ..., total }]) into distinct clips and find each pick. */
function pickRanks(scored, picks) {
  const ranked = rank(scored, { k: scored.length, iou: 0.3 });
  return {
    ranked,
    ranks: picks.map((p) => {
      const c = ranked.find((x) => matches(x, p));
      return c ? c.rank : null;
    }),
  };
}

const summary = (ranks) => ({
  top5: ranks.filter((r) => r != null && r <= 5).length,
  top10: ranks.filter((r) => r != null && r <= 10).length,
  mrr: +(ranks.reduce((s, r) => s + (r ? 1 / r : 0), 0) / ranks.length).toFixed(3),
});

async function report() {
  const W = readJson(windowsFile());
  const picksFile = readJson(PICKS);
  const picks = picksFile.picks;
  const others = picksFile.others || [];
  const judged = new Map((readJson(join(OUT, "judged.json")) || []).map((c) => [c.id, c]));
  const hearBy = hearingScores();
  const lists = shortlists(W, hearBy);
  const arms = {};
  // T: judged shortlist by the 0.7/0.3 blend, everything else below it by pre-score
  const inT = new Set(lists.T);
  const missingT = lists.T.filter((id) => !judged.has(id)).length;
  arms.T = W.windows.map((w) => (inT.has(w.id) && judged.has(w.id) ? { ...w, total: 1 + blend(judged.get(w.id).judgeTotal, w.pre) } : { ...w, total: w.pre }));
  arms.pre = W.windows.map((w) => ({ ...w, total: w.pre }));
  for (const [l, scores] of Object.entries(hearBy)) {
    const ws = W.windows.map((w) => ({ ...w, hear: windowHearing(w, scores) }));
    arms[`H-${l}`] = ws.map((w) => ({ ...w, total: w.hear ?? 0 }));
    const inF = new Set(lists[l]);
    arms[`F-${l}`] = ws.map((w) => {
      const pre2 = preWithHearing(w.pre, w.hear);
      if (inF.has(w.id) && judged.has(w.id)) return { ...w, total: 1 + blendWithHearing(judged.get(w.id).judgeTotal, w.pre, w.hear, blend(judged.get(w.id).judgeTotal, w.pre)) };
      return { ...w, total: pre2 };
    });
  }
  const res = {};
  for (const [name, scored] of Object.entries(arms)) {
    const { ranked, ranks } = pickRanks(scored, picks);
    res[name] = { ranks, ...summary(ranks), top10: ranked.slice(0, 10).map((c) => ({ rank: c.rank, start: c.start, end: c.end, total: +c.total.toFixed(3), hook: c.hook, why: judged.get(c.id)?.why ?? null, others: others.filter((o) => matches(c, o)).map((o) => o.id), picks: picks.filter((p) => matches(c, p)).map((p) => p.id) })), hits: summary(ranks) };
  }
  const out = { generatedAt: new Date().toISOString(), windows: W.windows.length, judgeN: W.judgeN.n, missingT, blend: HEAR_BLEND, picks: picks.map((p) => ({ id: p.id, title: p.title, start: p.start, end: p.end })), arms: res };
  writeFileSync(join(OUT, "results.json"), JSON.stringify(out, null, 1));
  const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  const L = ["| Arm | " + picks.map((p) => `${p.id.toUpperCase()} ${p.title}`).join(" | ") + " | top 5 | top 10 | MRR |", "|---" + "|---".repeat(picks.length + 3) + "|"];
  for (const [name, r] of Object.entries(res)) L.push(`| ${name} | ${r.ranks.map((x) => x ?? "not found").join(" | ")} | ${r.top5} | ${r.top10} | ${r.mrr} |`);
  for (const [name, r] of Object.entries(res)) {
    L.push("", `Top 10, ${name}:`);
    for (const c of r.top10) L.push(`${c.rank}. ${mmss(c.start)} to ${mmss(c.end)}${c.picks.length ? ` [${c.picks.join(", ").toUpperCase()}]` : ""}${c.others.length ? ` (also: ${c.others.join(", ")})` : ""}: ${c.why || (c.hook || "").slice(0, 90)}`);
  }
  writeFileSync(join(OUT, "ranks.md"), L.join("\n") + "\n");
  console.log(L.slice(0, Object.keys(res).length + 2).join("\n"));
}

const phases = { prep, cues: () => listen("cues"), gemma3n: () => listen("gemma3n"), text, report };
await phases[PHASE]();
