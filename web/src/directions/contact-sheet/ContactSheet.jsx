// Direction 3: the contact sheet, from the picture desk.
//
// A photo editor sees a whole roll at once as a contact sheet of small prints,
// reads it through a loupe and marks it with a china marker. Here the whole
// video is one sheet of the stills Selects already made; the model's picks
// are drawn on it in blue, the person's in yellow, and rejected ones are
// crossed out in red. Nothing plays until asked, which is what an old laptop
// busy transcribing needs.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./contact-sheet.css";
import { useDirectionJob, screenFor, thumbFor, isMine, useKeys, api } from "../shared/data.js";
import { useWindowPlayer } from "../shared/player.js";
import { languageQuestion, useLanguageAnswer } from "../shared/language.js";
import { Brand, FileLabel, Loading } from "../shared/Brand.jsx";
import { wordsIn } from "../../lib/sentences.js";
import { tc, plural } from "../../lib/time.js";
import { useReducedMotion } from "../../lib/hooks.js";

const RUBRIC = [
  ["hook", "Hook"],
  ["standalone", "Stands alone"],
  ["payoff", "Payoff"],
  ["clarity", "Clarity"],
];

// A deterministic wobble, so each mark looks drawn by hand and stays put.
function rng(seed) {
  let s = 0;
  for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) | 0;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
}

// A hand-drawn loop around [x0, x1] x [y0, y1]; open on a side that continues to another row.
function loopPath(x0, x1, y0, y1, seed, openL, openR) {
  const r = rng(seed);
  const j = (n) => n + r() * 3;
  const rad = 10;
  if (openL && openR) return `M${x0} ${j(y0)} L${x1} ${j(y0)} M${x0} ${j(y1)} L${x1} ${j(y1)}`;
  if (openL) return `M${x0} ${j(y0)} L${j(x1 - rad)} ${j(y0)} Q${j(x1)} ${j(y0)} ${j(x1)} ${y0 + rad} L${j(x1)} ${y1 - rad} Q${j(x1)} ${j(y1)} ${x1 - rad} ${j(y1)} L${x0} ${j(y1)}`;
  if (openR) return `M${x1} ${j(y0)} L${j(x0 + rad)} ${j(y0)} Q${j(x0)} ${j(y0)} ${j(x0)} ${y0 + rad} L${j(x0)} ${y1 - rad} Q${j(x0)} ${j(y1)} ${x0 + rad} ${j(y1)} L${x1} ${j(y1)}`;
  // Closed: start a little past the corner and overshoot the join, as a pencil does.
  return `M${j(x0 + rad + 6)} ${j(y0 - 1)} L${j(x1 - rad)} ${j(y0)} Q${j(x1)} ${j(y0)} ${j(x1)} ${y0 + rad} L${j(x1 + 1)} ${y1 - rad} Q${j(x1)} ${j(y1)} ${x1 - rad} ${j(y1)} L${x0 + rad} ${j(y1 + 1)} Q${j(x0)} ${j(y1)} ${j(x0)} ${y1 - rad} L${j(x0 - 1)} ${y0 + rad} Q${j(x0)} ${j(y0)} ${x0 + rad} ${j(y0)} L${j(x0 + rad + 18)} ${j(y0 + 1)}`;
}

function useSheetGeometry(job, minFrame = 132) {
  const ref = useRef(null);
  const [w, setW] = useState(960);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const count = job.thumbs?.count || 1;
  const interval = job.thumbs?.interval || job.source.duration / count;
  const cols = Math.max(3, Math.min(10, Math.floor(w / minFrame)));
  const gap = 4;
  const fw = (w - gap * (cols - 1)) / cols;
  const fh = (fw * 9) / 16;
  const rows = Math.ceil(count / cols);
  return { ref, w, count, interval, cols, gap, fw, fh, rows };
}

function framesOf(g) {
  return Array.from({ length: g.count }, (_, i) => ({ i, n: i + 1, s: i * g.interval, e: (i + 1) * g.interval, row: Math.floor(i / g.cols), col: i % g.cols }));
}

