// One device choice for the download estimate and for what actually runs: the page must
// never promise one model and then fetch another.
import assert from "node:assert/strict";
import { test } from "node:test";

await import("./test-env.mjs");
const { createBrowserApi } = await import("./api.js");
const { privateBackend } = await import("./llm.js");
const { resolveAsrDevice, resolveSpeech } = await import("./asr.js");
const { chooseRuntimes, inTabJudgeFits, isAppleMobile, resetDeviceFacts } = await import("./devices.js");
const { MODELS } = await import("./models.js");

/** Pretend to be a browser with this GPU and this much memory. */
function fakeDevice({ gpu = null, memoryGb = null, ua = null }) {
  const nav = globalThis.navigator;
  const had = { gpu: Object.getOwnPropertyDescriptor(nav, "gpu"), deviceMemory: Object.getOwnPropertyDescriptor(nav, "deviceMemory"), userAgent: Object.getOwnPropertyDescriptor(nav, "userAgent") };
  Object.defineProperty(nav, "gpu", { value: gpu ? { requestAdapter: async () => ({ info: { vendor: gpu, architecture: "x" } }) } : undefined, configurable: true });
  Object.defineProperty(nav, "deviceMemory", { value: memoryGb ?? undefined, configurable: true });
  if (ua) Object.defineProperty(nav, "userAgent", { value: ua, configurable: true });
  resetDeviceFacts?.();
  return () => {
    for (const [k, d] of Object.entries(had)) {
      if (d) Object.defineProperty(nav, k, d);
      else delete nav[k];
    }
    resetDeviceFacts?.();
  };
}

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const cases = [
  { name: "Intel GPU, 2 GB of memory", gpu: "intel", memoryGb: 2, judge: "gemma3-wasm", asr: "wasm", speech: "tiny" },
  { name: "Apple GPU, 8 GB", gpu: "apple", memoryGb: 8, judge: "gemma4-webgpu", asr: "webgpu", speech: "base" },
  { name: "Intel GPU, 8 GB", gpu: "intel", memoryGb: 8, judge: "gemma4-webgpu", asr: "wasm", speech: "base" },
  { name: "no WebGPU", gpu: null, memoryGb: 8, judge: "gemma3-wasm", asr: "wasm", speech: "base" },
  { name: "no WebGPU, memory not reported", gpu: null, memoryGb: null, judge: "gemma3-wasm", asr: "wasm", speech: "base" },
  // Safari on iOS 26 has WebGPU and does not report memory: whisper stays on the CPU, small
  { name: "iPhone with WebGPU (iOS 26)", gpu: "apple", memoryGb: null, ua: IPHONE, ios: true, judge: "gemma3-wasm", asr: "wasm", speech: "tiny" },
  { name: "iPhone without WebGPU", gpu: null, memoryGb: null, ua: IPHONE, ios: true, judge: "gemma3-wasm", asr: "wasm", speech: "tiny" },
];

for (const c of cases) {
  test(`device choice: the download estimate and the backend agree (${c.name})`, async () => {
    const restore = fakeDevice(c);
    try {
      const api = createBrowserApi();
      const d = await api.downloads();
      const judgeItem = d.items.find((i) => i.id === "gemma4" || i.id === "gemma3");
      const whisperItem = d.items.find((i) => i.id === "whisper");
      const backend = await privateBackend();
      assert.equal(backend.id, c.judge, "the judge that runs");
      const inTab = c.speech !== "tiny"; // the same devices get the small whisper and no in-tab judge
      if (inTab) {
        assert.equal(judgeItem.id, c.judge === "gemma4-webgpu" ? "gemma4" : "gemma3", "the judge the page says it will download");
        assert.equal(judgeItem.bytes, backend.bytes, "the size shown is the size fetched");
      } else {
        assert.equal(judgeItem, undefined, "a phone is never told it will download the judge");
      }
      const asr = await resolveAsrDevice("auto");
      assert.equal(asr, c.asr, "the speech model's device");
      const speech = await resolveSpeech();
      assert.equal(speech.size, c.speech, "the speech model's size");
      assert.equal(whisperItem.bytes, speech.model.bytes[asr], "the speech model's size shown is the one that loads, on its device");
      assert.equal(whisperItem.bytes, MODELS[c.speech === "tiny" ? "whisperTiny" : "whisper"].bytes[asr]);
      assert.deepEqual(chooseRuntimes({ webgpu: !!c.gpu, vendor: c.gpu || "", deviceMemoryGb: c.memoryGb, ios: !!c.ios }), { judge: c.judge, asr: c.asr, speech: c.speech, inTabJudge: inTab });
    } finally {
      restore();
    }
  });
}

test("the in-tab judge: never on iPhones and iPads, nor on 4 GB or less; computers keep it", () => {
  assert.equal(inTabJudgeFits({ ios: true }), false);
  assert.equal(inTabJudgeFits({ deviceMemoryGb: 4 }), false);
  assert.equal(inTabJudgeFits({ deviceMemoryGb: 2 }), false);
  assert.equal(inTabJudgeFits({ deviceMemoryGb: 8 }), true);
  assert.equal(inTabJudgeFits({}), true, "memory not reported (Safari, Firefox on a computer)");
  assert.equal(chooseRuntimes({ ios: true }).inTabJudge, false);
});

test("the person's choice of speech model wins over the device rule", () => {
  assert.equal(chooseRuntimes({ ios: true, speech: "base" }).speech, "base");
  assert.equal(chooseRuntimes({ deviceMemoryGb: 16, speech: "tiny" }).speech, "tiny");
  assert.equal(chooseRuntimes({ ios: true, asrDevice: "webgpu", webgpu: true }).asr, "webgpu");
});

test("iPhones and iPads are recognised, iPads that say they are Macs included", () => {
  assert.ok(isAppleMobile(IPHONE));
  assert.ok(isAppleMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15", 5));
  assert.ok(!isAppleMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15", 0));
  assert.ok(!isAppleMobile("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36"));
});
