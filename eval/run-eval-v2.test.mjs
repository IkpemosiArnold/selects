// The eval must select windows the way the app does: stretches where whisper looped are kept
// out of the shortlist in production (job.mjs), so they must be kept out here too.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loopExclusions, selectCandidates } from "../src/core/select.mjs";
import { windowsFor } from "./run-eval-v2.mjs";

/** A 10-minute talk: one 10-word sentence every 4 seconds, every word different enough. */
function talk(sec = 600) {
  const words = [];
  let n = 0;
  for (let t = 0; t < sec; t += 4) {
    for (let i = 0; i < 10; i++) {
      n++;
      const w = `word${(n * 7919) % 104729}${i === 9 ? "." : ""}`;
      words.push({ w: i === 0 ? `W${w.slice(1)}` : w, s: +(t + i * 0.38).toFixed(2), e: +(t + i * 0.38 + 0.3).toFixed(2), p: 0.95 });
    }
  }
  return words;
}

const overlaps = (c, x) => c.start < x.e && c.end > x.s;

test("eval: the shortlist excludes transcript-loop spans, as the app does", () => {
  const words = talk();
  const end = 600;
  // what transcriptQuality reports for one short local loop in an otherwise clean transcript
  const loop = { s: 180, e: 420, ratio: 3.1 };
  const quality = { verdict: "good", loops: [loop], loopShare: 0.01 };
  const settings = { minLen: 20, maxLen: 60, stride: 6 };
  // without the exclusion some shortlisted window sits on the loop, so the check below means something
  const plain = selectCandidates({ words, events: [], loudness: null, settings: { ...settings, judgeN: 16 }, duration: end });
  assert.ok(plain.shortlist.some((c) => overlaps(c, loop)), "a loop window would be shortlisted without the exclusion");
  assert.deepEqual(loopExclusions(quality), [loop]);
  assert.deepEqual(loopExclusions({ ...quality, loopShare: 0.5 }), [], "a transcript that is mostly loops is gated, not trimmed");

  const dir = mkdtempSync(join(tmpdir(), "selects-eval-"));
  try {
    const heatmapPath = join(dir, "heat.json");
    const heatmap = Array.from({ length: 60 }, (_, i) => ({ start_time: i * 10, end_time: (i + 1) * 10, value: (i % 7) / 7 }));
    writeFileSync(heatmapPath, JSON.stringify({ heatmap, duration: end }));
    const C = { selectCandidates, transcriptQuality: () => quality };
    const out = windowsFor({ id: "t", heatmapPath }, { words, events: [], loudness: null, end, quality }, C);
    for (const n of Object.keys(out.short)) {
      assert.ok(out.short[n].length > 0, `shortlist ${n} is not empty`);
      assert.ok(out.short[n].every((c) => !overlaps(c, loop)), `shortlist ${n} keeps the loop out`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
