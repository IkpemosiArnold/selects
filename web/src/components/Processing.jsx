import { useEffect, useMemo, useRef, useState } from "react";
import { Masthead } from "../App.jsx";
import { tc, aboutMinutes } from "../lib/time.js";
import { useReducedMotion } from "../lib/hooks.js";

const STEPS = [
  { key: "probe", label: "Read the file" },
  { key: "transcribe", label: "Transcribe" },
  { key: "candidates", label: "Find moments" },
  { key: "judge", label: "Judge with the model" },
];

const SHOWN = 160;
const GHOST = ".:·.  :.0 ·  9. :  3 ·.  #  ·:  .  6 = .  ·  x .  :";

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function Ghost({ seed, still }) {
  // Sparse edge-print characters standing in for speech not yet transcribed.
  // Dense next to the last word, thinning out toward the end of the reel.
  const rows = useMemo(() => {
    let s = still ? 7 : seed;
    const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    const out = [];
    for (let row = 0; row < 3; row++) {
      let line = "";
      for (let i = 0; i < 64; i++) {
        const density = Math.max(0.03, 0.55 - i / 90 - row * 0.16);
        line += r() < density ? GHOST[Math.floor(r() * GHOST.length)] : " ";
      }
      out.push(line);
    }
    return out;
  }, [seed, still]);
  return (
    <span className="ghost mono" aria-hidden="true">
      {rows.map((l, i) => (
        <span key={i} className="ghost-row">{l}</span>
      ))}
    </span>
  );
}

function Reveal({ words, active, reduce }) {
  // Words already here when the screen opened appear at once; words that
  // stream in afterwards fade up, staggered within their chunk. Each word's
  // delay is fixed the first time it is seen so later renders never restart it.
  const mountLen = useRef(words.length);
  const seen = useRef(words.length);
  const delays = useRef(new Map());
  const firstNew = seen.current;
  for (let i = firstNew; i < words.length; i++) {
    if (!delays.current.has(i)) delays.current.set(i, Math.min(400, (i - firstNew) * 16));
  }
  useEffect(() => {
    seen.current = words.length;
    if (delays.current.size > SHOWN * 2) {
      for (const k of delays.current.keys()) if (k < words.length - SHOWN) delays.current.delete(k);
    }
  });
  const start = Math.max(0, words.length - SHOWN);
  const items = [];
  let lastMark = start > 0 ? Math.floor(words[start].s / 30) : -1;
  for (let i = start; i < words.length; i++) {
    const w = words[i];
    const mark = Math.floor(w.s / 30);
    if (mark !== lastMark) {
      lastMark = mark;
      items.push(
        <span key={"m" + mark} className="rv-mark mono" aria-hidden="true">
          {tc(mark * 30)}
        </span>
      );
    }
    const fresh = !reduce && i >= mountLen.current && delays.current.has(i);
    items.push(
      <span
        key={i}
        className={"rv-w" + (fresh ? " is-new" : "") + (w.p < 0.6 ? " is-unsure" : "")}
        style={fresh ? { animationDelay: `${delays.current.get(i)}ms` } : undefined}
      >
        {w.w}{" "}
      </span>
    );
  }
  return (
    <div className="reveal" data-active={active || undefined}>
      <p className="reveal-text">
        {words.length === 0 && <span className="rv-wait">Listening for the first words. </span>}
        {items}
        {active && <Ghost seed={words.length} still={reduce} />}
      </p>
    </div>
  );
}

