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

  const candidates = passages
    .map((p, idx) => ({
      id: "c_" + String(idx * 13 + 7).padStart(4, "0"),
      rank: p.rank,
      start: p.start,
      end: p.end,
      text: p.text,
      hook: p.text.split(/(?<=[.?!])\s/)[0],
      scores: p.scores,
      total: p.total,
      reason: p.reason,
      title: null,
      status: "proposed",
      trimmed: false,
      render: null,
      _kit: { title: p.title, caption: p.caption, hashtags: p.hashtags },
    }))
    .sort((a, b) => a.rank - b.rank);

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

export function makeJob({ id, name = TALK_NAME, stage = "ready", createdAt } = {}) {
  const { candidates, curve, labels, duration } = buildTalk();
  const done = (startedAt, endedAt, note) => ({ status: "done", startedAt, endedAt, progress: 1, etaSec: null, note });
  const created = createdAt || "2026-10-15T21:14:03.000Z";
  return {
    id,
    source: { path: "/Users/demo/Movies/" + name, name, duration, width: 1920, height: 1080, fps: 25 },
    settings: { model: "gemma3:4b", k: 12, minLen: 20, maxLen: 60, preset: "shorts" },
    stage,
    stages: {
      probe: done(created, created, null),
      transcribe: done(created, created, "transcribed at 2.4x real time"),
      candidates: done(created, created, "148 moments"),
      judge: done(created, created, "2.1 s per moment"),
      render: { status: "pending", startedAt: null, endedAt: null, progress: 0, etaSec: null, note: null },
    },
    error: null,
    words: null,
    candidates: candidates.map((c) => ({ ...c, scores: { ...c.scores } })),
    curve,
    labels,
    thumbs: { count: 60, interval: duration / 60, pattern: "thumbs/strip-%04d.jpg" },
    createdAt: created,
    updatedAt: created,
  };
}
