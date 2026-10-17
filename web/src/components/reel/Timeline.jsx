// A thin strip along the bottom: the whole video, the model's interest curve
// in blue, and where each clip sits (blue proposed, yellow approved, red
// outline skipped). Click a clip to look at it again. With many clips on a
// long video, clips that would touch stack on lanes and only the rank numbers
// and times that fit are shown (marks.js).
import { memo, useMemo, useRef, useEffect, useLayoutEffect, useState } from "react";
import { tc } from "../../lib/time.js";
import { clipName } from "./util.js";
import { fitLabels, packLanes, tickTimes } from "./marks.js";
import "./many.css";

// Marker height and the gap between lanes, in px, for one, two or three lanes.
const LANE = [null, [14, 0], [6, 2], [4, 1]];

// The strip's width, read once and then from a ResizeObserver, so nothing reads layout per clip.
function useWidth(ref) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

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

function Timeline({ job, cands, currentId, onPick, player }) {
  const dur = job.source?.duration || 1;
  const W = 1000;
  const H = 28;
  const trackRef = useRef(null);
  const width = useWidth(trackRef);
  const path = useMemo(() => curvePath(job.curve, dur, W, H), [job.curve, dur]);
  const ticks = useMemo(() => tickTimes(dur, width), [dur, width]);
  const { lanes, lane } = useMemo(() => packLanes(cands, dur, width), [cands, dur, width]);
  const labels = useMemo(() => fitLabels(cands, dur, width, currentId), [cands, dur, width, currentId]);
  const [mh, gap] = LANE[lanes];
  const pct = (t) => `${(t / dur) * 100}%`;
  return (
    <nav className="timeline" aria-label="Clips in the video">
      <div className="tl-track" ref={trackRef}>
        {path && (
          <svg className="tl-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            <path className="tl-area" d={path.area} />
            <path className="tl-line" d={path.line} vectorEffect="non-scaling-stroke" />
          </svg>
        )}
        <div className={"tl-clips" + (lanes > 1 ? " is-laned" : "")}>
          {cands.map((c) => (
            <button
              key={c.id}
              type="button"
              className={"tl-clip is-" + c.status + (c.id === currentId ? " is-current" : "") + (lanes > 1 && lane[c.id] === lanes - 1 ? " is-top" : "")}
              style={{ left: pct(c.start), width: pct(c.end - c.start), ...(lanes > 1 ? { bottom: lane[c.id] * (mh + gap), height: mh } : null) }}
              onClick={() => onPick(c.id)}
              aria-current={c.id === currentId ? "true" : undefined}
              aria-label={`${clipName(c)}, ${tc(c.start)} to ${tc(c.end)}, ${c.status === "proposed" ? "to check" : c.status}`}
            />
          ))}
        </div>
        <div className="tl-nums" aria-hidden="true">
          {cands.map((c) =>
            c.id in labels ? (
              <span key={c.id} className={"tl-n" + (c.id === currentId ? " is-current" : "")} style={{ left: labels[c.id] }}>
                {c.rank ?? "+"}
              </span>
            ) : null
          )}
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

// The strip only changes with the clips or the current one; the playhead moves itself.
export default memo(Timeline);
