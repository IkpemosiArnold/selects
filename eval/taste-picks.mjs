#!/usr/bin/env node
// Leave one pick out: does the taste model (src/core/taste.mjs), fitted on a person's other
// picks and some skips, rank their held-out pick higher than the generic ranking does?
// Made for a private recording: it reads the windows, cached judge answers and cues that
// eval/hear-picks.mjs left in --data, and writes only to --out (keep both outside the repo).
// It sends nothing anywhere and decodes no audio.
//
//   node eval/taste-picks.mjs --job <job dir> --picks <picks.json> --data <hear-picks out> --out <dir>
//
// The protocol (written before the first run) is <out>/PROTOCOL.md. In short: for each held-out
// pick, Posts are the best window of each other pick, Skips are 9 judged windows drawn at random
// from those that touch no pick and no unlabelled shortlisted moment; 50 seeds; the held-out
// pick's rank is found as in METRIC.md (NMS iou 0.3, half-cover or within 10 s).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { selectCandidates, loopExclusions } from "../src/core/select.mjs";
import { transcriptQuality } from "../src/core/quality.mjs";
import { rank } from "../src/core/rank.mjs";
import { blend } from "../src/core/judge-core.mjs";
import { windowHearing } from "../src/core/hear-core.mjs";
import { applyTaste, labelRecord, TASTE_RULE, tasteLogit, trainTaste } from "../src/core/taste.mjs";
import { rng } from "./metrics.mjs";