// Where a time sits on a row, in px; null when not on that row.
function xOn(g, row, t) {
  const f = t / g.interval - row * g.cols;
  if (f < 0 || f > g.cols) return null;
  const col = Math.min(g.cols - 1, Math.floor(f));
  return col * (g.fw + g.gap) + (f - col) * g.fw;
}

/* --------------------------------------------------------------- the loupe */

// A magnifier that follows the pointer with a little lag, so it feels like a
// glass being moved over the sheet. It reads the stills already on screen.
function Loupe({ job, words, g, sheetRef, target, active }) {
  const lensRef = useRef(null);
  const reduce = useReducedMotion();
  const pos = useRef({ x: 0, y: 0, tx: 0, ty: 0, raf: 0 });
  useEffect(() => {
    const p = pos.current;
    if (!active || !target) return;
    p.tx = target.x;
    p.ty = target.y;
    if (reduce || !p.started) {
      p.x = p.tx;
      p.y = p.ty;
      p.started = true;
    }
    const step = () => {
      p.x += (p.tx - p.x) * 0.28;
      p.y += (p.ty - p.y) * 0.28;
      if (lensRef.current) lensRef.current.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
      if (Math.abs(p.tx - p.x) > 0.3 || Math.abs(p.ty - p.y) > 0.3) p.raf = requestAnimationFrame(step);
      else p.raf = 0;
    };
    if (!p.raf) p.raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(p.raf);
      p.raf = 0;
    };
  }, [target, active, reduce]);
  useEffect(() => {
    if (!active) pos.current.started = false;
  }, [active]);
  if (!target) return null;
  const f = target.frame;
  const zoom = 1.8;
  const bw = g.fw * zoom;
  const bh = g.fh * zoom;
  const lx = (target.fx / g.fw) * bw;
  const ly = (target.fy / g.fh) * bh;
  const said = wordsIn(words, Math.max(0, target.t - 2.5), target.t + 2.5)
    .map((i) => words[i])
    .slice(0, 12);
  return (
    <div ref={lensRef} className={"cs-loupe" + (active ? " is-on" : "")} aria-hidden="true">
      <div
        className="cs-lens"
        style={{
          backgroundImage: `url("${api.thumbUrl(job.id, f.n)}")`,
          backgroundSize: `${bw}px ${bh}px`,
          backgroundPosition: `${75 - lx}px ${75 - ly}px`,
        }}
      />
      <div className="cs-loupe-read">
        <span className="cs-loupe-tc">{tc(target.t)}</span>
        <span className="cs-loupe-words">
          {said.length
            ? said.map((w, k) => (
                <span key={k} className={w.p < 0.5 ? "is-unsure" : ""}>
                  {w.w}{" "}
                </span>
              ))
            : "No speech here"}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- the sheet */

function Sheet({ job, words, g, cands, selId, markIn, onFrame, captions, flags, children }) {
  const frames = useMemo(() => framesOf(g), [g]);
  const [hover, setHover] = useState(null);
  const [focusI, setFocusI] = useState(null);
  const FT = 18; // frame top inside its strip
  const rowH = g.fh + 44 + (captions ? 60 : 0);

  const targetFor = (frame, fx, fy) => {
    const left = frame.col * (g.fw + g.gap);
    const top = frame.row * rowH + FT;
    return { frame, fx, fy, x: left + fx - 75, y: top + fy - 190, t: frame.s + (fx / g.fw) * g.interval };
  };

  const onMove = (e) => {
    const rect = g.ref.current.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const row = Math.floor(y / rowH);
    const col = Math.min(g.cols - 1, Math.floor(x / (g.fw + g.gap)));
    const frame = frames[row * g.cols + col];
    if (!frame) return setHover(null);
    const fx = Math.max(0, Math.min(g.fw, x - col * (g.fw + g.gap)));
    const fy = Math.max(0, Math.min(g.fh, y - row * rowH - FT));
    setHover(targetFor(frame, fx, fy));
  };
  const focusTarget = focusI != null && frames[focusI] ? targetFor(frames[focusI], g.fw / 2, g.fh / 2) : null;

  const onKey = (e) => {
    const i = focusI ?? 0;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: g.cols, ArrowUp: -g.cols }[e.key];
    if (step) {
      e.preventDefault();
      setFocusI(Math.max(0, Math.min(frames.length - 1, i + step)));
    } else if (e.key === "Enter" && focusI != null) {
      e.preventDefault();
      onFrame(frames[focusI].s + g.interval / 2, e.shiftKey);
    }
  };

  // Marks per row: one loop per clip piece, a cross for skipped clips.
  const marks = [];
  for (let row = 0; row < g.rows; row++) {
    const rs = row * g.cols * g.interval, re = (row + 1) * g.cols * g.interval;
    for (const c of cands) {
      if (c.end <= rs || c.start >= re) continue;
      const openL = c.start < rs, openR = c.end > re;
      const x0 = openL ? -6 : xOn(g, row, c.start) - 5;
      const x1 = openR ? g.w + 6 : (xOn(g, row, c.end) ?? g.w) + 5;
      const y0 = row * rowH + FT - 5, y1 = y0 + g.fh + 10;
      marks.push({ c, row, x0, x1, y0, y1, openL, openR, head: !openL });
    }
  }

  return (
    <div className="cs-sheet-wrap">
      <div
        ref={g.ref}
        className="cs-sheet"
        style={{ height: g.rows * rowH }}
        onPointerMove={(e) => e.pointerType === "mouse" && onMove(e)}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(e) => e.pointerType !== "mouse" && onMove(e)}
        tabIndex={0}
        role="grid"
        aria-label={`Contact sheet, ${g.count} frames, one every ${Math.round(g.interval)} seconds. Arrow keys move, Enter opens.`}
        onKeyDown={onKey}
        onFocus={() => focusI == null && setFocusI(0)}
        onBlur={() => setFocusI(null)}
      >
        {Array.from({ length: g.rows }, (_, row) => (
          <div key={row} className="cs-strip" style={{ top: row * rowH, height: g.fh + 36 }} aria-hidden="true" />
        ))}
        {frames.map((f) => {
          const left = f.col * (g.fw + g.gap);
          const top = f.row * rowH + FT;
          const flagged = flags?.[f.i];
          return (
            <div key={f.i} className={"cs-frame" + (focusI === f.i ? " is-focus" : "")} style={{ left, top, width: g.fw, height: g.fh }} onClick={() => onFrame(hover?.t ?? f.s + g.interval / 2, false)}>
              <img src={api.thumbUrl(job.id, f.n)} alt="" loading="lazy" decoding="async" draggable={false} />
              <span className="cs-edge" style={{ top: -15 }}>
                {tc(f.s)}
              </span>
              {captions && <p className={"cs-said" + (flagged ? " is-flagged" : "")} style={{ top: g.fh + 26 }}>{captions[f.i]}</p>}
              {flagged && <span className="cs-q" title="Whisper could not make out most words here">?</span>}
            </div>
          );
        })}
        <svg className="cs-marks" width={g.w} height={g.rows * rowH} aria-hidden="true">
          {marks.map((m) => {
            const mine = isMine(m.c);
            const cut = m.c.status === "skipped";
            const d = loopPath(m.x0, m.x1, m.y0, m.y1, m.c.id + m.row, m.openL, m.openR);
            return (
              <g key={m.c.id + m.row} className={"cs-mark" + (mine ? " is-mine" : "") + (cut ? " is-cut" : "") + (m.c.id === selId ? " is-sel" : "")}>
                {mine && <path d={d} className="cs-mark-under" />}
                <path d={d} className="cs-mark-line" pathLength="1" />
                {cut && m.head && (
                  <path className="cs-cross" d={`M${m.x0 + 8} ${m.y0 + 6} L${m.x0 + g.fw * 0.7} ${m.y1 - 6} M${m.x0 + g.fw * 0.7} ${m.y0 + 6} L${m.x0 + 8} ${m.y1 - 6}`} />
                )}
              </g>
            );
          })}
          {markIn != null &&
            (() => {
              const row = Math.floor(markIn / (g.cols * g.interval));
              const x = xOn(g, row, markIn);
              const y = row * rowH + FT - 8;
              return x == null ? null : <path className="cs-in" d={`M${x} ${y} L${x} ${y + g.fh + 16} M${x} ${y} L${x + 12} ${y}`} />;
            })()}
        </svg>
        {marks
          .filter((m) => m.head)
          .map((m) => (
            <button
              key={"n" + m.c.id}
              type="button"
              className={"cs-n" + (isMine(m.c) ? " is-mine" : "") + (m.c.status === "skipped" ? " is-cut" : "") + (m.c.id === selId ? " is-sel" : "")}
              style={{ left: Math.max(-8, m.x0 - 10), top: m.y0 - 13 }}
              onClick={() => onFrame(m.c.start + 0.1, false)}
              aria-label={`${m.c.rank ? "Clip " + m.c.rank : "Your clip"}, ${tc(m.c.start)} to ${tc(m.c.end)}`}
            >
              {m.c.rank ?? "+"}
            </button>
          ))}
        <Loupe job={job} words={words} g={g} target={hover || focusTarget} active={!!(hover || focusTarget)} />
        {children}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- caption sheet */

function Viewer({ job, clip }) {
  const src = api.sourceUrl(job.id);
  const player = useWindowPlayer({ src, start: clip.start, end: clip.end });
  const poster = thumbFor(job, clip.start + 0.5);
  const progress = Math.min(1, Math.max(0, (player.t - clip.start) / (clip.end - clip.start)));
  return (
    <div className="cs-viewer">
      {src ? <video ref={player.ref} src={src} poster={poster || undefined} preload="none" playsInline onClick={player.toggle} /> : <img src={thumbFor(job, player.t)} alt="" />}
      <button type="button" className="cs-play" onClick={player.toggle}>
        {player.playing ? "Pause" : `Play ${Math.round(clip.end - clip.start)} s`}
      </button>
      <span className="cs-viewer-bar" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />
    </div>
  );
}

function Panel({ job, clip, markIn, onDecide, onMake, onClearIn }) {
  if (!clip) {
    return (
      <aside className="cs-panel" aria-label="Selected clip">
        {markIn != null ? (
          <div className="cs-panel-empty">
            <p className="cs-panel-big">Start marked at {tc(markIn)}.</p>
            <p>Click the frame where the clip should end. Selects snaps both ends to whole sentences.</p>
            <button type="button" className="cs-link" onClick={onClearIn}>
              Clear the mark
            </button>
          </div>
        ) : (
          <div className="cs-panel-empty">
            <p className="cs-panel-big">Click a marked clip to review it.</p>
            <p>Move over the sheet to read it through the loupe. Click any frame outside a clip to start a clip of your own there.</p>
          </div>
        )}
      </aside>
    );
  }
  const mine = isMine(clip);
  return (
    <aside className="cs-panel" aria-label="Selected clip">
      <Viewer key={clip.id + clip.start + clip.end} job={job} clip={clip} />
      <p className="cs-meta">
        <span className={"cs-chip" + (mine ? " is-mine" : clip.status === "skipped" ? " is-cut" : "")}>{clip.rank ? `Clip ${clip.rank}` : "Your clip"}</span>
        <span className="cs-mono">
          {tc(clip.start)} to {tc(clip.end)}
        </span>
        <span className="cs-mono cs-dim">{Math.round(clip.end - clip.start)} s</span>
      </p>
      <blockquote className="cs-hook">{clip.hook}</blockquote>
      {clip.reason && (
        <>
          <p className="cs-why">{clip.reason}</p>
          {clip.scores && (
            <p className="cs-rubric">
              {RUBRIC.map(([k, l]) => (
                <span key={k}>
                  {l} <b>{clip.scores[k]}</b>
                </span>
              ))}
            </p>
          )}
        </>
      )}
      <div className="cs-actions">
        <button type="button" className={"cs-btn cs-approve" + (clip.status === "approved" ? " is-on" : "")} aria-pressed={clip.status === "approved"} onClick={() => onDecide(clip.id, "approved")}>
          {clip.status === "approved" ? "Circled" : "Circle it"} <span className="dx-key">A</span>
        </button>
        <button type="button" className={"cs-btn" + (clip.status === "skipped" ? " is-cut" : "")} aria-pressed={clip.status === "skipped"} onClick={() => onDecide(clip.id, "skipped")}>
          {clip.status === "skipped" ? "Crossed out" : "Cross it out"} <span className="dx-key">S</span>
        </button>
      </div>
      <p className="cs-help">Circled clips render. Shift-click two frames to redraw this clip's ends.</p>
    </aside>
  );
}

function Review({ d }) {
  const { job, words, cands } = d;
  const g = useSheetGeometry(job);
  const [selId, setSelId] = useState(cands[0]?.id ?? null);
  const [markIn, setMarkIn] = useState(null);
  const [redraw, setRedraw] = useState(null);
  const sel = cands.find((c) => c.id === selId) || null;
  const circled = cands.filter((c) => c.status === "approved");
  const order = useMemo(() => [...cands].sort((a, b) => a.start - b.start), [cands]);

  const onFrame = useCallback(
    (t, shift) => {
      if (shift && sel) {
        if (redraw == null) return setRedraw(t);
        d.retime(sel.id, Math.min(redraw, t), Math.max(redraw, t));
        return setRedraw(null);
      }
      const hit = cands.find((c) => t >= c.start && t <= c.end);
      if (hit && markIn == null) {
        setSelId(hit.id);
        return;
      }
      if (markIn == null) {
        setSelId(null);
        setMarkIn(t);
      } else {
        const c = d.addClip(Math.min(markIn, t), Math.max(markIn, t));
        setMarkIn(null);
        setSelId(c.id);
      }
    },
    [cands, markIn, sel, redraw, d]
  );

  const step = (dir) => {
    const i = order.findIndex((c) => c.id === selId);
    const next = order[Math.max(0, Math.min(order.length - 1, i + dir))];
    if (next) setSelId(next.id);
  };
  useKeys(
    {
      a: () => sel && d.decide(sel.id, "approved"),
      s: () => sel && d.decide(sel.id, "skipped"),
      j: () => step(1),
      k: () => step(-1),
      Escape: () => {
        setMarkIn(null);
        setRedraw(null);
      },
      undo: d.undo,
    },
    [sel, d.decide, d.undo, order, selId]
  );

  return (
    <div className="cs">
      <header className="cs-bar">
        <Brand />
        <FileLabel job={job} />
        <p className="cs-bar-info">
          {g.count} frames, one every {Math.round(g.interval)} s
        </p>
        <p className="cs-bar-count">
          <span className="cs-legend is-model" aria-hidden="true" /> {plural(cands.filter((c) => c.rank).length, "pick")} by the model
          <span className="cs-legend is-mine" aria-hidden="true" /> {circled.length} circled
        </p>
        <button type="button" className="cs-render" disabled={!circled.length}>
          {circled.length ? `Render ${plural(circled.length, "clip")}` : "Circle a clip to render it"}
        </button>
      </header>
      <div className="cs-desk">
        <main className="cs-main">
          <Sheet job={job} words={words} g={g} cands={cands} selId={selId} markIn={markIn ?? redraw} onFrame={onFrame} />
        </main>
        <Panel job={job} clip={sel} markIn={markIn} onDecide={d.decide} onClearIn={() => setMarkIn(null)} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- language */

function Language({ d }) {
  const { job, words } = d;
  const q = useMemo(() => languageQuestion(job, words), [job, words]);
  const a = useLanguageAnswer();
  const g = useSheetGeometry(job, 150);
  // Under each print, what whisper heard while it was on screen.
  const { captions, flags } = useMemo(() => {
    const caps = [], fl = [];
    for (let i = 0; i < g.count; i++) {
      const idx = wordsIn(words, i * g.interval, (i + 1) * g.interval);
      const ws = idx.map((k) => words[k]);
      const unsure = ws.filter((w) => w.p < 0.5).length;
      fl.push(ws.length >= 4 && unsure / ws.length > 0.5);
      caps.push(
        ws.length ? (
          ws.slice(0, 14).map((w, k) => (
            <span key={k} className={w.p < 0.5 ? "is-unsure" : ""}>
              {w.w}{" "}
            </span>
          ))
        ) : (
          <span className="is-quiet">No speech</span>
        )
      );
    }
    return { captions: caps, flags: fl };
  }, [words, g.count, g.interval]);
  const flagged = flags.filter(Boolean).length;
  const [play, setPlay] = useState(null);

  return (
    <div className="cs cs-lang">
      <header className="cs-bar">
        <Brand />
        <FileLabel job={job} />
        <p className="cs-bar-count">Stopped before finding clips</p>
      </header>
      <section className="cs-ask" aria-labelledby="cs-q">
        {a.step === "done" ? (
          <div className="cs-ask-q" role="status">
            <h1 id="cs-q" className="cs-question">Listening again in {a.answer.name}.</h1>
            <p className="cs-ask-why">{a.answer.language === "en" ? q.yes.after : "Selects listens again in that language with its multilingual model."}</p>
            <button type="button" className="cs-link" onClick={a.back}>
              Change the answer
            </button>
          </div>
        ) : (
          <>
            <div className="cs-ask-q">
              <h1 id="cs-q" className="cs-question">{q.question}</h1>
              <p className="cs-ask-why">
                {q.evidence} Under each frame is what it heard; a red question mark means it could not make out most of it ({flagged} of {g.count} frames).
              </p>
            </div>
            {a.step === "ask" ? (
              <div className="cs-ask-a">
                <button type="button" className="cs-answer is-yes" onClick={() => a.yes(q.yes.body)}>
                  <b>{q.yes.label}</b>
                  <span>{q.yes.after}</span>
                </button>
                <button type="button" className="cs-answer" onClick={a.no}>
                  <b>{q.no.label}</b>
                  <span>{q.no.after}</span>
                </button>
                <p className="cs-anyway">
                  <button type="button" className="cs-link">
                    {q.anyway}
                  </button>{" "}
                  {q.anywayAfter}
                </p>
              </div>
            ) : (
              <div className="cs-ask-a is-pick" role="group" aria-label="Which language?">
                {q.quick.map((l) => (
                  <button key={l.code} type="button" className="cs-answer is-lang" onClick={() => a.pick(l.code)}>
                    <b>{l.name}</b>
                    {l.guess && <span>Whisper's guess</span>}
                  </button>
                ))}
                <label className="cs-other">
                  Another language
                  <select defaultValue="" onChange={(e) => e.target.value && a.pick(e.target.value)}>
                    <option value="" disabled>
                      Choose
                    </option>
                    {q.rest.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="cs-link" onClick={a.back}>
                  Back
                </button>
              </div>
            )}
          </>
        )}
      </section>
      <main className="cs-main cs-main-lang">
        <p className="cs-sheet-note">Click a frame to hear its {Math.round(g.interval)} seconds.</p>
        <Sheet job={job} words={words} g={g} cands={[]} selId={null} markIn={null} onFrame={(t) => setPlay(Math.floor(t / g.interval) * g.interval)} captions={captions} flags={flags} />
        {play != null && <HearBar job={job} start={play} end={Math.min(play + g.interval, job.source.duration)} onClose={() => setPlay(null)} />}
      </main>
    </div>
  );
}

function HearBar({ job, start, end, onClose }) {
  const src = api.sourceUrl(job.id);
  const player = useWindowPlayer({ src, start, end, loop: false });
  useEffect(() => {
    player.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);
  return (
    <div className="cs-hear" role="status">
      {src && <audio ref={player.ref} src={src} />}
      <span>
        Playing {tc(start)} to {tc(end)}
      </span>
      <span className="cs-hear-bar">
        <i style={{ transform: `scaleX(${Math.min(1, Math.max(0, (player.t - start) / (end - start)))})` }} />
      </span>
      <button type="button" className="cs-link" onClick={onClose}>
        Stop
      </button>
    </div>
  );
}

export default function ContactSheet() {
  const d = useDirectionJob();
  if (!d.job) return <Loading error={d.error} className="cs" />;
  return screenFor(d.job) === "language" ? <Language d={d} /> : <Review d={d} />;
}
