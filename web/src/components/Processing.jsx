import { useEffect, useMemo, useRef, useState } from "react";
import { Masthead } from "../App.jsx";
import { tc, aboutMinutes } from "../lib/time.js";
import { useReducedMotion } from "../lib/hooks.js";
import { languageName } from "../lib/languages.js";
import { api } from "../lib/api.js";
import { useNotifyOptIn } from "../lib/notify.js";

// The core's hints name CLI flags; in the app the same advice is said plainly.
function plainHint(h) {
  if (!h) return h;
  return h
    .replace(/\s*To judge it anyway, resume with --force\.?/g, "")
    .replace(/a bigger model \(--asr-model ([\w.-]+)\)/g, "a bigger speech model ($1)")
    .replace(/--asr-model ([\w.-]+)/g, "the $1 speech model")
    .replace(/set --language (\w+)/g, (_, c) => `set the language to ${languageName(c)}`)
    .replace(/set --language to/g, "set the language to")
    .replace(/\(--language\)/g, "")
    .replace(/--language/g, "the language")
    .replace(/\s+\./g, ".");
}

const STEPS = [
  { key: "probe", label: "Open the video" },
  { key: "language", label: "Check the language" },
  { key: "transcribe", label: "Transcribe what's said" },
  { key: "candidates", label: "Find moments that stand alone" },
  { key: "judge", label: "Gemma picks the best" },
];

