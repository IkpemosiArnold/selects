// One device choice for the download estimate and for what actually runs: the page must
// never promise one model and then fetch another.
import assert from "node:assert/strict";
import { test } from "node:test";

await import("./test-env.mjs");
const { createBrowserApi } = await import("./api.js");
const { privateBackend } = await import("./llm.js");
const { resolveAsrDevice } = await import("./asr.js");
const { chooseRuntimes, resetDeviceFacts } = await import("./devices.js");
const { MODELS } = await import("./models.js");

/** Pretend to be a browser with this GPU and this much memory. */
function fakeDevice({ gpu = null, memoryGb = null }) {
  const nav = globalThis.navigator;
  const had = { gpu: Object.getOwnPropertyDescriptor(nav, "gpu"), deviceMemory: Object.getOwnPropertyDescriptor(nav, "deviceMemory") };
  Object.defineProperty(nav, "gpu", { value: gpu ? { requestAdapter: async () => ({ info: { vendor: gpu, architecture: "x" } }) } : undefined, configurable: true });
  Object.defineProperty(nav, "deviceMemory", { value: memoryGb ?? undefined, configurable: true });
  resetDeviceFacts?.();
  return () => {
    for (const [k, d] of Object.entries(had)) {
      if (d) Object.defineProperty(nav, k, d);
      else delete nav[k];
    }
    resetDeviceFacts?.();
  };
}

const cases = [
  { name: "Intel GPU, 2 GB of memory", gpu: "intel", memoryGb: 2, judge: "gemma3-wasm", asr: "wasm" },
  { name: "Apple GPU, 8 GB", gpu: "apple", memoryGb: 8, judge: "gemma4-webgpu", asr: "webgpu" },
  { name: "Intel GPU, 8 GB", gpu: "intel", memoryGb: 8, judge: "gemma4-webgpu", asr: "wasm" },
  { name: "no WebGPU", gpu: null, memoryGb: 8, judge: "gemma3-wasm", asr: "wasm" },
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
      assert.equal(judgeItem.id, c.judge === "gemma4-webgpu" ? "gemma4" : "gemma3", "the judge the page says it will download");
      assert.equal(judgeItem.bytes, backend.bytes, "the size shown is the size fetched");
      const asr = await resolveAsrDevice("auto");
      assert.equal(asr, c.asr, "the speech model's device");
      assert.equal(whisperItem.bytes, MODELS.whisper.bytes[asr], "the speech model's size shown matches its device");
      assert.deepEqual(chooseRuntimes({ webgpu: !!c.gpu, vendor: c.gpu || "", deviceMemoryGb: c.memoryGb }), { judge: c.judge, asr: c.asr });
    } finally {
      restore();
    }
  });
}
