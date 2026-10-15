import { useState } from "react";
import { api } from "../lib/api.js";
import { tc, secs, plural, aboutMinutes } from "../lib/time.js";
import { copyText } from "../lib/hooks.js";
import { Masthead } from "../App.jsx";
import { frameSvg } from "../mock/frames.js";

function CopyButton({ text, label, done = "Copied" }) {
  const [state, setState] = useState(null);
  return (
    <button
      type="button"
      className={"btn btn-chip" + (state === "ok" ? " is-done" : "")}
      disabled={!text}
      onClick={async () => {
        const ok = await copyText(text);
        setState(ok ? "ok" : "fail");
        setTimeout(() => setState(null), 1600);
      }}
    >
      <span aria-live="polite">{state === "ok" ? done : state === "fail" ? "Copy failed" : label}</span>
    </button>
  );
}

function Row({ job, c }) {
  const [open, setOpen] = useState(false);
  const r = c.render || { status: "pending", progress: 0 };
  const len = c.end - c.start;
  const done = r.status === "done";
  const clip = api.clipUrl(job.id, c.id);
  const caption = [c.caption, (c.hashtags || []).join(" ")].filter(Boolean).join("\n\n");
  return (
    <li className={"rr is-" + r.status}>
      <div className="rr-main">
        <span className="rr-rank mono">{c.rank}</span>
        <div className="rr-text">
          <p className="rr-hook mono">{c.title || c.hook}</p>
          <p className="rr-meta mono dim">
            {tc(c.start)} to {tc(c.end)}, {secs(len)}
          </p>
        </div>
        <div className="rr-state">
          {r.status === "running" && (
            <span className="mono">
              {Math.round((r.progress || 0) * 100)}%{r.etaSec ? <span className="dim">, {aboutMinutes(r.etaSec)} left</span> : null}
            </span>
          )}
          {r.status === "pending" && <span className="dim">Waiting</span>}
          {r.status === "error" && <span className="is-error">{r.message || "This clip did not render."}</span>}
          {done && (
            <button type="button" className="btn btn-chip" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? "Hide" : "Play"}
            </button>
          )}
        </div>
      </div>
      {!done && r.status !== "error" && (
        <div className="rr-bar" role="progressbar" aria-label={`Clip ${c.rank} render`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((r.progress || 0) * 100)}>
          <div className="rr-fill" style={{ transform: `scaleX(${r.progress || 0})` }} />
        </div>
      )}
      {done && (
        <div className="rr-kit">
          {open && (
            <div className="rr-player">
              {clip ? (
                <video src={clip} controls autoPlay playsInline />
              ) : (
                <img src={frameSvg(Math.floor((c.start / (job.source?.duration || 1)) * 60) + 1)} alt="" />
              )}
            </div>
          )}
          <div className="rr-fields">
            <div className="kit-field">
              <p className="label">File</p>
              <p className="mono kit-path">{r.path}</p>
              <CopyButton text={r.path} label="Copy path" />
            </div>
            <div className="kit-field">
              <p className="label">Title</p>
              <p className="kit-title">{c.title || "No title yet"}</p>
              <CopyButton text={c.title} label="Copy title" />
            </div>
            <div className="kit-field">
              <p className="label">Caption</p>
              <p className="kit-caption">
                {c.caption || "No caption yet"}
                {c.hashtags?.length ? <span className="kit-tags"> {c.hashtags.join(" ")}</span> : null}
              </p>
              <CopyButton text={caption} label="Copy caption" />
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

export default function RenderScreen({ job }) {
  const list = (job.candidates || []).filter((c) => c.render).sort((a, b) => a.rank - b.rank);
  const done = list.filter((c) => c.render.status === "done").length;
  const all = list.length;
  const finished = all > 0 && done === all;
  const failed = list.filter((c) => c.render.status === "error");
  const errors = failed.length;
  const active = list.filter((c) => c.render.status === "pending" || c.render.status === "running").length;
  const [retrying, setRetrying] = useState(false);
  return (
    <>
      <Masthead job={job} />
      <main className="page render-page">
        <div className="render-head">
          <h1 className="h-24" aria-live="polite">
            {all === 0
              ? "Nothing rendered yet"
              : finished
              ? `Rendered ${plural(done, "clip")}`
              : active
              ? `Rendering ${plural(all, "clip")}`
              : `Rendered ${done} of ${plural(all, "clip")}`}
          </h1>
          <p className="lede">
            {all === 0
              ? "Approve clips in review, then render them here."
              : finished
              ? "Each clip is a 9:16 MP4 with captions burned in, an SRT file, and a title and caption to post with."
              : active
              ? `${done} of ${all} done. Only approved clips are rendered, so this is the slow part kept short.`
              : ""}
            {errors ? ` ${plural(errors, "clip")} did not render.` : ""}
          </p>
          <div className="render-actions">
            {errors > 0 && !active && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={retrying}
                onClick={async () => {
                  setRetrying(true);
                  try {
                    await api.render(job.id, failed.map((c) => c.id));
                  } finally {
                    setRetrying(false);
                  }
                }}
              >
                Render {plural(errors, "clip")} again
              </button>
            )}
            <a className="btn" href={`#/job/${job.id}/review`}>Back to review</a>
          </div>
        </div>
        <ol className="render-list">
          {list.map((c) => (
            <Row key={c.id} job={job} c={c} />
          ))}
        </ol>
      </main>
    </>
  );
}
