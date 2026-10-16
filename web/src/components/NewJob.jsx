import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { tc, plural } from "../lib/time.js";
import { Masthead, MiddleTruncate, go } from "../App.jsx";
import ModelControl from "./ModelControl.jsx";
import QueueList from "./QueueList.jsx";
import { measuredRates } from "../lib/estimate.js";
import { LICENCES } from "../lib/licences.js";
import { LANGUAGES } from "../lib/languages.js";



function healthIssues(h) {
  if (!h) return [];
  const out = [];
  if (!h.whisper)
    out.push({
      what: "Whisper was not found, so Selects cannot transcribe.",
      fix: "Build whisper.cpp, then set SELECTS_WHISPER_BIN to the whisper-cli path and restart Selects.",
      code: "export SELECTS_WHISPER_BIN=/path/to/whisper-cli",
    });
  if (!h.ollama)
    out.push({
      what: "Ollama is not running, so Selects cannot judge the moments.",
      fix: "Start Ollama, then reload this page.",
      code: "ollama serve",
    });
  else if (!h.models?.length)
    out.push({
      what: "Ollama is running but has no Gemma model.",
      fix: "Pull one, then reload. The 1b model is faster; the 4b model judges better.",
      code: "ollama pull gemma3:4b",
    });
  if (h.diskFreeGb != null && h.diskFreeGb < 5)
    out.push({
      what: `Only ${h.diskFreeGb} GB of disk is free.`,
      fix: "A long video needs about 2 GB while it works. Free some space before you start.",
    });
  return out;
}

function statusLine(j) {
  const n = j.candidateCount ?? j.candidates?.length ?? 0;
  const approved = j.approvedCount ?? j.candidates?.filter((c) => c.status === "approved").length ?? 0;
  const rendered = j.candidates?.filter((c) => c.render?.status === "done").length || 0;
  if (j.settings?.mode === "caption") {
    if (j.stage === "ready") return j.transcriptQuality?.verdict === "shaky" ? "Captions ready, check the unsure words" : "Captions ready to review";
    if (j.stage === "done") return j.output?.stale ? "Captioned, captions changed since" : "Captioned video rendered";
    if (j.stage === "rendering") return "Rendering the captioned video";
  }
  switch (j.stage) {
    case "ready":
      return approved ? `${approved} approved of ${n}` : n ? `Ready to review, ${plural(n, "clip")}` : "Ready to review";
    case "done":
      return rendered ? `Rendered ${plural(rendered, "clip")}` : approved ? `Rendered ${plural(approved, "clip")}` : "Rendered";
    case "rendering":
      return "Rendering";
    case "error":
      return "Stopped. Open it to resume";
    case "queued":
      return "Waiting its turn";
    default: {
      const k = { probing: "probe", transcribing: "transcribe", candidates: "candidates", judging: "judge" }[j.stage];
      const p = j.stages?.[k]?.progress;
      return `${j.stage[0].toUpperCase() + j.stage.slice(1)}${p ? ` ${Math.round(p * 100)}%` : ""}`;
    }
  }
}

