// The lined script: the clip's words with the context around them, set like a
// script supervisor's page. The clip is a line in the margin; drag its ends,
// or select words, to move the in and out points. The server snaps them to
// whole sentences (snapTrim), and the preview shows where they will land.
// A wavy mark in the margin shows where whisper was unsure; double-click a
// word to fix it in the captions every render uses.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { tc } from "../../lib/time.js";
import { snapTrim, toSentences, nudgeEdge } from "../../lib/sentences.js";
import { flatWords } from "../../lib/useCues.js";
import { clipName } from "./util.js";

const PAD = 40; // seconds of context either side

function paragraphs(words, i0, i1) {
  const out = [];
  let a = i0, sentences = 0;
  for (let i = i0; i <= i1; i++) {
    const end = /[.?!]["')\]]?$/.test(words[i].w);
    if (end) sentences++;
    const gap = i + 1 <= i1 ? words[i + 1].s - words[i].e : 9;
    const len = i - a + 1;
    if (i === i1 || (end && (gap > 1.1 || sentences >= 3 || len > 60)) || (len > 90 && gap > 0.35)) {
      out.push({ i0: a, i1: i });
      a = i + 1;
      sentences = 0;
    }
  }
  return out;
}

// Runs of unsure words, merged across short sure gaps, so the mark reads as
// "this stretch" rather than flickering word by word.
function unsureRuns(words, i0, i1, lowP, gap = 3) {
  const out = [];
  let run = null, sure = 0;
  for (let i = i0; i <= i1; i++) {
    if (words[i].p < lowP) {
      run = run ? [run[0], i] : [i, i];
      sure = 0;
    } else if (run && ++sure > gap) {
      out.push(run);
      run = null;
    }
  }
  if (run) out.push(run);
  return out;
}

const inside = (w, r) => (w.s + w.e) / 2 >= r.start - 0.01 && (w.s + w.e) / 2 <= r.end + 0.01;

export default function Script({ job, clip, cues, lowP, player, onTrim, onEditWord, onClose }) {
  const words = useMemo(() => flatWords(cues), [cues]);
  const sentences = useMemo(() => toSentences(words), [words]);
  const [pad, setPad] = useState({ before: PAD, after: PAD });
  const [preview, setPreview] = useState(null); // { start, end } while dragging or selecting
  const [pick, setPick] = useState(null); // a word selection waiting for "Set in and out"
  const [editing, setEditing] = useState(null); // index of the word being fixed
  const [saving, setSaving] = useState(false);
  const [marks, setMarks] = useState({ line: null, runs: [], lines: [] });
  const bodyRef = useRef(null);
  const scrollRef = useRef(null);
  const range = preview || clip;

  const dur = job.source?.duration || 0;
  const i0 = Math.max(0, words.findIndex((w) => w.e >= clip.start - pad.before));
  let i1 = words.length - 1;
  for (let i = i0; i < words.length; i++) if (words[i].s > clip.end + pad.after) { i1 = i - 1; break; }
  const paras = useMemo(() => (words.length && i1 >= i0 ? paragraphs(words, i0, i1) : []), [words, i0, i1]);
  const runs = useMemo(() => (words.length ? unsureRuns(words, i0, i1, lowP) : []), [words, i0, i1, lowP]);

  // Measure where the clip line and the unsure marks sit beside the text.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => {
      const span = (i) => body.querySelector(`[data-i="${i}"]`);
      const lh = parseFloat(getComputedStyle(body).lineHeight) || 30;
      let a = -1, b = -1;
      for (let i = i0; i <= i1; i++) if (inside(words[i], range)) {
        if (a < 0) a = i;
        b = i;
      }
      const line = a >= 0 ? { top: span(a)?.offsetTop ?? 0, bottom: (span(b)?.offsetTop ?? 0) + lh, a, b } : null;
      const rs = runs.map(([x, y]) => ({ top: (span(x)?.offsetTop ?? 0) + 3, bottom: (span(y)?.offsetTop ?? 0) + lh - 3 }));
      const lines = [];
      for (let i = i0; i <= i1; i++) {
        const top = span(i)?.offsetTop;
        if (top == null) continue;
        const last = lines[lines.length - 1];
        if (!last || Math.abs(last.top - top) > 2) lines.push({ top, a: i, b: i });
        else last.b = i;
      }
      setMarks({ line, runs: rs, lines, lh });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(body);
    return () => ro.disconnect();
  }, [words, i0, i1, range.start, range.end, runs]);

  // Open on the clip.
  useEffect(() => {
    const first = words.findIndex((w) => inside(w, clip));
    const el = bodyRef.current?.querySelector(`[data-i="${first}"]`);
    const sc = scrollRef.current;
    if (el && sc) sc.scrollTop = Math.max(0, el.offsetTop - sc.clientHeight * 0.28);
  }, [clip.id, words.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // The word being spoken, marked without re-rendering the page.
  useEffect(() => {
    let last = null;
    return player.onFrame((t) => {
      const body = bodyRef.current;
      if (!body) return;
      let lo = i0, hi = i1, k = -1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (words[m].s <= t) {
          k = m;
          lo = m + 1;
        } else hi = m - 1;
      }
      const el = k >= 0 && t <= words[k].e + 0.3 ? body.querySelector(`[data-i="${k}"]`) : null;
      if (el === last) return;
      last?.classList.remove("is-now");
      el?.classList.add("is-now");
      last = el;
    });
  }, [player, words, i0, i1]);

  const commit = useCallback(
    async (r) => {
      setPick(null);
      getSelection()?.removeAllRanges();
      if (Math.abs(r.start - clip.start) < 0.01 && Math.abs(r.end - clip.end) < 0.01) {
        setPreview(null);
        return;
      }
      setPreview(r);
      setSaving(true);
      await onTrim(r.start, r.end);
      setSaving(false);
      setPreview(null);
    },
    [clip.start, clip.end, onTrim]
  );

  // Dragging an end of the margin line.
  const drag = useRef(null);
  const onHandleDown = (edge) => (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { edge };
  };
  const onHandleMove = (e) => {
    const d = drag.current;
    if (!d || !bodyRef.current) return;
    const y = e.clientY - bodyRef.current.getBoundingClientRect().top;
    const ls = marks.lines;
    if (!ls.length) return;
    let line = ls[0];
    for (const l of ls) if (l.top <= y) line = l;
    const raw = d.edge === "start" ? { start: words[line.a].s, end: clip.end } : { start: clip.start, end: words[line.b].e };
    if (raw.end - raw.start < 1) return;
    setPreview(snapTrim(words, raw.start, raw.end, { sentences }));
  };
  const onHandleUp = () => {
    if (!drag.current) return;
    drag.current = null;
    if (preview) commit(preview);
  };
  const onHandleKey = (edge) => (e) => {
    const dir = e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    const at = edge === "start" ? clip.start : clip.end;
    const v = nudgeEdge(sentences, at, edge, dir);
    if (v === at) return;
    commit(edge === "start" ? { start: v, end: clip.end } : { start: clip.start, end: v });
  };

  // Selecting words offers to set the in and out points there.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const up = () => {
      const s = getSelection();
      if (!s || s.isCollapsed || !body.contains(s.anchorNode)) {
        setPick(null);
        return;
      }
      const el = (n) => (n?.nodeType === 3 ? n.parentElement : n)?.closest?.("[data-i]");
      const a = el(s.anchorNode), b = el(s.focusNode);
      if (!a || !b) return;
      const x0 = Math.min(+a.dataset.i, +b.dataset.i), x1 = Math.max(+a.dataset.i, +b.dataset.i);
      const r = snapTrim(words, words[x0].s, words[x1].e, { sentences });
      const rect = s.getRangeAt(0).getBoundingClientRect();
      const host = body.getBoundingClientRect();
      setPick({ ...r, x: Math.max(0, rect.left - host.left), y: rect.bottom - host.top + 10 });
    };
    body.addEventListener("mouseup", up);
    body.addEventListener("keyup", up);
    return () => {
      body.removeEventListener("mouseup", up);
      body.removeEventListener("keyup", up);
    };
  }, [words, sentences]);

  const onWordClick = (e) => {
    if (!getSelection()?.isCollapsed) return;
    const w = words[+e.currentTarget.dataset.i];
    if (w && w.s >= clip.start - 0.05 && w.s <= clip.end) player.seek(w.s);
  };
  const onWordDouble = (e) => {
    const i = +e.currentTarget.dataset.i;
    getSelection()?.removeAllRanges();
    setPick(null);
    setEditing(i);
  };

  const len = Math.round(range.end - range.start);
  const trimmed = Math.abs(range.start - clip.start) > 0.01 || Math.abs(range.end - clip.end) > 0.01;

  return (
    <section className="script" aria-labelledby="script-h">
      <header className="script-head">
        <div>
          <h2 id="script-h" className="script-title">
            Fine trim, {clipName(clip).toLowerCase()}
          </h2>
          <p className="script-range mono" aria-live="polite">
            <span className={trimmed ? "is-moving" : ""}>
              {tc(range.start)} to {tc(range.end)}, {len} s
            </span>
            {saving && <span className="dim"> saving</span>}
          </p>
        </div>
        <button type="button" className="btn btn-chip" onClick={onClose}>
          Done <kbd>T</kbd>
        </button>
      </header>
      <p className="script-help">
        Drag the ends of the line in the margin, or select words, to move the in and out points. Clips start and end on whole sentences. Double-click a word to fix it.
      </p>
      <div className="script-scroll" ref={scrollRef}>
        {i0 > 0 && pad.before < clip.start && (
          <button type="button" className="script-more" onClick={() => setPad((p) => ({ ...p, before: p.before + 60 }))}>
            Show the minute before
          </button>
        )}
        <div className="script-body" ref={bodyRef} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp}>
          {paras.map((p) => (
            <p key={p.i0} className="script-para">
              <span className="script-tc" aria-hidden="true">{tc(words[p.i0].s)}</span>
              {Array.from({ length: p.i1 - p.i0 + 1 }, (_, k) => {
                const i = p.i0 + k;
                const w = words[i];
                if (editing === i) {
                  return (
                    <WordInput
                      key={i}
                      word={w}
                      onDone={async (text) => {
                        setEditing(null);
                        if (text != null && text.trim() && text.trim() !== w.w) await onEditWord(w.ci, w.wi, text);
                      }}
                    />
                  );
                }
                const cls = "sw" + (inside(w, range) ? (clip.trimmed || trimmed ? " is-in is-mine" : " is-in") : "") + (w.p < lowP ? " is-unsure" : "");
                return (
                  <span key={i} data-i={i} className={cls} onClick={onWordClick} onDoubleClick={onWordDouble} title={w.p < lowP ? "Whisper was unsure of this word. Double-click to fix it." : undefined}>
                    {w.w + " "}
                  </span>
                );
              })}
            </p>
          ))}
          <div className="script-margin" aria-hidden={false}>
            {marks.runs.map((r, k) => (
              <span key={k} className="wavy" style={{ top: r.top, height: Math.max(14, r.bottom - r.top) }} aria-hidden="true" />
            ))}
            {marks.line && (
              <span className={"cover" + (clip.trimmed || trimmed ? " is-mine" : "")} style={{ top: marks.line.top, height: Math.max(12, marks.line.bottom - marks.line.top) }}>
                <button
                  type="button"
                  className="cover-handle is-start"
                  onPointerDown={onHandleDown("start")}
                  onKeyDown={onHandleKey("start")}
                  aria-label={`In point, ${tc(range.start)}. Up and down arrows move it by a sentence.`}
                />
                <button
                  type="button"
                  className="cover-handle is-end"
                  onPointerDown={onHandleDown("end")}
                  onKeyDown={onHandleKey("end")}
                  aria-label={`Out point, ${tc(range.end)}. Up and down arrows move it by a sentence.`}
                />
              </span>
            )}
          </div>
          {pick && (
            <div className="script-pick" style={{ left: pick.x, top: pick.y }} role="dialog" aria-label="Selected words">
              <span className="mono">
                {tc(pick.start)} to {tc(pick.end)}, {Math.round(pick.end - pick.start)} s
              </span>
              <button type="button" className="btn btn-chip is-on" onClick={() => commit({ start: pick.start, end: pick.end })} autoFocus>
                Set in and out here
              </button>
            </div>
          )}
        </div>
        {i1 < words.length - 1 && clip.end + pad.after < dur && (
          <button type="button" className="script-more" onClick={() => setPad((p) => ({ ...p, after: p.after + 60 }))}>
            Show the minute after
          </button>
        )}
      </div>
      <p className="script-key">
        <span className={"key-line" + (clip.trimmed ? " is-mine" : "")} aria-hidden="true" /> {clip.trimmed ? "the clip, trimmed by you" : "the clip the model proposed"}
        <span className="key-wavy" aria-hidden="true" /> whisper was unsure
      </p>
    </section>
  );
}

function WordInput({ word, onDone }) {
  const [v, setV] = useState(word.w);
  const done = useRef(false);
  const finish = (text) => {
    if (done.current) return;
    done.current = true;
    onDone(text);
  };
  return (
    <input
      className="sw-edit"
      value={v}
      size={Math.max(2, v.length + 1)}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      aria-label={`Fix the word "${word.w}" at ${tc(word.s)}. Enter saves, Escape cancels.`}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(v);
        else if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(v)}
    />
  );
}
