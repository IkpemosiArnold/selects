// Delivery features and windows around peaks: a laugh the words miss still makes candidates,
// with the setup before it, and reaches the judge.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryContext, deliveryFeatures, energyPeaks, markCues, peakWindows } from "./delivery.mjs";
import { makeCandidates, shortlist } from "./candidates.mjs";
import { selectCandidates } from "./select.mjs";
import { toSentences } from "./sentences.mjs";

// 10 minutes of plain talk: a full stop every 8 words, 2.5 words a second
function talk(sec = 600) {
  const vocab = ["We", "plan", "was", "simple", "and", "we", "kept", "going"];
  const out = [];
  for (let i = 0; i * 0.4 < sec; i++) out.push({ w: vocab[i % 8] + (i % 8 === 7 ? "." : ""), s: i * 0.4, e: i * 0.4 + 0.3, p: 0.92 });
  return out;
}

test("energy peaks: sustained bursts over the recording's loud end, not single spikes", () => {
  const db = Array.from({ length: 400 }, (_, i) => -30 + ((i * 37) % 7) * 0.5);
  for (let i = 100; i < 106; i++) db[i] = -14; // 3 s of raised voices
  db[300] = -12; // one 0.5 s spike
  const peaks = energyPeaks({ step: 0.5, db });
  assert.equal(peaks.length, 1);
  assert.equal(peaks[0].s, 50);
  assert.equal(peaks[0].e, 53);
  assert.ok(peaks[0].p > 0.5);
});

test("delivery features: laughter inside or just after, a late beat, pace against the median", () => {
  const sentences = toSentences(talk(120));
  const ctx = deliveryContext({ sentences, events: [{ type: "laughter", s: 58, e: 60, p: 0.4 }] });
  const win = { start: 30, end: 57, text: "x ".repeat(70).trim(), sentences: sentences.filter((s) => s.s >= 30 && s.e <= 57) };
  const d = deliveryFeatures(win, ctx);
  assert.equal(d.laughs, 1, "a laugh 1 s after the last word still counts");
  assert.equal(d.laughP, 0.4);
  assert.equal(d.late, true);
  assert.ok(d.rate > 0.9 && d.rate < 1.1, `pace near the median: ${d.rate}`);
  assert.equal(deliveryFeatures({ ...win, start: 0, end: 20 }, ctx).laughs, 0);
});

test("markCues puts (laughter) after the word it follows, and nothing without beats", () => {
  const words = [{ w: "So", s: 0, e: 0.3 }, { w: "I", s: 0.4, e: 0.5 }, { w: "fell.", s: 0.6, e: 1 }, { w: "Anyway.", s: 3, e: 3.5 }];
  assert.equal(markCues(words, [{ type: "laughter", s: 1.2, e: 2.5, p: 0.5 }], 0, 3.5), "So I fell. (laughter) Anyway.");
  assert.equal(markCues(words, [], 0, 3.5), null);
  assert.equal(markCues(words, [{ type: "energy", s: 0.4, e: 1.5, p: 0.2 }], 0, 3.5), null, "a weak energy peak is not marked");
});

test("peak windows end just after the laugh and start on a sentence before it, within the length range", () => {
  const sentences = toSentences(talk(300));
  const laugh = { type: "laughter", s: 150.2, e: 152, p: 0.3 };
  const wins = peakWindows(sentences, [laugh], { minLen: 20, maxLen: 60 });
  assert.ok(wins.length >= 2);
  for (const w of wins) {
    const d = w.end - w.start;
    assert.ok(d >= 20 && d <= 60, `length ${d}`);
    assert.ok(w.start < laugh.s - 10, "the setup is in");
    assert.ok(w.end >= laugh.s - 0.3 && w.end <= laugh.s + 8, `ends at the beat: ${w.end}`);
    assert.equal(w.peak.type, "laughter");
  }
  assert.ok(wins.some((w) => w.end - w.start <= 30), "a short setup-to-laugh window is among them");
});

test("a laugh the words miss makes peak candidates with marked words, and they reach the shortlist", () => {
  const words = talk(600);
  const events = [{ type: "laughter", s: 400.1, e: 402, p: 0.35 }];
  const sel = selectCandidates({ words, events, settings: { minLen: 20, maxLen: 60, judgeN: 8 }, duration: 600 });
  const peaks = sel.windows.filter((c) => c.peak?.type === "laughter");
  assert.ok(peaks.length, "peak windows exist");
  assert.ok(peaks.every((c) => /\(laughter\)/.test(c.cueText) && !/laughter/.test(c.text)), "the judge sees the mark, the captions never do");
  assert.ok(sel.shortlist.some((c) => c.peak?.type === "laughter"), "one reaches the judge");
  const plain = selectCandidates({ words, settings: { minLen: 20, maxLen: 60, judgeN: 8 }, duration: 600 });
  assert.ok(!plain.shortlist.some((c) => c.start <= 400 && c.end >= 395), "without the laugh, that stretch was not picked");
});

test("the shortlist spreads peak windows across beats and the recording", () => {
  const sentences = toSentences(talk(600));
  const events = [100, 103, 106, 300, 500].map((t) => ({ type: "laughter", s: t + 0.1, e: t + 1.5, p: 0.3 }));
  const all = makeCandidates(sentences, { minLen: 20, maxLen: 60, events });
  const short = shortlist(all, { n: 9, duration: 600 });
  const beats = new Set(short.filter((c) => c.peak?.type === "laughter").map((c) => c.peak.at));
  assert.ok(beats.size >= 2, "more than one beat is represented");
  assert.ok(short.some((c) => c.start > 400), "the end of the recording still gets a window");
});

test("a question to the listener at the end is a plus, any other question ending a minus", () => {
  const mk = (last) => {
    const ws = [];
    const text = `We tried it for a month and it worked. People asked us about it every week. ${last}`;
    text.split(" ").forEach((w, i) => ws.push({ w, s: i * 1.2, e: i * 1.2 + 0.4, p: 0.9 }));
    return makeCandidates(toSentences(ws), { minLen: 10, maxLen: 60, peaks: false }).find((c) => c.text.endsWith(last));
  };
  assert.equal(mk("Would you do the same?").preParts.questionEnding, 0.04);
  assert.equal(mk("So what happened next?").preParts.questionEnding, -0.06);
});
