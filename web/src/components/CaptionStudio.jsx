// The caption review screen. In caption mode it is the main screen once the
// transcript is done (captions, blur, then render the whole video). In clip
// mode it is the step before rendering, scoped to the approved clips.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { tc, plural, aboutMinutes } from "../lib/time.js";
import { usePlayer, usePlayerTime, usePlaying } from "../lib/player.js";
import { cueAt, isEdited } from "../lib/cues.js";
import { copyText } from "../lib/hooks.js";
import { Masthead } from "../App.jsx";
import CaptionEditor, { useCaptions } from "./CaptionEditor.jsx";
import { languageName } from "../lib/languages.js";
import { BlurOverlay, BlurPanel, useBlurDraft, useContentBox, trackLabelsFor, blurSummary } from "./Blur.jsx";

function naturalSize(job) {
  const s = job.source || {};
  const w = s.uprightWidth || s.displayWidth || s.width || 16;
  const h = s.uprightHeight || s.height || 9;
  return { w, h };
}

function CurrentCue({ items, player, captionsOn }) {
  const t = usePlayerTime(player);
  if (!captionsOn || !items?.length) return null;
  const i = cueAt(items, t);
  if (i < 0) return null;
  return (
    <p className="sp-caption" aria-hidden="true">
      <span>{items[i].text}</span>
    </p>
  );
}

function StudioPreview({ job, player, items, blur, faces, blurEditing, armed, onArmed, selected, onSelect, captionsOn }) {
  const frameRef = useRef(null);
  const videoRef = useRef(null);
  const [natural, setNatural] = useState(() => naturalSize(job));
  const [mediaError, setMediaError] = useState(false);
  const src = api.sourceUrl(job.id);
  const t = usePlayerTime(player);
  const playing = usePlaying(player);
  const box = useContentBox(frameRef, natural, "contain");
  const dur = job.source?.duration || 0;
  const labels = useMemo(() => trackLabelsFor(faces.tracks || []), [faces.tracks]);

  useEffect(() => {
    if (src) player.attach(videoRef.current);
    return () => player.attach(null);
  }, [player, src]);

  return (
    <div className="sp">
      <div className="sp-frame" ref={frameRef} style={{ "--ar": natural.w / natural.h }} data-playing={playing || undefined}>
        {src && !mediaError ? (
          <video
            ref={videoRef}
            className="sp-media"
            src={src}
            preload="metadata"
            playsInline
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.videoWidth && v.videoHeight) setNatural({ w: v.videoWidth, h: v.videoHeight });
            }}
            onError={() => setMediaError(true)}
          />
        ) : src ? (
          <div className="pv-missing">
            <p>The source video is not where it was. Move it back to</p>
            <p className="mono">{job.source?.path}</p>
          </div>
        ) : (
          <img className="sp-media" src={api.frameUrl(job.id, t)} alt="" draggable={false} />
        )}
        <CurrentCue items={items} player={player} captionsOn={captionsOn} />
        <BlurOverlay
          spec={blur.spec}
          onChange={blur.change}
          tracks={faces.tracks || []}
          t={t}
          editing={blurEditing}
          armed={armed}
          onArmed={onArmed}
          selected={selected}
          onSelect={onSelect}
          box={box}
          trackLabels={labels}
        />
        {!blurEditing && <button type="button" className="pv-hit" aria-label={playing ? "Pause" : "Play"} onClick={() => player.toggle()} />}
      </div>
      <div className="pv-controls sp-controls">
        <button type="button" className="btn btn-icon btn-on-film" onClick={() => player.toggle()} aria-label={playing ? "Pause, Space" : "Play, Space"}>
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" fill="currentColor" /><rect x="9.5" y="2" width="3.5" height="12" fill="currentColor" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2l10 6-10 6z" fill="currentColor" /></svg>
          )}
        </button>
        <div className="pv-scrub" role="presentation">
          <div className="pv-scrub-fill" style={{ transform: `scaleX(${dur ? t / dur : 0})` }} />
          <input
            type="range"
            min={0}
            max={Math.max(0.1, dur)}
            step={0.1}
            value={t}
            aria-label="Position in video"
            aria-valuetext={`${tc(t)} of ${tc(dur)}`}
            onChange={(e) => player.seek(Number(e.target.value))}
          />
        </div>
        <span className="pv-time mono">
          {tc(t, { tenths: true })}
          <span className="dim"> / {tc(dur)}</span>
        </span>
      </div>
    </div>
  );
}

