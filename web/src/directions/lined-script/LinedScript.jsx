// Direction 1: the lined script.
//
// A script supervisor marks coverage by drawing vertical lines through the
// script. Here the transcript is the working surface: the model's proposed
// clips are blue lines in the margin, the person's are grease-pencil yellow,
// and selecting words makes or trims a clip. The video is a docked monitor.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./lined-script.css";
import { api, useDirectionJob, screenFor, mediaFor, thumbFor, isMine, useKeys } from "../shared/data.js";
import { useWindowPlayer } from "../shared/player.js";
import { languageQuestion, useLanguageAnswer, useTicker } from "../shared/language.js";
import { Brand, FileLabel, Loading } from "../shared/Brand.jsx";
import { tc, plural } from "../../lib/time.js";

const RUBRIC = [
  ["hook", "Hook"],
  ["standalone", "Stands alone"],
  ["payoff", "Payoff"],
  ["clarity", "Clarity"],
];

// Paragraphs the way a reader would break them: after a sentence, at a pause,
// or when a paragraph has run long.
function paragraphs(words) {
  const out = [];
  let i0 = 0, sentences = 0;
  for (let i = 0; i < words.length; i++) {
    const end = /[.?!]["')\]]?$/.test(words[i].w);
    if (end) sentences++;
    const gap = i + 1 < words.length ? words[i + 1].s - words[i].e : 9;
    const len = i - i0 + 1;
    if (i === words.length - 1 || (end && (gap > 1.1 || sentences >= 4 || len > 70)) || (len > 110 && gap > 0.35)) {
      out.push({ i0, i1: i, s: words[i0].s, e: words[i].e });
      i0 = i + 1;
      sentences = 0;
    }
  }
  return out;
}

// Overlapping clips sit in separate lanes, as overlapping setups do on a lined script.
function lanes(cands) {
  const ends = [];
  const lane = {};
  for (const c of [...cands].sort((a, b) => a.start - b.start)) {
    let l = ends.findIndex((e) => e <= c.start);
    if (l < 0) l = ends.length;
    ends[l] = c.end;
    lane[c.id] = l;
  }
  return lane;
}

const label = (c) => (c.rank ? String(c.rank) : "+");

function statusWord(c) {
  if (c.status === "skipped") return "Skipped";
  if (c.status === "approved") return c.mine && !c.rank ? "Made by you" : c.trimmed ? "Approved, trimmed by you" : "Approved";
  if (c.trimmed) return "Trimmed by you";
  return "Proposed by the model";
}

/* ---------------------------------------------------------------- review */

const Para = memo(function Para({ para, words, clips, lane, selId, unsure, onWord }) {
  const pRef = useRef(null);
  const [segs, setSegs] = useState([]);

  useLayoutEffect(() => {
    const p = pRef.current;
    if (!p) return;
    const measure = () => {
      const spans = p.querySelectorAll("[data-i]");
      const first = spans[0]?.dataset.i | 0;
      const at = (i) => spans[i - first];
      const height = p.offsetHeight;
      const lh = parseFloat(getComputedStyle(p).lineHeight) || 28;
      const out = [];
      for (const c of clips) {
        let a = para.i0, b = para.i1;
        while (a <= b && words[a].e <= c.start + 0.01) a++;
        while (b >= a && words[b].s >= c.end - 0.01) b--;
        if (a > b) continue;
        const top = c.start > para.s + 0.01 ? at(a)?.offsetTop ?? 0 : 0;
        const lastEl = at(b);
        const bottom = c.end < para.e - 0.01 ? (lastEl ? lastEl.offsetTop + lh : height) : height;
        out.push({ c, top, bottom, head: c.start > para.s - 0.01 && words[a].s >= c.start - 0.01, tail: c.end <= para.e + 0.01 });
      }
      // Wavy line where whisper was unsure: runs of low-confidence words.
      for (const [a, b] of unsure) {
        const ta = at(a), tb = at(b);
        if (ta && tb) out.push({ wavy: true, top: ta.offsetTop + 4, bottom: tb.offsetTop + lh - 4 });
      }
      setSegs(out);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(p);
    return () => ro.disconnect();
  }, [para, words, clips, unsure]);

  const sel = clips.find((c) => c.id === selId);
  const spans = [];
  for (let i = para.i0; i <= para.i1; i++) {
    const w = words[i];
    const inSel = sel && w.s >= sel.start - 0.01 && w.e <= sel.end + 0.01;
    const cls = ["ls-w"];
    if (inSel) cls.push(isMine(sel) ? "in-mine" : sel.status === "skipped" ? "in-cut" : "in-model");
    if (w.p < 0.5) cls.push("is-unsure");
    spans.push(
      <span key={i} data-i={i} className={cls.join(" ")} onClick={onWord}>
        {w.w + " "}
      </span>
    );
  }

  return (
    <div className="ls-para">
      <span className="ls-tc" aria-hidden="true">{tc(para.s)}</span>
      <div className="ls-margin" aria-hidden="true">
        {segs.map((g, k) =>
          g.wavy ? (
            <span key={"u" + k} className="ls-wavy" style={{ top: g.top, height: Math.max(12, g.bottom - g.top) }} />
          ) : (
            <span
              key={g.c.id}
              className={
                "ls-line" +
                (isMine(g.c) ? " is-mine" : "") +
                (g.c.status === "skipped" ? " is-cut" : "") +
                (g.c.id === selId ? " is-sel" : "") +
                (g.head ? " has-head" : "") +
                (g.tail ? " has-tail" : "")
              }
              style={{ top: g.top, height: Math.max(8, g.bottom - g.top), left: 30 + (lane[g.c.id] || 0) * 22 }}
            >
              {g.head && <span className="ls-line-n">{label(g.c)}</span>}
            </span>
          )
        )}
      </div>
      <p className="ls-text" ref={pRef}>
        {spans}
      </p>
    </div>
  );
});

function Monitor({ job, clip, index, total, onDecide, onPrev, onNext }) {
  const media = mediaFor(job, clip);
  const player = useWindowPlayer(media);
  const poster = clip ? thumbFor(job, clip.start + 1) : null;
  useKeys({ " ": player.toggle }, [player.toggle]);
  if (!clip) return null;
  const dur = Math.round(clip.end - clip.start);
  const mine = isMine(clip);
  const progress = Math.min(1, Math.max(0, (player.t - clip.start) / (clip.end - clip.start)));
  return (
    <aside className="ls-monitor" aria-label="Selected clip">
      <div className="ls-screen">
        {media.src ? (
          <video
            ref={player.ref}
            src={media.src}
            poster={poster || undefined}
            preload="metadata"
            playsInline
            className={media.rendered ? "is-rendered" : "is-source"}
            onClick={player.toggle}
          />
        ) : (
          poster && <img src={thumbFor(job, player.t)} alt="" />
        )}
        <button type="button" className="ls-play" onClick={player.toggle} aria-label={player.playing ? "Pause" : "Play clip"}>
          {player.playing ? (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 2h3v10H3zM8 2h3v10H8z" fill="currentColor" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5l9 5.5-9 5.5z" fill="currentColor" /></svg>
          )}
        </button>
        <span className="ls-screen-bar" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />
      </div>

      <div className="ls-slate">
        <p className="ls-slate-meta">
          <span className={"ls-chip" + (mine ? " is-mine" : clip.status === "skipped" ? " is-cut" : "")}>{clip.rank ? `Clip ${clip.rank}` : "Your clip"}</span>
          <span className="ls-mono">{tc(clip.start)} to {tc(clip.end)}</span>
          <span className="ls-mono ls-dim">{dur} s</span>
        </p>
        <p className="ls-status">{statusWord(clip)}</p>
        <blockquote className="ls-hook">{clip.hook}</blockquote>
        {clip.reason && (
          <div className="ls-why">
            <p className="ls-why-label">Why the model picked it</p>
            <p className="ls-why-text">{clip.reason}</p>
            {clip.scores && (
              <dl className="ls-rubric">
                {RUBRIC.map(([k, l]) => (
                  <div key={k}>
                    <dt>{l}</dt>
                    <dd>
                      <span className="ls-pips" aria-hidden="true">
                        {[1, 2, 3, 4, 5].map((n) => (
                          <i key={n} className={n <= clip.scores[k] ? "on" : ""} />
                        ))}
                      </span>
                      <span className="dx-sr">{clip.scores[k]} of 5</span>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}
        <div className="ls-actions">
          <button type="button" className={"ls-btn ls-approve" + (clip.status === "approved" ? " is-on" : "")} aria-pressed={clip.status === "approved"} onClick={() => onDecide(clip.id, "approved")}>
            {clip.status === "approved" ? "Approved" : "Approve clip"} <span className="dx-key">A</span>
          </button>
          <button type="button" className={"ls-btn ls-skip" + (clip.status === "skipped" ? " is-on" : "")} aria-pressed={clip.status === "skipped"} onClick={() => onDecide(clip.id, "skipped")}>
            {clip.status === "skipped" ? "Skipped" : "Skip"} <span className="dx-key">S</span>
          </button>
        </div>
        <p className="ls-nav">
          <button type="button" className="ls-link" onClick={onPrev} disabled={index <= 0}>
            <span className="dx-key">K</span> Clip above
          </button>
          <button type="button" className="ls-link" onClick={onNext} disabled={index >= total - 1}>
            Clip below <span className="dx-key">J</span>
          </button>
        </p>
      </div>
    </aside>
  );
}

function Review({ d }) {
  const { job, words, cands } = d;
  const [selId, setSelId] = useState(() => cands[0]?.id);
  const [pick, setPick] = useState(null); // a word selection waiting for an action
  const pageRef = useRef(null);
  const paras = useMemo(() => paragraphs(words), [words]);
  const lane = useMemo(() => lanes(cands), [cands]);
  const ordered = useMemo(() => [...cands].sort((a, b) => a.start - b.start), [cands]);
  const sel = cands.find((c) => c.id === selId) || ordered[0];
  const idx = ordered.indexOf(sel);
  const mine = cands.filter((c) => c.status === "approved");

  // Clip lists and unsure runs per paragraph, so each paragraph re-renders only when its own marks change.
  const perPara = useMemo(
    () =>
      paras.map((p) => {
        const clips = cands.filter((c) => c.start < p.e && c.end > p.s);
        const unsure = [];
        const push = (r) => r[1] - r[0] >= 2 && unsure.push(r);
        let run = null;
        for (let i = p.i0; i <= p.i1; i++) {
          if (words[i].p < 0.5) run = run ? [run[0], i] : [i, i];
          else if (run) {
            push(run);
            run = null;
          }
        }
        if (run) push(run);
        return { clips, unsure };
      }),
    [paras, cands, words]
  );

  const go = useCallback(
    (dir) => {
      const next = ordered[Math.min(ordered.length - 1, Math.max(0, idx + dir))];
      if (!next) return;
      setSelId(next.id);
      const el = pageRef.current?.querySelector(`[data-i="${words.findIndex((w) => w.s >= next.start - 0.01)}"]`);
      el?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    },
    [ordered, idx, words]
  );

  useEffect(() => {
    const first = cands[0];
    if (!first) return;
    const i = words.findIndex((w) => w.s >= first.start - 0.01);
    pageRef.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words.length]);

  useKeys(
    {
      j: () => go(1),
      k: () => go(-1),
      a: () => sel && d.decide(sel.id, "approved"),
      s: () => sel && d.decide(sel.id, "skipped"),
      Escape: () => {
        setPick(null);
        getSelection()?.removeAllRanges();
      },
      undo: d.undo,
    },
    [go, sel, d.decide, d.undo]
  );

  const onWord = useCallback(
    (e) => {
      if (!getSelection()?.isCollapsed) return;
      const i = +e.currentTarget.dataset.i;
      const t = words[i]?.s;
      const hit = cands.find((c) => t >= c.start - 0.01 && t <= c.end);
      if (hit) setSelId(hit.id);
    },
    [words, cands]
  );

  // Selecting words proposes a clip, or a trim of the clip it overlaps.
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const up = () => {
      const s = getSelection();
      if (!s || s.isCollapsed || !page.contains(s.anchorNode)) {
        setPick(null);
        return;
      }
      const el = (n) => (n?.nodeType === 3 ? n.parentElement : n)?.closest?.("[data-i]");
      const a = el(s.anchorNode), b = el(s.focusNode);
      if (!a || !b) return;
      const i0 = Math.min(+a.dataset.i, +b.dataset.i), i1 = Math.max(+a.dataset.i, +b.dataset.i);
      const r = d.snap(words[i0].s, words[i1].e);
      const rect = s.getRangeAt(0).getBoundingClientRect();
      const host = page.getBoundingClientRect();
      const over = cands.find((c) => c.start < r.end && c.end > r.start);
      setPick({ ...r, x: rect.left - host.left, y: rect.bottom - host.top + 8, over });
    };
    page.addEventListener("mouseup", up);
    page.addEventListener("keyup", up);
    return () => {
      page.removeEventListener("mouseup", up);
      page.removeEventListener("keyup", up);
    };
  }, [words, cands, d.snap]);

  const act = (kind) => {
    if (!pick) return;
    if (kind === "trim" && pick.over) {
      d.retime(pick.over.id, pick.start, pick.end);
      setSelId(pick.over.id);
    } else {
      const c = d.addClip(pick.start, pick.end);
      setSelId(c.id);
    }
    setPick(null);
    getSelection()?.removeAllRanges();
  };

  return (
    <div className="ls">
      <header className="ls-bar">
        <Brand />
        <FileLabel job={job} />
        <p className="ls-bar-count">
          <span className="ls-key-model" aria-hidden="true" /> {plural(cands.filter((c) => c.rank).length, "proposed clip")}
          <span className="ls-key-mine" aria-hidden="true" /> {mine.length} yours
        </p>
        <button type="button" className="ls-render" disabled={!mine.length}>
          {mine.length ? `Render ${plural(mine.length, "clip")}` : "Approve a clip to render it"}
        </button>
      </header>

      <div className="ls-desk">
        <main className="ls-page" ref={pageRef} aria-label="Transcript">
          <div className="ls-page-head">
            <p>
              The script. <span className="ls-dim">Select words to make a clip or trim one. Click a line's words to open its clip.</span>
            </p>
          </div>
          {paras.map((p, k) => (
            <Para key={p.i0} para={p} words={words} clips={perPara[k].clips} lane={lane} selId={sel?.id} unsure={perPara[k].unsure} onWord={onWord} />
          ))}
          {pick && (
            <div className="ls-pick" style={{ left: Math.max(0, pick.x), top: pick.y }} role="dialog" aria-label="Selected words">
              <span className="ls-mono">
                {tc(pick.start)} to {tc(pick.end)}, {Math.round(pick.end - pick.start)} s
              </span>
              {pick.over ? (
                <button type="button" className="ls-btn ls-approve" onClick={() => act("trim")} autoFocus>
                  Trim {pick.over.rank ? `clip ${pick.over.rank}` : "your clip"} to this
                </button>
              ) : null}
              <button type="button" className={"ls-btn" + (pick.over ? "" : " ls-approve")} onClick={() => act("make")} autoFocus={!pick.over}>
                Make a new clip
              </button>
            </div>
          )}
        </main>
        <Monitor
          key={sel?.id + ":" + sel?.start + ":" + sel?.end}
          job={job}
          clip={sel}
          index={idx}
          total={ordered.length}
          onDecide={d.decide}
          onPrev={() => go(-1)}
          onNext={() => go(1)}
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- language */

// Runs of unsure words, merged across short sure gaps so the wavy line reads as
// "this stretch" rather than flickering word by word.
function unsureRuns(words, i0, i1, gap = 4, min = 1) {
  const out = [];
  let run = null, sure = 0;
  for (let i = i0; i <= i1; i++) {
    if (words[i].p < 0.5) {
      run = run ? [run[0], i] : [i, i];
      sure = 0;
    } else if (run && ++sure > gap) {
      if (run[1] - run[0] >= min - 1) out.push(run);
      run = null;
    }
  }
  if (run && run[1] - run[0] >= min - 1) out.push(run);
  return out;
}

function useSampleAudio(job, sample) {
  const src = job ? api.sourceUrl(job.id) : null;
  const ref = useRef(null);
  const [on, setOn] = useState(false);
  const tick = useTicker(on && !src, 100);
  const [left, setLeft] = useState(10);
  useEffect(() => {
    if (!on || src) return;
    setLeft(Math.max(0, 10 - Math.floor(tick / 10)));
    if (tick >= 100) setOn(false);
  }, [on, tick, src]);
  const toggle = () => {
    const a = ref.current;
    if (!sample) return;
    if (on) {
      a?.pause();
      setOn(false);
      return;
    }
    setLeft(10);
    setOn(true);
    if (a) {
      a.currentTime = sample.s;
      a.play().catch(() => setOn(false));
    }
  };
  const el = src ? (
    <audio
      ref={ref}
      src={src}
      preload="none"
      onTimeUpdate={(e) => {
        const t = e.currentTarget.currentTime - sample.s;
        setLeft(Math.max(0, Math.ceil(10 - t)));
        if (t >= 10) {
          e.currentTarget.pause();
          setOn(false);
        }
      }}
    />
  ) : null;
  return { on, left, toggle, el };
}

function Language({ d }) {
  const { job, words } = d;
  const q = useMemo(() => languageQuestion(job, words), [job, words]);
  const a = useLanguageAnswer();
  const paras = useMemo(() => paragraphs(words), [words]);
  const sampleRef = useRef(null);
  const listen = useSampleAudio(job, q.sample);
  const [showNumbers, setShowNumbers] = useState(false);
  const perPara = useMemo(() => paras.map((p) => unsureRuns(words, p.i0, p.i1)), [paras, words]);
  const sampleK = q.sample ? paras.findIndex((p) => p.i0 <= q.sample.i0 && p.i1 >= q.sample.i0) : -1;
  const doListen = () => {
    if (!listen.on) sampleRef.current?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    listen.toggle();
  };

  return (
    <div className="ls ls-lang">
      <header className="ls-bar">
        <Brand />
        <FileLabel job={job} />
        <p className="ls-bar-count">Stopped before finding clips</p>
      </header>
      <div className="ls-desk ls-desk-lang">
        <section className="ls-ask" aria-labelledby="ls-q">
          {a.step !== "done" ? (
            <>
              <h1 id="ls-q" className="ls-question">{q.question}</h1>
              <p className="ls-ask-why">{q.evidence}</p>
              {q.sample && (
                <button type="button" className={"ls-listen" + (listen.on ? " is-on" : "")} onClick={doListen} aria-pressed={listen.on}>
                  <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
                    {listen.on ? <path d="M3 2h3v10H3zM8 2h3v10H8z" fill="currentColor" /> : <path d="M3 1.5l9 5.5-9 5.5z" fill="currentColor" />}
                  </svg>
                  {listen.on ? `Listening, ${listen.left} s` : `Listen to 10 seconds from ${tc(q.sample.s)}`}
                </button>
              )}
              {listen.el}
              {a.step === "ask" ? (
                <div className="ls-answers">
                  <button type="button" className="ls-answer is-yes" onClick={() => a.yes(q.yes.body)}>
                    <span className="ls-answer-l">{q.yes.label}</span>
                    <span className="ls-answer-s">{q.yes.after}</span>
                  </button>
                  <button type="button" className="ls-answer" onClick={a.no}>
                    <span className="ls-answer-l">{q.no.label}</span>
                    <span className="ls-answer-s">{q.no.after}</span>
                  </button>
                </div>
              ) : (
                <div className="ls-answers" role="group" aria-label="Which language?">
                  <p className="ls-which">Which language is it?</p>
                  {q.quick.map((l) => (
                    <button key={l.code} type="button" className="ls-answer is-lang" onClick={() => a.pick(l.code)} autoFocus={l === q.quick[0]}>
                      <span className="ls-answer-l">{l.name}</span>
                      {l.guess && <span className="ls-answer-s">Whisper's guess</span>}
                    </button>
                  ))}
                  <label className="ls-other">
                    <span>Another language</span>
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
                  <button type="button" className="ls-link" onClick={a.back}>
                    Back
                  </button>
                </div>
              )}
              <p className="ls-anyway">
                <button type="button" className="ls-link">
                  {q.anyway}
                </button>{" "}
                <span className="ls-dim">{q.anywayAfter}</span>
              </p>
            </>
          ) : (
            <div className="ls-done" role="status">
              <h1 className="ls-question">Listening again in {a.answer.name}.</h1>
              <p className="ls-ask-why">
                {a.answer.language === "en" ? q.yes.after : "Selects listens again in that language with its multilingual model."} The clips will be waiting here when it finishes. You can close this tab.
              </p>
              <button type="button" className="ls-link" onClick={a.back}>
                Change the answer
              </button>
            </div>
          )}
        </section>

        <main className="ls-page is-evidence" aria-label="What whisper wrote">
          <div className="ls-page-head">
            <p>
              What whisper wrote. <span className="ls-dim">The wavy line marks stretches it could not make out.</span>
            </p>
            <button type="button" className="ls-link" aria-expanded={showNumbers} onClick={() => setShowNumbers((v) => !v)}>
              {showNumbers ? "Hide the numbers" : "The numbers"}
            </button>
          </div>
          {showNumbers && q.numbers && <p className="ls-numbers ls-mono">{q.numbers}</p>}
          {paras.map((p, k) => (
            <div key={p.i0} ref={k === sampleK ? sampleRef : undefined} className={k === sampleK ? "ls-sample" + (listen.on ? " is-on" : "") : undefined}>
              <Para para={p} words={words} clips={[]} lane={{}} selId={null} unsure={perPara[k]} onWord={undefined} />
            </div>
          ))}
        </main>
      </div>
    </div>
  );
}

export default function LinedScript() {
  const d = useDirectionJob();
  if (!d.job) return <Loading error={d.error} className="ls" />;
  return screenFor(d.job) === "language" ? <Language d={d} /> : <Review d={d} />;
}
