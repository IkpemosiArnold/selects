// Plain words for a speech model that would not load. The raw error crosses from the worker
// as { name, message, kind?, status?, loaded?, total? }; Safari's own text for a failed fetch
// is only "Load failed", which says nothing about what to do next.

const mbs = (b) => Math.round(b / 1e6);

const NETWORK = /load failed|failed to fetch|networkerror|network connection was lost|network error|appears to be offline|connection (was )?(reset|refused|closed)|err_network|timed out|the operation couldn.t be completed/i;
const MEMORY = /out of memory|\boom\b|bad_alloc|allocation failed|failed to allocate|cannot allocate|memory access out of bounds|could not allocate|maximum call stack/i;
const BLOCKED = /cross-origin|cors|access control|not allowed by|blocked|crossoriginisolated|sharedarraybuffer is not defined/i;
const UNSUPPORTED = /no available backend|webassembly is not defined|not supported|unsupported|unimplemented|webgpu is not|requestadapter/i;

/**
 * { kind, message, hint } for a model load failure.
 * kind: network | quota | memory | blocked | integrity | http | unsupported | other
 */
export function explainModelError(err = {}, { what = "speech model", sizeBytes = null } = {}) {
  const name = String(err.name || "");
  const text = `${name}: ${err.message || ""}`;
  const saved = err.loaded > 0 && err.total > 0 ? `${mbs(err.loaded)} of ${mbs(err.total)} MB is saved on this device` : null;
  const size = sizeBytes || err.total || null;

  if (err.kind === "quota" || name === "QuotaExceededError" || /quota/i.test(text)) {
    return {
      kind: "quota",
      message: `This device is out of room for the ${what}.`,
      hint: `It needs about ${size ? `${mbs(size)} MB` : "150 MB"} of storage. Free up space or add Selects to your Home Screen (Share, then Add to Home Screen), which gives it more room, then try again.`,
    };
  }
  if (err.kind === "integrity") {
    return { kind: "integrity", message: `The ${what} arrived damaged.`, hint: "The broken copy was deleted. Try again to download it fresh." };
  }
  if (err.kind === "http" && err.status) {
    const gone = err.status === 404 || err.status === 401 || err.status === 403;
    return {
      kind: "http",
      message: `Hugging Face did not send the ${what} (error ${err.status}).`,
      hint: gone ? "The model may have moved. Reload the page; if it happens again, Selects needs an update." : `Their servers may be busy. ${saved ? `${saved}. ` : ""}Try again in a few minutes.`,
    };
  }
  if (MEMORY.test(text) || name === "RangeError") {
    return { kind: "memory", message: "This device ran out of memory.", hint: "Close other apps and tabs, then try a shorter video or the smaller speech model." };
  }
  if (err.kind === "network" || NETWORK.test(text)) {
    return {
      kind: "network",
      message: `The connection dropped while getting the ${what}.`,
      hint: saved
        ? `${saved}. Press Try again on a steady connection, Wi-Fi if you can, and it carries on from there.`
        : "Press Try again on a steady connection, Wi-Fi if you can. Keep this tab open while it downloads.",
    };
  }
  if (name === "SecurityError" || BLOCKED.test(text)) {
    return { kind: "blocked", message: `The browser blocked the ${what} download.`, hint: "Reload the page and try again. Private browsing and content blockers can stop it; a normal tab works best." };
  }
  if (UNSUPPORTED.test(text)) {
    return { kind: "unsupported", message: `This browser cannot run the ${what}.`, hint: "Update the browser (on an iPhone, update iOS), or use Chrome or Edge on a computer." };
  }
  return { kind: "other", message: `The ${what} did not load: ${err.message || name || "no reason given"}.`, hint: "Reload the page and try again. Nothing was uploaded." };
}
