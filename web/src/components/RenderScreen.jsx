import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { tc, secs, plural, aboutMinutes } from "../lib/time.js";
import { copyText } from "../lib/hooks.js";
import { Masthead } from "../App.jsx";
import { frameSvg } from "../mock/frames.js";
import { thumbAt } from "./reel/util.js";
import { PlayIcon } from "./reel/Card.jsx";
import { LICENCES, needsMediaReminder } from "../lib/licences.js";

const REMINDER = "Check slides and on-screen media: a talk's licence may not cover every figure.";
const tag = (h) => (h.startsWith("#") ? h : "#" + h);

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

// One rendered clip as a take: the MP4 itself at 9:16 (its first frame until
// you play it), with the posting kit beside it.
function Row({ job, c, kit }) {
  const [playing, setPlaying] = useState(false);
  const r = c.render || { status: "pending", progress: 0 };
  const len = c.end - c.start;
  const done = r.status === "done";
  const clip = api.clipUrl(job.id, c.id);
  const title = kit?.title || c.title;
  const hashtags = (kit?.hashtags || c.hashtags || []).map(tag);
  const captionBody = kit?.captionText ?? kit?.caption ?? c.caption;
  // What gets pasted: the caption with its credit line, then the hashtags.
  const fullCaption = [kit?.caption ?? captionBody, hashtags.join(" ")].filter(Boolean).join("\n\n");
  const file = kit?.file || r.path;
  const pct = Math.round((r.progress || 0) * 100);
  return (
    <li className={"take is-" + r.status}>
      <div className="take-card">
        {done && clip ? (
          <video
            src={playing ? clip : `${clip}#t=0.4`}
            preload="metadata"
            playsInline
            controls={playing}
            autoPlay={playing}
            muted={!playing}
            aria-label={`Clip ${c.rank ?? ""} as rendered`}
          />
        ) : done ? (
          <img src={frameSvg(Math.floor((c.start / (job.source?.duration || 1)) * 60) + 1)} alt="" />
        ) : (
          thumbAt(job, c.start + 0.4) && <img className="take-poster" src={thumbAt(job, c.start + 0.4)} alt="" />
        )}
        {done && !playing && clip && (
          <button type="button" className="take-play" onClick={() => setPlaying(true)} aria-label={`Play clip ${c.rank ?? ""}`}>
            <PlayIcon playing={false} />
          </button>
        )}
        {!done && r.status !== "error" && (
          <div className="take-progress" role="progressbar" aria-label={`Clip ${c.rank} render`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ transform: `scaleY(${r.progress || 0})` }} />
            <b className="mono">{r.status === "pending" ? "Waiting" : `${pct}%`}</b>
          </div>
        )}
      </div>
      <div className="take-body">
        <p className="take-meta mono">
          Clip {c.rank ?? "+"}, {tc(c.start)} to {tc(c.end)}, {secs(len)}
          {r.status === "running" && r.etaSec ? <span className="dim">, {aboutMinutes(r.etaSec)} left</span> : null}
        </p>
        <h2 className="take-title">{title || c.hook}</h2>
        {done && r.stale && <p className="take-stale">Captions or blur changed since this render. Render it again to apply them.</p>}
        {r.status === "error" && <p className="take-error">{r.message || r.error || "This clip did not render."}</p>}
        {done && (
          <dl className="take-kit">
            <div className="kit-field">
              <dt className="label">Title</dt>
              <dd className="kit-title">{title || "No title yet"}</dd>
              <CopyButton text={title} label="Copy title" />
            </div>
            <div className="kit-field">
              <dt className="label">Caption</dt>
              <dd className="kit-caption">
                <p>{captionBody || (kit === null ? "Loading the posting kit" : "No caption in the kit")}</p>
                {hashtags.length > 0 && <p className="kit-tags">{hashtags.join(" ")}</p>}
                {kit?.attribution && <p className="kit-credit">Copying adds the credit line.</p>}
              </dd>
              <CopyButton text={fullCaption} label="Copy caption" />
            </div>
            <div className="kit-field">
              <dt className="label">File</dt>
              <dd className="mono kit-path">{file}</dd>
              <CopyButton text={file} label="Copy path" />
            </div>
          </dl>
        )}
      </div>
    </li>
  );
}

