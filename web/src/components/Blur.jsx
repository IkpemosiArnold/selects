// Privacy blur: boxes drawn over the preview, and faces found by Apple Vision.
// The spec is CONTRACTS.md's blur shape: { faces: { mode, tracks }, regions }.
// Boxes are normalised to the upright video frame (0..1), times in source seconds.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { tc, aboutMinutes } from "../lib/time.js";

export const EMPTY_BLUR = { faces: { mode: "off", tracks: [] }, regions: [] };

export function normBlur(b) {
  return {
    faces: { mode: b?.faces?.mode || "off", tracks: Array.isArray(b?.faces?.tracks) ? b.faces.tracks : [] },
    regions: Array.isArray(b?.regions) ? b.regions.map((r) => ({ ...r, start: r.start ?? null, end: r.end ?? null })) : [],
  };
}

export function blurIsEmpty(b) {
  const n = normBlur(b);
  return n.faces.mode === "off" && n.regions.length === 0;
}

export function faceBlurred(spec, track) {
  const m = spec?.faces?.mode || "off";
  if (m === "all") return true;
  if (m === "others") return !track.main;
  if (m === "chosen") return (spec.faces.tracks || []).includes(track.id);
  return false;
}

export function blurSummary(b, tracks) {
  const n = normBlur(b);
  const parts = [];
  if (n.regions.length) parts.push(n.regions.length === 1 ? "1 box" : `${n.regions.length} boxes`);
  const m = n.faces.mode;
  if (m === "all") parts.push("all faces");
  else if (m === "others") parts.push("faces except the main speaker");
  else if (m === "chosen") parts.push(n.faces.tracks.length === 1 ? "1 chosen face" : `${n.faces.tracks.length} chosen faces`);
  return parts.length ? `Blurring ${parts.join(" and ")}` : tracks ? "Nothing blurred" : "Nothing blurred";
}

