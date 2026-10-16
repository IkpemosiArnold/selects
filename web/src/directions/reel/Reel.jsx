// Direction 2: the reel.
//
// One clip at a time, playing large at 9:16 the way it will be posted, with
// its slate beside it. Decide with one key or a swipe, like culling photos:
// right approves, left skips, and the next clip is already there. The rest of
// the video is a thin strip at the bottom.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./reel.css";
import { useDirectionJob, screenFor, thumbFor, useKeys, api } from "../shared/data.js";
import { useWindowPlayer } from "../shared/player.js";
import { languageQuestion, useLanguageAnswer } from "../shared/language.js";
import { Brand, FileLabel, Loading } from "../shared/Brand.jsx";
import { nudgeEdge, wordsIn } from "../../lib/sentences.js";
import { tc, plural } from "../../lib/time.js";
import { useReducedMotion } from "../../lib/hooks.js";

const RUBRIC = [
  ["hook", "Hook"],
  ["standalone", "Stands alone"],
  ["payoff", "Payoff"],
  ["clarity", "Clarity"],
];

// Caption chunks the way the render burns them: 2 to 4 words, broken at punctuation.
function chunks(words, idx) {
  const out = [];
  let cur = [];
  for (const i of idx) {
    cur.push(i);
    const w = words[i].w;
    if (cur.length >= 4 || (cur.length >= 2 && /[,.?!;:]$/.test(w))) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

function Captions({ words, start, end, t, unsureStyle }) {
  const groups = useMemo(() => chunks(words, wordsIn(words, start, end)), [words, start, end]);
  const g = groups.find((c) => words[c[c.length - 1]].e >= t) || groups[groups.length - 1];
  if (!g || t < words[g[0]].s - 0.4) return null;
  return (
    <p className="rl-cap" aria-hidden="true">
      {g.map((i) => (
        <span key={i} className={(words[i].s <= t && words[i].e >= t - 0.05 ? "is-now " : "") + (unsureStyle && words[i].p < 0.5 ? "is-unsure" : "")}>
          {words[i].w}{" "}
        </span>
      ))}
    </p>
  );
}

function Frame({ job, words, start, end, autoPlay, unsureStyle, children, playerRef, fit }) {
  const src = api.sourceUrl(job.id);
  const player = useWindowPlayer({ src, start, end });
  if (playerRef) playerRef.current = player;
  const reduce = useReducedMotion();
  const [soundOff, setSoundOff] = useState(false);
  useEffect(() => {
    if (!autoPlay || reduce) return;
    const v = player.ref.current;
    if (!v) return player.play();
    // Browsers refuse sound before the first click; play muted and say so.
    v.play().catch(() => {
      v.muted = true;
      setSoundOff(true);
      v.play().catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, start]);
  const unmute = () => {
    const v = player.ref.current;
    if (v) v.muted = false;
    setSoundOff(false);
  };
  const poster = thumbFor(job, start + 0.5);
  const progress = Math.min(1, Math.max(0, (player.t - start) / Math.max(1, end - start)));
  return (
    <div className={"rl-frame" + (fit ? " is-fit" : "")}>
      {fit && poster && <img className="rl-backdrop" src={poster} alt="" aria-hidden="true" />}
      {src ? (
        <video ref={player.ref} src={src} poster={poster || undefined} preload="auto" playsInline onClick={player.toggle} />
      ) : (
        <img src={thumbFor(job, player.t)} alt="" draggable={false} onClick={player.toggle} />
      )}
      <Captions words={words} start={start} end={end} t={player.t} unsureStyle={unsureStyle} />
      <button type="button" className="rl-playpause" onClick={player.toggle} aria-label={player.playing ? "Pause" : "Play"}>
        {player.playing ? (
          <svg width="16" height="16" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 2h3v10H3zM8 2h3v10H8z" fill="currentColor" /></svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5l9 5.5-9 5.5z" fill="currentColor" /></svg>
        )}
      </button>
      {soundOff && (
        <button type="button" className="rl-sound" onClick={unmute}>
          Sound is off. Turn it on
        </button>
      )}
      <span className="rl-progress" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- review */

function useSwipe(onCommit) {
  const ref = useRef(null);
  const st = useRef(null);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    st.current = { x: e.clientX, y: e.clientY, t: performance.now(), hist: [[e.clientX, performance.now()]], id: e.pointerId, locked: false };
  };
  const onPointerMove = (e) => {
    const s = st.current;
    if (!s || s.id !== e.pointerId) return;
    const x = e.clientX - s.x;
    if (!s.locked) {
      if (Math.abs(x) < 10) return;
      if (Math.abs(e.clientY - s.y) > Math.abs(x)) {
        st.current = null;
        return;
      }
      s.locked = true;
      ref.current?.setPointerCapture(e.pointerId);
      setDragging(true);
    }
    s.hist.push([e.clientX, performance.now()]);
    if (s.hist.length > 5) s.hist.shift();
    setDx(x);
  };
  const onPointerUp = (e) => {
    const s = st.current;
    st.current = null;
    if (!s?.locked) return;
    setDragging(false);
    const [x0, t0] = s.hist[0];
    const v = (e.clientX - x0) / Math.max(1, performance.now() - t0); // px per ms
    const x = e.clientX - s.x;
    if (Math.abs(x) > 140 || (Math.abs(v) > 0.5 && Math.sign(v) === Math.sign(x))) {
      onCommit(x > 0 ? "approved" : "skipped");
    }
    setDx(0);
  };
  return { ref, dx, dragging, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } };
}

function Slate({ c, index, total }) {
  const dur = Math.round(c.end - c.start);
  return (
    <section className="rl-slate" aria-label="Slate">
      <div className="rl-sticks" aria-hidden="true" />
      <dl className="rl-fields">
        <div>
          <dt>Clip</dt>
          <dd>{c.rank ?? "+"}</dd>
        </div>
        <div>
          <dt>In</dt>
          <dd>{tc(c.start)}</dd>
        </div>
        <div>
          <dt>Out</dt>
          <dd>{tc(c.end)}</dd>
        </div>
        <div>
          <dt>Length</dt>
          <dd>{dur} s</dd>
        </div>
      </dl>
      <blockquote className="rl-hook">{c.hook}</blockquote>
      {c.reason && (
        <div className="rl-why">
          <p className="rl-why-text">{c.reason}</p>
          {c.scores && (
            <p className="rl-rubric">
              {RUBRIC.map(([k, l]) => (
                <span key={k}>
                  {l} <b>{c.scores[k]}</b>
                </span>
              ))}
            </p>
          )}
        </div>
      )}
      <p className="rl-left">
        {c.trimmed ? "Trimmed by you. " : ""}
        {index + 1} of {total} to decide
      </p>
    </section>
  );
}

function Strip({ job, cands, current }) {
  const dur = job.source?.duration || 1;
  const pct = (t) => `${(t / dur) * 100}%`;
  return (
    <div className="rl-strip" aria-label="Where the clips are in the video">
      <div className="rl-strip-track">
        {cands.map((c) => (
          <span
            key={c.id}
            className={"rl-strip-clip is-" + c.status + (c.id === current?.id ? " is-current" : "")}
            style={{ left: pct(c.start), width: pct(c.end - c.start) }}
            title={`${c.rank ? "Clip " + c.rank : "Your clip"}, ${tc(c.start)} to ${tc(c.end)}`}
          />
        ))}
      </div>
      <div className="rl-strip-ticks" aria-hidden="true">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <span key={f} style={{ left: `${f * 100}%` }}>
            {tc(f * dur)}
          </span>
        ))}
      </div>
    </div>
  );
}

function Done({ cands, onReopen }) {
  const approved = cands.filter((c) => c.status === "approved");
  return (
    <div className="rl-done">
      <p className="rl-done-big">
        {approved.length ? `${plural(approved.length, "clip")} to render.` : "Nothing approved."}
      </p>
      <p className="rl-done-sub">
        {plural(cands.filter((c) => c.status === "skipped").length, "clip")} skipped. Click any clip to decide again.
      </p>
      <ul className="rl-done-list">
        {cands.map((c) => (
          <li key={c.id}>
            <button type="button" className={"rl-done-item is-" + c.status} onClick={() => onReopen(c.id)}>
              <span className="rl-done-n">{c.rank ?? "+"}</span>
              <span className="rl-done-hook">{c.hook}</span>
              <span className="rl-done-s">{c.status === "approved" ? "Approved" : "Skipped"}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="rl-render-big" disabled={!approved.length}>
        Render {plural(approved.length, "clip")}
      </button>
    </div>
  );
}

function Review({ d }) {
  const { job, words, cands, sentences } = d;
  const reduce = useReducedMotion();
  const deck = cands.filter((c) => c.status === "proposed");
  const current = deck[0];
  const [ghosts, setGhosts] = useState([]);
  const playerRef = useRef(null);
  const approved = cands.filter((c) => c.status === "approved");

  const decide = useCallback(
    (status, fromDx = 0) => {
      if (!current) return;
      if (!reduce) setGhosts((g) => [...g, { c: current, dir: status === "approved" ? 1 : -1, from: fromDx, key: current.id + performance.now() }]);
      d.decide(current.id, status);
    },
    [current, d, reduce]
  );
  const swipe = useSwipe((status) => decide(status, swipe.dx));

  const nudge = (edge, dir) => {
    if (!current) return;
    const s = edge === "start" ? nudgeEdge(sentences, current.start, "start", dir) : current.start;
    const e = edge === "end" ? nudgeEdge(sentences, current.end, "end", dir) : current.end;
    if (e - s < 5) return;
    d.retime(current.id, s, e);
  };

  useKeys(
    {
      ArrowRight: () => decide("approved"),
      ArrowLeft: () => decide("skipped"),
      a: () => decide("approved"),
      s: () => decide("skipped"),
      " ": () => playerRef.current?.toggle(),
      ",": () => nudge("start", -1),
      ".": () => nudge("start", 1),
      "[": () => nudge("end", -1),
      "]": () => nudge("end", 1),
      z: d.undo,
      undo: d.undo,
    },
    [decide, current, d.undo, sentences]
  );

  const rot = swipe.dx / 22;
  const lean = Math.max(-1, Math.min(1, swipe.dx / 140));

  return (
    <div className="rl">
      <header className="rl-bar">
        <Brand />
        <FileLabel job={job} />
        <p className="rl-count">
          <span className="rl-dot is-approved" aria-hidden="true" /> {approved.length} approved
          <span className="rl-dot is-skipped" aria-hidden="true" /> {cands.filter((c) => c.status === "skipped").length} skipped
        </p>
        <button type="button" className="rl-render" disabled={!approved.length}>
          {approved.length ? `Render ${plural(approved.length, "clip")}` : "Render"}
        </button>
      </header>

      <main className="rl-stage">
        {current ? (
          <>
            <Slate c={current} index={cands.length - deck.length} total={cands.length} />
            <div className="rl-deck" style={{ "--depth": Math.min(3, deck.length - 1) }}>
              {deck.slice(1, 4).map((c, k) => (
                <div key={c.id} className="rl-under" style={{ "--k": k + 1 }} aria-hidden="true">
                  <img src={thumbFor(job, c.start + 0.5) || undefined} alt="" draggable={false} />
                </div>
              ))}
              {ghosts.map((g) => (
                <div
                  key={g.key}
                  className={"rl-ghost " + (g.dir > 0 ? "is-right" : "is-left")}
                  style={{ "--from": `${g.from}px` }}
                  onAnimationEnd={() => setGhosts((gs) => gs.filter((x) => x.key !== g.key))}
                  aria-hidden="true"
                >
                  <img src={thumbFor(job, g.c.start + 0.5) || undefined} alt="" />
                  <span className="rl-stamp">{g.dir > 0 ? "Approved" : "Skipped"}</span>
                </div>
              ))}
              <div
                ref={swipe.ref}
                className={"rl-card" + (swipe.dragging ? " is-dragging" : "")}
                style={{ transform: swipe.dx ? `translateX(${swipe.dx}px) rotate(${rot}deg)` : undefined }}
                {...swipe.handlers}
              >
                <Frame key={current.id + current.start + current.end} job={job} words={words} start={current.start} end={current.end} autoPlay playerRef={playerRef} fit={current.render?.reframe === "fit"}>
                  <span className="rl-lean is-approve" style={{ opacity: Math.max(0, lean) }} aria-hidden="true">
                    Approve
                  </span>
                  <span className="rl-lean is-skip" style={{ opacity: Math.max(0, -lean) }} aria-hidden="true">
                    Skip
                  </span>
                </Frame>
              </div>
            </div>
            <section className="rl-keys" aria-label="Decide">
              <button type="button" className="rl-key is-approve" onClick={() => decide("approved")}>
                <span className="rl-cap-key" aria-hidden="true">→</span>
                <span>
                  <b>Approve</b>
                  <small>Render it later</small>
                </span>
              </button>
              <button type="button" className="rl-key is-skip" onClick={() => decide("skipped")}>
                <span className="rl-cap-key" aria-hidden="true">←</span>
                <span>
                  <b>Skip</b>
                  <small>Leave it out</small>
                </span>
              </button>
              <div className="rl-nudge" role="group" aria-label="Trim by a sentence">
                <p>Trim by a sentence</p>
                <div>
                  <span>Start</span>
                  <button type="button" onClick={() => nudge("start", -1)} aria-label="Start a sentence earlier">
                    <span className="dx-key">,</span> earlier
                  </button>
                  <button type="button" onClick={() => nudge("start", 1)} aria-label="Start a sentence later">
                    <span className="dx-key">.</span> later
                  </button>
                </div>
                <div>
                  <span>End</span>
                  <button type="button" onClick={() => nudge("end", -1)} aria-label="End a sentence earlier">
                    <span className="dx-key">[</span> earlier
                  </button>
                  <button type="button" onClick={() => nudge("end", 1)} aria-label="End a sentence later">
                    <span className="dx-key">]</span> later
                  </button>
                </div>
              </div>
              <p className="rl-hint">
                <span className="dx-key">Space</span> play or pause <span className="dx-key">Z</span> undo
              </p>
            </section>
          </>
        ) : (
          <Done cands={cands} onReopen={(id) => d.decide(id, "proposed")} />
        )}
      </main>
      <Strip job={job} cands={cands} current={current} />
    </div>
  );
}

/* -------------------------------------------------------------- language */

function Language({ d }) {
  const { job, words } = d;
  const q = useMemo(() => languageQuestion(job, words), [job, words]);
  const a = useLanguageAnswer();
  const s = q.sample || { s: 0, e: 10 };
  const end = Math.min(s.s + 10, job.source?.duration || s.s + 10);

  useKeys(
    a.step === "ask"
      ? { y: () => a.yes(q.yes.body), n: a.no }
      : a.step === "pick"
      ? Object.fromEntries([...q.quick.map((l, i) => [String(i + 1), () => a.pick(l.code)]), ["Escape", a.back]])
      : { Escape: a.back },
    [a.step, q]
  );

  return (
    <div className="rl rl-lang">
      <header className="rl-bar">
        <Brand />
        <FileLabel job={job} />
        <p className="rl-count">Stopped before finding clips</p>
      </header>
      <main className="rl-stage">
        <section className="rl-ask" aria-labelledby="rl-q">
          {a.step === "done" ? (
            <div role="status">
              <h1 id="rl-q" className="rl-question">Listening again in {a.answer.name}.</h1>
              <p className="rl-ask-why">{a.answer.language === "en" ? q.yes.after : "Selects listens again in that language with its multilingual model."} The clips will be waiting here.</p>
            </div>
          ) : (
            <>
              <h1 id="rl-q" className="rl-question">{q.question}</h1>
              <p className="rl-ask-why">Watch ten seconds with whisper's captions. If the words do not match what you hear, the answer is probably no.</p>
              <p className="rl-evidence">{q.evidence}</p>
            </>
          )}
        </section>

        <div className={"rl-deck is-lang" + (a.step === "done" ? " is-done" : "")}>
          <div className="rl-card">
            <Frame job={job} words={words} start={s.s} end={end} autoPlay unsureStyle>
              <span className="rl-sample-tag">
                {tc(s.s)} to {tc(end)}, what whisper heard
              </span>
            </Frame>
          </div>
        </div>

        <section className="rl-keys" aria-label="Answer">
          {a.step === "ask" && (
            <>
              <button type="button" className="rl-key is-yes" onClick={() => a.yes(q.yes.body)}>
                <span className="rl-cap-key" aria-hidden="true">Y</span>
                <span>
                  <b>Yes, it's English</b>
                  <small>Listen again with the accent model. {q.yes.after.split(". ").slice(1).join(". ")}</small>
                </span>
              </button>
              <button type="button" className="rl-key" onClick={a.no}>
                <span className="rl-cap-key" aria-hidden="true">N</span>
                <span>
                  <b>No</b>
                  <small>Choose the language</small>
                </span>
              </button>
              <p className="rl-anyway">
                <button type="button" className="rl-linkbtn">{q.anyway}</button> {q.anywayAfter}
              </p>
            </>
          )}
          {a.step === "pick" && (
            <>
              <p className="rl-which">Which language?</p>
              {q.quick.map((l, i) => (
                <button key={l.code} type="button" className="rl-key is-lang" onClick={() => a.pick(l.code)}>
                  <span className="rl-cap-key" aria-hidden="true">{i + 1}</span>
                  <span>
                    <b>{l.name}</b>
                    {l.guess && <small>Whisper's guess</small>}
                  </span>
                </button>
              ))}
              <label className="rl-other">
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
              <button type="button" className="rl-linkbtn" onClick={a.back}>
                <span className="dx-key">Esc</span> Back
              </button>
            </>
          )}
          {a.step === "done" && (
            <button type="button" className="rl-linkbtn" onClick={a.back}>
              Change the answer
            </button>
          )}
        </section>
      </main>
    </div>
  );
}

export default function Reel() {
  const d = useDirectionJob();
  if (!d.job) return <Loading error={d.error} className="rl" />;
  return screenFor(d.job) === "language" ? <Language d={d} /> : <Review d={d} />;
}
