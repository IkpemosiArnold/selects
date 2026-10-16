// Plays one window of a video and reports the time in source seconds. With no
// video (mock mode) it runs a clock so the prototypes still move.
import { useCallback, useEffect, useRef, useState } from "react";

export function useWindowPlayer({ src, start = 0, end = 0, offset = 0, loop = true }) {
  const ref = useRef(null);
  const [t, setT] = useState(start + offset);
  const [playing, setPlaying] = useState(false);
  const clock = useRef({ t: start, raf: 0, last: 0 });

  // Reset when the window changes.
  useEffect(() => {
    setT(start + offset);
    clock.current.t = start;
    const v = ref.current;
    if (v && src) {
      const seek = () => {
        try {
          v.currentTime = start;
        } catch {}
      };
      if (v.readyState >= 1) seek();
      else v.addEventListener("loadedmetadata", seek, { once: true });
    }
  }, [src, start, end, offset]);

  useEffect(() => {
    const v = ref.current;
    if (!v || !src) return;
    let last = 0;
    const onTime = () => {
      if (v.currentTime >= end - 0.03) {
        if (loop) v.currentTime = start;
        else v.pause();
      }
      const now = performance.now();
      if (now - last > 90) {
        last = now;
        setT(v.currentTime + offset);
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [src, start, end, offset, loop]);

  // Mock clock.
  useEffect(() => {
    if (src || !playing) return;
    const c = clock.current;
    c.last = performance.now();
    const step = (now) => {
      c.t += (now - c.last) / 1000;
      c.last = now;
      if (c.t >= end) {
        if (loop) c.t = start;
        else {
          setPlaying(false);
          return;
        }
      }
      setT(c.t + offset);
      c.raf = requestAnimationFrame(step);
    };
    c.raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(c.raf);
  }, [src, playing, start, end, offset, loop]);

  const play = useCallback(() => {
    const v = ref.current;
    if (src && v) v.play().catch(() => {});
    else setPlaying(true);
  }, [src]);
  const pause = useCallback(() => {
    const v = ref.current;
    if (src && v) v.pause();
    else setPlaying(false);
  }, [src]);
  const toggle = useCallback(() => (playing ? pause() : play()), [playing, play, pause]);
  const seek = useCallback(
    (sourceT) => {
      const local = sourceT - offset;
      const v = ref.current;
      if (src && v) v.currentTime = local;
      clock.current.t = local;
      setT(sourceT);
    },
    [src, offset]
  );

  return { ref, t, playing, play, pause, toggle, seek };
}