const args = process.argv.slice(2);
const arg = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const JOB = arg("--job");
const DATA = arg("--data");
const OUT = arg("--out");
const PICKS = arg("--picks");
const SEEDS = Number(arg("--seeds", 50));
const N_SKIPS = 9;
const readJson = (f, d = null) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!JOB || !DATA || !OUT || !PICKS) {
  console.error("Usage: node eval/taste-picks.mjs --job <job dir> --picks <picks.json> --data <hear-picks out> --out <dir> [--seeds 50]");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

/** A clip matches a pick when it covers half of it, or starts and ends within 10 s of it (METRIC.md). */
export function matches(clip, pick) {
  const inter = Math.max(0, Math.min(clip.end, pick.end) - Math.max(clip.start, pick.start));
  return inter >= 0.5 * (pick.end - pick.start) || (Math.abs(clip.start - pick.start) <= 10 && Math.abs(clip.end - pick.end) <= 10);
}
const overlaps = (a, b) => Math.min(a.end, b.end) > Math.max(a.start, b.start);
const tiou = (a, b) => {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return inter / (Math.max(a.end, b.end) - Math.min(a.start, b.start));
};

function load() {
  const job = readJson(join(JOB, "job.json"));
  const duration = job.source.duration;
  const W = readJson(join(DATA, "windows.json"));
  // delivery features, recomputed as hear-picks.mjs prep made the windows (no audio decoded)
  const words = readJson(join(JOB, "words.json"));
  const sound = readJson(join(DATA, "sound.json"));
  const events = [...readJson(join(JOB, "events.json"), []), ...(sound?.events || [])].sort((a, b) => a.s - b.s);
  const loudness = readJson(join(JOB, "loudness.json"), null);
  const exclude = loopExclusions(transcriptQuality(words, { duration }));
  const sel = selectCandidates({ words, events, loudness, settings: { minLen: 20, maxLen: 60, stride: 6, k: 5 }, duration, judge: { secPerCall: 3 }, exclude });
  const fresh = new Map(sel.windows.map((w) => [`${w.start}|${w.end}`, w]));
  const judged = new Map((readJson(join(DATA, "judged.json")) || []).map((c) => [c.id, c]));
  const cues = readJson(join(DATA, "scores-cues.json"), null);
  const inT = new Set(W.shortlistT);
  let missing = 0;
  const windows = W.windows.map((w) => {
    const f = fresh.get(`${w.start}|${w.end}`);
    if (!f) missing++;
    const j = judged.get(w.id);
    return {
      id: w.id,
      start: w.start,
      end: w.end,
      pre: w.pre,
      ...(f?.delivery ? { delivery: f.delivery } : {}),
      ...(w.peak ? { peak: w.peak } : {}),
      ...(j ? { scores: j.scores, judgeTotal: j.judgeTotal } : {}),
      judged: !!j,
      inT: inT.has(w.id),
      hearScore: cues ? windowHearing(w, cues) : null,
    };
  });
  const picksFile = readJson(PICKS);
  return { windows, picks: picksFile.picks, others: picksFile.others || [], missing, why: judged };
}

/** G: the T shortlist's judged windows by 0.7 judge + 0.3 pre, above all others, which go by pre. */
const generic = (w) => (w.inT && w.judged ? 1 + blend(w.judgeTotal, w.pre) : w.pre);

/** The candidate the taste model sees: judge scores only when judged, hearing only in the hearing arm. */
const asCand = (w, { hear = false, judge = true } = {}) => ({ id: w.id, start: w.start, end: w.end, pre: w.pre, delivery: w.delivery, peak: w.peak, ...(judge && w.scores ? { scores: w.scores } : {}), hear: hear ? w.hearScore : null, total: w.inT && w.judged ? blend(w.judgeTotal, w.pre) : null });

/** The held-out pick's rank in a scored list ({...w, total}), as METRIC.md finds it. */
function pickRank(scored, pick, iou) {
  // rank()'s order and NMS, walked only as far as the first clip that matches the pick
  const sorted = scored.slice().sort((a, b) => b.total - a.total || (b.pre ?? 0) - (a.pre ?? 0) || a.start - b.start);
  const kept = [];
  for (const c of sorted) {
    if (!kept.every((x) => tiou(x, c) <= iou)) continue;
    kept.push(c);
    if (matches(c, pick)) return kept.length;
  }
  return null;
}

/** The best window for a training pick: judged first, then the highest overlap with the pick. */
function bestWindow(windows, pick) {
  const m = windows.filter((w) => matches(w, pick));
  return m.sort((a, b) => Number(b.judged) - Number(a.judged) || tiou(b, pick) - tiou(a, pick))[0] || null;
}

function arms(windows, model, { weight, hear }) {
  // L: the T shortlist's judged windows reordered by the blend, everything else as in G
  const judgedT = windows.filter((w) => w.inT && w.judged);
  const blended = new Map(applyTaste(judgedT.map((w) => asCand(w, { hear })), model, { weight }).map((c) => [c.id, c]));
  return windows.map((w) => {
    const b = blended.get(w.id);
    return { ...w, total: b ? 1 + (typeof b.order === "number" ? b.order : b.total) : w.pre };
  });
}

async function main() {
  const { windows, picks, others, missing, why } = load();
  log(`${windows.length} windows (${missing} without recomputed delivery), ${windows.filter((w) => w.judged).length} judged, ${windows.filter((w) => w.inT).length} in the T shortlist`);
  const G = windows.map((w) => ({ ...w, total: generic(w) }));
  const res = { generatedAt: new Date().toISOString(), protocol: "PROTOCOL.md", rule: TASTE_RULE, seeds: SEEDS, skipsPerFit: N_SKIPS, picks: [], weights: [] };
  for (const held of picks) {
    const train = picks.filter((p) => p !== held);
    const posts = train.map((p) => bestWindow(windows.filter((w) => !overlaps(w, held)), p)).filter(Boolean);
    const pool = windows.filter((w) => w.judged && !picks.some((p) => overlaps(w, p)) && !others.some((o) => matches(w, o)));
    const row = { id: held.id, title: held.title, G: { iou03: pickRank(G, held, 0.3), iou0: pickRank(G, held, 0) }, posts: posts.map((w) => ({ id: w.id, judged: w.judged })), poolSize: pool.length, L: [], Lfull: [], Lhear: [], X: [], weight: null };
    for (let s = 0; s < SEEDS; s++) {
      const r = rng(9000 + s * 31 + held.n);
      const skips = pool.map((w) => [r(), w]).sort((a, b) => a[0] - b[0]).slice(0, N_SKIPS).map((x) => x[1]);
      const fit = (hear) => trainTaste([...posts.map((w) => labelRecord("p", asCand(w, { hear }), "post")), ...skips.map((w) => labelRecord("p", asCand(w, { hear }), "skip"))]);
      const m = fit(false);
      const mh = fit(true);
      row.weight = m.weight;
      if (s === 0) res.weights.push({ held: held.id, w: Object.fromEntries(m.features.map((f, j) => [f, m.w?.[j] ?? 0])) });
      const L = arms(windows, m, { weight: m.weight, hear: false });
      const Lf = arms(windows, m, { weight: TASTE_RULE.maxWeight, hear: false });
      const Lh = arms(windows, mh, { weight: mh.weight, hear: true });
      // X: every window by the taste score alone, from what the app knows before judging
      const X = windows.map((w) => ({ ...w, total: tasteLogit(m, asCand(w, { judge: false })) }));
      row.L.push({ iou03: pickRank(L, held, 0.3), iou0: pickRank(L, held, 0) });
      row.Lfull.push({ iou03: pickRank(Lf, held, 0.3), iou0: pickRank(Lf, held, 0) });
      row.Lhear.push({ iou03: pickRank(Lh, held, 0.3), iou0: pickRank(Lh, held, 0) });
      row.X.push({ iou03: pickRank(X, held, 0.3), iou0: pickRank(X, held, 0) });
    }
    res.picks.push(row);
    log(`${held.id}: G ${row.G.iou03}, L median ${med(row.L.map((x) => x.iou03))}, L-full ${med(row.Lfull.map((x) => x.iou03))}, X ${med(row.X.map((x) => x.iou03))}`);
  }
  // a preview, not a test: all four picks as Posts and the first seed's skips, the new top 10
  const pool = windows.filter((w) => w.judged && !picks.some((p) => overlaps(w, p)) && !others.some((o) => matches(w, o)));
  const r = rng(9000);
  const skips = pool.map((w) => [r(), w]).sort((a, b) => a[0] - b[0]).slice(0, N_SKIPS).map((x) => x[1]);
  const m4 = trainTaste([...picks.map((p) => bestWindow(windows, p)).filter(Boolean).map((w) => labelRecord("p", asCand(w), "post")), ...skips.map((w) => labelRecord("p", asCand(w), "skip"))]);
  const top = rank(arms(windows, m4, { weight: m4.weight, hear: false }), { k: 10, iou: 0 });
  res.preview = { weight: m4.weight, top10: top.map((c) => ({ rank: c.rank, start: c.start, end: c.end, picks: picks.filter((p) => matches(c, p)).map((p) => p.id), others: others.filter((o) => matches(c, o)).map((o) => o.id), why: why.get(c.id)?.why ?? null })) };
  const md = report(res); // also sets res.verdict
  writeFileSync(join(OUT, "results.json"), JSON.stringify(res, null, 1));
  writeFileSync(join(OUT, "RESULTS.md"), md);
  console.log(md);
}

function med(xs) {
  const v = xs.map((x) => (x == null ? Infinity : x)).sort((a, b) => a - b);
  const m = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return m === Infinity ? null : m;
}
const range = (xs) => {
  const v = xs.filter((x) => x != null);
  const nf = xs.length - v.length;
  return v.length ? `${Math.min(...v)} to ${Math.max(...v)}${nf ? `, not found ${nf}x` : ""}` : "not found";
};
const summary = (ranks) => ({
  top5: ranks.filter((r) => r != null && r <= 5).length,
  top10: ranks.filter((r) => r != null && r <= 10).length,
  mrr: +(ranks.reduce((s, r) => s + (r ? 1 / r : 0), 0) / ranks.length).toFixed(3),
});

export function report(res) {
  const L = ["# Taste model on one private recording: leave one pick out (private)", ""];
  L.push(`Generated ${res.generatedAt.slice(0, 16).replace("T", " ")} UTC by eval/taste-picks.mjs (feat/taste). Protocol written before the run: PROTOCOL.md in this folder. Private: never commit or upload. Nothing was sent anywhere for this test; it reads cached judge answers only.`, "");
  L.push(`Each fit: 3 Posts (the other picks) and ${res.skipsPerFit} Skips drawn at random, ${res.seeds} seeds. Under the shipped rule the model's weight is ${res.picks[0]?.weight ?? "n/a"} (it grows with answers, up to ${res.rule.maxWeight}). **4 picks from one recording is a tiny sample.**`, "");
  for (const [key, title] of [["iou03", "Ranks as in METRIC.md (NMS iou 0.3)"], ["iou0", "Ranks with the new review rule (no overlap)"]]) {
    L.push(`## ${title}`, "");
    L.push("| Held-out pick | G (generic) | L, as shipped: median (range) | L-full, weight 0.6 | L-hear | X, taste alone before judging |", "|---|---|---|---|---|---|");
    for (const p of res.picks) {
      const cell = (arr) => `${med(arr.map((x) => x[key])) ?? "not found"} (${range(arr.map((x) => x[key]))})`;
      L.push(`| ${p.id.toUpperCase()} ${p.title} | ${p.G[key] ?? "not found"} | ${cell(p.L)} | ${cell(p.Lfull)} | ${cell(p.Lhear)} | ${cell(p.X)} |`);
    }
    const sums = { G: summary(res.picks.map((p) => p.G[key])), L: summary(res.picks.map((p) => med(p.L.map((x) => x[key])))), Lfull: summary(res.picks.map((p) => med(p.Lfull.map((x) => x[key])))), Lhear: summary(res.picks.map((p) => med(p.Lhear.map((x) => x[key])))), X: summary(res.picks.map((p) => med(p.X.map((x) => x[key])))) };
    L.push("", "| Arm | top 5 | top 10 | MRR |", "|---|---|---|---|");
    for (const [k, s] of Object.entries(sums)) L.push(`| ${k} | ${s.top5} | ${s.top10} | ${s.mrr} |`);
    if (key === "iou03") {
      const g = sums.G;
      const l = sums.L;
      const worse = res.picks.some((p) => {
        const a = p.G.iou03 ?? Infinity;
        const b = med(p.L.map((x) => x.iou03)) ?? Infinity;
        return b - a > 3;
      });
      const verdict = l.top10 > g.top10 && !worse ? "clearly better" : l.top10 < g.top10 || g.mrr - l.mrr >= 0.02 ? "clearly worse" : "no visible change";
      L.push("", `**Verdict by the rule written beforehand (L against G): ${verdict}.**`, "");
      res.verdict = verdict;
    }
  }
  L.push("## What the model leaned on (first seed, weights on standardised features)", "");
  for (const w of res.weights) L.push(`- ${w.held.toUpperCase()} held out: ${Object.entries(w.w).filter(([, x]) => Math.abs(x) >= 0.01).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([f, x]) => `${f} ${x > 0 ? "+" : ""}${x.toFixed(2)}`).join(", ") || "nothing"}`);
  const mm = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
  L.push("", `## Preview, not a test: all four picks as Posts (weight ${res.preview.weight}), the top 10 it would show`, "");
  for (const c of res.preview.top10) L.push(`${c.rank}. ${mm(c.start)} to ${mm(c.end)}${c.picks.length ? ` [${c.picks.join(", ").toUpperCase()}]` : ""}${c.others.length ? ` (also: ${c.others.join(", ")})` : ""}${c.why ? `: ${c.why}` : ""}`);
  return L.join("\n") + "\n";
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
