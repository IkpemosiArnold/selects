// Which language whisper used, how sure it was of the words, and a one-click
// way to say what was actually spoken. Accented English is often guessed as
// another language, so the guess is shown as a warning, never trusted.
import { useEffect, useId, useState } from "react";
import { api } from "../lib/api.js";
import { LANGUAGES, ASR_MODELS, languageName, pct } from "../lib/languages.js";

// The core's hints name CLI flags; in the app the same advice points at the controls.
export function plainHint(h) {
  if (!h) return h;
  return h
    .replace(/\s*To judge it anyway, resume with --force\.?/g, "")
    .replace(/a bigger model \(--asr-model ([\w.-]+)\)/g, "a bigger speech model ($1)")
    .replace(/--asr-model ([\w.-]+)/g, "the $1 speech model")
    .replace(/set --language to/g, "set the language to")
    .replace(/\(--language\)/g, "")
    .replace(/--language/g, "the language")
    .replace(/\s+\./g, ".");
}

const VERDICT = { good: "Transcript good", shaky: "Transcript shaky", unreliable: "Transcript unreliable" };

function dismissedKey(id) {
  return `selects-lang-ok-${id}`;
}
function readDismissed(id) {
  try {
    return localStorage.getItem(dismissedKey(id)) === "1";
  } catch {
    return false;
  }
}

export function QualityLine({ q }) {
  if (!q) return null;
  return (
    <p className={"lq-quality is-" + q.verdict}>
      <span className="lq-verdict">{VERDICT[q.verdict] || q.verdict}</span>
      <span className="mono lq-nums">
        mean confidence {q.meanP?.toFixed(2)}, {pct(q.lowShare)} of words unsure
      </span>
    </p>
  );
}

