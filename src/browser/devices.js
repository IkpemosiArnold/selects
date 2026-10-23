// Which runtimes this browser uses: one choice, made in one place, for both what the page says
// it will download and what actually runs (the judge backend in llm.js, whisper's device and
// size in asr.js). chooseRuntimes is pure, so the rule is tested in Node.

import { MODELS } from "./models.js";

/** The judge on WebGPU (Gemma 4 E2B, 2 GB) needs at least this much device memory, when the browser says. */
export const MIN_GPU_MEMORY_GB = 4;
/** At or below this much memory (navigator.deviceMemory), whisper defaults to the smaller model. */
export const SMALL_SPEECH_MEMORY_GB = 4;

/**
 * Whether the in-tab LLM judge (Gemma 3 1B, 722 MB; Gemma 4 E2B, 2 GB) belongs on this device.
 * Not on iPhones and iPads: iOS closes a tab's process at a soft limit of about 1.5 GB
 * (WebKit bug 277848, 9 Aug 2024), and a 722 MB model on top of whisper crashed the tab in
 * WebKit; nor on devices reporting 4 GB of memory or less. A phone on mobile data must also
 * never start that download by itself. There, Private mode ranks by the first-stage score
 * and the rule-based cut checks.
 */
export function inTabJudgeFits(facts = {}) {
  return inTabJudgeWhyNot(facts) === null;
}

/**
 * Why the in-tab judge is not the default here: "phone", "memory", "one-thread" (Gemma 3 on
 * the processor without threads: Safari, which has never been cross-origin isolated, or any
 * page that is not; a 2-minute video then sat in judging for over 40 minutes), or null.
 */
export function inTabJudgeWhyNot({ ios = false, deviceMemoryGb = null, judge = null, multiThread = true } = {}) {
  if (ios) return "phone";
  if (deviceMemoryGb != null && deviceMemoryGb <= SMALL_SPEECH_MEMORY_GB) return "memory";
  if (judge === "gemma3-wasm" && !multiThread) return "one-thread";
  return null;
}

/** The one line a Private run shows when it ranked without the in-tab judge. */
export const JUDGE_NOTES = {
  phone: "Ranked by the first-stage score and the cut checks, without Gemma: it is too big for a phone's browser. Smart or Light mode adds Gemma's judgment.",
  memory: "Ranked by the first-stage score and the cut checks, without Gemma: this device has too little memory for it. Smart or Light mode adds Gemma's judgment.",
  "one-thread": "Ranked by the first-stage score and the cut checks, without Gemma: in this browser it runs on one processor thread and can take an hour. Smart or Light mode adds Gemma's judgment, or judge on this device.",
};

/** WebKit (Safari, and every browser on iOS): whisper and wllama run on one thread there. */
export const isWebKitUa = (ua = "") => /AppleWebKit/.test(ua) && !/Chrome\/|Chromium\/|Edg\/|Android/.test(ua);

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
export function chooseRuntimes({ webgpu = false, vendor = "", deviceMemoryGb = null, ios = false, multiThread = true, prefer = "auto", asrDevice = "auto", speech = "auto" } = {}) {
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
  const whyNot = inTabJudgeWhyNot({ ios, deviceMemoryGb, judge, multiThread });
  return { judge, asr, speech: size, inTabJudge: whyNot === null, inTabJudgeWhyNot: whyNot };
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
    // threads need cross-origin isolation, and WebKit stays on one thread even then (asr.worker.js)
    const multiThread = !!globalThis.crossOriginIsolated && !isWebKitUa(nav.userAgent || "");
    return { webgpu: !!adapter, vendor: adapter?.info?.vendor || "", architecture: adapter?.info?.architecture || "", deviceMemoryGb: nav.deviceMemory || null, ios: isAppleMobile(nav.userAgent || "", nav.maxTouchPoints || 0), multiThread };
  })();
  return facts;
}

/** Forget the cached facts (tests). */
export function resetDeviceFacts() {
  facts = null;
}

/** Whether this device runs the in-tab judge by default: { fits, why, note } (inTabJudgeWhyNot). */
export async function canJudgeInTab({ prefer = "auto" } = {}) {
  const rt = await runtimes({ prefer });
  const bytes = MODELS[rt.judge === "gemma4-webgpu" ? "gemma4" : "gemma3"].bytes;
  return { fits: rt.inTabJudge, why: rt.inTabJudgeWhyNot, note: rt.inTabJudgeWhyNot ? JUDGE_NOTES[rt.inTabJudgeWhyNot] : null, bytes };
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
