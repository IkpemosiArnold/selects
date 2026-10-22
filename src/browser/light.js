// Light mode: for slow or metered connections (Lagos mobile data) and phones. The audio is
// compressed on the device and transcribed by a free hosted whisper; the judge is Smart
// mode's (text only); the clips are rendered on the device. The video never leaves.
//
// suggestMode is the rule for which mode to suggest, pure so it is tested in Node:
//   - Private stays the default whenever the speech model is already in this browser.
//   - Otherwise Light is suggested when the browser reports Data Saver, a 2G or 3G
//     connection, or under 1.5 Mbps; when the speech model would take over a minute to
//     download at the reported speed; or on an iPhone or iPad (a 140 to 209 MB model in a
//     Safari tab is where downloads and memory fail).
//   - With no signal either way, Private stays the default.

export const SLOW_MBPS = 1.5;
export const SLOW_DOWNLOAD_SEC = 60;

/** iPhone, iPad (which reports itself as a Mac with touch) or iPod. */
export function isIos(nav = globalThis.navigator) {
  const ua = String(nav?.userAgent || "");
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints || 0) > 1);
}

/**
 * @param {{ connection?: object, ios?: boolean, asrCached?: boolean|null, asrBytes?: number, lightAvailable?: boolean }} facts
 * @returns {{ mode: "light" | "private", reasons: string[], estSec: number|null }}
 */
export function suggestMode({ connection = null, ios = false, asrCached = null, asrBytes = 140e6, lightAvailable = true } = {}) {
  const mbps = Number(connection?.downlink) > 0 ? Number(connection.downlink) : null;
  const estSec = mbps ? Math.round((asrBytes * 8) / (mbps * 1e6)) : null;
  if (!lightAvailable || asrCached === true) return { mode: "private", reasons: asrCached ? ["the speech model is already in this browser"] : [], estSec };
  const reasons = [];
  if (connection?.saveData) reasons.push("Data Saver is on");
  if (/^(slow-2g|2g|3g)$/.test(String(connection?.effectiveType || ""))) reasons.push(`the connection looks like ${String(connection.effectiveType).toUpperCase()}`);
  if (mbps != null && mbps < SLOW_MBPS) reasons.push(`the connection is about ${mbps} Mbps`);
  if (estSec != null && estSec > SLOW_DOWNLOAD_SEC && !reasons.length) reasons.push(`the speech model would take about ${Math.round(estSec / 60) || 1} min to download`);
  if (ios) reasons.push("this is an iPhone or iPad");
  return { mode: reasons.length ? "light" : "private", reasons, estSec };
}

/**
 * Whether this browser already holds whisper's files (transformers.js keeps them in Cache
 * Storage, keyed by their Hugging Face URL). Looks in every cache, so it still works if the
 * cache's name changes. null when the browser cannot say.
 */
export async function speechModelCached(modelId) {
  try {
    if (typeof caches === "undefined") return null;
    for (const name of await caches.keys()) {
      const c = await caches.open(name);
      const keys = await c.keys();
      if (keys.some((r) => r.url.includes(modelId) && /encoder_model/.test(r.url)) && keys.some((r) => r.url.includes(modelId) && /decoder_model/.test(r.url))) return true;
    }
    return false;
  } catch {
    return null;
  }
}

const woken = new Map();
/**
 * Fire-and-forget GET /healthz on page load, so a free server that sleeps when idle is awake
 * by the time a video is picked. Resolves { ok, sec, light } and never throws.
 */
export function wakeProxy(url, { fetchImpl = globalThis.fetch, now = () => performance.now() } = {}) {
  if (!url) return Promise.resolve({ ok: false, sec: 0, light: false });
  const base = url.replace(/\/+$/, "");
  if (!woken.has(base)) {
    const t0 = now();
    woken.set(base, fetchImpl(`${base}/healthz`, { credentials: "omit", cache: "no-store" })
      .then((r) => r.json().then((j) => ({ ok: r.ok, light: !!j.light, sec: +((now() - t0) / 1000).toFixed(1) })))
      .catch(() => ({ ok: false, light: false, sec: +((now() - t0) / 1000).toFixed(1) })));
  }
  return woken.get(base);
}
