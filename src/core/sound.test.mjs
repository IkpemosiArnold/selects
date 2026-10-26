// Sound events: the YAMNet framing and thresholds (with a stand-in model), and the
// signal-processing laughter detector on synthetic laughter-like bursts against flat speech.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLASSES, eventsFromFrames, FRAMES_PER_CHUNK, laughterHeuristic, YAMNET, yamnetFrames } from "./sound.mjs";

const RATE = 16000;

/** A voiced tone switched on and off: `rate` bursts a second, each `on` seconds long. */
function bursts(sec, { rate = 5, on = 0.09, f0 = 300, amp = 0.5 } = {}) {
  const x = new Float32Array(Math.round(sec * RATE));
  for (let i = 0; i < x.length; i++) {
    const t = i / RATE;
    const phase = (t * rate) % 1;
    x[i] = phase < on * rate ? amp * Math.sin(2 * Math.PI * f0 * t) * Math.sin((Math.PI * phase) / (on * rate)) : 0;
  }
  return x;
}

/** Speech-like: syllables of uneven length at uneven gaps, steady loudness, a little noise. */
function flatSpeech(sec, { amp = 0.5, seed = 7 } = {}) {
  let s = seed;
  const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const x = new Float32Array(Math.round(sec * RATE));
  let i = 0;
  while (i < x.length) {
    const syl = Math.round((0.08 + r() * 0.3) * RATE);
    const gap = Math.round(r() * 0.06 * RATE);
    const f0 = 140 + r() * 60;
    for (let k = 0; k < syl && i < x.length; k++, i++) x[i] = amp * (0.7 + 0.3 * r()) * Math.sin((2 * Math.PI * f0 * k) / RATE);
    for (let k = 0; k < gap && i < x.length; k++, i++) x[i] = 0.02 * (r() - 0.5);
  }
  return x;
}

test("the fallback detector finds laughter-like bursts and not flat speech", () => {
  const speech = flatSpeech(8);
  const laugh = bursts(3);
  const pcm = new Float32Array(speech.length * 2 + laugh.length);
  pcm.set(speech, 0);
  pcm.set(laugh, speech.length);
  pcm.set(flatSpeech(8, { seed: 11 }), speech.length + laugh.length);
  const ev = laughterHeuristic(pcm);
  assert.ok(ev.length >= 1, "the bursts are found");
  for (const e of ev) {
    assert.equal(e.type, "laughter");
    assert.equal(e.by, "dsp");
    assert.ok(e.s >= 7 && e.e <= 12.5, `inside the laugh (8 to 11 s): ${e.s} to ${e.e}`);
  }
  assert.deepEqual(laughterHeuristic(flatSpeech(20, { seed: 3 })), [], "flat speech alone fires nothing");
  assert.deepEqual(laughterHeuristic(new Float32Array(RATE * 5)), [], "silence fires nothing");
});

test("the fallback detector counts a burst train under transcribed words for half", () => {
  const pcm = bursts(4);
  const words = Array.from({ length: 16 }, (_, i) => ({ w: "ha", s: i * 0.25, e: i * 0.25 + 0.24 }));
  const free = laughterHeuristic(pcm);
  const worded = laughterHeuristic(pcm, { words });
  assert.ok(free.length && free[0].p > 0.5);
  assert.ok(!worded.length || worded[0].p < free[0].p);
});

test("YAMNet frames tile minute by minute and keep the highest class of each event", async () => {
  const seen = [];
  const run = async (chunk) => {
    seen.push(chunk.length);
    const frames = 1 + Math.ceil(Math.max(0, chunk.length - 15360) / 7680);
    const out = new Float32Array(frames * YAMNET.classes);
    for (let i = 0; i < frames; i++) {
      out[i * YAMNET.classes + CLASSES.laughter[2]] = i === 10 ? 0.4 : 0.01; // Giggle at frame 10
      out[i * YAMNET.classes + CLASSES.applause[1]] = 0.02;
    }
    return out;
  };
  const pcm = new Float32Array(RATE * 150); // 2.5 minutes
  const f = await yamnetFrames(run, pcm);
  assert.deepEqual(seen, [RATE * 60 + 7680, RATE * 60 + 7680, RATE * 30]);
  assert.equal(f.laughter.length, 2 * FRAMES_PER_CHUNK + 62, "the last half minute: the frames the model gives for it");
  assert.equal(f.laughter[10], 0.4);
  assert.equal(f.laughter[FRAMES_PER_CHUNK + 10], 0.4, "the second minute's frame 10 lands at 60 s + 4.8 s");
  const ev = eventsFromFrames(f).filter((e) => e.type === "laughter");
  assert.deepEqual(ev.map((e) => e.s), [4.8, 64.8, 124.8]);
  assert.equal(ev[0].p, 0.4);
  assert.equal(eventsFromFrames(f).filter((e) => e.type === "applause").length, 0, "under the threshold");
});

test("events join frames across a one-frame gap and need a peak", () => {
  const z = (n) => new Array(n).fill(0);
  const laughter = [...z(5), 0.09, 0.05, 0.1, 0.13, ...z(10), 0.09, 0.09, ...z(5)];
  const ev = eventsFromFrames({ hop: 0.48, laughter, applause: [], shout: [] });
  assert.equal(ev.length, 1, "the second run never reaches the peak threshold");
  assert.equal(ev[0].s, +(5 * 0.48).toFixed(2));
  assert.equal(ev[0].e, +(8 * 0.48 + 0.96).toFixed(2));
});
