import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { GEMMA3N, hearStretches, laughIn, listenerStatus, loudSpread, segmentationPath, stretchKey } from "./hear-node.mjs";

test("loudSpread: flat audio has no spread, audio that swings has some, silence has none to measure", () => {
  const rate = 16000;
  const flat = new Float32Array(rate * 10).map((_, i) => 0.1 * Math.sin(i / 10));
  assert.ok(loudSpread(flat) < 0.1);
  const swing = new Float32Array(rate * 10).map((_, i) => (Math.floor(i / rate) % 2 ? 0.3 : 0.02) * Math.sin(i / 10));
  assert.ok(loudSpread(swing) > 5);
  assert.equal(loudSpread(new Float32Array(rate * 10)), null);
});

test("laughIn: the best laughter frame inside a stretch, null without frames", () => {
  const frames = { hop: 0.5, laughter: [0, 0.1, 0.6, 0, 0, 0.2] };
  assert.equal(laughIn(frames, 0, 1), 0.1);
  assert.equal(laughIn(frames, 0, 3), 0.6);
  assert.equal(laughIn(null, 0, 3), null);
});

test("stretchKey: changes with the listener and the stretch, so caches never mix", () => {
  const g = { s: 15, e: 45 };
  assert.notEqual(stretchKey("cues", g), stretchKey("gemma3n", g));
  assert.notEqual(stretchKey("cues", g), stretchKey("cues", { s: 30, e: 60 }));
});

test("listenerStatus: says what is missing instead of failing later", () => {
  assert.equal(listenerStatus("nope").ok, false);
  const g = listenerStatus("gemma3n");
  assert.ok(g.ok || /transformers\.js|Gemma 3n/.test(g.why));
  assert.ok(GEMMA3N.files.some((f) => f.includes("audio_encoder")) && !GEMMA3N.files.some((f) => f.includes("vision")), "the vision encoder is never needed");
});

test("hearStretches refuses clearly when the listener cannot run", async () => {
  const prev = process.env.SELECTS_HEAR_MODEL;
  process.env.SELECTS_HEAR_MODEL = path.join(os.tmpdir(), "no-such-gemma");
  try {
    await assert.rejects(hearStretches(os.tmpdir(), "x.wav", [{ s: 0, e: 30 }], { listener: "gemma3n" }), /hearing judge cannot run/);
  } finally {
    if (prev == null) delete process.env.SELECTS_HEAR_MODEL;
    else process.env.SELECTS_HEAR_MODEL = prev;
  }
});

const haveFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
let haveOrt = true;
try {
  await import("onnxruntime-node");
} catch {
  haveOrt = false;
}
test("the cues listener scores stretches of a real file and caches them", { skip: !(haveFfmpeg && haveOrt && fs.existsSync(segmentationPath())) && "needs ffmpeg, onnxruntime-node and the segmentation model" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selects-hear-"));
  try {
    const wav = path.join(dir, "tone.wav");
    // 45 s: a steady tone, then a tone that pulses in loudness
    spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=45", "-af", "volume='if(gt(t,20),0.2+0.8*mod(floor(t),2),0.5)':eval=frame", "-ar", "16000", "-ac", "1", wav]);
    const stretches = [{ s: 0, e: 30 }, { s: 15, e: 45 }];
    const rows = await hearStretches(dir, wav, stretches, { listener: "cues", soundFrames: null });
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.ok(r.overlap == null || (r.overlap >= 0 && r.overlap <= 1));
      assert.ok(typeof r.score === "number");
    }
    assert.ok(rows[1].loudSpread > rows[0].loudSpread, "the pulsing stretch moves more");
    assert.ok(fs.existsSync(path.join(dir, "hear-cues.json")));
    // a second call reads the cache (no child process): same answer
    assert.deepEqual(await hearStretches(dir, wav, stretches, { listener: "cues" }), rows);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
