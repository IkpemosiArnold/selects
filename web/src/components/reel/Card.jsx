// One clip as it will be posted: 9:16, the same crop or fit the render uses,
// and the captions the render will burn in, in the same style. The frame has
// a fixed shape and a still behind it, so nothing moves while the video loads.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../lib/api.js";
import { usePlayerTime, usePlaying } from "../../lib/player.js";
import { burnAt, clipCues, display } from "../../lib/burn.js";
import { thumbAt } from "./util.js";

export function BurnCaptions({ cues, start, end, player, lowP = null }) {
  const t = usePlayerTime(player);
  const list = useMemo(() => clipCues(cues, start, end), [cues, start, end]);
  const hit = burnAt(list, t);
  if (!hit) return null;
  return (
    <div className="burn" aria-hidden="true">
      <p>
        {hit.cue.words.map((w, i) => (
          <span key={i} className={(i === hit.on ? "is-on" : "") + (lowP != null && w.p < lowP ? " is-unsure" : "")}>
            {display(w.w)}{" "}
          </span>
        ))}
      </p>
    </div>
  );
}

export function PlayIcon({ playing }) {
  return playing ? (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="0.5" fill="currentColor" /><rect x="9.5" y="2.5" width="3" height="11" rx="0.5" fill="currentColor" /></svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.6v10.8a.5.5 0 0 0 .76.43l8.6-5.4a.5.5 0 0 0 0-.86l-8.6-5.4a.5.5 0 0 0-.76.43z" fill="currentColor" /></svg>
  );
}

/** What the render will do: what it did if it ran, else fit for sources that are not wide. */
export function reframeOf(job, c) {
  if (c?.render?.reframe) return c.render.reframe === "fit" ? "fit" : "crop";
  if (c?.preview?.reframe) return c.preview.reframe === "fit" ? "fit" : "crop";
  // A trimmed clip has no render yet: the others from this video are the best guess.
  const done = (job.candidates || []).map((x) => x.render?.reframe || x.preview?.reframe).filter(Boolean);
  if (done.length) return done.filter((r) => r === "fit").length * 2 >= done.length ? "fit" : "crop";
  const w = job.source?.uprightWidth || job.source?.displayWidth || job.source?.width;
  const h = job.source?.uprightHeight || job.source?.height;
  return w && h && w / h < 1.2 ? "fit" : "crop";
}

export default function Card({ job, clip, player, cues, captionsOn = true, lowP = null, frameRef, onNatural, children, label }) {
  const videoRef = useRef(null);
  const src = api.sourceUrl(job.id);
  const playing = usePlaying(player);
  const muted = useSyncExternalStore(player.subscribe, () => player.mutedByPolicy);
  const t = usePlayerTime(player);
  const [missing, setMissing] = useState(false);
  const fit = reframeOf(job, clip) === "fit";
  const poster = thumbAt(job, clip.start + 0.4);

  useEffect(() => {
    if (src) player.attach(videoRef.current);
    return () => player.attach(null);
  }, [player, src]);

  const len = Math.max(0.1, clip.end - clip.start);
  const into = Math.min(1, Math.max(0, (t - clip.start) / len));

  return (
    <div className={"card-frame" + (fit ? " is-fit" : "")} ref={frameRef} role="group" aria-label={label}>
      {poster && <img className="card-backdrop" src={poster} alt="" draggable={false} />}
      {src && !missing ? (
        <video
          ref={videoRef}
          className="card-media"
          src={src}
          poster={fit ? undefined : poster || undefined}
          preload="auto"
          playsInline
          onError={() => setMissing(true)}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) onNatural?.({ w: v.videoWidth, h: v.videoHeight });
          }}
        />
      ) : src ? (
        <div className="card-missing">
          <p>The source video is not where it was. Move it back to</p>
          <p className="mono">{job.source?.path}</p>
        </div>
      ) : (
        poster && <img className="card-media" src={thumbAt(job, t)} alt="" draggable={false} />
      )}
      {captionsOn && <BurnCaptions cues={cues} start={clip.start} end={clip.end} player={player} lowP={lowP} />}
      {children}
      <div className="card-controls">
        <button type="button" className="card-play" onClick={() => player.toggle()} aria-label={playing ? "Pause, Space" : "Play, Space"}>
          <PlayIcon playing={playing} />
        </button>
        {muted && (
          <button type="button" className="card-sound" onClick={() => player.unmute()}>
            Sound is off. Turn it on
          </button>
        )}
      </div>
      <span className="card-progress" style={{ transform: `scaleX(${into})` }} aria-hidden="true" />
    </div>
  );
}
