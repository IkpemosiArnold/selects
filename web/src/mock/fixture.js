// Builds a deterministic mock job from talk.js: word timings, ranked
// candidates, an interest curve, thumbnails and (for eval mode) human labels.
import { INTRO, FILLER, OUTRO, PASSAGES, TALK_NAME } from "./talk.js";

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

function speak(text, t, rand, words) {
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const len = w.replace(/[^\w']/g, "").length;
    const dur = 0.14 + 0.043 * len + rand() * 0.08;
    const s = t;
    const e = t + dur;
    words.push({ w, s: r2(s), e: r2(e), p: r2(0.78 + rand() * 0.21) });
    t = e + 0.05 + rand() * 0.05;
    if (/[.?!]$/.test(w)) t += 0.45 + rand() * 0.6;
    else if (/[,;:]$/.test(w)) t += 0.12 + rand() * 0.12;
  }
  return t;
}

let cache = null;

export function buildTalk() {
  if (cache) return cache;
  const rand = rng(20261016);
  const words = [];
  let t = 1.4;
  for (const s of INTRO) t = speak(s, t, rand, words);

  let fi = 0;
  const nextFiller = () => FILLER[fi++ % FILLER.length];
  const passages = [];
  for (const p of PASSAGES) {
    while (t < p.at - 4) t = speak(nextFiller(), t, rand, words);
    t += 0.4;
    const i0 = words.length;
    t = speak(p.text, t, rand, words);
    const i1 = words.length - 1;
    passages.push({ ...p, i0, i1, start: words[i0].s, end: words[i1].e });
  }
  while (t < 1836) t = speak(nextFiller(), t, rand, words);
  for (const s of OUTRO) t = speak(s, t, rand, words);
  const duration = r2(t + 2.2);

  // Scoring as the core does it (notes/CONTRACTS.md, 16 Oct): the rubric gives
  // judgeTotal, blended 0.7 judge + 0.3 pre-score, then a listwise final round
  // on the top 4 moves each total by up to 0.15.
  const W = { hook: 0.35, standalone: 0.3, payoff: 0.2, clarity: 0.15 };
  const judgeTotal = (sc) => r3(Object.entries(W).reduce((a, [k, w]) => a + w * ((sc[k] - 1) / 4), 0));
  const PRE = { validator: 0.71, promise: 0.66, triple: 0.69, index: 0.58, receipt: 0.62, arguing: 0.55, boxes: 0.6, time: 0.52, exactly: 0.57, support: 0.64, "second-click": 0.5, oncall: 0.43 };
  const LIST = {
    promise: [1, "Quotable first line, and the payoff lands in the last sentence."],
    validator: [2, "Strong claim up front; the lesson needs the middle to land."],
    index: [3, "Clear advice, but the proof at the end is a little quiet."],
    triple: [4, "Good story, though the opening needs the talk's context."],
  };
  const candidates = passages
    .map((p, idx) => {
      const jt = judgeTotal(p.scores);
      const pre = PRE[p.key] ?? 0.5;
      const blended = 0.7 * jt + 0.3 * pre;
      const lr = LIST[p.key];
      const total = r3(lr ? 0.85 * blended + 0.15 * [1, 2 / 3, 1 / 3, 0][lr[0] - 1] : 0.85 * blended);
      return {
        id: "c_" + String(idx * 13 + 7).padStart(4, "0"),
        rank: null,
        start: p.start,
        end: p.end,
        text: p.text,
        hook: p.text.split(/(?<=[.?!])\s/)[0],
        scores: p.scores,
        judgeTotal: jt,
        pre,
        total,
        ...(lr ? { listRank: lr[0], listReason: lr[1] } : {}),
        reason: p.reason,
        title: null,
        status: "proposed",
        trimmed: false,
        render: null,
        _kit: { title: p.title, captionText: p.caption, hashtags: p.hashtags.map((h) => h.replace(/^#/, "")) },
      };
    })
    .sort((a, b) => b.total - a.total)
    .map((c, i) => ({ ...c, rank: i + 1 }));

  // Interest curve: one point every 5 s. Bumps at every judged window, the
  // twelve ranked ones plus some moments that scored well but lost to overlap.
  const bumps = candidates.map((c) => ({ mid: (c.start + c.end) / 2, w: (c.end - c.start) / 2.2, h: c.total }));
  for (const [mid, h] of [[95, 0.38], [655, 0.47], [870, 0.55], [1150, 0.36], [1290, 0.5], [1560, 0.44], [1800, 0.4]]) {
    bumps.push({ mid, w: 18, h });
  }
  const curve = [];
  for (let x = 0; x <= duration; x += 5) {
    let v = 0.1 + Math.sin(x / 47) * 0.03 + rand() * 0.05;
    for (const b of bumps) v = Math.max(v, b.h * Math.exp(-((x - b.mid) ** 2) / (2 * b.w * b.w)) + rand() * 0.03);
    curve.push({ t: x, v: r2(Math.min(1, v)) });
  }

  // Human labels for eval mode. Three agree with the model; one it missed.
  const byKey = Object.fromEntries(passages.map((p) => [p.key, p]));
  const labels = [
    { start: byKey.validator.start - 3, end: byKey.validator.end - 6, source: "human", weight: 1 },
    { start: byKey.promise.start + 2, end: byKey.promise.end + 4, source: "human", weight: 1 },
    { start: byKey.triple.start - 8, end: byKey.triple.end - 10, source: "heatmap", weight: 0.6 },
    { start: 1268, end: 1312, source: "human", weight: 1 },
  ];

  cache = { words, candidates, curve, labels, duration };
  return cache;
}

// Measured on the build machine (notes/timings.md, final run): whisper base.en
// at 2.78x real time, 72.9 s per judged moment plus a 141 s listwise round,
// renders at about 1.1x the clip length plus about 100 s for each posting kit.
export const MEASURED = { rtf: 2.78, judgePerMoment: 72.9, listwiseSec: 141.1, renderFactor: 1.1, kitSec: 104 };

export const DEMO_CREDIT = {
  credit: "Northwind Engineering Summit 2026",
  license: "CC-BY-4.0",
  sourceUrl: "https://example.org/talks/retries-are-a-promise",
};

export function attributionFor({ credit, license, sourceUrl } = {}) {
  const L = { "CC-BY-4.0": ["CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/"], "CC-BY-SA-4.0": ["CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/"], "CC0-1.0": ["CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/"] }[license];
  if (!credit && !L) return null;
  const parts = [`Clip from ${credit || "the original video"}${sourceUrl ? ` (${sourceUrl})` : ""}`];
  if (license === "CC0-1.0") parts.push(`Dedicated to the public domain under ${L[0]}: ${L[1]}`);
  else if (L) parts.push(`Licensed under ${L[0]}: ${L[1]}`);
  parts.push("Cut, reframed and captioned from the original");
  if (license === "CC-BY-SA-4.0") parts.push(`This clip is shared under ${L[0]} too`);
  return parts.join(". ") + ".";
}

export function makeJob({ id, name = TALK_NAME, stage = "ready", createdAt, duration: durOverride, judgeN = 12 } = {}) {
  const { candidates, curve, labels, duration: talkDur, words } = buildTalk();
  const duration = durOverride || talkDur;
  const created = createdAt || "2026-10-15T21:14:03.000Z";
  const t0 = Date.parse(created);
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const trSec = duration / MEASURED.rtf;
  const jdSec = judgeN * MEASURED.judgePerMoment + MEASURED.listwiseSec;
  const st = (a, b, note) => ({ status: "done", startedAt: at(a), endedAt: at(b), progress: 1, etaSec: 0, note });
  return {
    id,
    source: { path: "/Users/demo/Movies/" + name, name, duration, width: 1920, height: 1080, fps: 25 },
    settings: { model: "gemma3-4b-hf:latest", k: 12, minLen: 20, maxLen: 60, preset: "shorts", judgeN, listwise: true, ...DEMO_CREDIT },
    stage,
    stages: {
      probe: st(0, 1.2, `${Math.round(duration)} s of video`),
      transcribe: st(1.2, 1.2 + trSec, `${words.length} words, ${MEASURED.rtf}x real time`),
      candidates: st(1.2 + trSec, 1.3 + trSec, `190 windows passed the filter, ${judgeN} go to the judge`),
      judge: st(1.3 + trSec, 1.3 + trSec + jdSec, `${judgeN} clips judged, ${MEASURED.judgePerMoment} s each`),
      render: { status: "pending", startedAt: null, endedAt: null, progress: 0, etaSec: null, note: null },
    },
    error: null,
    words: null,
    candidates: candidates.map((c) => ({ ...c, scores: { ...c.scores } })),
    curve,
    labels,
    listwise: { order: candidates.filter((c) => c.listRank).sort((a, b) => a.listRank - b.listRank).map((c) => c.id), complete: true, sec: MEASURED.listwiseSec },
    thumbs: { count: 60, interval: duration / 60, pattern: "thumbs/strip-%04d.jpg" },
    createdAt: created,
    updatedAt: created,
  };
}
