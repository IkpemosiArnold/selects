import { useEffect, useRef, useState } from "react";
import { api, inBrowser } from "../lib/api.js";
import EnginePanel, { useEngine, LAPTOP_LINE } from "./EnginePanel.jsx";
import { tc, plural } from "../lib/time.js";
import { Masthead, MiddleTruncate, go } from "../App.jsx";
import ModelControl from "./ModelControl.jsx";
import QueueList from "./QueueList.jsx";
import { thumbAt } from "./reel/util.js";
import { measuredRates } from "../lib/estimate.js";
import { LICENCES } from "../lib/licences.js";
import { LANGUAGES, languageName } from "../lib/languages.js";
import { MADE_FOR, madeForById } from "../lib/madeFor.js";



// "gemma3-4b-hf:latest" reads as "Gemma 3 4B"; other names stay as they are.
function modelLabel(name) {
  if (!name) return "Gemma";
  const m = String(name).match(/gemma[-_ ]?(\d+(?:\.\d+)?)\D*?(\d+(?:\.\d+)?)b/i);
  return m ? `Gemma ${m[1]} ${m[2]}B` : name;
}

// A job saved by the browser engine, in words: where it will carry on from.
function savedLine(x) {
  const when = x.savedAt ? new Date(x.savedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
  const at = { probe: "Not started yet", transcribe: "Stopped before transcribing", candidates: "Transcribed", judge: "Transcribed. Gemma has not picked yet", render: "Clips picked", done: "Clips picked" }[x.from];
  return [x.finished ? "Clips ready to check" : at || "Stopped part way", when].filter(Boolean).join(", ");
}

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
      what: "Ollama is not running, so Gemma cannot pick the moments.",
      fix: "Start Ollama, then reload this page.",
      code: "ollama serve",
    });
  else if (!h.models?.length)
    out.push({
      what: "Ollama is running, but it has no Gemma model.",
      fix: "Download one, then reload. The 1b model is faster, and the 4b model picks better clips.",
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
    if (j.stage === "ready") return j.transcriptQuality?.verdict === "shaky" ? "Captions ready. Check the unsure words" : "Captions ready to check";
    if (j.stage === "done") return j.output?.stale ? "Captions changed since the render" : "Captioned video ready";
    if (j.stage === "rendering") return "Rendering the captioned video";
  }
  switch (j.stage) {
    case "ready":
    {
      const left = j.candidates ? j.candidates.filter((c) => c.status === "proposed").length : n;
      return approved ? `${approved} of ${n} approved` : left ? `${plural(left, "clip")} to check` : n ? "Every clip checked" : "Ready to check";
    }
    case "done":
      return rendered ? `Rendered ${plural(rendered, "clip")}` : approved ? `Rendered ${plural(approved, "clip")}` : "Rendered";
    case "rendering":
      return "Rendering";
    case "error":
      return "Stopped. Open it to carry on";
    case "queued":
      return "Waiting its turn";
    default: {
      const k = { probing: "probe", transcribing: "transcribe", candidates: "candidates", judging: "judge" }[j.stage];
      const p = j.stages?.[k]?.progress;
      const what = { probing: "Opening the video", language: "Checking the language", transcribing: "Transcribing", candidates: "Finding moments", judging: "Gemma is choosing" }[j.stage] || j.stage;
      return `${what}${p ? `, ${Math.round(p * 100)}%` : ""}`;
    }
  }
}