function CreditBlock({ job, attribution, onSaved }) {
  const s = job.settings || {};
  const [editing, setEditing] = useState(false);
  const [credit, setCredit] = useState(s.credit || "");
  const [license, setLicense] = useState(s.license || "");
  const [sourceUrl, setSourceUrl] = useState(s.sourceUrl || "");
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const lic = LICENCES.find(([v]) => v === s.license)?.[1] || s.license;
  return (
    <section className="credit" aria-labelledby="credit-h">
      <div className="credit-text">
        <h2 id="credit-h" className="label">Credit on every caption</h2>
        {attribution ? (
          <p className="credit-line">{attribution}</p>
        ) : s.license === "own" ? (
          <p className="credit-line dim">Own footage. No credit line is added.</p>
        ) : s.credit || lic ? (
          <p className="credit-line">{[s.credit, lic, s.sourceUrl].filter(Boolean).join(", ")}</p>
        ) : (
          <p className="credit-line dim">No credit set. If this is someone else's talk, add who made it and the licence.</p>
        )}
      </div>
      {!editing ? (
        <button type="button" className="btn btn-chip" onClick={() => setEditing(true)}>
          Edit credit
        </button>
      ) : (
        <form
          className="credit-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            setErr(null);
            try {
              const lic = license === "other" ? "" : license;
              await api.patchJob(job.id, { credit: credit.trim(), license: lic, sourceUrl: sourceUrl.trim() });
              setEditing(false);
              onSaved();
            } catch (e2) {
              setErr(e2.message);
            } finally {
              setSaving(false);
            }
          }}
        >
          <label className="field">
            <span className="field-label">Who made it</span>
            <input className="input" value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="Speaker, event and year" />
          </label>
          <label className="field">
            <span className="field-label">Licence</span>
            <select className="input select" value={license} onChange={(e) => setLicense(e.target.value)}>
              {LICENCES.map(([v, l]) => (
                <option key={v} value={v}>{v === "" ? "None" : l}</option>
              ))}
            </select>
          </label>
          <label className="field field-wide">
            <span className="field-label">Source link</span>
            <input className="input" type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://" spellCheck={false} />
          </label>
          <div className="credit-actions">
            <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Saving" : "Save credit"}</button>
            <button className="btn btn-quiet" type="button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
          <p className="field-hint">Saving rewrites the captions of clips already rendered. The videos stay as they are.</p>
          {err && <p className="field-error" role="alert">{err}</p>}
        </form>
      )}
    </section>
  );
}

function CaptionsToggle({ job, refetch, done, onRerender, busy }) {
  const [on, setOn] = useState(job.settings?.captions !== false);
  const [err, setErr] = useState(null);
  const [changed, setChanged] = useState(false);
  return (
    <div className="render-captions">
      <label className="ab-check">
        <input
          type="checkbox"
          checked={on}
          onChange={async (e) => {
            const v = e.target.checked;
            setOn(v);
            setErr(null);
            try {
              await api.patchJob(job.id, { captions: v });
              setChanged(true);
              refetch?.();
            } catch (e2) {
              setOn(!v);
              setErr(e2.message);
            }
          }}
        />
        Burn captions into the clips
      </label>
      {changed && done > 0 && (
        <button type="button" className="btn btn-chip" disabled={busy} onClick={onRerender}>
          Render {plural(done, "clip")} again {on ? "with" : "without"} captions
        </button>
      )}
      {err && <p className="field-error" role="alert">{err}</p>}
    </div>
  );
}

export default function RenderScreen({ job, refetch }) {
  const list = (job.candidates || []).filter((c) => c.render).sort((a, b) => a.rank - b.rank);
  const done = list.filter((c) => c.render.status === "done").length;
  const all = list.length;
  const finished = all > 0 && done === all;
  const failed = list.filter((c) => c.render.status === "error");
  const errors = failed.length;
  const active = list.filter((c) => c.render.status === "pending" || c.render.status === "running").length;
  const [retrying, setRetrying] = useState(false);
  const stale = list.filter((c) => c.render.status === "done" && c.render.stale);
  const [kits, setKits] = useState({});
  const [kitVersion, setKitVersion] = useState(0);
  const doneIds = list.filter((c) => c.render.status === "done").map((c) => c.id).join(",");

  useEffect(() => {
    let alive = true;
    for (const id of doneIds.split(",").filter(Boolean)) {
      api
        .getKit(job.id, id)
        .then((k) => alive && setKits((m) => ({ ...m, [id]: k })))
        .catch(() => alive && setKits((m) => ({ ...m, [id]: false })));
    }
    return () => {
      alive = false;
    };
  }, [job.id, doneIds, kitVersion]);

  const anyKit = Object.values(kits).find(Boolean);
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
            {stale.length > 0 && !active && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={retrying}
                onClick={async () => {
                  setRetrying(true);
                  try {
                    await api.render(job.id, stale.map((c) => c.id));
                  } finally {
                    setRetrying(false);
                  }
                }}
              >
                Re-render {plural(stale.length, "clip")} to apply changes
              </button>
            )}
            <a className="btn" href={`#/job/${job.id}/captions`}>Review captions</a>
            <a className="btn" href={`#/job/${job.id}/review`}>Back to review</a>
          </div>
          <CaptionsToggle
            job={job}
            refetch={refetch}
            done={done}
            busy={retrying || active > 0}
            onRerender={async () => {
              setRetrying(true);
              try {
                await api.render(job.id, list.filter((c) => c.render.status === "done").map((c) => c.id));
              } finally {
                setRetrying(false);
              }
            }}
          />
        </div>

        {all > 0 && (
          <div className="rights-panel">
            <CreditBlock job={job} attribution={anyKit?.attribution ?? null} onSaved={() => setKitVersion((v) => v + 1)} />
            {needsMediaReminder(job.settings) && (
              <p className="reminder" role="note">
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 1.5l7 12.5H1z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  <path d="M8 6v4M8 11.5v1.2" stroke="currentColor" strokeWidth="1.5" />
                </svg>
                {anyKit?.reminder || REMINDER}
              </p>
            )}
          </div>
        )}

        <ol className="takes">
          {list.map((c) => (
            <Row key={c.id} job={job} c={c} kit={kits[c.id] === undefined ? null : kits[c.id] || undefined} />
          ))}
        </ol>
      </main>
    </>
  );
}
