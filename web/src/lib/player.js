// A tiny playback store shared by the preview, the filmstrip playhead and the
// transcript. It plays one window [start, end] of the source and loops it.
// With a <video> attached it follows the element; in mock mode it runs a clock.
import { useEffect, useState, useSyncExternalStore } from "react";

export function createPlayer() {
  let time = 0;
  let playing = false;
  let win = { start: 0, end: 0 };
  let video = null;
  let raf = 0;
  let lastFrame = 0;
  let lastNotify = 0;
  let stopAt = null; // playSpan: pause here once, then forget it
  const subs = new Set(); // React subscribers, about 15 times a second
  const frameSubs = new Set(); // DOM subscribers, every frame

  const notify = (force) => {
    const now = performance.now();
    for (const f of frameSubs) f(time, playing);
    if (force || now - lastNotify > 66) {
      lastNotify = now;
      for (const f of subs) f();
    }
  };

  const loop = (now) => {
    if (!playing) return;
    if (video) {
      time = video.currentTime;
    } else {
      time += Math.min(0.1, (now - (lastFrame || now)) / 1000);
    }
    lastFrame = now;
    if (stopAt != null && time >= stopAt) {
      stopAt = null;
      api.pause();
      return;
    }
    if (win.end > win.start && time >= win.end) {
      time = win.start;
      if (video) video.currentTime = win.start;
    }
    notify(false);
    raf = requestAnimationFrame(loop);
  };

  const api = {
    get time() { return time; },
    get playing() { return playing; },
    get window() { return win; },
    attach(el) {
      video = el;
      if (el) {
        try { el.currentTime = time; } catch {}
      }
    },
    setWindow(start, end, { seek = true } = {}) {
      win = { start, end };
      if (seek || time < start || time > end) api.seek(start);
      else notify(true);
    },
    seek(t) {
      time = Math.max(0, t);
      if (video) {
        try { video.currentTime = time; } catch {}
      }
      notify(true);
    },
    play() {
      if (playing) return;
      if (time < win.start || time >= win.end - 0.05) api.seek(win.start);
      playing = true;
      lastFrame = 0;
      if (video) video.play().catch(() => { playing = false; notify(true); });
      raf = requestAnimationFrame(loop);
      notify(true);
    },
    // Play one stretch (a caption cue) and stop at its end.
    playSpan(s, e) {
      api.seek(Math.max(win.start, s));
      stopAt = e;
      if (!playing) {
        playing = true;
        lastFrame = 0;
        if (video) video.play().catch(() => { playing = false; notify(true); });
        raf = requestAnimationFrame(loop);
        notify(true);
      }
    },
    pause() {
      playing = false;
      cancelAnimationFrame(raf);
      if (video) video.pause();
      notify(true);
    },
    toggle() { stopAt = null; (playing ? api.pause : api.play)(); },
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    onFrame(f) { frameSubs.add(f); return () => frameSubs.delete(f); },
    destroy() { cancelAnimationFrame(raf); subs.clear(); frameSubs.clear(); },
  };
  return api;
}

export function usePlayerTime(player) {
  return useSyncExternalStore(player.subscribe, () => player.time);
}

export function usePlaying(player) {
  return useSyncExternalStore(player.subscribe, () => player.playing);
}

export function usePlayer() {
  const [p] = useState(createPlayer);
  useEffect(() => () => p.destroy(), [p]);
  return p;
}
