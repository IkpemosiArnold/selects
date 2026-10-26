// The review on a phone. The clip fills the screen; the slate becomes a
// bottom sheet whose top edge is the clap stick. Collapsed, it shows the
// slate's fields (clip, in, out, length). Pull it up, or tap "Why", to read
// Gemma's reason and scores and to trim. Skip and Approve sit in a bar under
// the sheet, where a thumb rests, and follow the card as it is swiped.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { tc } from "../../lib/time.js";
import { setNow, springTo, current as springNow } from "../../lib/spring.js";
import { rubricFor } from "./util.js";
import Why from "./Why.jsx";

function Pips({ n }) {
  return (
    <span className="pips" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((k) => (
        <i key={k} className={k <= n ? "on" : ""} />
      ))}
    </span>
  );
}

export const DecisionBar = forwardRef(function DecisionBar({ cur, onDecide }, ref) {
  return (
    <div className="decide-bar" ref={ref} role="group" aria-label="Decide">
      <button type="button" className={"bar-btn is-skip" + (cur.status === "skipped" ? " is-on" : "")} onClick={() => onDecide("skipped")}>
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M11 4L6 9l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        Skip
      </button>
      <button type="button" className={"bar-btn is-approve" + (cur.status === "approved" ? " is-on" : "")} onClick={() => onDecide("approved")}>
        Approve
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M7 4l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
    </div>
  );
});

