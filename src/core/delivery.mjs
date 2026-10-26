// Delivery: how a moment sounds, not only what is said. In a conversation the moments worth
// posting are often in the delivery: a laugh, voices rising, a quick back and forth. These
// features feed the first-stage score, mark the words the judge reads, and seed candidate
// windows around the peaks (with the setup before them). Pure and browser-safe.

/** Beats: where something happens in the sound. Laughter and applause from sound events, energy peaks from loudness. */
export function energyPeaks(loudness, { minSec = 1, pct = 0.92, gapSec = 1 } = {}) {
  const db = loudness?.db;
  const step = loudness?.step || 0.5;
  if (!db?.length) return [];
  const speech = db.filter((d) => d > -60).sort((a, b) => a - b);
  if (speech.length < 20) return [];
  const thr = speech[Math.floor(speech.length * pct)];
  const med = speech[Math.floor(speech.length * 0.5)];
  const out = [];
  let run = null;
  for (let i = 0; i < db.length; i++) {
    if (db[i] >= thr) {
      if (run && (i - run.i1) * step <= gapSec) run.i1 = i;
      else {
        if (run) out.push(run);
        run = { i0: i, i1: i };
      }
    }
  }
  if (run) out.push(run);
  return out
    .filter((r) => (r.i1 - r.i0 + 1) * step >= minSec)
    .map((r) => {
      const seg = db.slice(r.i0, r.i1 + 1);
      return { type: "energy", s: +(r.i0 * step).toFixed(2), e: +((r.i1 + 1) * step).toFixed(2), p: +Math.min(1, (Math.max(...seg) - med) / 12).toFixed(3) };
    });
}

/** Laughter and applause events (from sound events or whisper's notes) plus energy peaks, by time. */
export function beatsFrom({ events = [], loudness = null } = {}) {
  const sound = (events || []).filter((e) => e.type === "laughter" || e.type === "applause").map((e) => ({ ...e, p: e.p ?? 0.5 }));
  return [...sound, ...energyPeaks(loudness)].sort((a, b) => a.s - b.s);
}

/** Recording-level context for deliveryFeatures: median speaking rate, and the beats. */
export function deliveryContext({ sentences = [], events = [], loudness = null } = {}) {
  const rates = sentences.filter((s) => s.e - s.s >= 2).map((s) => s.text.split(/\s+/).length / (s.e - s.s)).sort((a, b) => a - b);
  return { wps: rates.length ? rates[Math.floor(rates.length / 2)] : null, beats: beatsFrom({ events, loudness }) };
}

const AFTER = 2.5; // a laugh that comes just after the last word still belongs to the clip

/**
 * Per window: laughs (count and best score), whether a beat sits near the end (the payoff),
 * energy peaks, the speaking-rate change against the recording's median, and quick exchanges
 * (very short sentences: "No way.", "Exactly.", "Wait, what?"), a cheap stand-in for
 * turn-taking, since whisper does not say who is speaking.
 */
export function deliveryFeatures(win, ctx) {
  const beats = ctx?.beats || [];
  const s = win.start;
  const e = win.end;
  const inside = beats.filter((b) => b.s < e + AFTER && b.e > s);
  const laughs = inside.filter((b) => b.type === "laughter");
  const energy = inside.filter((b) => b.type === "energy");
  const dur = Math.max(1, e - s);
  const words = win.text.split(/\s+/).filter(Boolean).length;
  const rate = ctx?.wps ? +(words / dur / ctx.wps).toFixed(2) : null;
  const exchanges = (win.sentences || []).filter((x) => x.text.split(/\s+/).length <= 3).length;
  const late = inside.some((b) => (b.type === "laughter" || b.type === "applause") && b.s >= s + 0.5 * dur);
  return {
    laughs: laughs.length,
    laughP: laughs.length ? Math.max(...laughs.map((b) => b.p ?? 0.5)) : 0,
    applause: inside.filter((b) => b.type === "applause").length,
    energy: energy.length,
    late,
    rate,
    exchanges,
  };
}

