// Which runtimes this browser uses: one choice, made in one place, for both what the page says
// it will download and what actually runs (the judge backend in llm.js, whisper's device and
// size in asr.js). chooseRuntimes is pure, so the rule is tested in Node.

/** The judge on WebGPU (Gemma 4 E2B, 2 GB) needs at least this much device memory, when the browser says. */
export const MIN_GPU_MEMORY_GB = 4;
/** At or below this much memory (navigator.deviceMemory), whisper defaults to the smaller model. */
export const SMALL_SPEECH_MEMORY_GB = 4;

/** iPhone, iPad (which reports itself as a Mac with a touch screen) or iPod. */
export function isAppleMobile(ua = "", maxTouchPoints = 0) {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

/**
 * @param {{ webgpu?: boolean, vendor?: string, deviceMemoryGb?: number|null, ios?: boolean, prefer?: string, asrDevice?: string, speech?: string }} facts
 *   prefer: "auto" | "gemma4-webgpu" | "gemma3-wasm" (the judge); asrDevice: "auto" | "webgpu" | "wasm";
 *   speech: "auto" | "base" | "tiny" (whisper's size)
 * @returns {{ judge: "gemma4-webgpu" | "gemma3-wasm", asr: "webgpu" | "wasm", speech: "base" | "tiny" }}
 */
export function chooseRuntimes({ webgpu = false, vendor = "", deviceMemoryGb = null, ios = false, prefer = "auto", asrDevice = "auto", speech = "auto" } = {}) {
  const memOk = !deviceMemoryGb || deviceMemoryGb >= MIN_GPU_MEMORY_GB;
  // An iPhone or iPad tab is closed by iOS long before the device's memory is used up, and
  // Safari does not say how much memory there is, so the 2 GB WebGPU judge is not the default there
  const judge = prefer === "gemma4-webgpu" || prefer === "gemma3-wasm" ? prefer : webgpu && memOk && !ios ? "gemma4-webgpu" : "gemma3-wasm";
  // On an Intel integrated GPU whisper ran 2.4 times slower than on the CPU (2017 MacBook Pro,
  // notes/timings.md), so "auto" keeps whisper on the CPU there. On iOS it stays on the CPU
  // too: the WebAssembly path is the one tested in WebKit, and the WebGPU build of whisper
  // needs a 4-bit decoder that is 70 MB bigger to download
  const asr = asrDevice === "webgpu" || asrDevice === "wasm" ? asrDevice : webgpu && !ios && !/intel/i.test(vendor || "") ? "webgpu" : "wasm";
  // phones and small-memory devices get the smaller whisper unless the person picks the bigger one
  const small = ios || (deviceMemoryGb != null && deviceMemoryGb <= SMALL_SPEECH_MEMORY_GB);
  const size = speech === "base" || speech === "tiny" ? speech : small ? "tiny" : "base";
  return { judge, asr, speech: size };
}

let facts = null;

/** What this browser has: { webgpu, vendor, architecture, deviceMemoryGb, ios }. Asked once per page. */
export function deviceFacts() {
  facts ??= (async () => {
    const nav = globalThis.navigator || {};
    let adapter = null;
    try {
      adapter = nav.gpu ? await nav.gpu.requestAdapter() : null;
    } catch {}
    return { webgpu: !!adapter, vendor: adapter?.info?.vendor || "", architecture: adapter?.info?.architecture || "", deviceMemoryGb: nav.deviceMemory || null, ios: isAppleMobile(nav.userAgent || "", nav.maxTouchPoints || 0) };
  })();
  return facts;
}

/** Forget the cached facts (tests). */
export function resetDeviceFacts() {
  facts = null;
}

/** The runtimes for this browser, with the person's preferences. */
export async function runtimes({ prefer = "auto", asrDevice = "auto", speech = "auto" } = {}) {
  return chooseRuntimes({ ...(await deviceFacts()), prefer, asrDevice, speech });
}

/**
 * What a download would cost on this connection, from the Network Information API where the
 * browser has it (Chrome on Android and desktop; not Safari or Firefox).
 * Returns { bytes, estSec, mbps, metered, warning }: estSec is null when the speed is unknown
 * (Chrome reports at most 10 Mbps, so on a fast line it is an upper bound), metered is true on
 * mobile data or with Data Saver on.
 */
export function downloadAdvice(bytes, connection = globalThis.navigator?.connection) {
  const mbps = Number(connection?.downlink) > 0 ? Number(connection.downlink) : null;
  const estSec = mbps ? Math.round((bytes * 8) / (mbps * 1e6)) : null;
  const cellular = connection?.type === "cellular";
  const saveData = !!connection?.saveData;
  const metered = cellular || saveData;
  const size = bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
  const warning = cellular
    ? `This looks like mobile data. The download is ${size}; use Wi-Fi if your data plan is limited.`
    : saveData
      ? `Data Saver is on. The download is ${size}; use Wi-Fi if your data plan is limited.`
      : null;
  return { bytes, estSec, mbps, metered, warning };
}
