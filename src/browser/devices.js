// Which runtimes this browser uses: one choice, made in one place, for both what the page says
// it will download and what actually runs (the judge backend in llm.js, whisper's device in
// asr.js). chooseRuntimes is pure, so the rule is tested in Node.

/** The judge on WebGPU (Gemma 4 E2B, 2 GB) needs at least this much device memory, when the browser says. */
export const MIN_GPU_MEMORY_GB = 4;

/**
 * @param {{ webgpu?: boolean, vendor?: string, deviceMemoryGb?: number|null, prefer?: string, asrDevice?: string }} facts
 *   prefer: "auto" | "gemma4-webgpu" | "gemma3-wasm" (the judge); asrDevice: "auto" | "webgpu" | "wasm"
 * @returns {{ judge: "gemma4-webgpu" | "gemma3-wasm", asr: "webgpu" | "wasm" }}
 */
export function chooseRuntimes({ webgpu = false, vendor = "", deviceMemoryGb = null, prefer = "auto", asrDevice = "auto" } = {}) {
  const memOk = !deviceMemoryGb || deviceMemoryGb >= MIN_GPU_MEMORY_GB;
  const judge = prefer === "gemma4-webgpu" || prefer === "gemma3-wasm" ? prefer : webgpu && memOk ? "gemma4-webgpu" : "gemma3-wasm";
  // On an Intel integrated GPU whisper ran 2.4 times slower than on the CPU (2017 MacBook Pro,
  // notes/timings.md), so "auto" keeps whisper on the CPU there
  const asr = asrDevice === "webgpu" || asrDevice === "wasm" ? asrDevice : webgpu && !/intel/i.test(vendor || "") ? "webgpu" : "wasm";
  return { judge, asr };
}

let facts = null;

/** What this browser has: { webgpu, vendor, architecture, deviceMemoryGb }. Asked once per page. */
export function deviceFacts() {
  facts ??= (async () => {
    const nav = globalThis.navigator || {};
    let adapter = null;
    try {
      adapter = nav.gpu ? await nav.gpu.requestAdapter() : null;
    } catch {}
    return { webgpu: !!adapter, vendor: adapter?.info?.vendor || "", architecture: adapter?.info?.architecture || "", deviceMemoryGb: nav.deviceMemory || null };
  })();
  return facts;
}

/** Forget the cached facts (tests). */
export function resetDeviceFacts() {
  facts = null;
}

/** The runtimes for this browser, with the person's preferences. */
export async function runtimes({ prefer = "auto", asrDevice = "auto" } = {}) {
  return chooseRuntimes({ ...(await deviceFacts()), prefer, asrDevice });
}