function OverrideForm({ job, busy, onGo, withModel, compact, consequence }) {
  const id = useId();
  const used = job.language?.used || job.settings?.language || "en";
  const [lang, setLang] = useState(used === "auto" ? "en" : used);
  const [model, setModel] = useState(job.settings?.asrModel || "auto");
  const [installed, setInstalled] = useState(null);
  useEffect(() => {
    if (!withModel) return;
    let alive = true;
    api.asrModels?.().then((ms) => alive && Array.isArray(ms) && setInstalled(ms)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [withModel]);
  const known = Object.fromEntries(ASR_MODELS);
  const choices = installed
    ? [["auto", known.auto], ...installed.map((m) => [m.name, known[m.name] || `${m.name}${m.english ? ", English only" : ""}`])]
    : ASR_MODELS;
  return (
    <form
      className={"lq-form" + (compact ? " is-compact" : "")}
      onSubmit={(e) => {
        e.preventDefault();
        onGo({ language: lang, ...(withModel ? { asrModel: model } : {}) });
      }}
    >
      <label className="field">
        <span className="field-label" id={id + "l"}>Spoken language</span>
        <select className="input select" value={lang} onChange={(e) => setLang(e.target.value)} aria-labelledby={id + "l"}>
          <option value="auto">Detect automatically</option>
          {LANGUAGES.map(([c, n]) => (
            <option key={c} value={c}>{n}</option>
          ))}
        </select>
      </label>
      {withModel && (
        <label className="field">
          <span className="field-label">Speech model</span>
          <select className="input select" value={model} onChange={(e) => setModel(e.target.value)}>
            {choices.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
      )}
      <div className="lq-form-go">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Starting" : "Transcribe again"}
        </button>
      </div>
      {consequence && <p className="field-hint lq-consequence">{consequence}</p>}
    </form>
  );
}

// variant "block": the processing and error screens. "strip": a band under
// the masthead on review screens, only loud when there is something to check.
export default function LanguageQuality({ job, onRetranscribe, onForce, variant = "strip" }) {
  const lang = job.language;
  const q = job.transcriptQuality;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(null); // { language, asrModel } waiting for a yes
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(() => readDismissed(job.id));
  if (!lang && !q) return null;

  const used = lang?.used;
  const det = lang?.detected;
  const warn = lang?.warning && !dismissed ? lang.warning : null;
  const isClips = job.settings?.mode !== "caption";
  const stopped = job.stage === "error" && job.error?.stage === "transcribe" && q?.verdict === "unreliable";
  const consequence = isClips
    ? "This replaces the transcript, your caption edits and the clips found from it."
    : "This replaces the transcript and your caption edits.";

  const go = async (body) => {
    if (variant === "strip" && !confirm) {
      setConfirm(body);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onRetranscribe(body);
      setConfirm(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const keep = () => {
    setDismissed(true);
    try {
      localStorage.setItem(dismissedKey(job.id), "1");
    } catch {}
  };

  const quick = [];
  if (used && used !== "en") quick.push(["en", "It's English"]);
  if (det && det.code !== used) quick.push([det.code, `Use ${languageName(det.code)}`]);
  // The best decode, when it is neither of those.
  const best = lang?.compared?.slice().sort((a, b) => b.meanP - a.meanP)[0];
  if (best && best.code !== used && !quick.some(([c]) => c === best.code)) quick.push([best.code, `Use ${languageName(best.code)}`]);

  const loud = !!warn || (q && q.verdict !== "good") || stopped;
  const langLine = used ? (
    <span className="lq-lang">
      {languageName(used)}
      {det && det.code !== used ? (
        <span className="dim">, whisper guessed {languageName(det.code)} ({pct(det.p)} sure)</span>
      ) : lang?.setting === "auto" ? (
        <span className="dim">, detected</span>
      ) : null}
    </span>
  ) : null;

  if (variant === "strip" && !loud) {
    return (
      <div className="lq lq-strip is-quiet">
        <p className="lq-line">
          {langLine}
          {q && (
            <span className="dim">
              {langLine ? ". " : ""}
              {VERDICT[q.verdict]}, mean confidence {q.meanP?.toFixed(2)}.
            </span>
          )}
        </p>
        <button type="button" className="btn btn-quiet lq-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Close" : "Wrong language?"}
        </button>
        {open && <OverrideForm job={job} busy={busy} onGo={go} withModel compact consequence={consequence} />}
        {confirm && <Confirm body={confirm} busy={busy} onYes={() => go(confirm)} onNo={() => setConfirm(null)} consequence={consequence} />}
        {err && <p className="field-error" role="alert">{err}</p>}
      </div>
    );
  }

  return (
    <section className={"lq lq-" + variant + (loud ? " is-loud" : "")} aria-label="Language and transcript quality">
      {warn && (
        <div className="lq-warn" role="note">
          <svg className="lq-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1.5l7 12.5H1z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M8 6v4M8 11.5v1.2" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <div className="lq-warn-body">
            <p className="lq-warn-head">
              {det && det.code !== used
                ? `Whisper guessed ${languageName(det.code)} (${pct(det.p)} sure). Selects used ${languageName(used)}.`
                : `Check the language. Selects used ${languageName(used)}.`}
            </p>
            <p className="lq-warn-text">{warn}</p>
            <div className="lq-quick">
              {quick.map(([code, label]) => (
                <button key={code} type="button" className="btn" disabled={busy} onClick={() => go({ language: code })}>
                  {label}
                </button>
              ))}
              {used && (
                <button type="button" className="btn btn-quiet" onClick={keep}>
                  Keep {languageName(used)}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {!warn && langLine && <p className="lq-line">{langLine}</p>}
      <div className="lq-q">
        {q && <QualityLine q={q} />}
        {q?.hint && <p className="lq-hint">{plainHint(q.hint)}</p>}
        {!stopped && (
          <button type="button" className="btn btn-quiet lq-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Close" : "Another language or speech model"}
          </button>
        )}
      </div>
      {stopped ? <OverrideForm job={job} busy={busy} onGo={go} withModel={true} /> : open && <OverrideForm job={job} busy={busy} onGo={go} withModel compact />}
      {stopped && onForce && (
        <p className="lq-force">
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={onForce}>
            Find clips in it anyway
          </button>
          <span className="dim">The picks will be guesses.</span>
        </p>
      )}
      {confirm && <Confirm body={confirm} busy={busy} onYes={() => go(confirm)} onNo={() => setConfirm(null)} consequence={consequence} />}
      {err && <p className="field-error" role="alert">{err}</p>}
    </section>
  );
}

function Confirm({ body, busy, onYes, onNo, consequence }) {
  return (
    <div className="lq-confirm" role="alertdialog" aria-label="Transcribe again?">
      <p>
        Transcribe again {body.language === "auto" ? "and detect the language" : `in ${languageName(body.language)}`}
        {body.asrModel && body.asrModel !== "auto" ? ` with ${body.asrModel}` : ""}? {consequence}
      </p>
      <div className="lq-quick">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onYes} autoFocus>
          {busy ? "Starting" : "Transcribe again"}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onNo}>Cancel</button>
      </div>
    </div>
  );
}
