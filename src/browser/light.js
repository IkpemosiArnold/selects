// Light mode: for slow or metered connections (Lagos mobile data) and phones. The audio is
// compressed on the device and transcribed by a free hosted whisper; the judge is Smart
// mode's (text only); the clips are rendered on the device. The video never leaves.
//
// suggestMode is the rule for which mode to suggest, pure so it is tested in Node:
//   - Private whenever the speech model is already in this browser (nothing to download).
//   - Otherwise Light, whenever it can run: the proxy confirmed its free shared transcriber is
//     on, or the person has given their own free Groq key. An unanswered or failed health
//     check is "unknown", never "on". Private is one tap away (opt-in).
//   - With neither, Private, as before.
// The reasons say why in plain words, from what the browser reports (Data Saver, 2G or 3G,
// the speed) or from a timed 1 MB probe where it reports nothing (Safari), and on iPhones.

import { providerRequest } from "../core/provider-request.mjs";

export const SLOW_MBPS = 1.5;
export const SLOW_DOWNLOAD_SEC = 60;

/** iPhone, iPad (which reports itself as a Mac with touch) or iPod. */
export function isIos(nav = globalThis.navigator) {
  const ua = String(nav?.userAgent || "");
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints || 0) > 1);
}

/**
 * @param {{ connection?: object, probeMbps?: number|null, ios?: boolean, asrCached?: boolean|null, asrBytes?: number, lightAvailable?: boolean }} facts
 * @returns {{ mode: "light" | "private", reasons: string[], estSec: number|null, mbps: number|null }}
 */
export function suggestMode({ connection = null, probeMbps = null, ios = false, asrCached = null, asrBytes = 140e6, lightAvailable = true } = {}) {
  const reported = Number(connection?.downlink) > 0 ? Number(connection.downlink) : null;
  const mbps = reported ?? (Number(probeMbps) > 0 ? +Number(probeMbps).toFixed(1) : null);
  const estSec = mbps ? Math.round((asrBytes * 8) / (mbps * 1e6)) : null;
  if (asrCached === true) return { mode: "private", reasons: ["the speech model is already in this browser"], estSec, mbps };
  if (!lightAvailable) return { mode: "private", reasons: [], estSec, mbps };
  const reasons = [];
  if (connection?.saveData) reasons.push("Data Saver is on");
  if (/^(slow-2g|2g|3g)$/.test(String(connection?.effectiveType || ""))) reasons.push(`the connection looks like ${String(connection.effectiveType).toUpperCase()}`);
  else if (mbps != null && mbps < SLOW_MBPS) reasons.push(`the connection is about ${mbps} Mbps`);
  if (estSec != null && estSec > SLOW_DOWNLOAD_SEC && !reasons.length) reasons.push(`the speech model would take about ${Math.round(estSec / 60) || 1} min to download here`);
  if (ios) reasons.push("this is an iPhone or iPad");
  if (!reasons.length) reasons.push(`the speech model (${Math.round(asrBytes / 1e6)} MB) is not in this browser yet`);
  return { mode: "light", reasons, estSec, mbps };
}

/**
 * Time a 1 MB download (an HTTP Range request) to estimate the speed where the browser does
 * not report one (Safari, Firefox). Resolves Mbps, or null when it cannot tell. Used once,
 * only when the speech model is not cached, so the page can say how long Private would take.
 * It never reads more than `bytes`: only a 206 (partial) answer is read, through a reader that
 * is cancelled at the cap (provider-request.mjs); a 200 (the whole file) is cancelled unread.
 */