/**
 * The clip's words with what was heard marked in them, for the judge: "(laughter)" where
 * people laughed and "(louder)" where voices rose, after the word it follows. At most `max`
 * marks. words: speech words [{ w, s, e }] (the clip's own, or the whole transcript).
 */
export function markCues(words, beats, start, end, { max = 6 } = {}) {
  const ws = (words || []).filter((w) => w.s >= start - 0.05 && w.e <= end + 0.05);
  if (!ws.length) return null;
  const marks = (beats || [])
    .filter((b) => b.s < end + AFTER && b.e > start && (b.type === "laughter" || b.type === "applause" || (b.type === "energy" && b.p >= 0.5)))
    .sort((a, b) => (b.p ?? 0) - (a.p ?? 0))
    .slice(0, max)
    .sort((a, b) => a.s - b.s);
  if (!marks.length) return null;
  const label = { laughter: "(laughter)", applause: "(applause)", energy: "(louder)" };
  const after = new Map();
  for (const m of marks) {
    // after the last word that starts before the beat (a laugh after the clip goes at the end)
    let i = ws.findLastIndex((w) => w.s <= m.s);
    if (i < 0) i = 0;
    const list = after.get(i) || [];
    if (!list.includes(label[m.type])) list.push(label[m.type]);
    after.set(i, list);
  }
  return ws.map((w, i) => (after.has(i) ? `${w.w} ${after.get(i).join(" ")}` : w.w)).join(" ");
}

/**
 * Candidate windows around beats: for each laughter, applause or strong energy peak, windows
 * that end on the first sentence end at or after the beat (the payoff and the laugh) and start
 * on a sentence boundary before it, so the setup is included. Lengths aim at the short end of
 * the range (the setup-to-laugh beat is usually short) and at the middle.
 * Returns raw windows { start, end, sentences, text, peak } for makeCandidates' filter and score.
 */
export function peakWindows(sentences, beats, { minLen = 20, maxLen = 60, maxBeats = 120 } = {}) {
  const use = (beats || [])
    .filter((b) => b.type === "laughter" || b.type === "applause" || (b.type === "energy" && b.p >= 0.5))
    .sort((a, b) => (b.p ?? 0) - (a.p ?? 0))
    .slice(0, maxBeats);
  const targets = [minLen + 0.1 * (maxLen - minLen), minLen + 0.3 * (maxLen - minLen), minLen + 0.55 * (maxLen - minLen)];
  const out = [];
  for (const b of use) {
    // the sentence the beat lands in or right after: end there (or on the next one if the beat is at its very start)
    let j = sentences.findIndex((x) => x.e >= b.s - 0.3);
    if (j < 0) j = sentences.length - 1;
    if (sentences[j] && sentences[j].e - b.s > 12 && j > 0) j--; // a long sentence after the laugh: end before it
    for (const jEnd of [j, j + 1]) {
      const last = sentences[jEnd];
      if (!last) continue;
      const starts = [];
      for (let i = jEnd; i >= 0; i--) {
        const dur = last.e - sentences[i].s;
        if (dur > maxLen) break;
        if (dur >= minLen) starts.push(i);
      }
      if (!starts.length) continue;
      const picked = new Set();
      for (const t of targets) {
        let best = starts[0];
        for (const i of starts) if (Math.abs(last.e - sentences[i].s - t) < Math.abs(last.e - sentences[best].s - t)) best = i;
        picked.add(best);
      }
      for (const i of picked) {
        const sents = sentences.slice(i, jEnd + 1);
        out.push({ start: sents[0].s, end: last.e, sentences: sents, text: sents.map((x) => x.text).join(" "), peak: { type: b.type, at: +b.s.toFixed(2), p: b.p ?? null } });
      }
    }
  }
  return out;
}
