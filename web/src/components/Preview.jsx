import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { tc } from "../lib/time.js";
import { wordsIn } from "../lib/sentences.js";
import { usePlayerTime, usePlaying } from "../lib/player.js";
import { frameSvg } from "../mock/frames.js";

// Captions as the render will burn them: 2 to 4 words at a time, never across
// a sentence end, current word in marker yellow.
function chunk(words, idxs) {
  const out = [];
  let cur = [];
  for (const i of idxs) {
    cur.push(i);
    const w = words[i].w;
    if (cur.length >= 3 || /[.?!,;:]$/.test(w)) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

function Captions({ words, chunks, player }) {
  const t = usePlayerTime(player);
  let k = -1;
  for (let i = 0; i < chunks.length; i++) {
    if (words[chunks[i][0]].s <= t + 0.05) k = i;
    else break;
  }
  if (k < 0) return null;
  const c = chunks[k];
  if (t > words[c[c.length - 1]].e + 0.8) return null;
  return (
    <p className="captions" aria-hidden="true">
      {c.map((i) => (
        <span key={i} className={words[i].s <= t + 0.03 && t < (words[i + 1]?.s ?? words[i].e + 0.3) ? "cw is-on" : "cw"}>
          {words[i].w.replace(/[,;:]$/, "")}{" "}
        </span>
      ))}
    </p>
  );
}

function MockFrame({ player, duration }) {
  const t = usePlayerTime(player);
  const idx = Math.min(60, Math.floor((t / duration) * 60) + 1);
  const playing = usePlaying(player);
  return <img className={"pv-media mock-media" + (playing ? " is-playing" : "")} src={frameSvg(idx, 60)} alt="" draggable={false} />;
}

// The blurred backdrop behind a "fit" frame, from the nearest filmstrip
// thumbnail, so the preview costs one video decode, not two.
function Backdrop({ job, player }) {
  const t = usePlayerTime(player);
  const count = job.thumbs?.count || 60;
  const interval = job.thumbs?.interval || (job.source?.duration || 1) / count;
  const n = Math.min(count, Math.max(1, Math.floor(t / interval) + 1));
  return <img className="pv-backdrop" src={api.thumbUrl(job.id, n)} alt="" draggable={false} />;
}

// What the render will do: a clip already rendered says; a source that is not
// landscape is always fit; otherwise the core decides from motion, so crop is
// the best guess and the toggle lets you look at both.
function defaultReframe(job, c) {
  if (c?.render?.reframe) return c.render.reframe === "fit" ? "fit" : "crop";
  const w = job.source?.displayWidth || job.source?.width;
  const h = job.source?.height;
  return w && h && w / h < 1.2 ? "fit" : "crop";
}

export default function Preview({ job, words, candidate, player }) {
  const videoRef = useRef(null);
  const [safe, setSafe] = useState(false);
  const auto = defaultReframe(job, candidate);
  const [reframeChoice, setReframe] = useState(null);
  const reframe = reframeChoice || auto;
  const [mediaError, setMediaError] = useState(false);
  const src = api.sourceUrl(job.id);
  const playing = usePlaying(player);
  const t = usePlayerTime(player);

  useEffect(() => {
    if (src) player.attach(videoRef.current);
    return () => player.attach(null);
  }, [player, src]);

  const chunks = useMemo(() => {
    if (!candidate || !words.length) return [];
    return chunk(words, wordsIn(words, candidate.start, candidate.end));
  }, [words, candidate?.start, candidate?.end]);

  if (!candidate) return <div className="preview is-empty" />;
  const len = candidate.end - candidate.start;
  const into = Math.max(0, Math.min(len, t - candidate.start));

  return (
    <div className="preview">
      <div className="pv-frame" data-playing={playing || undefined} data-reframe={reframe}>
        {reframe === "fit" && <Backdrop job={job} player={player} />}
        {src && !mediaError ? (
          <video
            ref={videoRef}
            className="pv-media"
            src={src}
            preload="metadata"
            playsInline
            onError={() => setMediaError(true)}
            onClick={() => player.toggle()}
          />
        ) : src && mediaError ? (
          <div className="pv-missing">
            <p>The source video is not where it was. Move it back to</p>
            <p className="mono">{job.source?.path}</p>
          </div>
        ) : (
          <MockFrame player={player} duration={job.source?.duration || 1} />
        )}
        <Captions words={words} chunks={chunks} player={player} />
        {safe && (
          <div className="safe-zone" aria-hidden="true">
            <span>Platform buttons</span>
          </div>
        )}
        <button type="button" className="pv-hit" aria-label={playing ? "Pause" : "Play"} onClick={() => player.toggle()} />
      </div>
      <div className="pv-controls">
        <button type="button" className="btn btn-icon btn-on-film" onClick={() => player.toggle()} aria-label={playing ? "Pause, Space" : "Play, Space"}>
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" fill="currentColor" /><rect x="9.5" y="2" width="3.5" height="12" fill="currentColor" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2l10 6-10 6z" fill="currentColor" /></svg>
          )}
        </button>
        <div className="pv-scrub" role="presentation">
          <div className="pv-scrub-fill" style={{ transform: `scaleX(${len ? into / len : 0})` }} />
          <input
            type="range"
            min={0}
            max={Math.max(0.1, len)}
            step={0.1}
            value={into}
            aria-label="Position in clip"
            aria-valuetext={`${tc(into)} of ${tc(len)}`}
            onChange={(e) => player.seek(candidate.start + Number(e.target.value))}
          />
        </div>
        <span className="pv-time mono">
          {tc(into)}<span className="dim"> / {tc(len)}</span>
        </span>
      </div>
      <div className="pv-options">
        <div className="seg" role="group" aria-label="Reframe">
          {["crop", "fit"].map((m) => (
            <button key={m} type="button" className={"seg-btn" + (reframe === m ? " is-on" : "")} aria-pressed={reframe === m} onClick={() => setReframe(m)}>
              {m === "crop" ? "Crop" : "Fit"}
            </button>
          ))}
        </div>
        <button type="button" className={"btn btn-chip btn-on-film" + (safe ? " is-on" : "")} aria-pressed={safe} onClick={() => setSafe((s) => !s)}>
          Safe zone
        </button>
      </div>
      <p className="pv-note">
        {candidate.render?.reframe
          ? `Rendered with ${candidate.render.reframe === "fit" ? "fit" : "crop"}.`
          : auto === "fit"
          ? "This source is not wide, so the render will fit it."
          : "The render crops when the speaker stays central, and fits otherwise."}
      </p>
    </div>
  );
}