export async function measureDownlink(url, { bytes = 1 << 20, fetchImpl = (...a) => globalThis.fetch(...a), now = () => performance.now(), timeoutMs = 20000 } = {}) {
  const t0 = now();
  try {
    const r = await providerRequest(url, { headers: { range: `bytes=0-${bytes - 1}` }, cache: "no-store", credentials: "omit" }, { deadlineMs: timeoutMs, maxBytes: bytes, overCap: "truncate", read: (res) => (res.status === 206 ? "bytes" : "none"), fetchImpl });
    if (r.status !== 206) return null;
    const sec = (now() - t0) / 1000;
    return r.bytes >= bytes / 4 && sec > 0 ? +((r.bytes * 8) / sec / 1e6).toFixed(2) : null;
  } catch (e) {
    // a timeout is an answer too: under bytes*8/timeout Mbps
    return e?.timeout ? +((bytes * 8) / (timeoutMs / 1000) / 1e6).toFixed(2) : null;
  }
}

// transformers.js names each ONNX file by its precision
const SUFFIX = { fp32: "", q8: "_quantized", int8: "_int8", uint8: "_uint8", q4: "_q4", q4f16: "_q4f16", fp16: "_fp16", bnb4: "_bnb4" };

/** The large files a speech model needs on this device: their Hugging Face URLs (the download store's keys). */
export function speechFileUrls(model, device = "wasm", hf = "https://huggingface.co") {
  const dtype = model?.dtype?.[device] || model?.dtype?.wasm || {};
  return Object.entries(dtype).map(([part, dt]) => `${hf}/${model.id}/resolve/main/onnx/${part}${SUFFIX[dt] ?? ""}.onnx`);
}

/**
 * Whether this browser already holds the speech model's large files: finished resumable
 * downloads in the origin private file system ("models", download.js), or a copy saved in
 * Cache Storage before resumable downloads existed. null when the browser cannot say.
 * openStore and openLegacy are replaceable in tests.
 */
export async function speechModelCached(model, device = "wasm", { openStore = null, openLegacy = null } = {}) {
  try {
    const urls = speechFileUrls(model, device);
    if (!urls.length) return null;
    const store = await (openStore ? openStore() : import("./download.js").then((m) => m.opfsStore()));
    const legacy = await (openLegacy ? openLegacy() : typeof caches === "undefined" ? null : caches.open("transformers-cache").catch(() => null));
    for (const url of urls) {
      const info = store ? await store.info(url).catch(() => null) : null;
      if (info?.meta?.done && info.meta.size === info.bytes) continue;
      if (legacy && (await legacy.match(url))) continue;
      return false;
    }
    return true;
  } catch {
    return null;
  }
}

const woken = new Map();

/** The shared transcriber from a health check: true or false when the proxy said so, null when unknown. */
export const lightState = (w) => (w?.reached && typeof w.light === "boolean" ? w.light : null);

/** Whether Light mode can run without asking: the person's own Groq key, or a shared transcriber the proxy confirmed. */
export const canRunLight = ({ own = false, proxyUrl = null, shared = null } = {}) => !!own || (!!proxyUrl && shared === true);

/**
 * Fire-and-forget GET /healthz on page load, so a free server that sleeps when idle is awake
 * by the time a file is picked. Resolves { ok, reached, sec, light } and never throws; light
 * is null unless the proxy answered.
 */
export function wakeProxy(url, { fetchImpl = globalThis.fetch, now = () => performance.now() } = {}) {
  if (!url) return Promise.resolve({ ok: false, sec: 0, light: null, reached: false });
  const base = url.replace(/\/+$/, "");
  if (!woken.has(base)) {
    const t0 = now();
    woken.set(base, fetchImpl(`${base}/healthz`, { credentials: "omit", cache: "no-store" })
      .then((r) => r.json().then((j) => ({ ok: r.ok, reached: r.ok, light: r.ok && typeof j?.light === "boolean" ? j.light : null, sec: +((now() - t0) / 1000).toFixed(1) })))
      // a failed check (offline, cold, refused by CORS) says nothing about the transcriber
      .catch(() => ({ ok: false, reached: false, light: null, sec: +((now() - t0) / 1000).toFixed(1) })));
  }
  return woken.get(base);
}