export default function Processing({ job, words, onResume }) {
  const reduce = useReducedMotion();
  const [resuming, setResuming] = useState(false);
  const dur = job.source?.duration || 0;
  const st = job.stages || {};
  const reached = words.length ? words[words.length - 1].e : 0;
  const tr = st.transcribe || {};
  const jd = st.judge || {};
  const isErr = job.stage === "error";
  const active = job.stage === "transcribing" && !isErr;

  // Honest numbers: prefer what the server measured; otherwise derive them.
  let rtfText = tr.note || (tr.speed ? `transcribing at ${tr.speed}x real time` : null);
  let eta = tr.etaSec;
  if (!rtfText && tr.startedAt && reached > 0) {
    const elapsed = (Date.now() - Date.parse(tr.startedAt)) / 1000;
    if (elapsed > 5) {
      const rtf = reached / elapsed;
      rtfText = `transcribing at ${rtf.toFixed(1)}x real time`;
      eta ??= (dur - reached) / rtf;
    }
  }

  let headline, sub;
  if (isErr) {
    headline = job.error?.message || "The job stopped.";
    sub = job.error?.hint || "Resume to continue from the last saved step.";
  } else if (job.stage === "queued") {
    headline = "Waiting for the job ahead of this one.";
    sub = "It starts by itself. You can close the lid; progress is saved after each step.";
  } else if (job.stage === "probing") {
    headline = "Reading the file.";
    sub = `${job.source?.name}`;
  } else if (job.stage === "transcribing") {
    headline = cap(rtfText || "Transcribing") + ".";
    sub = eta != null ? `${cap(aboutMinutes(eta))} left. You can close this tab; progress is saved.` : "Working out the speed on this laptop.";
  } else if (job.stage === "candidates") {
    headline = "Finding moments that start and end on a full sentence.";
    sub = "This takes a few seconds.";
  } else {
    headline = cap(jd.note ? `the model is reading ${jd.note}` : "the model is reading each moment") + ".";
    sub = jd.etaSec != null ? `${cap(aboutMinutes(jd.etaSec))} left.` : "";
  }

  const pct = job.stage === "transcribing" || isErr ? (dur ? reached / dur : 0) : job.stage === "judging" ? jd.progress || 0 : null;
  const ticks = useMemo(() => {
    const step = dur > 5400 ? 900 : dur > 1800 ? 300 : dur > 600 ? 120 : 60;
    const out = [];
    for (let t = 0; t <= dur; t += step) out.push(t);
    return out;
  }, [dur]);

  return (
    <>
      <Masthead job={job} />
      <main className="page proc-page">
        <ol className="steps" aria-label="Progress">
          {STEPS.map((s) => {
            const state = st[s.key]?.status || "pending";
            return (
              <li key={s.key} className={"step is-" + state} aria-current={state === "running" ? "step" : undefined}>
                <span className="step-mark" aria-hidden="true" />
                <span>{s.label}</span>
                <span className="sr-only">{state === "done" ? ", done" : state === "running" ? ", in progress" : state === "error" ? ", stopped" : ""}</span>
              </li>
            );
          })}
        </ol>

        <div className="proc-head" aria-live="polite">
          <h1 className={"h-24" + (isErr ? " is-error" : "")}>{headline}</h1>
          {sub && <p className="lede">{sub}</p>}
          {isErr && (
            <button
              className="btn btn-primary"
              disabled={resuming}
              onClick={async () => {
                setResuming(true);
                try {
                  await onResume();
                } finally {
                  setResuming(false);
                }
              }}
            >
              {resuming ? "Resuming" : "Resume"}
            </button>
          )}
        </div>

        {(job.stage === "transcribing" || isErr) && (
          <div className="reel-progress">
            <div className="rp-bar" role="progressbar" aria-label="Transcribed so far" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(reached)} aria-valuetext={`${tc(reached)} of ${tc(dur)}`}>
              <div className="rp-fill" style={{ transform: `scaleX(${pct || 0})` }} />
              {ticks.map((t) => (
                <span key={t} className="rp-tick" style={{ left: `${(t / dur) * 100}%` }} />
              ))}
            </div>
            <div className="rp-labels mono">
              <span>
                {tc(reached)} <span className="dim">of {tc(dur)}</span>
              </span>
              <span className="dim">{Math.round((pct || 0) * 100)}%</span>
            </div>
          </div>
        )}
        {job.stage === "judging" && (
          <div className="reel-progress">
            <div className="rp-bar is-blue" role="progressbar" aria-label="Moments judged" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((pct || 0) * 100)}>
              <div className="rp-fill" style={{ transform: `scaleX(${pct || 0})` }} />
            </div>
          </div>
        )}

        <section className="proc-transcript" aria-label="Transcript so far">
          <Reveal words={words} active={active} reduce={reduce} />
        </section>
      </main>
    </>
  );
}
