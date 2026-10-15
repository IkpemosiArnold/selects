import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, debugMode } from "../lib/api.js";
import { tc } from "../lib/time.js";
import { snapEdge, nudgeEdge } from "../lib/sentences.js";

const PX_PER_MIN = 42; // the strip never gets denser than this; long videos scroll
const FRAME_H = 62;
const MIN_LEN = 5;

function smoothPath(pts) {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}

function tickStep(dur, width) {
  const per = dur / Math.max(1, width / 90); // aim for a label every ~90 px
  for (const s of [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]) if (s >= per) return s;
  return 3600;
}

export default function Filmstrip({ job, candidates, selectedId, onSelect, onTrim, sentences, player, inputMode }) {
  const dur = job.source?.duration || 1;
  const scrollRef = useRef(null);
  const stripRef = useRef(null);
  const headRef = useRef(null);
  const [width, setWidth] = useState(1200);
  const [drag, setDrag] = useState(null); // { id, edge, start, end, snap }
  const [settle, setSettle] = useState(null); // { id, edge, value } after a snap

  const minWidth = Math.max(960, (dur / 60) * PX_PER_MIN);

  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Playhead follows playback every frame without re-rendering React.
  useEffect(() => {
    return player.onFrame((t) => {
      if (headRef.current) headRef.current.style.transform = `translateX(${(t / dur) * width}px)`;
    });
  }, [player, dur, width]);
  useEffect(() => {
    if (headRef.current) headRef.current.style.transform = `translateX(${(player.time / dur) * width}px)`;
  });

  // Keep the selected bracket in view when the strip scrolls sideways.
  const sel = candidates.find((c) => c.id === selectedId);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || !sel || sc.scrollWidth <= sc.clientWidth + 2) return;
    const x = (((sel.start + sel.end) / 2) / dur) * width;
    if (x < sc.scrollLeft + 60 || x > sc.scrollLeft + sc.clientWidth - 60) {
      sc.scrollTo({ left: x - sc.clientWidth / 2, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }, [selectedId, sel, dur, width]);

  const frames = useMemo(() => {
    const fw = (FRAME_H * 16) / 9;
    const n = Math.max(1, Math.ceil(width / fw));
    const count = job.thumbs?.count || 60;
    const interval = job.thumbs?.interval || dur / count;
    return Array.from({ length: n }, (_, i) => {
      const t = ((i + 0.5) / n) * dur;
      const idx = Math.min(count, Math.max(1, Math.floor(t / interval) + 1));
      return { i, idx, w: width / n };
    });
  }, [width, dur, job.thumbs]);

  const ticks = useMemo(() => {
    const step = tickStep(dur, width);
    const out = [];
    for (let t = 0; t < dur - step * 0.4; t += step) out.push(t);
    return out;
  }, [dur, width]);

  const curve = useMemo(() => {
    const pts = (job.curve || []).map((p) => [(p.t / dur) * 1000, 96 - p.v * 88]);
    if (!pts.length) return null;
    const line = smoothPath(pts);
    const area = `${line} L${pts[pts.length - 1][0]},100 L${pts[0][0]},100 Z`;
    return { line, area };
  }, [job.curve, dur]);

  const pct = (t) => `${(t / dur) * 100}%`;

  // Overlapping windows stack into lanes, so two ranks never read as one number.
  const lanes = useMemo(() => {
    const ends = [];
    const map = {};
    for (const c of [...candidates].sort((a, b) => a.start - b.start)) {
      const pad = (dur / Math.max(1, width)) * 26; // keep 26 px between neighbours in a lane
      let lane = ends.findIndex((e) => e + pad <= c.start);
      if (lane === -1) lane = ends.length < 3 ? ends.length : ends.indexOf(Math.min(...ends));
      ends[lane] = Math.max(ends[lane] ?? 0, c.end);
      map[c.id] = lane;
    }
    return { map, count: Math.max(1, ends.length) };
  }, [candidates, dur, width]);

  const timeAt = (clientX) => {
    const r = stripRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(dur, ((clientX - r.left) / r.width) * dur));
  };

  const startDrag = (e, c, edge) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (drag) return; // ignore a second finger
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    onSelect(c.id, "pointer");
    setDrag({ id: c.id, edge, start: c.start, end: c.end, snap: edge === "start" ? c.start : c.end, pointerId: e.pointerId });
  };

  const moveDrag = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    let t = timeAt(e.clientX);
    const next = { ...drag };
    if (drag.edge === "start") next.start = Math.min(t, drag.end - MIN_LEN);
    else next.end = Math.max(t, drag.start + MIN_LEN);
    next.snap = snapEdge(sentences, drag.edge === "start" ? next.start : next.end, drag.edge);
    setDrag(next);
  };

  const endDrag = async (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    setDrag(null);
    const c = candidates.find((x) => x.id === d.id);
    const body = d.edge === "start" ? { start: d.snap } : { end: d.snap };
    if (Math.abs((d.edge === "start" ? c.start : c.end) - d.snap) < 0.01) return; // snapped back where it was
    const res = await onTrim(c, body, { [d.edge]: d.snap });
    if (res) setSettle({ id: c.id, edge: d.edge, value: d.edge === "start" ? res.start : res.end, at: Date.now() });
  };

  useEffect(() => {
    if (!settle) return;
    const t = setTimeout(() => setSettle(null), 1600);
    return () => clearTimeout(t);
  }, [settle]);

  const handleKey = async (e, c, edge) => {
    const dir = e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    const cur = edge === "start" ? c.start : c.end;
    const v = nudgeEdge(sentences, cur, edge, dir);
    if (v === cur) return;
    if (edge === "start" && v > c.end - MIN_LEN) return;
    if (edge === "end" && v < c.start + MIN_LEN) return;
    const res = await onTrim(c, { [edge]: v }, { [edge]: v });
    if (res) setSettle({ id: c.id, edge, value: edge === "start" ? res.start : res.end, at: Date.now() });
  };

  const selView = sel && (drag?.id === sel.id ? { ...sel, start: drag.start, end: drag.end } : sel);
  const ranked = [...candidates].sort((a, b) => (b.rank ?? 99) - (a.rank ?? 99)); // best drawn last, on top

  return (
    <section className="filmstrip" aria-label="Filmstrip" data-input={inputMode}>
      <div className="fs-legend">
        <span className="fs-legend-item">
          <svg width="22" height="10" aria-hidden="true"><path d="M1 8 C6 8 7 2 11 2 S16 8 21 8" fill="none" stroke="var(--blue)" strokeWidth="1.6" /></svg>
          Interest, from the model's scores
        </span>
        <span className="fs-legend-item">
          <span className="lg-bracket" aria-hidden="true" />
          {candidates.length} proposed, numbered by rank
        </span>
        <span className="fs-legend-item">
          <span className="lg-mark" aria-hidden="true" />
          Yours: trimmed or approved
        </span>
        {debugMode && job.labels?.length > 0 && (
          <span className="fs-legend-item">
            <span className="lg-label" aria-hidden="true" />
            Human labels
          </span>
        )}
      </div>
      <div className="fs-scroll" ref={scrollRef}>
        <div className="fs-strip" ref={stripRef} style={{ minWidth }}>
          {selView && (
            <div
              className={"fs-band" + (sel.status === "approved" || sel.trimmed || drag?.id === sel.id ? " is-mine" : "") + (sel.status === "skipped" ? " is-cut" : "")}
              style={{ left: pct(selView.start), width: pct(selView.end - selView.start) }}
              aria-hidden="true"
            />
          )}

          <div className="film" aria-hidden="true">
            <div className="film-edge film-edge-top">
              {ticks.map((t) => (
                <span key={t} className="edge-print mono" style={{ left: pct(t) }}>
                  {tc(t)}
                </span>
              ))}
            </div>
            <div className="film-frames">
              {frames.map((f) => (
                <div key={f.i} className="frame" style={{ width: f.w }}>
                  <img src={api.thumbUrl(job.id, f.idx)} alt="" loading="lazy" decoding="async" draggable={false} />
                </div>
              ))}
            </div>
            <div className="film-edge film-edge-bottom" />
          </div>

          <div className="fs-curve" aria-hidden="true">
            {curve ? (
              <svg viewBox="0 0 1000 100" preserveAspectRatio="none">
                <defs>
                  {selView && (
                    <clipPath id="selwin">
                      <rect x={(selView.start / dur) * 1000} y="0" width={((selView.end - selView.start) / dur) * 1000} height="100" />
                    </clipPath>
                  )}
                </defs>
                <path d={curve.area} className="curve-area" />
                <path d={curve.line} className="curve-line" vectorEffect="non-scaling-stroke" />
                {selView && <path d={curve.line} className="curve-line is-sel" clipPath="url(#selwin)" vectorEffect="non-scaling-stroke" />}
              </svg>
            ) : (
              <p className="fs-empty mono">No interest curve for this job.</p>
            )}
            {debugMode &&
              job.labels?.map((l, i) => (
                <span key={i} className="human-label" style={{ left: pct(l.start), width: pct(l.end - l.start), opacity: 0.45 + 0.55 * (l.weight ?? 1) }} title={`${l.source} label ${tc(l.start)} to ${tc(l.end)}`} />
              ))}
          </div>

          <div className="fs-brackets" style={{ "--lanes": lanes.count }} data-lanes={lanes.count}>
            {ranked.map((c) => {
              const view = drag?.id === c.id ? { ...c, start: drag.start, end: drag.end } : c;
              const isSel = c.id === selectedId;
              const settled = settle?.id === c.id ? settle : null;
              const cls = [
                "bracket",
                isSel && "is-sel",
                c.status === "approved" && "is-approved",
                c.status === "skipped" && "is-skipped",
                (c.trimmed || drag?.id === c.id) && "is-mine",
                drag?.id === c.id && "is-dragging",
                settled && "is-settling",
              ].filter(Boolean).join(" ");
              const label = `Clip ${c.rank ?? ""}, ${tc(c.start)} to ${tc(c.end)}${c.status !== "proposed" ? ", " + c.status : ""}`;
              return (
                <div key={c.id} className={cls} style={{ left: pct(view.start), width: pct(view.end - view.start), "--lane": lanes.map[c.id] ?? 0 }}>
                  <button type="button" className="bracket-body" aria-label={label} aria-current={isSel || undefined} onClick={() => onSelect(c.id, "pointer")}>
                    <span className="bracket-rank mono">{c.rank ?? "?"}</span>
                    <span className="marker" aria-hidden="true" />
                  </button>
                  {isSel && c.status !== "skipped" && (
                    <>
                      {["start", "end"].map((edge) => (
                        <span
                          key={edge}
                          className={"handle handle-" + edge}
                          role="slider"
                          tabIndex={0}
                          aria-label={edge === "start" ? "In point" : "Out point"}
                          aria-valuemin={0}
                          aria-valuemax={Math.round(dur)}
                          aria-valuenow={Math.round(edge === "start" ? c.start : c.end)}
                          aria-valuetext={`${tc(edge === "start" ? c.start : c.end, { tenths: true })}. Arrow keys move it one sentence.`}
                          onPointerDown={(e) => startDrag(e, c, edge)}
                          onPointerMove={moveDrag}
                          onPointerUp={endDrag}
                          onPointerCancel={endDrag}
                          onKeyDown={(e) => handleKey(e, c, edge)}
                        />
                      ))}
                    </>
                  )}
                </div>
              );
            })}
            {drag && (
              <div className="snap-guide" style={{ left: pct(drag.snap) }} aria-hidden="true">
                <span className={"snap-chip mono edge-" + drag.edge}>
                  {drag.edge === "start" ? "In" : "Out"} {tc(drag.snap, { tenths: true })}
                  <span className="snap-why">{drag.edge === "start" ? "sentence start" : "sentence end"}</span>
                </span>
              </div>
            )}
            {settle && !drag && (
              <div key={settle.at} className="snap-guide is-done" style={{ left: pct(settle.value) }} role="status">
                <span className={"snap-chip mono edge-" + settle.edge}>Snapped to {tc(settle.value, { tenths: true })}</span>
              </div>
            )}
          </div>

          <div className="playhead" ref={headRef} aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}
