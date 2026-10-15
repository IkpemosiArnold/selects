// Overnight queue: jobs run one at a time, in order, and the queue survives on disk.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { talk } from "./test/fixtures.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "selects-queue-"));
process.env.SELECTS_HOME = home;
const { createJob } = await import("./job.mjs");
const { drainQueue, enqueue, queueState } = await import("./queue.mjs");
after(() => fs.rmSync(home, { recursive: true, force: true }));

const WORDS = talk(80);
let active = 0;
let maxActive = 0;
const order = [];
const deps = {
  probe: async (p) => ({ path: p, name: path.basename(p), duration: WORDS[WORDS.length - 1].e + 1, width: 1920, height: 1080, fps: 25 }),
  thumbs: async () => null,
  transcribe: async (p) => {
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(path.basename(p));
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return WORDS;
  },
  judge: async (cands) => cands.map((c, i) => ({ ...c, scores: { hook: 3, standalone: 3, payoff: 3, clarity: 3 }, total: 0.5 - i * 0.01, reason: "Fine." })),
};

test("queued jobs run sequentially in order and the queue empties", async () => {
  const ids = ["a.mp4", "b.mp4", "c.mp4"].map((n) => {
    const f = path.join(home, n);
    fs.writeFileSync(f, "x");
    return createJob(f, { model: "mock", k: 2 }).id;
  });
  for (const id of ids) enqueue({ jobId: id });
  enqueue({ jobId: ids[0] }); // duplicate is ignored
  assert.equal(queueState().items.length, 3);
  assert.ok(fs.existsSync(path.join(home, "queue.json")), "queue persisted to disk");
  const done = await drainQueue({ deps });
  assert.deepEqual(order, ["a.mp4", "b.mp4", "c.mp4"]);
  assert.equal(maxActive, 1, "never two heavy jobs at once");
  assert.ok(done.every((j) => j.stage === "ready"));
  assert.equal(queueState().items.length, 0);
});
