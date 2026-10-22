import assert from "node:assert/strict";
import { test } from "node:test";
import { frameDb, inOrder, planChunks, speechRegions } from "./speech-chunks.js";

const RATE = 16000;
/** Speech-like noise with a short dip every `gap` seconds, and silence where asked. */
function signal(sec, { silent = [], dipEvery = 7 } = {}) {
  const pcm = new Float32Array(Math.round(sec * RATE));
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < pcm.length; i++) {
    const t = i / RATE;
    const quiet = silent.some(([a, b]) => t >= a && t < b);
    const dip = t % dipEvery > dipEvery - 0.2;
    pcm[i] = quiet ? 0 : rnd() * (dip ? 0.002 : 0.3);
  }
  return pcm;
}

test("pieces: a short first piece, then up to two minutes, covering every sample in order", () => {
  const pcm = signal(240);
  const pieces = planChunks(pcm, RATE);
  assert.ok(pieces[0].end / RATE <= 30 + 1e-6, "the first piece is at most 30 s, so the first words come back fast");
  assert.ok(pieces.every((p) => (p.end - p.start) / RATE <= 120 + 1e-6), "no piece over 2 minutes");
  assert.equal(pieces[0].start, 0);
  assert.equal(pieces[pieces.length - 1].end, pcm.length);
  for (let i = 1; i < pieces.length; i++) assert.equal(pieces[i].start, pieces[i - 1].end, "contiguous: no audio lost or sent twice");
  assert.ok(pieces.length >= 3 && pieces.length <= 4, `${pieces.length} pieces for 4 minutes`);
});

test("pieces are cut at a quiet moment, never mid-sound", () => {
  const pcm = signal(240);
  const db = frameDb(pcm, RATE);
  for (const p of planChunks(pcm, RATE).slice(0, -1)) {
    const f = Math.floor(p.end / (RATE * 0.05));
    assert.ok(db[f] < -40, `cut at ${(p.end / RATE).toFixed(2)} s is in a dip (${db[f].toFixed(1)} dBFS)`);
  }
});

test("long silences are not sent; short gaps are kept inside a piece", () => {
  const pcm = signal(200, { silent: [[40, 70], [100, 101]] });
  const regions = speechRegions(pcm, RATE);
  assert.equal(regions.length, 2, "the 1 s pause is not a gap, the 30 s silence is");
  const pieces = planChunks(pcm, RATE, { regions });
  const sent = pieces.reduce((a, p) => a + (p.end - p.start), 0) / RATE;
  assert.ok(sent < 200 - 29 && sent > 200 - 31, `about 30 s of silence skipped (sent ${sent.toFixed(1)} s)`);
  assert.ok(!pieces.some((p) => p.start / RATE > 41 && p.start / RATE < 69), "nothing starts inside the silence");
});

test("a quietly recorded speaker is not mistaken for silence", () => {
  const pcm = signal(60).map((x) => x * 0.01); // about -50 dBFS speech
  assert.deepEqual(speechRegions(pcm, RATE).length, 1);
});

test("inOrder: results come back in order even when later pieces finish first", async () => {
  const delays = [50, 5, 5, 30, 1];
  const got = [];
  const out = await inOrder(delays, (d, i) => new Promise((r) => setTimeout(() => r(i), d)), { concurrency: 3, onResult: (r, i) => got.push([r, i]) });
  assert.deepEqual(got.map(([r]) => r), [0, 1, 2, 3, 4]);
  assert.deepEqual(out, { done: 5, error: null });
});

test("inOrder: a failure reports how far the in-order results reached", async () => {
  const got = [];
  const out = await inOrder([0, 1, 2, 3], async (x) => {
    if (x === 2) throw new Error("busy");
    return x;
  }, { concurrency: 2, onResult: (r) => got.push(r) });
  assert.equal(out.error.message, "busy");
  assert.equal(out.done, 2);
  assert.deepEqual(got, [0, 1], "pieces after the failure are not handed back");
});
