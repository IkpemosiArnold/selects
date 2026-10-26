// Time left from a recent rate, not the average since the start. On a busy laptop the speed
// changes a lot (another app finishes, the machine cools down), and an ETA from the average
// since the start stayed about 3 times too high for an hour after the machine sped up.
// Browser-safe, no imports.

/**
 * Track progress through `total` units (seconds of audio, windows judged). Call update(done)
 * whenever a piece finishes; it returns { rate, etaSec, lowSec, highSec, steady }:
 *   rate     an exponential moving average of the recent pieces' rates (units per second)
 *   etaSec   what is left at that rate
 *   lowSec, highSec   what is left at the fastest and slowest of the last `window` pieces
 *   steady   true when those agree within `spread` (then one number is honest; otherwise
 *            show the range, or say "about")
 * now() is in milliseconds.
 */
export function rateTracker(total, { alpha = 0.35, window = 5, spread = 1.35, now = () => Date.now(), startDone = 0 } = {}) {
  let last = { t: now(), done: startDone };
  let ema = null;
  const recent = [];
  return {
    update(done) {
      const t = now();
      const dt = (t - last.t) / 1000;
      const dd = done - last.done;
      if (dt > 0 && dd > 0) {
        const r = dd / dt;
        ema = ema == null ? r : alpha * r + (1 - alpha) * ema;
        recent.push(r);
        if (recent.length > window) recent.shift();
      }
      last = { t, done };
      return this.estimate(done);
    },
    estimate(done = last.done) {
      const left = Math.max(0, total - done);
      if (!ema) return { rate: null, etaSec: null, lowSec: null, highSec: null, steady: false };
      const fast = Math.max(...recent);
      const slow = Math.min(...recent);
      return {
        rate: +ema.toFixed(4),
        etaSec: Math.round(left / ema),
        lowSec: Math.round(left / fast),
        highSec: Math.round(left / slow),
        steady: recent.length >= 2 && fast / slow <= spread,
      };
    },
  };
}

/**
 * Seconds left now, counted down from the last estimate: an estimate made `sinceSec` ago is
 * that much smaller, so the number moves every second between updates. Never below zero.
 */
export const countDown = (etaSec, sinceSec) => (etaSec == null ? null : Math.max(0, Math.round(etaSec - Math.max(0, sinceSec))));

/** "about 25 min" style text for seconds. */
export function aboutText(sec) {
  if (sec == null || !Number.isFinite(sec)) return null;
  if (sec < 50) return "less than a minute";
  const m = Math.round(sec / 60);
  if (m < 90) return m === 1 ? "about 1 minute" : `about ${m} minutes`;
  return `about ${(Math.round((sec / 3600) * 10) / 10)} hours`;
}

/**
 * Time left as text: one number when the speed is steady, a range when it is not (the fastest
 * and slowest recent pieces disagree by more than 30% and 2 minutes).
 */
export function leftText(sec, low = null, high = null) {
  if (sec == null) return null;
  if (low != null && high != null && high > low * 1.3 && high - low >= 120) {
    if (high >= 5400) return `about ${(low / 3600).toFixed(1)} to ${(high / 3600).toFixed(1)} hours left`;
    return `about ${Math.max(1, Math.round(low / 60))} to ${Math.max(1, Math.round(high / 60))} minutes left`;
  }
  return `${aboutText(sec)} left`;
}
