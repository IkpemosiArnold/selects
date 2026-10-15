import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { energyScore, loudnessEnvelope } from "./methods/energy.mjs";
import { randomScore } from "./methods/random.mjs";

const cands = [
  { id: "c1", start: 0, end: 20 },
  { id: "c2", start: 20, end: 40 },
  { id: "c3", start: 40, end: 60 },
];

test("randomScore is seeded and keeps windows", () => {
  const a = randomScore(cands, 3), b = randomScore(cands, 3), c = randomScore(cands, 4);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.map((x) => x.total), c.map((x) => x.total));
  assert.deepEqual(a.map((x) => [x.start, x.end]), cands.map((x) => [x.start, x.end]));
});

test("energyScore prefers the loud, fast, dynamic window", () => {
  const hop = 1;
  const db = [];
  for (let t = 0; t < 60; t++) db.push(t >= 20 && t < 40 ? (t % 2 ? -10 : -20) : -35);
  const words = [];
  for (let t = 0; t < 60; t += t >= 20 && t < 40 ? 0.25 : 1) words.push({ w: "x", s: t, e: t + 0.2 });
  const scored = energyScore(cands, { hop, db }, words);
  const best = scored.reduce((a, b) => (b.total > a.total ? b : a));
  assert.equal(best.id, "c2");
  assert.ok(scored.every((c) => c.total >= 0 && c.total <= 1));
  assert.ok(best.features.wordsPerSec > 3);
});

test("loudnessEnvelope reads a generated tone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selects-eval-"));
  const f = join(dir, "tone.wav");
  try {
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ar", "8000", "-y", f]);
    const env = await loudnessEnvelope(f, { hop: 0.5 });
    assert.ok(env.db.length >= 5 && env.db.length <= 7);
    assert.ok(env.db[2] > -30 && env.db[2] < 0, `tone level ${env.db[2]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