// Where a face track sits at time t: linear between the two nearest samples.
export function boxAt(track, t) {
  if (!track?.boxes?.length || t < track.start - 0.25 || t > track.end + 0.25) return null;
  const bs = track.boxes;
  let lo = 0;
  let hi = bs.length - 1;
  if (t <= bs[0].t) return bs[0];
  if (t >= bs[hi].t) return bs[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (bs[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = bs[lo];
  const b = bs[hi];
  if (b.t - a.t > 3) return Math.abs(t - a.t) < Math.abs(t - b.t) ? a : b; // a gap: no smearing across it
  const k = (t - a.t) / (b.t - a.t || 1);
  const mix = (p) => a[p] + (b[p] - a[p]) * k;
  return { x: mix("x"), y: mix("y"), w: mix("w"), h: mix("h") };
}

const regionActive = (r, t) => (r.start == null || t >= r.start - 0.01) && (r.end == null || t <= r.end + 0.01);

// The faces of a job: GET once, then follow the `faces` events (with a poll
// as a fallback, in case the event stream dropped while detection ran).
export function useFaces(jobId) {
  const [state, setState] = useState({ status: "unknown", tracks: [], progress: 0, message: null, hint: null });
  const statusRef = useRef("unknown");
  statusRef.current = state.status;

  useEffect(() => {
    let alive = true;
    api
      .getFaces(jobId)
      .then((f) => alive && setState({ status: "done", tracks: f?.tracks || [], progress: 1, message: null, hint: null }))
      .catch(() => alive && setState((s) => (s.status === "unknown" ? { ...s, status: "none" } : s)));
    return () => {
      alive = false;
    };
  }, [jobId]);

  const onEvent = useCallback((d) => {
    if (!d) return;
    if (d.status === "error") setState({ status: "error", tracks: [], progress: 0, message: d.message || "Face detection stopped.", hint: d.hint || null });
    else if (d.status === "running") setState((s) => ({ ...s, status: "running", progress: d.progress ?? s.progress ?? 0 }));
    else if (d.tracks) setState({ status: "done", tracks: d.tracks, progress: 1, message: null, hint: null });
  }, []);

  useEffect(() => {
    if (state.status !== "running") return;
    const t = setInterval(() => {
      api
        .getFaces(jobId)
        .then((f) => statusRef.current === "running" && f?.tracks && setState({ status: "done", tracks: f.tracks, progress: 1, message: null, hint: null }))
        .catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [state.status, jobId]);

  const detect = useCallback(async () => {
    setState({ status: "running", tracks: [], progress: 0, message: null, hint: null });
    try {
      await api.detectFaces(jobId);
    } catch (e) {
      setState({ status: "error", tracks: [], progress: 0, message: e.message, hint: null });
    }
  }, [jobId]);

  return { ...state, detect, onEvent };
}

// The box the picture occupies inside its frame, for object-fit contain or
// cover, so normalised coordinates land on the same pixels the person sees.
export function useContentBox(frameRef, natural, fit = "contain") {
  const [box, setBox] = useState(null);
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      const nw = natural?.w || W;
      const nh = natural?.h || H;
      const scale = fit === "cover" ? Math.max(W / nw, H / nh) : Math.min(W / nw, H / nh);
      const w = nw * scale;
      const h = nh * scale;
      setBox({ x: (W - w) / 2, y: (H - h) / 2, w, h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [frameRef, natural?.w, natural?.h, fit]);
  return box;
}

function capture(el, id) {
  try {
    el.setPointerCapture(id);
  } catch {}
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const r4 = (v) => Math.round(v * 10000) / 10000;

export function BlurOverlay({ spec, onChange, tracks = [], t, editing, armed, onArmed, selected, onSelect, box, trackLabels }) {
  const layerRef = useRef(null);
  const [draft, setDraft] = useState(null);
  const drag = useRef(null);
  const regions = spec?.regions || [];

  const toNorm = (e) => {
    const r = layerRef.current.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left - box.x) / box.w), y: clamp01((e.clientY - r.top - box.y) / box.h) };
  };

  const setRegion = (i, patch) => {
    const next = regions.map((r, k) => (k === i ? { ...r, ...patch } : r));
    onChange({ ...spec, regions: next });
  };

  const onLayerDown = (e) => {
    if (!armed || !box) return;
    e.preventDefault();
    capture(e.currentTarget, e.pointerId);
    const p = toNorm(e);
    drag.current = { kind: "draw", p0: p };
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onLayerMove = (e) => {
    const d = drag.current;
    if (!d || !box) return;
    const p = toNorm(e);
    if (d.kind === "draw") {
      setDraft({ x: Math.min(p.x, d.p0.x), y: Math.min(p.y, d.p0.y), w: Math.abs(p.x - d.p0.x), h: Math.abs(p.y - d.p0.y) });
    } else if (d.kind === "move") {
      const dx = p.x - d.p0.x;
      const dy = p.y - d.p0.y;
      const r = d.r0;
      setRegion(d.i, { x: r4(clamp01(Math.min(1 - r.w, r.x + dx))), y: r4(clamp01(Math.min(1 - r.h, r.y + dy))) });
    } else if (d.kind === "size") {
      const r = d.r0;
      setRegion(d.i, { w: r4(Math.max(0.02, Math.min(1 - r.x, p.x - r.x))), h: r4(Math.max(0.02, Math.min(1 - r.y, p.y - r.y))) });
    }
  };
  const onLayerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "draw") {
      const r = draft;
      setDraft(null);
      onArmed?.(false);
      if (r && r.w > 0.015 && r.h > 0.015) {
        const next = [...regions, { x: r4(r.x), y: r4(r.y), w: r4(r.w), h: r4(r.h), start: null, end: null }];
        onChange({ ...spec, regions: next });
        onSelect?.(next.length - 1);
      }
    }
  };

  const startDrag = (e, i, kind) => {
    if (!editing || armed || !box) return;
    e.stopPropagation();
    e.preventDefault();
    capture(layerRef.current, e.pointerId);
    drag.current = { kind, i, p0: toNorm(e), r0: { ...regions[i] } };
    onSelect?.(i);
  };

  const onBoxKey = (e, i) => {
    const r = regions[i];
    const step = e.shiftKey ? 0.05 : 0.01;
    const k = e.key;
    if (k === "Delete" || k === "Backspace") {
      e.preventDefault();
      onChange({ ...spec, regions: regions.filter((_, j) => j !== i) });
      onSelect?.(null);
      return;
    }
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[k];
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.altKey) setRegion(i, { w: r4(Math.max(0.02, Math.min(1 - r.x, r.w + dir[0] * step))), h: r4(Math.max(0.02, Math.min(1 - r.y, r.h + dir[1] * step))) });
    else setRegion(i, { x: r4(clamp01(Math.min(1 - r.w, r.x + dir[0] * step))), y: r4(clamp01(Math.min(1 - r.h, r.y + dir[1] * step))) });
  };

  if (!box) return null;
  const pos = (b) => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
  const showFaces = editing || spec?.faces?.mode !== "off";

  return (
    <div
      ref={layerRef}
      className={"blur-layer" + (editing ? " is-editing" : "") + (armed ? " is-armed" : "")}
      onPointerDown={onLayerDown}
      onPointerMove={onLayerMove}
      onPointerUp={onLayerUp}
      onPointerCancel={onLayerUp}
    >
      <div className="blur-content" style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
        {showFaces &&
          tracks.map((tr) => {
            const b = boxAt(tr, t);
            if (!b) return null;
            const on = faceBlurred(spec, tr);
            if (!editing && !on) return null;
            return (
              <div key={tr.id} className={"blur-face" + (on ? " is-blurred" : "")} style={pos(b)} aria-hidden="true">
                {editing && <span className="blur-tag">{trackLabels?.[tr.id] || tr.id}</span>}
              </div>
            );
          })}
        {regions.map((r, i) => {
          const active = regionActive(r, t);
          if (!editing && !active) return null;
          return (
            <div
              key={i}
              role={editing ? "button" : undefined}
              tabIndex={editing ? 0 : undefined}
              aria-label={editing ? `Blur box ${i + 1}. Arrow keys move it, Alt and arrows resize it, Delete removes it.` : undefined}
              className={"blur-region" + (active ? " is-blurred" : " is-idle") + (selected === i ? " is-sel" : "")}
              style={pos(r)}
              onPointerDown={(e) => startDrag(e, i, "move")}
              onFocus={() => onSelect?.(i)}
              onKeyDown={editing ? (e) => onBoxKey(e, i) : undefined}
            >
              {editing && <span className="blur-tag">Box {i + 1}</span>}
              {editing && <span className="blur-size" onPointerDown={(e) => startDrag(e, i, "size")} aria-hidden="true" />}
            </div>
          );
        })}
        {draft && <div className="blur-region is-draft" style={pos(draft)} aria-hidden="true" />}
      </div>
    </div>
  );
}

function timeLabel(r, scope) {
  const whole = scope === "clip" ? "Whole clip" : "Whole video";
  if (r.start == null && r.end == null) return whole;
  if (r.start != null && r.end == null) return `From ${tc(r.start, { tenths: true })}`;
  if (r.start == null && r.end != null) return `Until ${tc(r.end, { tenths: true })}`;
  return `${tc(r.start, { tenths: true })} to ${tc(r.end, { tenths: true })}`;
}

const FACE_MODES = [
  ["off", "Don't blur faces"],
  ["all", "Blur all faces"],
  ["others", "Blur everyone except the main speaker"],
  ["chosen", "Choose faces"],
];

export function trackLabelsFor(tracks) {
  const out = {};
  let n = 1;
  for (const tr of tracks) out[tr.id] = tr.main ? "Main speaker" : `Face ${++n}`;
  return out;
}

export function BlurPanel({ spec, onChange, faces, t, scope = "clip", range, selected, onSelect, armed, onArm, saveState, onSeek, duration }) {
  const regions = spec.regions;
  const inRange = (tr) => !range || (tr.end >= range.start && tr.start <= range.end);
  const tracks = (faces.tracks || []).filter(inRange);
  const labels = trackLabelsFor(faces.tracks || []);
  const setRegion = (i, patch) => onChange({ ...spec, regions: regions.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  const setMode = (mode) => onChange({ ...spec, faces: { ...spec.faces, mode } });
  const toggleTrack = (id) => {
    const cur = spec.faces.tracks || [];
    onChange({ ...spec, faces: { ...spec.faces, mode: "chosen", tracks: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] } });
  };
  const estimate = duration ? aboutMinutes(Math.max(20, duration / 6)) : null;

  return (
    <section className="blur-panel" aria-label="Blur">
      <div className="bp-head">
        <p className="bp-summary">{blurSummary(spec, faces.tracks)}</p>
        <p className="bp-save mono" aria-live="polite">
          {saveState === "saving" ? "Saving" : saveState === "saved" ? "Saved" : saveState === "error" ? <span className="is-error">Not saved</span> : ""}
        </p>
      </div>

      <div className="bp-block">
        <div className="bp-row">
          <h3 className="bp-h">Boxes</h3>
          <button type="button" className={"btn btn-chip" + (armed ? " is-on" : "")} aria-pressed={!!armed} onClick={() => onArm(!armed)}>
            {armed ? "Drag on the video" : "Draw a box"}
          </button>
        </div>
        <p className="bp-hint">
          {armed
            ? "Drag over the area to hide. Press Escape to stop."
            : "Cover a phone number, a name badge, a logo, or a figure the talk's licence may not cover."}
        </p>
        {regions.length > 0 && (
          <ol className="bp-list">
            {regions.map((r, i) => (
              <li key={i} className={"bp-item" + (selected === i ? " is-sel" : "")}>
                <button type="button" className="bp-name" onClick={() => onSelect(i)} aria-pressed={selected === i}>
                  Box {i + 1}
                </button>
                <span className="bp-time mono">{timeLabel(r, scope)}</span>
                <span className="bp-acts">
                  <button type="button" className="btn btn-chip" onClick={() => setRegion(i, { start: +t.toFixed(2), end: r.end != null && r.end <= t ? null : r.end })} title={`Start blurring at ${tc(t, { tenths: true })}`}>
                    From here
                  </button>
                  <button type="button" className="btn btn-chip" onClick={() => setRegion(i, { end: +t.toFixed(2), start: r.start != null && r.start >= t ? null : r.start })} title={`Stop blurring at ${tc(t, { tenths: true })}`}>
                    Until here
                  </button>
                  {(r.start != null || r.end != null) && (
                    <button type="button" className="btn btn-chip" onClick={() => setRegion(i, { start: null, end: null })}>
                      {scope === "clip" ? "Whole clip" : "Whole video"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-chip btn-del"
                    onClick={() => {
                      onChange({ ...spec, regions: regions.filter((_, k) => k !== i) });
                      onSelect(null);
                    }}
                    aria-label={`Delete box ${i + 1}`}
                  >
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="bp-block">
        <div className="bp-row">
          <h3 className="bp-h">Faces</h3>
          {faces.status === "done" && (
            <span className="bp-found dim">{faces.tracks.length === 1 ? "1 face found" : `${faces.tracks.length} faces found`}{range && tracks.length !== faces.tracks.length ? `, ${tracks.length} in this clip` : ""}</span>
          )}
        </div>
        {(faces.status === "none" || faces.status === "unknown") && (
          <>
            <p className="bp-hint">Selects looks for faces on this laptop{estimate ? `, which takes ${estimate} for this video` : ""}. Nothing is uploaded.</p>
            <button type="button" className="btn" onClick={faces.detect} disabled={faces.status === "unknown"}>
              Detect faces
            </button>
          </>
        )}
        {faces.status === "running" && (
          <div className="bp-running" aria-live="polite">
            <p className="mono">Looking for faces{faces.progress ? ` ${Math.round(faces.progress * 100)}%` : ""}</p>
            <div className="rp-bar is-blue" role="progressbar" aria-label="Face detection" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((faces.progress || 0) * 100)}>
              <div className="rp-fill" style={{ transform: `scaleX(${faces.progress || 0})` }} />
            </div>
          </div>
        )}
        {faces.status === "error" && (
          <div className="bp-error" role="alert">
            <p>{faces.message}</p>
            {faces.hint && <p className="dim">{faces.hint}</p>}
            <p className="dim">Boxes you draw still work. Draw one over each face you want hidden.</p>
          </div>
        )}
        {faces.status === "done" && faces.tracks.length === 0 && <p className="bp-hint">No faces were found. Draw boxes if something still needs hiding.</p>}
        {faces.status === "done" && faces.tracks.length > 0 && (
          <>
            <div className="bp-modes" role="radiogroup" aria-label="Which faces to blur">
              {FACE_MODES.map(([m, label]) => (
                <label key={m} className={"bp-mode" + (spec.faces.mode === m ? " is-on" : "")}>
                  <input type="radio" name="face-mode" value={m} checked={spec.faces.mode === m} onChange={() => setMode(m)} />
                  <span>{label}</span>
                </label>
              ))}
            </div>
            {spec.faces.mode === "chosen" && (
              <ul className="bp-tracks">
                {tracks.map((tr) => {
                  const on = (spec.faces.tracks || []).includes(tr.id);
                  return (
                    <li key={tr.id} className={"bp-track" + (on ? " is-on" : "")}>
                      <label className="bp-check">
                        <input type="checkbox" checked={on} onChange={() => toggleTrack(tr.id)} />
                        <span>{labels[tr.id]}</span>
                      </label>
                      <button type="button" className="bp-time mono bp-seek" onClick={() => onSeek(tr.start)} title="Show this face">
                        {tc(tr.start)} to {tc(tr.end)}
                      </button>
                    </li>
                  );
                })}
                {tracks.length === 0 && <li className="dim">No faces appear in this clip.</li>}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// Blur state for one target (a clip, or the whole video), saved shortly after
// each change, the same way trims are saved.
export function useBlurDraft(initial, key, save) {
  const [spec, setSpec] = useState(() => normBlur(initial));
  const [saveState, setSaveState] = useState(null);
  const timer = useRef(0);
  const pending = useRef(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const keyRef = useRef(key);
  useEffect(() => {
    // Switching target: send anything still waiting for the one we leave.
    if (pending.current) {
      clearTimeout(timer.current);
      const p = pending.current;
      pending.current = null;
      saveRef.current(p.spec, p.key).catch(() => {});
    }
    keyRef.current = key;
    setSpec(normBlur(initial));
    setSaveState(null);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = useCallback((next) => {
    setSpec(next);
    setSaveState("saving");
    pending.current = { spec: next, key: keyRef.current };
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const p = pending.current;
      pending.current = null;
      if (!p) return;
      try {
        await saveRef.current(p.spec, p.key);
        if (p.key === keyRef.current) setSaveState("saved");
      } catch {
        if (p.key === keyRef.current) setSaveState("error");
      }
    }, 450);
  }, []);
  return [spec, change, saveState];
}
