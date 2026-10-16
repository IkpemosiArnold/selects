// Being kind to phones: keep the screen awake while Selects works, show progress in the
// tab title, and (only if the person opts in) notify when the clips are ready.
// Phones freeze background tabs, so none of this promises background work: the engine
// saves after every stage and picks up where it stopped when the tab comes back.

export const KEEP_OPEN = "Keep this tab open to finish faster. If you leave, it continues when you come back.";

/**
 * Hold a screen wake lock until release() is called, taking it again whenever the tab
 * becomes visible (the browser drops it when the tab is hidden). Returns { release, held }.
 */
export function keepAwake() {
  let lock = null;
  let active = true;
  const take = async () => {
    if (!active || document.visibilityState !== "visible" || !navigator.wakeLock) return;
    try {
      lock = await navigator.wakeLock.request("screen");
      lock.addEventListener?.("release", () => (lock = null));
    } catch {
      lock = null; // low battery, or not allowed: carry on without it
    }
  };
  const onVis = () => take();
  document.addEventListener("visibilitychange", onVis);
  take();
  return {
    held: () => !!lock,
    release() {
      active = false;
      document.removeEventListener("visibilitychange", onVis);
      lock?.release?.().catch(() => {});
      lock = null;
    },
  };
}

/** "42%: Selects" while working; the plain title when done. */
export function titleProgress(base = document.title || "Selects") {
  return {
    set(p, label) {
      document.title = p == null ? base : `${Math.round(p * 100)}%${label ? ` ${label}` : ""}: ${base}`;
    },
    reset() {
      document.title = base;
    },
  };
}

/** Ask once, from a button press. Resolves true when notifications are allowed. */
export async function enableNotifications() {
  if (!("Notification" in self)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

/** Notify only when allowed and the tab is not in front. On iOS this works only for an installed web app. */
export async function notifyDone(title, body) {
  try {
    if (!("Notification" in self) || Notification.permission !== "granted" || document.visibilityState === "visible") return false;
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg?.showNotification) await reg.showNotification(title, { body, icon: "icons/icon-192.png", tag: "selects-done" });
    else new Notification(title, { body, icon: "icons/icon-192.png", tag: "selects-done" });
    return true;
  } catch {
    return false;
  }
}

/** Register the service worker (app shell only) and say whether the app can be installed. */
export async function registerApp(url = "./sw.js") {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(url, { scope: "./" });
  } catch {
    return null;
  }
}
