// The caption review: every cue as editable text, whisper's unsure words
// underlined so they get fixed first, split and merge at word boundaries, and
// a click (or Enter) plays the cue in the preview. Works without a mouse.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { tc, plural } from "../lib/time.js";
import { fromCues, tokensOf, splitItem, mergeItems, unsureSpans, isEdited, cueAt } from "../lib/cues.js";

// Load, edit and save captions.json. Saves are serial; a reply only replaces
// the cues it was sent for, so typing during a save is never lost.
export function useCaptions(jobId, version) {
  const [items, setItemsState] = useState(null);
  const [lowP, setLowP] = useState(0.5);
  const [edited, setEdited] = useState(false);
  const [saveState, setSaveState] = useState("idle");
  const [error, setError] = useState(null);
  const itemsRef = useRef(null);
  const localVer = useRef(0);
  const saving = useRef(false);
  const again = useRef(false);
  const lastSave = useRef(0);

  const setItems = useCallback((fn) => {
    setItemsState((cur) => {
      const next = typeof fn === "function" ? fn(cur) : fn;
      itemsRef.current = next;
      return next;
    });
    localVer.current++;
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await api.getCaptions(jobId);
      const cur = itemsRef.current;
      // The same cues as on screen: keep their keys, so a focused field stays put.
      const same = cur && cur.length === res.cues.length && cur.every((it, i) => it.base === res.cues[i].text);
      const its = same ? cur.map((it, i) => ({ ...it, s: res.cues[i].s, e: res.cues[i].e, words: res.cues[i].words || it.words })) : fromCues(res.cues);
      itemsRef.current = its;
      setItemsState(its);
      setLowP(res.lowP ?? 0.5);
      setEdited(!!res.edited);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, [jobId]);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = !!items?.some((i) => i.text !== i.base);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  // Someone else changed the captions (a reset, or a new transcript): follow,
  // unless this screen holds edits that are not saved yet.
  useEffect(() => {
    if (version && !saving.current && !dirtyRef.current && Date.now() - lastSave.current > 3000) load();
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    if (!itemsRef.current) return;
    if (saving.current) {
      again.current = true;
      return;
    }
    saving.current = true;
    setSaveState("saving");
    const sent = itemsRef.current.map((i) => ({ k: i.k, text: i.text }));
    const sentVer = localVer.current;
    try {
      const res = await api.putCaptions(
        jobId,
        itemsRef.current.map((i) => ({ s: i.s, e: i.e, text: i.text }))
      );
      setLowP(res.lowP ?? 0.5);
      setEdited(!!res.edited);
      setItemsState((cur) => {
        let next;
        if (res.cues.length === sent.length) {
          const byK = new Map(sent.map((x, i) => [x.k, { cue: res.cues[i], text: x.text }]));
          next = cur.map((it) => {
            const hit = byK.get(it.k);
            if (!hit) return it;
            const same = it.text === hit.text;
            return { ...it, s: hit.cue.s, e: hit.cue.e, words: hit.cue.words || it.words, base: hit.cue.text, text: same ? hit.cue.text : it.text };
          });
        } else if (localVer.current === sentVer) {
          next = fromCues(res.cues); // empty cues were dropped; nothing changed meanwhile
        } else {
          again.current = true;
          next = cur;
        }
        itemsRef.current = next;
        return next;
      });
      setSaveState("saved");
      setError(null);
      lastSave.current = Date.now();
    } catch (e) {
      setSaveState("error");
      setError(e.message);
    } finally {
      saving.current = false;
      if (again.current) {
        again.current = false;
        save();
      }
    }
  }, [jobId]);

  const reset = useCallback(async () => {
    setSaveState("saving");
    try {
      const res = await api.resetCaptions(jobId);
      const its = fromCues(res.cues);
      itemsRef.current = its;
      setItemsState(its);
      setEdited(false);
      setSaveState("idle");
      localVer.current++;
    } catch (e) {
      setSaveState("error");
      setError(e.message);
    }
  }, [jobId]);

  return { items, setItems, itemsRef, lowP, edited, dirty, saveState, error, save, reset };
}

function Mirror({ item, lowP }) {
  // The same text as the field above it, painted with marks only: whisper's
  // unsure words get a faint blue underline, the person's edits a yellow one.
  const toks = tokensOf(item.text);
  const ws = item.words || [];
  const matched = ws.length === toks.length;
  const unsure = new Set(unsureSpans(item, lowP).map((x) => x.a));
  const parts = [];
  let at = 0;
  toks.forEach((tk, i) => {
    if (tk.a > at) parts.push(item.text.slice(at, tk.a));
    const mine = matched && (ws[i].edited || ws[i].w !== tk.t);
    parts.push(
      <span key={tk.a} className={unsure.has(tk.a) ? "mw is-unsure" : mine ? "mw is-mine" : undefined}>
        {tk.t}
      </span>
    );
    at = tk.b;
  });
  if (at < item.text.length) parts.push(item.text.slice(at));
  return (
    <div className="cue-mirror" aria-hidden="true">
      {parts}
      {"​"}
    </div>
  );
}

const CueRow = memo(function CueRow({ item, lowP, clipLabel, inClip, onText, onKey, onFocusCue, onPlay, onSplit, onMerge, hasNext, setRef, rowRef, focused, caretWord }) {
  const edited = isEdited(item);
  const unsure = unsureSpans(item, lowP).length;
  return (
    <li ref={rowRef} className={"cue" + (edited ? " is-mine" : "") + (focused ? " is-focus" : "") + (inClip ? " in-clip" : "")} data-k={item.k}>
      {clipLabel && <p className="cue-clip mono">{clipLabel}</p>}
      <button type="button" className="cue-tc mono" onClick={() => onPlay(item.k)} title="Play this cue" tabIndex={-1}>
        {tc(item.s, { tenths: true })}
      </button>
      <div className="cue-field">
        <Mirror item={item} lowP={lowP} />
        <textarea
          ref={setRef}
          className="cue-input"
          rows={1}
          value={item.text}
          spellCheck
          aria-label={`Caption at ${tc(item.s, { tenths: true })}${unsure ? `, ${plural(unsure, "unsure word")}` : ""}${edited ? ", edited by you" : ""}`}
          onChange={(e) => onText(item.k, e.target.value)}
          onKeyDown={(e) => onKey(e, item.k)}
          onFocus={(e) => onFocusCue(item.k, e)}
          onMouseUp={(e) => {
            if (e.altKey) onSplit(item.k, e.currentTarget.selectionStart);
          }}
        />
      </div>
      <div className="cue-acts">
        {edited && <span className="cue-tag">Edited</span>}
        {focused && (
          <>
            <button type="button" className="btn btn-chip" onMouseDown={(e) => e.preventDefault()} onClick={() => onSplit(item.k)}>
              {caretWord ? <>Split before <q>{caretWord}</q></> : "Split at the caret"}
            </button>
            {hasNext && (
              <button type="button" className="btn btn-chip" onMouseDown={(e) => e.preventDefault()} onClick={() => onMerge(item.k)}>
                Merge with next
              </button>
            )}
          </>
        )}
      </div>
    </li>
  );
});

// groups: [{ label, keys: Set }] (clip mode) marks which cues sit in which approved clip.
// visibleKeys: null for every cue, or a Set limiting the list.
export default function CaptionEditor({ caps, player, visible, clipLabels, clipRowKeys, autoPlay = true, onFlash, toolbarExtra }) {
  const { items, setItems, itemsRef, lowP, save } = caps;
  const refs = useRef(new Map());
  const rowRefs = useRef(new Map());
  const listRef = useRef(null);
  const [focusK, setFocusK] = useState(null);
  const [caretWord, setCaretWord] = useState(null);
  const lastPlayed = useRef(null);
  const saveTimer = useRef(0);

  const shown = useMemo(() => (items ? (visible ? items.filter((i) => visible(i)) : items) : []), [items, visible]);
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const unsureTotal = useMemo(() => shown.reduce((a, i) => a + unsureSpans(i, lowP).length, 0), [shown, lowP]);
  const editedTotal = useMemo(() => shown.filter(isEdited).length, [shown]);

  const scheduleSave = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(), 900);
  }, [save]);
  const saveNow = useCallback(() => {
    clearTimeout(saveTimer.current);
    save();
  }, [save]);
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const find = (k) => itemsRef.current?.findIndex((i) => i.k === k) ?? -1;

  const focusCue = useCallback((k, sel = "end") => {
    requestAnimationFrame(() => {
      const el = refs.current.get(k);
      if (!el) return;
      el.focus({ preventScroll: true });
      const n = el.value.length;
      if (Array.isArray(sel)) el.setSelectionRange(sel[0], sel[1]);
      else if (sel === "start") el.setSelectionRange(0, 0);
      else if (typeof sel === "number") el.setSelectionRange(sel, sel);
      else el.setSelectionRange(n, n);
      const row = rowRefs.current.get(k);
      const list = listRef.current;
      if (row && list) {
        const rr = row.getBoundingClientRect();
        const lr = list.getBoundingClientRect();
        if (rr.top < lr.top + 40 || rr.bottom > lr.bottom - 40) row.scrollIntoView({ block: "center" });
      }
    });
  }, []);

  const playCue = useCallback(
    (k) => {
      const it = itemsRef.current?.find((i) => i.k === k);
      if (!it) return;
      lastPlayed.current = k;
      player.playSpan(Math.max(0, it.s - 0.12), it.e + 0.25);
    },
    [player, itemsRef]
  );

  const onText = useCallback(
    (k, v) => {
      const text = v.replace(/[\r\n]+/g, " ");
      setItems((cur) => cur.map((i) => (i.k === k ? { ...i, text } : i)));
    },
    [setItems]
  );

  const updateCaret = useCallback((el) => {
    if (!el) return;
    const toks = tokensOf(el.value);
    const c = el.selectionStart;
    let j = toks.findIndex((t) => c <= t.a || c < t.b);
    if (j >= 0 && c > toks[j].a && c - toks[j].a >= toks[j].b - c) j += 1;
    setCaretWord(j > 0 && j < toks.length ? toks[j].t : null);
  }, []);

  useEffect(() => {
    const on = () => {
      const el = document.activeElement;
      if (el && el.classList?.contains("cue-input")) updateCaret(el);
    };
    document.addEventListener("selectionchange", on);
    return () => document.removeEventListener("selectionchange", on);
  }, [updateCaret]);

  const split = useCallback(
    (k, caret) => {
      const i = find(k);
      if (i < 0) return;
      const el = refs.current.get(k);
      const at = caret ?? el?.selectionStart ?? 0;
      const res = splitItem(itemsRef.current[i], at);
      if (!res) {
        onFlash?.("Put the caret between two words to split there.");
        return;
      }
      const [a, b] = res;
      setItems((cur) => [...cur.slice(0, i), a, b, ...cur.slice(i + 1)]);
      focusCue(b.k, "start");
      saveNow();
    },
    [setItems, focusCue, saveNow, onFlash] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const merge = useCallback(
    (k, withPrev = false) => {
      const list = shownRef.current;
      const vi = list.findIndex((x) => x.k === k);
      const ai = withPrev ? vi - 1 : vi;
      const a = list[ai];
      const b = list[ai + 1];
      if (!a || !b) return;
      const m = mergeItems(a, b);
      setItems((cur) => {
        const i = cur.findIndex((x) => x.k === a.k);
        const j = cur.findIndex((x) => x.k === b.k);
        if (i < 0 || j < 0) return cur;
        const out = cur.filter((x) => x.k !== b.k);
        out[i] = m;
        return out;
      });
      focusCue(m.k, m.joinAt);
      saveNow();
    },
    [setItems, focusCue, saveNow]
  );

  const nextUnsure = useCallback(
    (dir = 1) => {
      const list = shownRef.current;
      if (!list.length) return;
      const el = document.activeElement;
      let from = list.findIndex((x) => x.k === focusK);
      let caret = el?.classList?.contains("cue-input") ? (dir > 0 ? el.selectionEnd : el.selectionStart) : dir > 0 ? -1 : Infinity;
      if (from < 0) {
        // Start from what is playing, or the top.
        const at = cueAt(list, player.time);
        from = at < 0 ? (dir > 0 ? 0 : list.length - 1) : at;
        caret = dir > 0 ? -1 : Infinity;
      }
      const n = list.length;
      for (let step = 0; step <= n; step++) {
        const idx = (from + dir * step + n * 2) % n;
        const spans = unsureSpans(list[idx], lowP);
        const pick =
          dir > 0
            ? spans.find((s) => step > 0 || s.a >= caret)
            : [...spans].reverse().find((s) => step > 0 || s.b <= caret);
        if (pick && !(step === 0 && list[idx].k === focusK && dir > 0 && pick.a < caret)) {
          const k = list[idx].k;
          focusCue(k, [pick.a, pick.b]);
          if (lastPlayed.current !== k) playCue(k);
          return;
        }
      }
      onFlash?.("No unsure words left. Every word whisper doubted has been checked.");
    },
    [focusK, lowP, focusCue, playCue, player, onFlash]
  );

  const onKey = useCallback(
    (e, k) => {
      const el = e.currentTarget;
      const list = shownRef.current;
      const vi = list.findIndex((x) => x.k === k);
      const collapsed = el.selectionStart === el.selectionEnd;
      if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        saveNow();
        const next = list[vi + 1];
        if (next) focusCue(next.k, "end");
        else onFlash?.("That was the last caption. Saved.");
      } else if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        split(k);
      } else if (e.key === "Enter" && e.altKey) {
        e.preventDefault();
        playCue(k);
      } else if (e.key === "Backspace" && collapsed && el.selectionStart === 0 && vi > 0) {
        e.preventDefault();
        merge(k, true);
      } else if (e.key === "Delete" && collapsed && el.selectionStart === el.value.length && vi < list.length - 1) {
        e.preventDefault();
        merge(k);
      } else if (e.key === "ArrowDown" && e.altKey) {
        e.preventDefault();
        nextUnsure(1);
      } else if (e.key === "ArrowUp" && e.altKey) {
        e.preventDefault();
        nextUnsure(-1);
      } else if (e.key === "ArrowUp" && collapsed && el.selectionStart === 0 && vi > 0) {
        e.preventDefault();
        focusCue(list[vi - 1].k, "end");
      } else if (e.key === "ArrowDown" && collapsed && el.selectionStart === el.value.length && vi < list.length - 1) {
        e.preventDefault();
        focusCue(list[vi + 1].k, "start");
      } else if (e.key === "Escape") {
        const it = list[vi];
        if (it && it.base != null && it.text !== it.base) {
          e.preventDefault();
          onText(k, it.base);
        } else el.blur();
      }
    },
    [saveNow, focusCue, split, playCue, merge, nextUnsure, onText, onFlash]
  );

  const onFocusCue = useCallback(
    (k, e) => {
      setFocusK(k);
      updateCaret(e.currentTarget);
      if (autoPlay && lastPlayed.current !== k) playCue(k);
    },
    [autoPlay, playCue, updateCaret]
  );

  // Leaving a cue with changes in it saves them, shortly after.
  useEffect(() => {
    const it = items?.find((i) => i.k === focusK);
    if (it && it.text !== it.base) scheduleSave();
  }, [focusK]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onOut = (e) => {
      if (e.target?.classList?.contains("cue-input") && !listRef.current?.contains(e.relatedTarget)) {
        setFocusK(null);
        if (caps.dirty) scheduleSave();
      }
    };
    const el = listRef.current;
    el?.addEventListener("focusout", onOut);
    return () => el?.removeEventListener("focusout", onOut);
  }, [caps.dirty, scheduleSave]);

  // The cue under the playhead, marked straight on the DOM so the list does
  // not re-render fifteen times a second.
  useEffect(() => {
    let last = null;
    return player.onFrame((t) => {
      const list = shownRef.current;
      const i = cueAt(list, t);
      const k = i >= 0 ? list[i].k : null;
      if (k === last) return;
      if (last) rowRefs.current.get(last)?.classList.remove("is-now");
      if (k) rowRefs.current.get(k)?.classList.add("is-now");
      last = k;
    });
  }, [player]);

  // Outside a field: N jumps to the next unsure word.
  useEffect(() => {
    const on = (e) => {
      const t = e.target;
      if (e.metaKey || e.ctrlKey || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        nextUnsure(e.shiftKey ? -1 : 1);
      }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [nextUnsure]);

  const setRefFor = useMemo(() => {
    const cache = new Map();
    return (k) => {
      if (!cache.has(k)) cache.set(k, (el) => (el ? refs.current.set(k, el) : refs.current.delete(k)));
      return cache.get(k);
    };
  }, []);
  const rowRefFor = useMemo(() => {
    const cache = new Map();
    return (k) => {
      if (!cache.has(k)) cache.set(k, (el) => (el ? rowRefs.current.set(k, el) : rowRefs.current.delete(k)));
      return cache.get(k);
    };
  }, []);

  if (!items) {
    return (
      <div className="ce is-loading">
        {caps.error ? <p className="field-error" role="alert">The captions could not be loaded. {caps.error}</p> : <p className="mono dim">Loading the captions</p>}
      </div>
    );
  }

  return (
    <div className="ce">
      <div className="ce-bar">
        <p className="ce-counts">
          <span className="mono">{plural(shown.length, "cue")}</span>
          <span className={unsureTotal ? "ce-unsure" : "dim"}>{unsureTotal ? `${plural(unsureTotal, "unsure word")} to check` : "No unsure words left"}</span>
          {editedTotal > 0 && <span className="ce-edited">{editedTotal} edited by you</span>}
        </p>
        <div className="ce-tools">
          {toolbarExtra}
          <button type="button" className="btn btn-chip" onClick={() => nextUnsure(1)} disabled={!unsureTotal} title="Alt and Down arrow in a caption, or N">
            Next unsure word <kbd>N</kbd>
          </button>
        </div>
      </div>
      <ol className="ce-list" ref={listRef} aria-label="Captions">
        {shown.map((it, i) => (
          <CueRow
            key={it.k}
            item={it}
            lowP={lowP}
            clipLabel={clipLabels?.get(it.k)}
            inClip={clipRowKeys?.has(it.k)}
            onText={onText}
            onKey={onKey}
            onFocusCue={onFocusCue}
            onPlay={playCue}
            onSplit={split}
            onMerge={merge}
            hasNext={i < shown.length - 1}
            setRef={setRefFor(it.k)}
            rowRef={rowRefFor(it.k)}
            focused={focusK === it.k}
            caretWord={focusK === it.k ? caretWord : null}
          />
        ))}
        {shown.length === 0 && <li className="ce-empty dim">No captions in this range.</li>}
      </ol>
    </div>
  );
}