const VERDICT = { good: "transcript good", shaky: "transcript shaky, check the grey words", unreliable: "transcript unreliable" };

// Which language whisper listened in, and a way to say it was wrong.
function LanguageLine({ job }) {
  const used = job.language?.used || job.settings?.language;
  const q = job.transcriptQuality;
  if (!used && !q) return null;
  return (
    <p className="lang-line">
      <span>
        {used ? languageName(used === "auto" ? "en" : used) : "Language unknown"}
        {q?.verdict ? `, ${VERDICT[q.verdict] || q.verdict}` : ""}.
      </span>
      <a href={`#/job/${job.id}/language`}>Wrong language?</a>
    </p>
  );
}

function LiveBlurPanel({ player, ...rest }) {
  const t = usePlayerTime(player);
  return <BlurPanel t={t} {...rest} />;
}

function OutputPanel({ job, onRender, busy }) {
  const o = job.output;
  const [copied, setCopied] = useState(null);
  if (!o) {
    return (
      <div className="out-panel">
        <p className="lede">Nothing rendered yet. Render the captioned video once the captions read right.</p>
      </div>
    );
  }
  const done = o.status === "done";
  const files = [
    ["Video", o.file || o.path],
    ["SRT", o.srtFile || o.srt],
    ["WebVTT", o.vttFile || o.vtt],
  ].filter(([, p]) => p);
  const relative = done && !o.file;
  const url = api.outputUrl(job.id);
  return (
    <div className="out-panel">
      {done ? (
        <>
          {o.stale && (
            <p className="out-stale" role="note">
              The captions changed after this render. Render again to apply them.
              <button type="button" className="btn btn-chip" disabled={busy} onClick={onRender}>
                Render again
              </button>
            </p>
          )}
          {url ? <video className="out-video" src={url + (o.wallSec ? `?v=${o.wallSec}` : "")} controls playsInline /> : <div className="out-video is-mock mono">Captioned video plays here</div>}
          <dl className="out-files">
            {files.map(([k, p]) => (
              <div key={k} className="kit-field">
                <dt className="label">{k}</dt>
                <dd className="mono kit-path">{p}</dd>
                <button
                  type="button"
                  className={"btn btn-chip" + (copied === k ? " is-done" : "")}
                  onClick={async () => {
                    if (await copyText(p)) {
                      setCopied(k);
                      setTimeout(() => setCopied(null), 1600);
                    }
                  }}
                >
                  {copied === k ? "Copied" : "Copy path"}
                </button>
              </div>
            ))}
          </dl>
          {relative && <p className="field-hint">Paths are inside this job's folder.</p>}
        </>
      ) : o.status === "error" ? (
        <p className="field-error" role="alert">{o.message || job.error?.message || "The render stopped."} {job.error?.hint || "Render again to retry."}</p>
      ) : (
        <div className="out-running" aria-live="polite">
          <p className="mono">
            {o.status === "pending" ? "Waiting to start" : `Rendering ${Math.round((o.progress || 0) * 100)}%`}
            {o.etaSec ? <span className="dim">, {aboutMinutes(o.etaSec)} left</span> : null}
          </p>
          <div className="rr-bar is-wide" role="progressbar" aria-label="Captioned video render" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((o.progress || 0) * 100)}>
            <div className="rr-fill" style={{ transform: `scaleX(${o.progress || 0})` }} />
          </div>
        </div>
      )}
      <p className="out-downloads">
        <span className="dim">Captions only:</span>
        <a className="btn btn-chip" href={api.captionsFileUrl(job.id, "srt")} download={`${(job.source?.name || "captions").replace(/\.[^.]+$/, "")}.srt`}>
          Download SRT
        </a>
        <a className="btn btn-chip" href={api.captionsFileUrl(job.id, "vtt")} download={`${(job.source?.name || "captions").replace(/\.[^.]+$/, "")}.vtt`}>
          Download WebVTT
        </a>
      </p>
    </div>
  );
}