const SHOWN = 160;
const BEFORE = ["queued", "probing", "language"];
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
  const lg = st.language || {};
  const checkingLanguage = lg.status === "running";
  const active = job.stage === "transcribing" && !isErr && !checkingLanguage;
  const captionMode = job.settings?.mode === "caption";
  const unreliable = isErr && job.error?.stage === "transcribe" && job.transcriptQuality?.verdict === "unreliable";

  // Honest numbers: prefer what the server measured; otherwise derive them.
  let speed = Number(tr.speed) || Number(String(tr.note || "").match(/([\d.]+)x/)?.[1]) || null;
  let eta = tr.etaSec;
  if (!speed && tr.startedAt && reached > 0) {
    const elapsed = (Date.now() - Date.parse(tr.startedAt)) / 1000;
    if (elapsed > 5) {
      speed = reached / elapsed;
      eta ??= (dur - reached) / speed;
    }
  }
  const speedText = speed ? `${speed >= 1 ? `${speed.toFixed(1)} times faster than` : `${(1 / speed).toFixed(1)} times slower than`} the video plays, on this ${api.browser ? "device" : "laptop"}.` : "";
  const leave = api.browser
    ? "Keep this tab open to finish faster. If you leave, it carries on when you come back."
    : "You can close this tab. Progress is saved.";
  const notify = useNotifyOptIn(job.id);

  let headline, sub;
  if (isErr) {
    headline = job.error?.message || "The job stopped.";
    sub = unreliable
      ? "Say which language is spoken, or try a bigger speech model, and Selects transcribes it again."
      : plainHint(job.error?.hint) || "Resume to carry on from the last saved step.";
  } else if (job.stage === "queued") {
    headline = "Waiting for the video ahead of this one.";
    sub = "It starts by itself. You can close the laptop lid, and progress is saved after each step.";
  } else if (job.stage === "probing") {
    headline = "Opening the video.";
    sub = `${job.source?.name}`;
  } else if (checkingLanguage) {
    headline = "Checking which language is spoken.";
    sub = "Selects writes out a few short samples in each likely language and keeps the one that makes the most sense.";
  } else if (job.stage === "transcribing") {
    headline = "Transcribing what's said.";
    sub = eta != null ? `${cap(aboutMinutes(eta))} left. ${speedText} ${leave}` : `Timing the speed on this ${api.browser ? "device" : "laptop"}. ${leave}`;
  } else if (job.stage === "candidates") {
    headline = "Finding moments that start and end on a full sentence.";
    sub = "This takes a few seconds.";
  } else {
    headline = jd.note ? `Gemma is reading ${jd.note}.` : "Gemma is reading each moment.";
    sub = `${jd.etaSec != null ? `${cap(aboutMinutes(jd.etaSec))} left. ` : ""}${leave}`;
  }

  const pct = job.stage === "transcribing" || isErr ? (dur ? reached / dur : 0) : job.stage === "judging" ? jd.progress || 0 : null;
  const ticks = useMemo(() => {
    const step = dur > 5400 ? 900 : dur > 1800 ? 300 : dur > 600 ? 120 : 60;
    const out = [];
    for (let t = 0; t <= dur - step * 0.4; t += step) out.push(t);
    return out;
  }, [dur]);

  const steps = STEPS.filter((s) => st[s.key] && st[s.key].status !== "skipped" && !(captionMode && (s.key === "candidates" || s.key === "judge")));
  const stepNow = steps.find((s) => st[s.key]?.status === "running" || st[s.key]?.status === "error");
  const left = job.stage === "transcribing" ? eta : job.stage === "judging" ? jd.etaSec : null;

  return (
    <div className="proc">
      <Masthead job={job} />
      <main className="proc-stage">
        <section className="proc-left" aria-live="polite">
          <div className="slate is-proposed">
            <div className="slate-clap" aria-hidden="true">
              <div className="slate-stick" />
              <div className="slate-hinge" />
              <div className="slate-stick slate-stick-base" />
            </div>
            <div className="slate-board">
              <dl className="slate-fields">
                <div>
                  <dt>Step</dt>
                  <dd>
                    {stepNow ? steps.indexOf(stepNow) + 1 : steps.filter((s) => st[s.key]?.status === "done").length}
                    <small> of {steps.length}</small>
                  </dd>
                </div>
                <div>
                  <dt>Heard</dt>
                  <dd>{tc(reached)}</dd>
                </div>
                <div>
                  <dt>Length</dt>
                  <dd>{tc(dur)}</dd>
                </div>
                <div>
                  <dt>Left</dt>
                  <dd>{left != null ? tc(left) : "--:--"}</dd>
                </div>
              </dl>
              <h1 className={"slate-line is-mid proc-headline" + (isErr ? " is-error" : "")}>{headline}</h1>
              {isErr && <p className="slate-mark is-skipped">Stopped</p>}
            </div>
            {sub && <p className="proc-sub">{sub}</p>}
            {isErr && !unreliable && (
              <button
                className="btn btn-primary btn-big proc-resume"
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
            {!isErr && notify.supported && (
              <label className="ab-check notify-opt">
                <input type="checkbox" checked={notify.on} onChange={notify.toggle} disabled={notify.denied && !notify.on} />
                {notify.denied && !notify.on ? "Notifications are blocked for this page in your browser settings." : "Notify me when it's done"}
              </label>
            )}
            <ol className="steps" aria-label="Progress">
              {steps.map((s) => {
                const state = st[s.key]?.status || "pending";
                return (
                  <li key={s.key} className={"step is-" + state} aria-current={state === "running" ? "step" : undefined}>
                    <span className="step-mark" aria-hidden="true" />
                    <span>{s.label}</span>
                    {state === "running" && st[s.key]?.progress > 0 && <span className="step-pct mono">{Math.round(st[s.key].progress * 100)}%</span>}
                    <span className="sr-only">{state === "done" ? ", done" : state === "running" ? ", in progress" : state === "error" ? ", stopped" : ""}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>

        <section className="proc-transcript" aria-label="Transcript so far">
          <p className="proc-page-head">What Selects has heard so far</p>
          <Reveal words={words} active={active} reduce={reduce} />
        </section>
      </main>

      <div className="timeline proc-timeline">
        <div
          className={"tl-track proc-track" + (job.stage === "judging" ? " is-judging" : "")}
          role="progressbar"
          aria-label={job.stage === "judging" ? "Moments judged" : "Transcribed so far"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((pct || 0) * 100)}
          aria-valuetext={job.stage === "judging" ? `${Math.round((pct || 0) * 100)}%` : `${tc(reached)} of ${tc(dur)}`}
        >
          <span className="proc-fill" style={{ transform: `scaleX(${pct ?? (BEFORE.includes(job.stage) ? 0 : 1)})` }} />
        </div>
        <div className="tl-ticks" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} style={{ left: `${(t / (dur || 1)) * 100}%` }}>
              {tc(t)}
            </span>
          ))}
          <span className="is-end" style={{ left: "100%" }}>{tc(dur)}</span>
        </div>
      </div>
    </div>
  );
}
