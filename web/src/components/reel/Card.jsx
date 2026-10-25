// One clip as it will be posted: 9:16, the same crop or fit the render uses,
// and the captions the render will burn in, in the same style. The frame has
// a fixed shape and a still behind it, so nothing moves while the video loads.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../lib/api.js";
import { usePlayerTime, usePlaying } from "../../lib/player.js";
import { burnAt, clipCues, display } from "../../lib/burn.js";
import { thumbAt } from "./util.js";
import { AUDIOGRAM_PRESETS, audiogramSettings, isAudioJob, paintStill, presetThumb, useCoverImage, useLevels } from "../../lib/audiogram.js";
import { paintMoving } from "../../../../src/core/audiogram.mjs";

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

// The still under the play position, where there is no video (the mock). Kept apart
// so the card itself does not render again on every tick of the player.
function StillAt({ job, player }) {
  const t = usePlayerTime(player);
  return <img className="card-media" src={thumbAt(job, t)} alt="" draggable={false} />;
}

// How far into the clip the player is: written straight on the bar, without a render.
// About 15 times a second, as before; every frame would repaint the card 60 times a second.
function Progress({ player, start, end }) {
  const ref = useRef(null);
  useEffect(() => {
    const len = Math.max(0.1, end - start);
    const draw = () => {
      if (ref.current) ref.current.style.transform = `scaleX(${Math.min(1, Math.max(0, (player.time - start) / len)).toFixed(4)})`;
    };
    draw();
    return player.subscribe(draw);
  }, [player, start, end]);
  return <span className="card-progress" ref={ref} aria-hidden="true" />;
}

/**
 * The audiogram preview: the background painted once, then the meter and the mouth painted
 * on every frame from the clip's measured loudness, at the player's time.
 */
function AudiogramStage({ job, clip, player }) {
  const ref = useRef(null);
  const still = useRef(null);
  const cover = useCoverImage(job);
  const env = useLevels(job, clip.start, clip.end);
  const a = audiogramSettings(job.settings);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.min(540, Math.round((c.clientWidth || 300) * dpr));
    const h = Math.round((w * 16) / 9);
    c.width = w;
    c.height = h;
    const bgc = document.createElement("canvas");
    bgc.width = w;
    bgc.height = h;
    const bg = paintStill(bgc.getContext("2d"), job, w, h, cover);
    still.current = bgc;
    const ctx = c.getContext("2d");
    const draw = () => {
      ctx.drawImage(bgc, 0, 0);
      paintMoving(ctx, { env, t: env ? player.time - env.start : 0, W: w, H: h, bg });
    };
    draw();
    return player.onFrame(draw);
  }, [job.id, a.bg, job.settings?.audiogram?.coverAt, cover, env, player]); // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas ref={ref} className="card-media card-audiogram" aria-hidden="true" />;
}

/** Choose the audiogram's background: six drawn characters, or your own image (it stays on this device). */
export function BackgroundPicker({ job }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);
  const a = audiogramSettings(job.settings);
  const choose = async (bg) => {
    setErr(null);
    try {
      await api.patchJob(job.id, { audiogram: { bg } });
    } catch (e) {
      setErr(e.message);
    }
  };
  return (
    <div className={"bg-picker" + (open ? " is-open" : "")}>
      {open && (
        <div className="bg-tray" role="group" aria-label="Background">
          {AUDIOGRAM_PRESETS.map((p) => (
            <button key={p.id} type="button" className={"bg-swatch" + (a.bg === p.id ? " is-on" : "")} aria-pressed={a.bg === p.id} aria-label={p.label} title={p.label} onClick={() => choose(p.id)}>
              <img src={presetThumb(p.id) || undefined} alt="" draggable={false} />
            </button>
          ))}
          {api.setCover && (
            <button type="button" className={"bg-swatch is-own" + (a.bg === "cover" ? " is-on" : "")} aria-pressed={a.bg === "cover"} aria-label="Your image" title="Your image. It stays on this device." onClick={() => fileRef.current?.click()}>
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M9 3.5v11M3.5 9h11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              setErr(null);
              try {
                await api.setCover(job.id, f);
              } catch (e2) {
                setErr(e2.message);
              }
            }}
          />
        </div>
      )}
      {err && open && <p className="bg-err" role="alert">{err}</p>}
      <button type="button" className="card-play bg-toggle" aria-expanded={open} aria-label={open ? "Close backgrounds" : "Background"} title="Background" onClick={() => setOpen((v) => !v)}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="2.5" y="2.5" width="13" height="13" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" /><circle cx="7" cy="7" r="1.6" fill="currentColor" /><path d="M3.5 13.5l3.6-3.8 2.6 2.4 2.2-2.1 2.6 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
      </button>
    </div>
  );
}

export default function Card({ job, clip, player, cues, captionsOn = true, lowP = null, frameRef, onNatural, children, label }) {
  const videoRef = useRef(null);
  const src = api.sourceUrl(job.id);
  const playing = usePlaying(player);
  const muted = useSyncExternalStore(player.subscribe, () => player.mutedByPolicy);
  const [missing, setMissing] = useState(false);
  const audio = isAudioJob(job);
  const fit = !audio && reframeOf(job, clip) === "fit";
  const poster = audio ? null : thumbAt(job, clip.start + 0.4);

  useEffect(() => {
    if (src) player.attach(videoRef.current);
    return () => player.attach(null);
  }, [player, src]);

  return (
    <div className={"card-frame" + (fit ? " is-fit" : "") + (audio ? " is-audiogram" : "")} ref={frameRef} role="group" aria-label={label}>
      {poster && <img className="card-backdrop" src={poster} alt="" draggable={false} />}
      {audio && <AudiogramStage job={job} clip={clip} player={player} />}
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
          <p>Selects can't find the {audio ? "recording" : "video"}. Put it back here:</p>
          <p className="mono">{job.source?.path}</p>
        </div>
      ) : (
        poster && <StillAt job={job} player={player} />
      )}
      {captionsOn && <BurnCaptions cues={cues} start={clip.start} end={clip.end} player={player} lowP={lowP} />}
      {children}
      <div className="card-controls">
        <button type="button" className="card-play" onClick={() => player.toggle()} aria-label={playing ? "Pause, Space" : "Play, Space"}>
          <PlayIcon playing={playing} />
        </button>
        {audio && <BackgroundPicker job={job} />}
        {muted && (
          <button type="button" className="card-sound" onClick={() => player.unmute()}>
            Sound is off. Turn it on
          </button>
        )}
      </div>
      <Progress player={player} start={clip.start} end={clip.end} />
    </div>
  );
}
