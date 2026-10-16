// A thin strip along the bottom: the whole video, the model's interest curve
// in blue, and where each clip sits (blue proposed, yellow approved, red
// outline skipped). Click a clip to look at it again.
import { useMemo, useRef, useEffect } from "react";
import { tc } from "../../lib/time.js";
import { clipName } from "./util.js";

function curvePath(curve, dur, w, h) {
  if (!curve?.length || !dur) return null;
  const pts = curve.map((p) => [(p.t / dur) * w, h - Math.max(0, Math.min(1, p.v)) * (h - 2)]);
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const mx = (x0 + x1) / 2;
    d += ` C${mx.toFixed(1)},${y0.toFixed(1)} ${mx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return { line: d, area: `${d} L${pts[pts.length - 1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z` };
}

function Playhead({ player, dur }) {
  const ref = useRef(null);
  useEffect(
    () =>
      player.onFrame((t) => {
        if (ref.current) ref.current.style.transform = `translateX(${((t / dur) * 100).toFixed(3)}cqw)`;
      }),
    [player, dur]
  );
  return <span className="tl-head" ref={ref} aria-hidden="true" />;
}

export default function Timeline({ job, cands, currentId, onPick, player }) {
  const dur = job.source?.duration || 1;
  const W = 1000;
  const H = 28;
  const path = useMemo(() => curvePath(job.curve, dur, W, H), [job.curve, dur]);
  const ticks = useMemo(() => {
    const step = dur > 5400 ? 900 : dur > 1800 ? 300 : dur > 600 ? 120 : dur > 120 ? 60 : 10;
    const out = [];
    // leave room for the end time, which is always shown
    for (let t = 0; t <= dur - step * 0.6; t += step) out.push(t);
    return out;
  }, [dur]);
  const pct = (t) => `${(t / dur) * 100}%`;
  // With many clips the numbers collide: keep the best few, and the current one.
  const crowded = cands.length > 12;
  return (
    <nav className="timeline" aria-label="Clips in the video">
      <div className="tl-track">
        {path && (
          <svg className="tl-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            <path className="tl-area" d={path.area} />
            <path className="tl-line" d={path.line} vectorEffect="non-scaling-stroke" />
          </svg>
        )}
        <div className="tl-clips">
          {cands.map((c) => (
            <button
              key={c.id}
              type="button"
              className={"tl-clip is-" + c.status + (c.id === currentId ? " is-current" : "")}
              style={{ left: pct(c.start), width: pct(c.end - c.start) }}
              onClick={() => onPick(c.id)}
              aria-current={c.id === currentId ? "true" : undefined}
              aria-label={`${clipName(c)}, ${tc(c.start)} to ${tc(c.end)}, ${c.status === "proposed" ? "to check" : c.status}`}
            >
              {(!crowded || c.id === currentId || (c.rank && c.rank <= 5)) && (
                <span className="tl-n" aria-hidden="true">{c.rank ?? "+"}</span>
              )}
            </button>
          ))}
        </div>
        {player && <Playhead player={player} dur={dur} />}
      </div>
      <div className="tl-ticks" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t} style={{ left: pct(t) }}>
            {tc(t)}
          </span>
        ))}
        <span className="is-end" style={{ left: "100%" }}>{tc(dur)}</span>
      </div>
    </nav>
  );
}
