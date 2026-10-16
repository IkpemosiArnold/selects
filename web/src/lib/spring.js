// A small spring animator for element transforms. Springs start from the
// value on screen and keep their velocity when they are re-targeted, so a
// card grabbed mid-flight never jumps. No library: Selects runs offline and
// the whole motion budget is three moments (throw, settle, clap).
//
// Parameters follow Apple's two: response (seconds, how quickly it gets there)
// and damping ratio (1 = no overshoot, below 1 = some bounce).

const KEYS = ["x", "y", "scale", "rotate", "opacity"];

// ?slowmo=5 plays every spring five times slower, to judge the motion frame by frame.
export const SLOW = Math.max(1, Number(new URLSearchParams(location.search).get("slowmo")) || 1);
const DEFAULT = { x: 0, y: 0, scale: 1, rotate: 0, opacity: 1 };
const state = new WeakMap(); // element -> { v: values, vel: velocities, target, raf, opts, done }

function write(el, v) {
  el.style.transform = `translate3d(${v.x.toFixed(2)}px, ${v.y.toFixed(2)}px, 0) rotate(${v.rotate.toFixed(3)}deg) scale(${v.scale.toFixed(4)})`;
  el.style.opacity = v.opacity >= 0.999 ? "" : v.opacity.toFixed(3);
}

function entry(el) {
  let s = state.get(el);
  if (!s) {
    s = { v: { ...DEFAULT }, vel: { x: 0, y: 0, scale: 0, rotate: 0, opacity: 0 }, target: { ...DEFAULT }, raf: 0, opts: {}, done: null };
    state.set(el, s);
  }
  return s;
}

/** Jump to values with no motion (and zero velocity). */
export function setNow(el, values) {
  if (!el) return;
  const s = entry(el);
  cancelAnimationFrame(s.raf);
  s.raf = 0;
  Object.assign(s.v, values);
  Object.assign(s.target, values);
  for (const k of KEYS) s.vel[k] = 0;
  write(el, s.v);
}

/** The values on screen right now. */
export function current(el) {
  return el ? { ...entry(el).v } : { ...DEFAULT };
}

/**
 * Spring el toward `to`. Options: response (s), damping (ratio), velocity
 * (per key, units per second, added to what it already carries), onRest,
 * bounceStop { at, restitution } (a hard stop rotate bounces off: the clapper).
 */
export function springTo(el, to, opts = {}) {
  if (!el) return Promise.resolve();
  const s = entry(el);
  Object.assign(s.target, to);
  s.opts = { response: 0.3, damping: 1, ...opts };
  s.opts.response *= SLOW;
  if (opts.velocity) for (const k in opts.velocity) opts.velocity[k] /= SLOW;
  if (opts.velocity) for (const k in opts.velocity) s.vel[k] += opts.velocity[k];
  if (s.done) s.done(false); // the old promise resolves as interrupted
  return new Promise((resolve) => {
    s.done = (finished) => {
      s.done = null;
      resolve(finished);
    };
    if (s.raf) return; // already running: it simply follows the new target
    let last = performance.now();
    const step = (now) => {
      const { response, damping, bounceStop } = s.opts;
      const k = (2 * Math.PI / response) ** 2;
      const c = (4 * Math.PI * damping) / response;
      let dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      let moving = false;
      // a few sub-steps keep stiff springs stable at 60 Hz
      const n = 4;
      dt /= n;
      for (let i = 0; i < n; i++) {
        for (const key of KEYS) {
          const x = s.v[key];
          const a = -k * (x - s.target[key]) - c * s.vel[key];
          s.vel[key] += a * dt;
          s.v[key] += s.vel[key] * dt;
          if (bounceStop && key === "rotate" && s.v.rotate > bounceStop.at) {
            // the stick hits the slate and bounces back off it
            s.v.rotate = bounceStop.at;
            s.vel.rotate = -s.vel.rotate * bounceStop.restitution;
          }
        }
      }
      for (const key of KEYS) {
        const scale = key === "x" || key === "y" ? 0.5 : key === "rotate" ? 0.05 : 0.002;
        if (Math.abs(s.v[key] - s.target[key]) > scale || Math.abs(s.vel[key]) > scale * 4) moving = true;
      }
      if (!moving) {
        Object.assign(s.v, s.target);
        for (const key of KEYS) s.vel[key] = 0;
        write(el, s.v);
        s.raf = 0;
        s.opts.onRest?.();
        s.done?.(true);
        return;
      }
      write(el, s.v);
      s.raf = requestAnimationFrame(step);
    };
    s.raf = requestAnimationFrame(step);
  });
}

export function stop(el) {
  if (!el) return;
  const s = state.get(el);
  if (!s) return;
  cancelAnimationFrame(s.raf);
  s.raf = 0;
  s.done?.(false);
}