const Sheet = forwardRef(function Sheet({ clip, line, total, waiting, onNudge, onTrim, onBlur, blurText, captionsOn, jobId, timeline, stickRef, fileName, topN = null }, ref) {
  const sheetRef = useRef(null);
  const bodyRef = useRef(null);
  const peekRef = useRef(0);
  const heightRef = useRef(0);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const drag = useRef(null);
  const scrimRef = useRef(null);
  const moving = useRef(0); // a token while a spring runs, 0 at rest

  // Collapsed, the sheet sits low so only the stick and the fields show.
  const measure = useCallback(() => {
    const el = sheetRef.current;
    if (!el) return;
    const fields = el.querySelector(".sheet-head");
    const clap = el.querySelector(".slate-clap");
    peekRef.current = (clap?.offsetHeight || 26) + (fields?.offsetHeight || 60);
    heightRef.current = el.offsetHeight;
  }, []);
  const closedY = () => Math.max(0, heightRef.current - peekRef.current);
  const paintScrim = (y) => {
    const s = scrimRef.current;
    if (!s) return;
    const t = closedY() ? 1 - y / closedY() : 0;
    s.style.opacity = String(Math.max(0, Math.min(1, t)) * 0.55);
    s.style.pointerEvents = t > 0.05 ? "auto" : "none";
  };

  const snap = useCallback((toOpen, velocity = 0) => {
    const el = sheetRef.current;
    if (!el) return;
    openRef.current = toOpen;
    setOpen(toOpen);
    if (!toOpen && bodyRef.current) bodyRef.current.scrollTop = 0;
    const y = toOpen ? 0 : closedY();
    const token = (moving.current = (moving.current || 0) + 1);
    springTo(el, { y }, { response: 0.36, damping: 0.88, velocity: { y: velocity }, onRest: () => paintScrim(y) }).then(() => {
      if (moving.current === token) moving.current = 0;
    });
    // the scrim follows the sheet on each frame of the spring
    const follow = () => {
      paintScrim(springNow(el).y);
      if (Math.abs(springNow(el).y - y) > 0.5) requestAnimationFrame(follow);
    };
    requestAnimationFrame(follow);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({ close: () => openRef.current && snap(false) }), [snap]);

  useLayoutEffect(() => {
    measure();
    if (drag.current || moving.current) return;
    setNow(sheetRef.current, { y: openRef.current ? 0 : closedY() });
    paintScrim(openRef.current ? 0 : closedY());
  }); // every render: the content height can change with the clip

  useEffect(() => {
    const on = () => {
      measure();
      setNow(sheetRef.current, { y: openRef.current ? 0 : closedY() });
    };
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, [measure]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag by the stick or the fields row. A tap toggles.
  const onDown = (e) => {
    if (e.button !== 0 || e.target.closest(".slate-line")) return;
    const el = sheetRef.current;
    drag.current = { y0: e.clientY, from: springNow(el).y, hist: [[e.clientY, performance.now()]], moved: false, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dy = e.clientY - d.y0;
    if (!d.moved && Math.abs(dy) < 6) return;
    d.moved = true;
    d.hist.push([e.clientY, performance.now()]);
    if (d.hist.length > 6) d.hist.shift();
    let y = d.from + dy;
    const max = closedY();
    // friction past either end instead of a hard stop
    if (y < 0) y = -Math.sqrt(-y) * 3;
    if (y > max) y = max + Math.sqrt(y - max) * 3;
    setNow(sheetRef.current, { y });
    paintScrim(y);
  };
  const onUp = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      if (e.type === "pointerup") snap(!openRef.current);
      return;
    }
    const [y0, t0] = d.hist[0];
    const vy = ((e.clientY - y0) / Math.max(1, performance.now() - t0)) * 1000;
    const y = springNow(sheetRef.current).y;
    const toOpen = Math.abs(vy) > 400 ? vy < 0 : y < closedY() / 2;
    snap(toOpen, vy);
  };

  const dur = Math.round(clip.end - clip.start);
  const status = clip.status;
  const long = line.length > 90 ? " is-long" : line.length > 54 ? " is-mid" : "";
  const handle = { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp };

  return (
    <>
      <div className="sheet-scrim" ref={scrimRef} onClick={() => snap(false)} aria-hidden="true" />
      <section ref={sheetRef} className={"sheet slate is-" + status + (open ? " is-open" : "")} aria-label={`Slate for ${clip.rank ? "clip " + clip.rank : "your clip"}`}>
        <div className="slate-clap" aria-hidden="true" {...handle}>
          <div className="slate-stick" ref={stickRef} />
          <div className="slate-hinge" />
          <div className="slate-stick slate-stick-base" />
        </div>
        <div className="slate-board">
          <div className="sheet-head" {...handle}>
            <dl className="slate-fields">
              <div>
                <dt>Clip</dt>
                <dd>
                  {clip.rank ?? "+"}
                  <small> of {total}</small>
                </dd>
              </div>
              <div className={clip.trimmed ? "is-mine" : ""}>
                <dt>In</dt>
                <dd>{tc(clip.start)}</dd>
              </div>
              <div className={clip.trimmed ? "is-mine" : ""}>
                <dt>Out</dt>
                <dd>{tc(clip.end)}</dd>
              </div>
              <div className={clip.trimmed ? "is-mine" : ""}>
                <dt>Length</dt>
                <dd>
                  {dur}
                  <small> s</small>
                </dd>
              </div>
            </dl>
            <button
              type="button"
              className="sheet-toggle"
              aria-expanded={open}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => snap(!openRef.current)}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span>{open ? "Close" : "Why"}</span>
            </button>
          </div>
          <button type="button" className={"slate-line" + long} onClick={onTrim}>
            {line}
          </button>
          {status !== "proposed" && <p className={"slate-mark is-" + status}>{status === "approved" ? "Approved" : "Skipped"}</p>}
        </div>
        <div className="sheet-body" ref={bodyRef} inert={open ? undefined : ""}>
          {clip.reason ? (
            <div className="slate-why">
              <h2 className="why-h">Why post it</h2>
              <Why clip={clip} />
              {clip.scores && (
                <>
                  <h3 className="why-h">How Gemma scored it, out of 5</h3>
                  <dl className="rubric">
                    {rubricFor(clip.scores).map(([k, l]) => (
                      <div key={k}>
                        <dt>{l}</dt>
                        <dd>
                          <Pips n={clip.scores[k]} />
                          <span className="rubric-n">{clip.scores[k]}</span>
                          <span className="sr-only"> of 5</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </>
              )}
            </div>
          ) : (
            <p className="slate-reason is-yours">{clip.trimmed ? "You trimmed this clip." : "You made this clip."}</p>
          )}
          <div className="nudge" role="group" aria-label="Move the start or the end by one sentence">
            <p className="nudge-h">Move the start or the end by one sentence</p>
            <div className="nudge-row">
              <span>Start</span>
              <button type="button" onClick={() => onNudge("start", -1)} aria-label="Start one sentence earlier">Earlier</button>
              <button type="button" onClick={() => onNudge("start", 1)} aria-label="Start one sentence later">Later</button>
            </div>
            <div className="nudge-row">
              <span>End</span>
              <button type="button" onClick={() => onNudge("end", -1)} aria-label="End one sentence earlier">Earlier</button>
              <button type="button" onClick={() => onNudge("end", 1)} aria-label="End one sentence later">Later</button>
            </div>
          </div>
          <div className="tools">
            <button type="button" className="tool" onClick={onTrim}>Trim by words</button>
            {onBlur && <button type="button" className="tool" onClick={onBlur}>{blurText || "Blur faces or an area"}</button>}
            <a className="tool is-link" href={`#/job/${jobId}/captions`}>{captionsOn ? "Fix caption words" : "Captions are off. Turn them on"}</a>
          </div>
          <div className="sheet-where">
            <h3 className="why-h">Where the clips are in {fileName || "the video"}</h3>
            <p className="sheet-left">{waiting ? `${waiting} still to check` : "You've checked every clip"}</p>
            {topN}
            {timeline}
          </div>
        </div>
      </section>
    </>
  );
});

export default Sheet;
