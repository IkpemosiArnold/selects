// Smart mode keeps under the proxy's per-minute limit instead of losing clips to it.
import assert from "node:assert/strict";
import { test } from "node:test";

await import("./test-env.mjs");
const { pacer } = await import("./llm.js");

test("pacer: at most n call starts in any minute", async () => {
  let t = 0;
  const waits = [];
  const sleep = async (ms) => {
    waits.push(ms);
    t += ms;
  };
  const pace = pacer(3, { now: () => t, sleep });
  const starts = [];
  for (let i = 0; i < 7; i++) {
    await pace();
    starts.push(t);
    t += 1000; // each call takes a second
  }
  for (let i = 3; i < starts.length; i++) assert.ok(starts[i] - starts[i - 3] >= 60000, `call ${i + 1} waited: ${starts}`);
  assert.equal(waits.length, 2, "only the 4th and 7th calls had to wait");
});
