// Early picks while Selects is still listening: after the first few minutes, the best 1 to 3
// moments so far by the first-stage score (no model yet). Each is previewed here by playing
// that stretch of the video itself with its words drawn on top; nothing is rendered or
// uploaded. Gemma's ranking replaces them when the whole video has been heard.
import { useEffect, useRef, useState } from "react";
import { tc } from "../lib/time.js";
import { api } from "../lib/api.js";

const CUE_WORDS = 7;

/** The caption line at time t: the group of about seven words that holds it. */
export function cueAt(words, start, end, t) {
  const inside = words.filter((w) => w.s >= start - 0.05 && w.e <= end + 0.05);
  const i = inside.findIndex((w) => w.e >= t);
  if (i < 0) return "";
  const from = Math.floor(i / CUE_WORDS) * CUE_WORDS;
  return inside.slice(from, from + CUE_WORDS).map((w) => w.w).join(" ");
}

export default function EarlyPicks({ job, words }) {
  const pre = job.preliminary;
  const [playing, setPlaying] = useState(null);
  const [cue, setCue] = useState("");
  const videoRef = useRef(null);
  const src = api.sourceUrl?.(job.id) || null;
  const picks = pre?.picks || [];

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !playing) return;
    const onTime = () => {
      setCue(cueAt(words, playing.start, playing.end, v.currentTime));
      if (v.currentTime >= playing.end) {
        v.pause();
        setPlaying(null);
      }
    };
    v.addEventListener("timeupdate", onTime);
    v.currentTime = playing.start;
    v.play().catch(() => {});
    return () => v.removeEventListener("timeupdate", onTime);
  }, [playing, words]);

  if (!picks.length) return null;
  return (
    <section className="early-picks" aria-label="Early picks">
      <p className="proc-page-head">Early picks from the first {tc(pre.upTo)}</p>
      <p className="field-hint">Ranked by the first-stage score (sentence shape, pauses, loudness), before Gemma has read anything. Gemma's ranking replaces them when the whole video has been heard. Nothing is rendered yet.</p>
      {src && (
        <div className={"early-player" + (playing ? " is-on" : "")} hidden={!playing}>
          <video ref={videoRef} src={src} playsInline preload="metadata" />
          {cue && <p className="early-cue">{cue}</p>}
        </div>
      )}
      <ol className="early-list">
        {picks.map((p, i) => (
          <li key={`${p.start}-${p.end}`} className="early-pick">
            <span className="early-n mono">{i + 1}</span>
            <div className="early-body">
              <p className="early-hook">&ldquo;{p.hook}&rdquo;</p>
              <p className="early-meta mono">{tc(p.start)} to {tc(p.end)}, {Math.round(p.end - p.start)} s</p>
            </div>
            {src && (
              <button type="button" className="btn" onClick={() => (playing?.start === p.start ? (videoRef.current?.pause(), setPlaying(null)) : setPlaying(p))}>
                {playing?.start === p.start ? "Stop" : "Preview"}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
