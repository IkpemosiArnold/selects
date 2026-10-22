// Safari 27.0's H.264 encoder hangs in latencyMode "quality" (mediabunny issue 541): WebKit
// gets "realtime", and a frame that never comes back ends the render with a plain message.
import assert from "node:assert/strict";
import { test } from "node:test";

await import("./test-env.mjs");
const { encoderLatencyMode, withStallLimit } = await import("./render-clip.js");

test("WebKit browsers encode in realtime mode, Chromium keeps quality", () => {
  assert.equal(encoderLatencyMode("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15"), "realtime");
  assert.equal(encoderLatencyMode("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1"), "realtime");
  assert.equal(encoderLatencyMode("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"), "quality");
  assert.equal(encoderLatencyMode("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0"), "quality");
});

test("an encoder that never answers is reported, not waited on forever", async () => {
  await assert.rejects(withStallLimit(new Promise(() => {}), 0.05), (e) => e.code === "encoder_stalled" && /stopped responding/.test(e.message));
  assert.equal(await withStallLimit(Promise.resolve(7), 0.05), 7);
});