export default function NewJob() {
  const [health, setHealth] = useState(null);
  const [models, setModels] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [path, setPath] = useState("");
  const [model, setModel] = useState(null);
  const [minLen, setMinLen] = useState(20);
  const [maxLen, setMaxLen] = useState(60);
  const [k, setK] = useState(5);
  const [judgeN, setJudgeN] = useState(8);
  const [mode, setMode] = useState("clips");
  const [language, setLanguage] = useState("en");
  const [credit, setCredit] = useState("");
  const [license, setLicense] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [queue, setQueue] = useState(null);
  const [notice, setNotice] = useState(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [hint, setHint] = useState(null);
  const fileRef = useRef(null);
  const pathRef = useRef(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth({ ok: false, unreachable: true }));
    api.models().then((ms) => {
      setModels(ms);
      const pref = ms.find((m) => m.name === "gemma3:4b") || ms.find((m) => m.name.startsWith("gemma3")) || ms[0];
      if (pref) setModel(pref.name);
    }).catch(() => setModels([]));
    api.listJobs().then(setJobs).catch(() => {});
  }, []);

  // The queue changes while the page is open; poll it gently.
  useEffect(() => {
    let alive = true;
    let lastKey = "";
    const tick = async () => {
      try {
        const q = await api.queue();
        if (!alive) return;
        setQueue(q);
        const key = JSON.stringify([q.running, q.items?.map((x) => x.jobId + x.kind)]);
        if (key !== lastKey) {
          lastKey = key;
          api.listJobs().then((j) => alive && setJobs(j)).catch(() => {});
        }
      } catch {}
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const takeFile = async (file) => {
    setError(null);
    setHint(null);
    setPath(file.name);
    const found = await api.locate(file.name, file.size);
    if (found) {
      setPath(found);
    } else {
      setHint(`Your browser hides which folder ${file.name} is in. Type the full path, for example ~/Movies/${file.name}`);
      pathRef.current?.focus();
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setOver(false);
    const text = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (text && /^(file:\/\/|\/|~)/.test(text.trim())) {
      setPath(decodeURIComponent(text.trim().split("\n")[0].replace(/^file:\/\//, "")));
      return;
    }
    const f = e.dataTransfer.files?.[0];
    if (f) takeFile(f);
  };

  const submit = async (e, mode = "now") => {
    e?.preventDefault?.();
    if (!path.trim()) {
      setError("Add the path to a video first.");
      pathRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const settings = {
        mode,
        language,
        ...(mode === "caption"
          ? {}
          : { model, k: Number(k), minLen: Number(minLen), maxLen: Number(maxLen), judgeN: Number(judgeN), preset: "shorts" }),
        ...(credit.trim() ? { credit: credit.trim() } : {}),
        ...(license && license !== "other" ? { license } : {}),
        ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
      };
      const job = await api.createJob(path.trim(), settings, { queueOnly: mode === "queue" });
      if (mode === "queue") {
        setNotice(`Queued ${job.source?.name}. It starts when the jobs ahead of it finish.`);
        setPath("");
        setBusy(false);
        api.queue().then(setQueue).catch(() => {});
        api.listJobs().then(setJobs).catch(() => {});
        return;
      }
      go(`#/job/${job.id}`);
    } catch (err) {
      setError(err.message || "Selects could not start that job.");
      setBusy(false);
    }
  };

  const rates = measuredRates(jobs);
  const issues = health?.unreachable
    ? [{ what: "Selects cannot reach its local server.", fix: "Start it in a terminal, then reload this page.", code: "npm run serve" }]
    : healthIssues(health);

  return (
    <>
      <Masthead />
      <main className="page new-page">
        {issues.length > 0 && (
          <section className="health" aria-labelledby="health-h">
            <h2 id="health-h" className="h-18">Fix these before you start</h2>
            <ul>
              {issues.map((x) => (
                <li key={x.what}>
                  <p className="health-what">{x.what}</p>
                  <p className="health-fix">{x.fix}</p>
                  {x.code && <code className="health-code">{x.code}</code>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <form onSubmit={submit} className="new-form">
          <div
            className={"leader" + (over ? " is-over" : "")}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <div className="perfs" aria-hidden="true" />
            <div className="leader-body">
              <h1 className="leader-title">Drop a long video here, or choose a file.</h1>
              <p className="leader-sub">Nothing leaves this laptop.</p>
              <div className="leader-actions">
                <button type="button" className="btn btn-quiet-on-film" onClick={() => fileRef.current?.click()}>
                  Choose a file
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="video/*,.mkv"
                  hidden
                  onChange={(e) => e.target.files?.[0] && takeFile(e.target.files[0])}
                />
              </div>
            </div>
            <svg className="leader-mark" viewBox="0 0 200 200" aria-hidden="true">
              <circle cx="100" cy="100" r="84" />
              <circle cx="100" cy="100" r="70" />
              <path d="M100 0v200M0 100h200" />
              <text x="100" y="100" dominantBaseline="central" textAnchor="middle">8</text>
            </svg>
            <div className="perfs" aria-hidden="true" />
          </div>

          <div className="new-grid">
            <div className="new-left">
              <label className="label" htmlFor="path">Video path</label>
              <div className="path-row">
                <input
                  id="path"
                  ref={pathRef}
                  className="input mono"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="~/Movies/talk.mp4"
                  spellCheck={false}
                  autoComplete="off"
                  aria-describedby={hint ? "path-hint" : error ? "path-error" : undefined}
                  aria-invalid={!!error}
                />
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  {busy ? "Starting" : mode === "caption" ? "Caption the video" : "Find clips"}
                </button>
                <button className="btn" type="button" disabled={busy} onClick={(e) => submit(e, "queue")}>
                  Queue for overnight
                </button>
              </div>
              {notice && <p className="field-ok" role="status">{notice}</p>}
              {hint && <p id="path-hint" className="field-hint">{hint}</p>}
              {error && <p id="path-error" className="field-error" role="alert">{error}</p>}

              <fieldset className="lengths">
                <legend className="label">The brief</legend>
                <div className="mode-row">
                  <div className="seg seg-light" role="radiogroup" aria-label="What to make">
                    {[["clips", "Find clips"], ["caption", "Caption the whole video"]].map(([v, l]) => (
                      <button key={v} type="button" role="radio" aria-checked={mode === v} className={"seg-btn" + (mode === v ? " is-on" : "")} onClick={() => setMode(v)}>
                        {l}
                      </button>
                    ))}
                  </div>
                  <label className="lang-field">
                    <span>Spoken in</span>
                    <select className="input select" value={language} onChange={(e) => setLanguage(e.target.value)}>
                      {LANGUAGES.slice(0, 1).map(([c, n]) => (
                        <option key={c} value={c}>{n}</option>
                      ))}
                      <option value="auto">Detect automatically</option>
                      {LANGUAGES.slice(1).map(([c, n]) => (
                        <option key={c} value={c}>{n}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {mode === "caption" ? (
                  <p className="brief-line caption-brief">
                    Transcribe the whole video, let you correct the captions and blur what should not be seen, then burn the captions in. The video keeps its shape. No clips, no judge model.
                  </p>
                ) : (
                <p className="brief-line">
                  Clips from
                  <input className="input num mono" type="number" min={5} max={180} value={minLen} onChange={(e) => setMinLen(e.target.value)} aria-label="Shortest clip in seconds" />
                  to
                  <input className="input num mono" type="number" min={10} max={180} value={maxLen} onChange={(e) => setMaxLen(e.target.value)} aria-label="Longest clip in seconds" />
                  seconds, up to
                  <input className="input num mono" type="number" min={1} max={30} value={k} onChange={(e) => setK(e.target.value)} aria-label="Number of clips to propose" />
                  clips, in 9:16 with captions. The model reads the best
                  <input className="input num mono" type="number" min={2} max={30} value={judgeN} onChange={(e) => setJudgeN(e.target.value)} aria-label="Moments the model reads" />
                  moments.
                </p>
                )}
                {language === "auto" && (
                  <p className="field-hint">Selects compares a few samples in each likely language. Accented English is often guessed as another language, so choose it here if you know it.</p>
                )}
              </fieldset>

              <fieldset className="rights">
                <legend className="label">Credit</legend>
                <div className="rights-grid">
                  <label className="field">
                    <span className="field-label">Who made it</span>
                    <input className="input" value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="Speaker, event and year" autoComplete="off" />
                  </label>
                  <label className="field">
                    <span className="field-label">Licence</span>
                    <select className="input select" value={license} onChange={(e) => setLicense(e.target.value)}>
                      {LICENCES.map(([v, l]) => (
                        <option key={v} value={v} disabled={v === ""}>{l}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field field-wide">
                    <span className="field-label">Source link</span>
                    <input className="input" type="url" inputMode="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://" autoComplete="off" spellCheck={false} />
                  </label>
                </div>
                <p className="field-hint">
                  {license === "own"
                    ? "Your own footage needs no credit line. Add one anyway if you want your name on the post."
                    : "Added to every caption, so the original gets credit and the licence is followed."}
                </p>
              </fieldset>
            </div>
            <div className="new-right">
              {mode === "caption" ? (
                <div className="model-control">
                  <p className="label">No judge model needed</p>
                  <p className="dim">Captioning uses whisper only. You review every caption before anything is rendered.</p>
                </div>
              ) : models ? (
                <ModelControl models={models} value={model} onChange={setModel} judgeN={Number(judgeN) || 8} rates={rates} />
              ) : (
                <div className="model-control is-loading" aria-busy="true" />
              )}
            </div>
          </div>
        </form>

        <QueueList queue={queue} jobs={jobs} rates={rates} models={models || []} />

        {jobs.length > 0 && (
          <section className="recent" aria-labelledby="recent-h">
            <h2 id="recent-h" className="h-18">On this laptop</h2>
            <ul>
              {jobs.map((j) => (
                <li key={j.id}>
                  <a href={`#/job/${j.id}`} className="recent-row">
                    <span className="recent-name" title={j.source?.path}><MiddleTruncate text={j.source?.name} /></span>
                    <span className="mono dim">{tc(j.source?.duration)}</span>
                    <span className={"recent-status" + (j.stage === "error" ? " is-error" : "")}>{statusLine(j)}</span>
                    <span className="mono dim recent-date">{new Date(j.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}
