import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { plural } from "../lib/time.js";
import { toSentences, nudgeEdge } from "../lib/sentences.js";
import { usePlayer } from "../lib/player.js";
import { Masthead } from "../App.jsx";
import Filmstrip from "./Filmstrip.jsx";
import Preview from "./Preview.jsx";
import Detail from "./Detail.jsx";
import LanguageQuality from "./LanguageQuality.jsx";
import { BlurPanel, useBlurDraft, blurSummary, blurIsEmpty } from "./Blur.jsx";
import { usePlayerTime } from "../lib/player.js";

function LiveBlurPanel({ player, ...rest }) {
  const t = usePlayerTime(player);
  return <BlurPanel t={t} {...rest} />;
}

function isTyping(el) {
  return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

export default function Review({ job, words, faces, onCandidate, onRender, onRetranscribe }) {
  const player = usePlayer();
  const ranked = useMemo(() => [...(job.candidates || [])].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)), [job.candidates]);
  const [selectedId, setSelectedId] = useState(() => (ranked.find((c) => c.status === "proposed") || ranked[0])?.id);
  const [inputMode, setInputMode] = useState("pointer");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [rendering, setRendering] = useState(false);
  const sentences = useMemo(() => toSentences(words), [words]);
  const sel = ranked.find((c) => c.id === selectedId) || ranked[0];
  const [blurOpen, setBlurOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [blurSel, setBlurSel] = useState(null);
  const [blurSpec, blurChange, blurSave] = useBlurDraft(sel?.blur ?? job.settings?.blur, sel?.id, async (spec, cid) => {
    const res = await api.patchCandidate(job.id, cid, { blur: spec });
    if (res?.id) onCandidate(res);
  });
  useEffect(() => {
    setBlurSel(null);
    setArmed(false);
  }, [sel?.id]);
  useEffect(() => {
    if (!blurOpen) setArmed(false);
  }, [blurOpen]);
  const [captionsOn, setCaptionsOn] = useState(job.settings?.captions !== false);
  const shellRef = useRef(null);
  const footRef = useRef(null);
  const selRef = useRef(sel);
  // The decide buttons stick just above the action bar, whatever its height.
  useEffect(() => {
    const f = footRef.current;
    if (!f) return;
    const ro = new ResizeObserver(() => shellRef.current?.style.setProperty("--ab-h", f.offsetHeight + "px"));
    ro.observe(f);
    return () => ro.disconnect();
  }, []);
  selRef.current = sel;

  // Play the selected window; switching clips keeps play or pause as it was.
  useEffect(() => {
    if (sel) player.setWindow(sel.start, sel.end, { seek: true });
  }, [sel?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (sel) player.setWindow(sel.start, sel.end, { seek: false });
  }, [sel?.start, sel?.end]); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = useCallback((msg, kind = "ok") => {
    setToast({ msg, kind, at: Date.now() });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const select = useCallback((id, mode) => {
    setSelectedId(id);
    if (mode) setInputMode(mode);
  }, []);

  const step = useCallback(
    (dir, mode) => {
      const i = ranked.findIndex((c) => c.id === selRef.current?.id);
      const n = ranked[(i + dir + ranked.length) % ranked.length];
      if (n) select(n.id, mode);
    },
    [ranked, select]
  );

  const patch = useCallback(
    async (c, body, optimistic) => {
      const before = { ...c };
      onCandidate({ ...c, ...optimistic, ...(body.start != null || body.end != null ? { trimmed: true } : {}) });
      try {
        const res = await api.patchCandidate(job.id, c.id, body);
        onCandidate(res);
        return res;
      } catch (e) {
        onCandidate(before);
        flash(`That change was not saved. ${e.message}`, "error");
        return null;
      }
    },
    [job.id, onCandidate, flash]
  );

  const decide = useCallback(
    async (status, mode = "pointer") => {
      const c = selRef.current;
      if (!c) return;
      setInputMode(mode);
      setBusy(true);
      const res = await patch(c, { status }, { status });
      setBusy(false);
      if (!res) return;
      // From the keyboard, move straight on to the next clip still waiting.
      if (mode === "key" && status !== "proposed") {
        const i = ranked.findIndex((x) => x.id === c.id);
        const rest = ranked.slice(i + 1).concat(ranked.slice(0, i));
        const next = rest.find((x) => x.status === "proposed");
        if (next) select(next.id);
      }
    },
    [patch, ranked, select]
  );

  const nudge = useCallback(
    async (edge, dir) => {
      const c = selRef.current;
      if (!c || c.status === "skipped") return;
      const cur = edge === "start" ? c.start : c.end;
      const v = nudgeEdge(sentences, cur, edge, dir);
      if (v === cur) return;
      if (edge === "start" && v > c.end - 5) return;
      if (edge === "end" && v < c.start + 5) return;
      await patch(c, { [edge]: v }, { [edge]: v });
    },
    [sentences, patch]
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && armed) {
        setArmed(false);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.target?.getAttribute?.("role") === "slider" && e.key.startsWith("Arrow")) return;
      const k = e.key.toLowerCase();
      if (k === "j") { e.preventDefault(); step(1, "key"); }
      else if (k === "k") { e.preventDefault(); step(-1, "key"); }
      else if (k === "a") { e.preventDefault(); decide(selRef.current?.status === "approved" ? "proposed" : "approved", "key"); }
      else if (k === "s") { e.preventDefault(); decide(selRef.current?.status === "skipped" ? "proposed" : "skipped", "key"); }
      else if (e.code === "Space") {
        // A keyboard user on a focused button gets the button; otherwise Space plays.
        const t = e.target;
        if (t && t !== document.body && (t.tagName === "BUTTON" || t.tagName === "A") && t.matches(":focus-visible")) return;
        e.preventDefault();
        player.toggle();
      } else if (e.code === "BracketLeft" || e.code === "BracketRight") {
        e.preventDefault();
        setInputMode("key");
        nudge(e.shiftKey ? "start" : "end", e.code === "BracketLeft" ? -1 : 1);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [step, decide, nudge, player, armed]);

  const approved = ranked.filter((c) => c.status === "approved");
  const skipped = ranked.filter((c) => c.status === "skipped").length;
  const waiting = ranked.length - approved.length - skipped;
  const rendered = ranked.filter((c) => c.render?.status === "done").length;

  return (
    <div className="review-shell" ref={shellRef}>
      <Masthead job={job}>
        <span className="judged-by mono dim">Judged by {job.settings?.model}</span>
      </Masthead>
      <LanguageQuality job={job} variant="strip" onRetranscribe={onRetranscribe} />
      <main className="review">
        <h1 className="sr-only">Review clips from {job.source?.name}</h1>
        <Filmstrip
          job={job}
          candidates={ranked}
          selectedId={sel?.id}
          onSelect={select}
          onTrim={patch}
          sentences={sentences}
          player={player}
          inputMode={inputMode}
        />
        <div className={"bay" + (ranked.length ? "" : " is-empty")}>
          <div className="bay-preview">
            <Preview
              job={job}
              words={words}
              candidate={sel}
              player={player}
              blur={{ spec: blurSpec, change: blurChange }}
              faces={faces}
              blurEditing={blurOpen}
              armed={armed}
              onArmed={setArmed}
              blurSelected={blurSel}
              onBlurSelect={setBlurSel}
            />
          </div>
          <Detail
            job={job}
            candidate={sel}
            total={ranked.length}
            words={words}
            sentences={sentences}
            player={player}
            busy={busy}
            onDecide={(s) => decide(s, "pointer")}
            onExtend={(body) => sel && patch(sel, body, body)}
            onPrev={() => step(-1, "pointer")}
            onNext={() => step(1, "pointer")}
            extra={
              sel && (
                <div className="detail-blur">
                  <div className="detail-blur-head">
                    <button type="button" className={"btn btn-chip" + (blurOpen ? " is-on" : "")} aria-expanded={blurOpen} onClick={() => setBlurOpen((o) => !o)}>
                      {blurOpen ? "Done blurring" : "Blur faces or areas"}
                    </button>
                    {!blurOpen && <p className="bp-summary">{blurIsEmpty(blurSpec) ? "Nothing blurred in this clip." : blurSummary(blurSpec) + "."}</p>}
                  </div>
                  {blurOpen && (
                    <LiveBlurPanel
                      player={player}
                      spec={blurSpec}
                      onChange={blurChange}
                      faces={faces}
                      scope="clip"
                      range={{ start: sel.start, end: sel.end }}
                      selected={blurSel}
                      onSelect={setBlurSel}
                      armed={armed}
                      onArm={setArmed}
                      saveState={blurSave}
                      onSeek={(t) => player.seek(Math.max(sel.start, Math.min(sel.end, t)))}
                      duration={job.source?.duration}
                    />
                  )}
                </div>
              )
            }
          />
        </div>
      </main>
      <footer className="actionbar" ref={footRef}>
        <p className="ab-count" aria-live="polite">
          <span className="ab-approved">{approved.length} approved</span>
          <span className="dim">{skipped} skipped</span>
          <span className="dim">{waiting} to review</span>
        </p>
        <p className="ab-keys" aria-label="Keyboard shortcuts">
          <span><kbd>J</kbd><kbd>K</kbd> move</span>
          <span><kbd>A</kbd> approve</span>
          <span><kbd>S</kbd> skip</span>
          <span><kbd>Space</kbd> play</span>
          <span><kbd>[</kbd><kbd>]</kbd> out point</span>
          <span><kbd>Shift</kbd> in point</span>
        </p>
        <div className="ab-go">
          <label className="ab-check" title="Burn captions into the rendered clips">
            <input
              type="checkbox"
              checked={captionsOn}
              onChange={async (e) => {
                const v = e.target.checked;
                setCaptionsOn(v);
                try {
                  await api.patchJob(job.id, { captions: v });
                } catch (err) {
                  setCaptionsOn(!v);
                  flash(`That change was not saved. ${err.message}`, "error");
                }
              }}
            />
            Captions
          </label>
          <a className="btn" href={`#/job/${job.id}/captions`}>
            Review captions
          </a>
          {rendered > 0 && (
            <a className="btn btn-quiet" href={`#/job/${job.id}/render`}>
              See {plural(rendered, "rendered clip")}
            </a>
          )}
          <button
            type="button"
            className="btn btn-primary btn-render"
            disabled={!approved.length || rendering}
            onClick={async () => {
              setRendering(true);
              try {
                await onRender(approved.map((c) => c.id));
              } catch (e) {
                flash(`Rendering did not start. ${e.message}`, "error");
                setRendering(false);
              }
            }}
          >
            {approved.length ? `Render ${plural(approved.length, "clip")}` : "Approve a clip to render it"}
          </button>
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