export default function CaptionStudio({ job, words, mode, faces, captionsVersion, onJob, refetch, onRender }) {
  const player = usePlayer();
  const caps = useCaptions(job.id, captionsVersion);
  const isCaption = mode === "caption";
  const dur = job.source?.duration || 0;
  const [tab, setTab] = useState(() => (isCaption && job.output ? "video" : "captions"));
  const [armed, setArmed] = useState(false);
  const [selected, setSelected] = useState(null);
  const [toast, setToast] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const approved = useMemo(() => (job.candidates || []).filter((c) => c.status === "approved").sort((a, b) => a.start - b.start), [job.candidates]);
  const [scope, setScope] = useState(() => (!isCaption && approved.length ? "clips" : "all"));

  useEffect(() => {
    player.setWindow(0, dur, { seek: false });
    if (!isCaption && approved.length) player.seek(approved[0].start);
  }, [player, dur]); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = useCallback((msg, kind = "ok") => setToast({ msg, kind, at: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  // Blur for the whole video (caption mode keeps it in job.settings.blur).
  const [blurSpec, blurChange, blurSave] = useBlurDraft(job.settings?.blur, job.id, async (spec) => {
    const j = await api.patchJob(job.id, { blur: spec });
    if (j?.id) onJob((cur) => ({ ...cur, settings: j.settings, output: j.output ?? cur.output }));
  });
  const blur = { spec: blurSpec, change: blurChange };
  const blurEditing = isCaption && tab === "blur";
  useEffect(() => {
    if (!blurEditing) setArmed(false);
  }, [blurEditing]);
  useEffect(() => {
    if (!armed) return;
    const on = (e) => e.key === "Escape" && setArmed(false);
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [armed]);

  // Clip mode: which cues sit in an approved clip, and the label for the first cue of each.
  const inClip = useCallback(
    (it) => {
      const mid = (it.s + it.e) / 2;
      return approved.find((c) => mid >= c.start - 0.05 && mid <= c.end + 0.05) || null;
    },
    [approved]
  );
  const visible = useMemo(() => (scope === "clips" ? (it) => !!inClip(it) : null), [scope, inClip]);
  const clipLabels = useMemo(() => {
    if (isCaption || !caps.items) return null;
    const m = new Map();
    let last = null;
    for (const it of caps.items) {
      const c = inClip(it);
      if (c && c !== last) m.set(it.k, `Clip ${c.rank ?? ""}, ${tc(c.start)} to ${tc(c.end)}`);
      last = c;
    }
    return m;
  }, [caps.items, inClip, isCaption]);
  const clipRowKeys = useMemo(() => {
    if (isCaption || scope !== "all" || !caps.items) return null;
    return new Set(caps.items.filter((it) => inClip(it)).map((it) => it.k));
  }, [caps.items, inClip, isCaption, scope]);

  // Space plays outside a field.
  useEffect(() => {
    const on = (e) => {
      const t = e.target;
      if (e.code !== "Space" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName))) return;
      e.preventDefault();
      player.toggle();
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [player]);

  const captionsOn = job.settings?.captions !== false;
  const renderFailed = job.stage === "error" && job.error?.stage === "render";
  const out = job.output && renderFailed && job.output.status !== "done" ? { ...job.output, status: "error", message: job.error.message } : job.output;
  const rendering = !renderFailed && ((out && (out.status === "running" || out.status === "pending")) || job.stage === "rendering");
  const editedCount = caps.items ? caps.items.filter(isEdited).length : 0;

  const renderVideo = async () => {
    setBusy(true);
    try {
      if (caps.dirty) await caps.save();
      await api.render(job.id);
      onJob((j) => ({ ...j, stage: "rendering", output: { ...(j.output || {}), status: "pending", progress: 0, stale: false } }));
      setTab("video");
    } catch (e) {
      flash(`Rendering did not start. ${e.message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const saveLabel = caps.saveState === "saving" ? "Saving" : caps.saveState === "error" ? "Not saved" : caps.dirty ? "Unsaved changes" : caps.edited ? "Saved" : "Whisper's words, unedited";

  return (
    <div className="studio-shell">
      <Masthead job={job} />
      <LanguageLine job={job} />
      <main className="studio">
        <h1 className="sr-only">{isCaption ? "Caption the video" : "Review captions"} for {job.source?.name}</h1>
        <div className="studio-preview">
          <StudioPreview
            job={job}
            player={player}
            items={caps.items}
            blur={blur}
            faces={faces}
            blurEditing={blurEditing}
            armed={armed}
            onArmed={setArmed}
            selected={selected}
            onSelect={setSelected}
            captionsOn={captionsOn || !isCaption}
          />
          {isCaption && !blurEditing && (
            <p className="pv-note">{blurSummary(blurSpec)}. {captionsOn ? "Captions as they will be burned in." : "Captions are off for this render."}</p>
          )}
        </div>
        <section className="studio-side">
          <div className="studio-head">
            {isCaption ? (
              <div className="tabs" role="tablist" aria-label="Caption mode">
                {[["captions", "Captions"], ["blur", "Blur"], ["video", "Captioned video"]].map(([k, l]) => (
                  <button key={k} type="button" role="tab" aria-selected={tab === k} className={"tab" + (tab === k ? " is-on" : "")} onClick={() => setTab(k)}>
                    {l}
                    {k === "video" && out?.stale ? <span className="tab-dot" aria-label=", out of date" /> : null}
                  </button>
                ))}
              </div>
            ) : (
              <div className="studio-title">
                <h2 className="h-18">Review captions</h2>
                <div className="seg seg-light" role="group" aria-label="Which captions">
                  <button type="button" className={"seg-btn" + (scope === "clips" ? " is-on" : "")} aria-pressed={scope === "clips"} disabled={!approved.length} onClick={() => setScope("clips")}>
                    {approved.length ? `In ${plural(approved.length, "approved clip")}` : "No approved clips"}
                  </button>
                  <button type="button" className={"seg-btn" + (scope === "all" ? " is-on" : "")} aria-pressed={scope === "all"} onClick={() => setScope("all")}>
                    Whole transcript
                  </button>
                </div>
              </div>
            )}
            {tab === "captions" && (
              <p className="ce-save">
                <span className={"mono" + (caps.saveState === "error" ? " is-error" : caps.dirty ? "" : " dim")} aria-live="polite">{saveLabel}</span>
                {(caps.dirty || caps.saveState === "error") && (
                  <button type="button" className="btn btn-chip" onClick={() => caps.save()}>
                    Save
                  </button>
                )}
                {caps.edited && !confirmReset && (
                  <button type="button" className="btn btn-quiet btn-small" onClick={() => setConfirmReset(true)}>
                    Undo all edits
                  </button>
                )}
              </p>
            )}
          </div>
          {confirmReset && (
            <div className="lq-confirm ce-confirm" role="alertdialog" aria-label="Undo all edits?">
              <p>Undo every caption edit and go back to whisper's words? This cannot be taken back.</p>
              <div className="lq-quick">
                <button
                  type="button"
                  className="btn btn-primary"
                  autoFocus
                  onClick={async () => {
                    setConfirmReset(false);
                    await caps.reset();
                    refetch?.().catch(() => {});
                    flash("Back to whisper's words.");
                  }}
                >
                  Undo all edits
                </button>
                <button type="button" className="btn btn-quiet" onClick={() => setConfirmReset(false)}>
                  Keep my edits
                </button>
              </div>
            </div>
          )}
          {caps.saveState === "error" && caps.error && <p className="field-error ce-err" role="alert">The captions were not saved. {caps.error}</p>}

          <div className="studio-body">
            {tab === "captions" && (
              <CaptionEditor
                caps={caps}
                player={player}
                visible={visible}
                clipLabels={clipLabels}
                clipRowKeys={clipRowKeys}
                onFlash={flash}
              />
            )}
            {tab === "blur" && (
              <LiveBlurPanel
                player={player}
                spec={blurSpec}
                onChange={blurChange}
                faces={faces}
                scope="video"
                selected={selected}
                onSelect={setSelected}
                armed={armed}
                onArm={setArmed}
                saveState={blurSave}
                onSeek={(s) => player.seek(s)}
                duration={dur}
              />
            )}
            {tab === "video" && <OutputPanel job={{ ...job, output: out }} onRender={renderVideo} busy={busy || rendering} />}
          </div>
        </section>
      </main>
      <footer className="actionbar">
        {tab === "captions" || !isCaption ? (
          <p className="ab-keys" aria-label="Keyboard shortcuts">
            <span><kbd>Enter</kbd> save, next</span>
            <span><kbd>Shift</kbd><kbd>Enter</kbd> split</span>
            <span><kbd>⌫</kbd> at start merges</span>
            <span><kbd>Alt</kbd><kbd>Enter</kbd> play</span>
            <span><kbd>Alt</kbd><kbd>↓</kbd> next unsure</span>
            <span><kbd>Esc</kbd> undo cue</span>
          </p>
        ) : (
          <p className="ab-count">
            <span className="dim">{editedCount ? `${plural(editedCount, "caption")} edited by you` : "Captions unedited"}</span>
          </p>
        )}
        <div className="ab-go">
          {isCaption ? (
            <>
              <label className="ab-check">
                <input
                  type="checkbox"
                  checked={captionsOn}
                  onChange={async (e) => {
                    const v = e.target.checked;
                    onJob((j) => ({ ...j, settings: { ...j.settings, captions: v } }));
                    try {
                      await api.patchJob(job.id, { captions: v });
                    } catch (err) {
                      onJob((j) => ({ ...j, settings: { ...j.settings, captions: !v } }));
                      flash(`That change was not saved. ${err.message}`, "error");
                    }
                  }}
                />
                Burn in captions
              </label>
              <button type="button" className="btn btn-primary btn-render" disabled={busy || rendering} onClick={renderVideo}>
                {rendering
                  ? `Rendering ${Math.round((out?.progress || 0) * 100)}%`
                  : out?.status === "done"
                  ? out.stale
                    ? "Render again with the new captions"
                    : "Render again"
                  : "Render captioned video"}
              </button>
            </>
          ) : (
            <>
              <a className="btn btn-quiet" href={`#/job/${job.id}/review`}>Back to clips</a>
              <button
                type="button"
                className="btn btn-primary btn-render"
                disabled={!approved.length || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    if (caps.dirty) await caps.save();
                    await onRender(approved.map((c) => c.id));
                  } catch (e) {
                    flash(`Rendering did not start. ${e.message}`, "error");
                    setBusy(false);
                  }
                }}
              >
                {approved.length ? `Render ${plural(approved.length, "clip")}` : "Approve a clip to render it"}
              </button>
            </>
          )}
        </div>
      </footer>
      {toast && (
        <div key={toast.at} className={"toast is-" + toast.kind} role={toast.kind === "error" ? "alert" : "status"}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