export default function NewJob() {
  const [health, setHealth] = useState(null);
  const [models, setModels] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [path, setPath] = useState("");
  const [model, setModel] = useState(null);
  const [madeFor, setMadeFor] = useState("shorts");
  const [ownLengths, setOwnLengths] = useState(false);
  const [minLen, setMinLen] = useState(20);
  const [maxLen, setMaxLen] = useState(60);
  const preset = madeForById(madeFor);
  const pickMadeFor = (id) => {
    const m = madeForById(id);
    setMadeFor(id);
    if (m && !ownLengths) {
      setMinLen(m.minLen);
      setMaxLen(m.maxLen);
    }
  };
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
  // The browser engine takes the File itself; the server takes a path on this laptop.
  const [file, setFile] = useState(null);
  const [saved, setSaved] = useState([]);
  const engine = inBrowser ? useEngine() : null; // eslint-disable-line react-hooks/rules-of-hooks
  const smart = engine?.mode?.mode === "smart";
  // The list carries summaries; the stills and clips come from each job (a few small requests).
  const [full, setFull] = useState({});
  useEffect(() => {
    let alive = true;
    for (const j of jobs.slice(0, 24)) {
      if (full[j.id] && full[j.id].updatedAt === j.updatedAt) continue;
      api.getJob(j.id).then((x) => alive && x && setFull((m) => ({ ...m, [j.id]: { thumbs: x.thumbs, candidates: x.candidates, updatedAt: x.updatedAt } }))).catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps
  const pathRef = useRef(null);

  useEffect(() => {
    if (inBrowser) api.listSaved().then(setSaved).catch(() => {});
    else api.health().then(setHealth).catch(() => setHealth({ ok: false, unreachable: true }));
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
      if (inBrowser) return; // no overnight queue in the browser
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
    if (inBrowser) {
      setFile(file);
      return;
    }
    const found = await api.locate(file.name, file.size);
    if (found) {
      setPath(found);
    } else {
      setHint(`Your browser does not say which folder ${file.name} is in. Type where it is, for example ~/Movies/${file.name}`);
      pathRef.current?.focus();
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setOver(false);
    const text = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (!inBrowser && text && /^(file:\/\/|\/|~)/.test(text.trim())) {
      setPath(decodeURIComponent(text.trim().split("\n")[0].replace(/^file:\/\//, "")));
      return;
    }
    const f = e.dataTransfer.files?.[0];
    if (f) takeFile(f);
  };

  const submit = async (e, how = "now") => {
    e?.preventDefault?.();
    if (inBrowser ? !file : !path.trim()) {
      setError("Choose a video first.");
      if (!inBrowser) pathRef.current?.focus();
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
          : { model, k: Number(k), judgeN: Number(judgeN), preset: "shorts", madeFor, ...(ownLengths ? { minLen: Number(minLen), maxLen: Number(maxLen) } : {}) }),
        ...(credit.trim() ? { credit: credit.trim() } : {}),
        ...(license && license !== "other" ? { license } : {}),
        ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
      };
      if (inBrowser) {
        // English only, clips only, and the judge is set by Private or Smart mode
        const { mode: _m, language: _l, model: _model, ...browserSettings } = settings;
        const job = await api.createJob(file, browserSettings);
        go(`#/job/${job.id}`);
        return;
      }
      const job = await api.createJob(path.trim(), settings, { queueOnly: how === "queue" });
      if (how === "queue") {
        setNotice(`Added ${job.source?.name} to the overnight queue. It starts when the jobs ahead of it finish.`);
        setPath("");
        setBusy(false);
        api.queue().then(setQueue).catch(() => {});
        api.listJobs().then(setJobs).catch(() => {});
        return;
      }
      go(`#/job/${job.id}`);
    } catch (err) {
      setError(err.message || "Selects could not start on that video.");
      setBusy(false);
    }
  };

  const rates = measuredRates(jobs);
  // Started and not finished: still working, or stopped. Queued jobs show in the queue.
  const queued = new Set((queue?.items || []).map((q) => q.jobId));
  const unfinished = jobs.filter((j) => !queued.has(j.id) && (["probing", "language", "transcribing", "candidates", "judging", "error"].includes(j.stage) || j.resumable));
  const issues = inBrowser ? [] : health?.unreachable
    ? [{ what: "Selects cannot reach its local server.", fix: "Start it in a terminal, then reload this page.", code: "npm run serve" }]
    : healthIssues(health);

  const langLabel = language === "auto" ? "language found for you" : `in ${languageName(language)}`;
  const summary =
    mode === "caption"
      ? `Captions for the whole video, ${langLabel}.`
      : inBrowser
      ? `Up to ${plural(Number(k) || 0, "clip")}, in English. Gemma picks them${smart ? " through Google's API" : " in this tab"}.`
      : `Up to ${plural(Number(k) || 0, "clip")}, ${langLabel}. ${modelLabel(model)} picks them.`;
  const licName = LICENCES.find(([v]) => v === license)?.[1];
  const creditSummary = credit.trim()
    ? [credit.trim(), license && license !== "other" ? licName : null].filter(Boolean).join(", ")
    : license === "own"
    ? "Your own video. No credit line is added."
    : "None yet. Add one if someone else made the video.";
  const picked = path.trim();
  const pickedName = picked.split(/[\\/]/).pop();

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

        {!inBrowser && unfinished.length > 0 && (
          <section className="resume" aria-labelledby="resume-h">
            <h2 id="resume-h" className="h-18">Not finished yet</h2>
            <ul className="resume-list">
              {unfinished.slice(0, 3).map((j) => (
                <li key={j.id}>
                  <a className={"resume-row" + (j.stage === "error" ? " is-error" : "")} href={`#/job/${j.id}`}>
                    <span className="resume-name" title={j.source?.path}><MiddleTruncate text={j.source?.name || j.id} tail={10} /></span>
                    <span className="resume-status">{statusLine(j)}</span>
                    <span className="resume-go">{j.stage === "error" ? "Open" : "Continue"}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {inBrowser && saved.length > 0 && (
          <section className="resume" aria-labelledby="saved-h">
            <h2 id="saved-h" className="h-18">{saved.some((x) => !x.finished) ? "Not finished yet" : "Saved on this device"}</h2>
            <ul className="resume-list">
              {[...saved.filter((x) => !x.finished), ...saved.filter((x) => x.finished)].slice(0, 4).map((x) => (
                <li key={x.key}>
                  <button
                    type="button"
                    className={"resume-row" + (x.finished ? " is-done" : "")}
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setError(null);
                      try {
                        const job = await api.openSaved(x.key);
                        go(`#/job/${job.id}`);
                      } catch (e) {
                        setError(e.message);
                        setBusy(false);
                      }
                    }}
                  >
                    <span className="resume-name"><MiddleTruncate text={x.name || "Your video"} tail={10} /></span>
                    <span className="resume-status">{savedLine(x)}</span>
                    <span className="resume-go">{x.finished ? "Open" : "Continue"}</span>
                  </button>
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
              <h1 className="leader-title">{mode === "caption" ? "Add captions to a whole video." : "Turn a long video into short, captioned clips."}</h1>
              <p className="leader-sub">
                {mode === "caption"
                  ? "Selects writes the captions, you fix any word, and it renders the video with them. Nothing is uploaded."
                  : inBrowser
                  ? smart
                    ? "Gemma picks the best moments and says why. You approve each clip before anything is rendered. Your video stays on this device."
                    : "Gemma picks the best moments and says why. You approve each clip before anything is rendered. Everything runs in this tab, and nothing is uploaded."
                  : "Gemma picks the best moments and says why. You approve each clip before anything is rendered. Nothing is uploaded."}
              </p>
              <div className="leader-actions">
                {picked ? (
                  <>
                    <p className="picked">
                      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="3" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M6.5 6v4l3.5-2z" fill="currentColor" /></svg>
                      <span className="picked-name" title={picked}><MiddleTruncate text={pickedName} tail={10} /></span>
                    </p>
                    <div className="leader-buttons">
                      <button className="btn btn-mark btn-big" type="submit" disabled={busy}>
                        {busy ? "Starting" : mode === "caption" ? "Caption this video" : "Find clips"}
                      </button>
                      <button type="button" className="btn btn-quiet-on-film" onClick={() => fileRef.current?.click()} disabled={busy}>
                        Choose another
                      </button>
                    </div>
                    {!inBrowser && (
                      <button className="linkish on-film" type="button" disabled={busy} onClick={(e) => submit(e, "queue")}>
                        Add it to the overnight queue instead
                      </button>
                    )}
                  </>
                ) : (
                  <div className="leader-buttons">
                    <button type="button" className="btn btn-mark btn-big" onClick={() => fileRef.current?.click()}>
                      Choose a video
                    </button>
                    <span className="leader-or">or drop one here</span>
                  </div>
                )}
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
          {notice && <p className="field-ok" role="status">{notice}</p>}
          {error && <p id="path-error" className="field-error" role="alert">{error}</p>}

          {!inBrowser && <div className="path-field">
            <label className="field-label" htmlFor="path">Or type where the video is on this laptop</label>
            <input
              id="path"
              ref={pathRef}
              className="input mono"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="~/Movies/talk.mp4"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              enterKeyHint="go"
              aria-describedby={hint ? "path-hint" : error ? "path-error" : undefined}
              aria-invalid={!!error}
            />
            {hint && <p id="path-hint" className="field-hint">{hint}</p>}
          </div>}

          {mode !== "caption" && (
            <fieldset className="made-for">
              <legend className="field-label">Made for</legend>
              <div className="seg seg-light seg-wide" role="radiogroup" aria-label="Made for">
                {MADE_FOR.map((m) => (
                  <button key={m.id} type="button" role="radio" aria-checked={!ownLengths && madeFor === m.id} className={"seg-btn" + (!ownLengths && madeFor === m.id ? " is-on" : "")} onClick={() => { setOwnLengths(false); pickMadeFor(m.id); setMinLen(m.minLen); setMaxLen(m.maxLen); }}>
                    <span className="mf-long">{m.label}</span>
                    <span className="mf-short">{m.short}</span>
                  </button>
                ))}
              </div>
              <p className="field-hint">
                {ownLengths ? `Your own lengths, ${minLen} to ${maxLen} seconds. The captions and the post suit ${preset?.label}.` : preset?.hint}
              </p>
            </fieldset>
          )}

          {inBrowser && <EnginePanel engine={engine} />}

          <div className="folds">
            <details className="fold">
              <summary>
                <span className="fold-h">{mode === "caption" ? "Caption settings" : "Clip settings"}</span>
                <span className="fold-sum">{summary}</span>
              </summary>
              <div className="fold-body">
                {inBrowser ? (
                  <p className="field-hint">Selects Web transcribes English speech, and works best on videos up to about 10 to 15 minutes.</p>
                ) : <div className="mode-row">
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
                      <option value="auto">Find it for me</option>
                      {LANGUAGES.slice(1).map(([c, n]) => (
                        <option key={c} value={c}>{n}</option>
                      ))}
                    </select>
                  </label>
                </div>}
                {!inBrowser && language === "auto" && (
                  <p className="field-hint">Selects tries a few short samples in each likely language. Accented English is often mistaken for another language, so pick English here if you know it.</p>
                )}
                {mode === "caption" ? (
                  <p className="brief-line caption-brief">
                    Selects writes captions for the whole video. You fix any wrong word and blur what should not be seen, then it renders the video with the captions on it. The video keeps its shape, and Gemma is not used.
                  </p>
                ) : (
                  <>
                    <p className="brief-line">
                      Up to
                      <input className="input num mono" type="number" inputMode="numeric" min={1} max={30} value={k} onChange={(e) => setK(e.target.value)} aria-label="Most clips to suggest" />
                      clips. Gemma reads the best
                      <input className="input num mono" type="number" inputMode="numeric" min={2} max={30} value={judgeN} onChange={(e) => setJudgeN(e.target.value)} aria-label="Moments Gemma reads" />
                      moments to choose them.
                    </p>
                    <details className="more" open={ownLengths || undefined}>
                      <summary>More options</summary>
                      <p className="brief-line">
                        Clips from
                        <input className="input num mono" type="number" inputMode="numeric" min={5} max={180} value={minLen} onChange={(e) => { setOwnLengths(true); setMinLen(e.target.value); }} aria-label="Shortest clip in seconds" />
                        to
                        <input className="input num mono" type="number" inputMode="numeric" min={10} max={180} value={maxLen} onChange={(e) => { setOwnLengths(true); setMaxLen(e.target.value); }} aria-label="Longest clip in seconds" />
                        seconds long, instead of the lengths for {preset?.label || "the platform"}.
                        {ownLengths && (
                          <button type="button" className="linkish inline" onClick={() => { setOwnLengths(false); setMinLen(preset.minLen); setMaxLen(preset.maxLen); }}>
                            Use the usual lengths
                          </button>
                        )}
                      </p>
                    </details>
                    {inBrowser ? null : models ? (
                      <ModelControl models={models} value={model} onChange={setModel} judgeN={Number(judgeN) || 8} rates={rates} />
                    ) : (
                      <div className="model-control is-loading" aria-busy="true" />
                    )}
                  </>
                )}
              </div>
            </details>

            <details className="fold">
              <summary>
                <span className="fold-h">Credit the original</span>
                <span className="fold-sum">{creditSummary}</span>
              </summary>
              <div className="fold-body">
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
                    <span className="field-label">Link to the original</span>
                    <input className="input" type="url" inputMode="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://" autoComplete="off" spellCheck={false} autoCapitalize="none" />
                  </label>
                </div>
                <p className="field-hint">
                  {license === "own"
                    ? "Your own video needs no credit line. Add one anyway if you want your name on the post."
                    : "Selects adds this to the caption of every clip, so the person who made the video gets credit and the licence is followed."}
                </p>
              </div>
            </details>
          </div>
          {inBrowser && <p className="laptop-line">{LAPTOP_LINE}</p>}
        </form>

        <QueueList queue={queue} jobs={jobs} rates={rates} models={models || []} />

        {jobs.length > 0 && (
          <section className="recent" aria-labelledby="recent-h">
            <h2 id="recent-h" className="h-18">Your videos</h2>
            <ul className="shelf">
              {jobs.map((summary) => {
                const j = full[summary.id] ? { ...summary, ...full[summary.id] } : summary;
                const clips = (j.candidates || []).filter((c) => c.status === "approved").slice(0, 3);
                const poster = thumbAt(j, (j.source?.duration || 0) * 0.3);
                return (
                  <li key={j.id}>
                    <a href={`#/job/${j.id}`} className={"shelf-item" + (j.stage === "error" ? " is-error" : "")}>
                      <span className="shelf-card" aria-hidden="true">
                        {poster && <img src={poster} alt="" loading="lazy" />}
                        {clips.length > 0 && (
                          <span className="shelf-clips">
                            {clips.map((c, i) => (
                              <img key={c.id} src={thumbAt(j, c.start + 0.4) || undefined} alt="" style={{ "--i": i }} loading="lazy" />
                            ))}
                          </span>
                        )}
                        <span className="shelf-dur mono">{tc(j.source?.duration)}</span>
                      </span>
                      <span className="shelf-name" title={j.source?.path}>
                        <MiddleTruncate text={j.source?.name} tail={10} />
                      </span>
                      <span className="shelf-status">{statusLine(j)}</span>
                      <span className="shelf-date mono">{new Date(j.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}
