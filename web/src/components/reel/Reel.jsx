// Review, one clip at a time. The clip plays large at 9:16 with the captions
// the render will burn in; its slate sits beside it; the next clip peeks out
// from behind. Approve (A or right arrow) claps the slate and throws the card
// onto the approved pile; Skip (S or left arrow) slides it quietly away. The
// next clip is already playing underneath, so nobody waits for the motion.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api.js";
import { plural, tc } from "../../lib/time.js";
import { nudgeEdge, toSentences } from "../../lib/sentences.js";
import { usePlayer } from "../../lib/player.js";
import { useReducedMotion } from "../../lib/hooks.js";
import { setNow, springTo, current as springNow, stop, SLOW } from "../../lib/spring.js";
import { flatWords, useCues } from "../../lib/useCues.js";
import { Masthead } from "../../App.jsx";
import Card, { reframeOf } from "./Card.jsx";
import Slate from "./Slate.jsx";
import Timeline from "./Timeline.jsx";
import Script from "./Script.jsx";
import { byRank, clipName, firstLine, thumbAt } from "./util.js";
import { BlurOverlay, BlurPanel, useBlurDraft, useContentBox, trackLabelsFor, blurSummary, blurIsEmpty } from "../Blur.jsx";
import { usePlayerTime } from "../../lib/player.js";

const OPEN = -8; // degrees: the clap stick raised, ready
const PEEK = { x: 0, y: 0, scale: 0.92, rotate: 2.5, opacity: 1 }; // x is set from the card width

function isTyping(el) {
  return el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

// The frame of the video as a still, for the card that flies away while the
// real card already plays the next clip.
function snapshot(frame, video, fit) {
  const r = frame.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const c = document.createElement("canvas");
  c.width = Math.round(r.width * dpr);
  c.height = Math.round(r.height * dpr);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, c.width, c.height);
  try {
    const src = video && video.readyState >= 2 ? video : frame.querySelector(".card-backdrop");
    const sw = src?.videoWidth || src?.naturalWidth;
    const sh = src?.videoHeight || src?.naturalHeight;
    if (src && sw && sh) {
      const cover = Math.max(c.width / sw, c.height / sh);
      if (fit) {
        ctx.filter = "blur(18px) brightness(0.7)";
        ctx.drawImage(src, (c.width - sw * cover) / 2, (c.height - sh * cover) / 2, sw * cover, sh * cover);
        ctx.filter = "none";
        const contain = Math.min(c.width / sw, c.height / sh);
        ctx.drawImage(src, (c.width - sw * contain) / 2, (c.height - sh * contain) / 2, sw * contain, sh * contain);
      } else {
        ctx.drawImage(src, (c.width - sw * cover) / 2, (c.height - sh * cover) / 2, sw * cover, sh * cover);
      }
    }
  } catch {}
  return { url: c.toDataURL("image/jpeg", 0.82), rect: r };
}

function LiveBlurPanel({ player, ...rest }) {
  const t = usePlayerTime(player);
  return <BlurPanel t={t} {...rest} />;
}

function LiveBlurOverlay({ player, ...rest }) {
  const t = usePlayerTime(player);
  return <BlurOverlay t={t} {...rest} />;
}

export default function Reel({ job, words, faces, captionsVersion, onCandidate, onRender }) {
  const player = usePlayer();
  const reduce = useReducedMotion();
  const caps = useCues(job.id, words, captionsVersion);
  const capWords = useMemo(() => flatWords(caps.cues), [caps.cues]);
  const sentences = useMemo(() => toSentences(words), [words]);
  const ranked = useMemo(() => byRank(job.candidates), [job.candidates]);
  const [currentId, setCurrentId] = useState(() => ranked.find((c) => c.status === "proposed")?.id ?? null);
  const cur = ranked.find((c) => c.id === currentId) || null;
  const [mode, setMode] = useState("review"); // review | trim | blur
  const [ghosts, setGhosts] = useState([]);
  const [flying, setFlying] = useState([]); // approved ids whose card is still in the air
  const [toast, setToast] = useState(null);
  const [rendering, setRendering] = useState(false);
  const history = useRef([]);
  const cardRef = useRef(null);
  const frameRef = useRef(null);
  const peekRef = useRef(null);
  const stickRef = useRef(null);
  const pileRef = useRef(null);
  const leanRef = useRef({});
  const clapping = useRef(false);
  const [natural, setNatural] = useState(() => {
    const s = job.source || {};
    return { w: s.uprightWidth || s.displayWidth || s.width || 16, h: s.uprightHeight || s.height || 9 };
  });

  const approved = ranked.filter((c) => c.status === "approved");
  const skipped = ranked.filter((c) => c.status === "skipped");
  const waiting = ranked.filter((c) => c.status === "proposed");
  const captionsOn = job.settings?.captions !== false;

  // The clip after this one: the next one still waiting, in rank order.
  const nextOf = useCallback(
    (c, list = ranked) => {
      const i = list.findIndex((x) => x.id === c?.id);
      const rest = list.slice(i + 1).concat(list.slice(0, Math.max(0, i)));
      return rest.find((x) => x.status === "proposed" && x.id !== c?.id) || null;
    },
    [ranked]
  );
  const peek = cur ? nextOf(cur) : null;

  const flash = useCallback((msg, kind = "ok") => setToast({ msg, kind, at: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3400);
    return () => clearTimeout(t);
  }, [toast]);

  // Play the current clip from its start; trims keep the play position.
  useEffect(() => {
    if (!cur) {
      player.pause();
      return;
    }
    player.setWindow(cur.start, cur.end, { seek: true });
    if (!reduce && mode === "review") player.play();
  }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (cur) player.setWindow(cur.start, cur.end, { seek: false });
  }, [cur?.start, cur?.end]); // eslint-disable-line react-hooks/exhaustive-deps

  // The clap stick rests open on a clip waiting for a decision, shut on a decided one.
  useLayoutEffect(() => {
    if (clapping.current || !stickRef.current) return;
    setNow(stickRef.current, { rotate: cur?.status === "proposed" ? OPEN : 0 });
  }, [cur?.id, cur?.status]);

  // ---- motion --------------------------------------------------------------

  const peekPose = () => {
    const w = cardRef.current?.offsetWidth || 400;
    return { ...PEEK, x: w * 0.15 };
  };
  const deckRef = useRef(null);
  const forward = useRef(false); // set by a decision: the next card comes forward from the peek

  const clap = () => {
    const el = stickRef.current;
    if (!el) return;
    clapping.current = true;
    const from = springNow(el).rotate;
    if (from > OPEN / 2) setNow(el, { rotate: OPEN });
    // shut hard against the slate, bounce once, then open again for the next take
    springTo(el, { rotate: 0 }, { response: 0.16, damping: 0.9, velocity: { rotate: 260 }, bounceStop: { at: 0, restitution: 0.32 } });
    setTimeout(() => {
      springTo(el, { rotate: OPEN }, { response: 0.24, damping: 1 }).then(() => {
        clapping.current = false;
      });
    }, 150 * SLOW);
    const board = el.closest(".slate")?.querySelector(".slate-board");
    if (board) {
      setNow(board, { y: 2.5 });
      springTo(board, { y: 0 }, { response: 0.2, damping: 0.7 });
    }
  };

  // Throw a still of the card: onto the approved pile, or quietly off to the left.
  const throwCard = (c, status, from = { x: 0, rotate: 0 }, vx = 0) => {
    const frame = frameRef.current;
    if (!frame) return;
    const video = frame.querySelector("video");
    const shot = snapshot(frame, video, reframeOf(job, c) === "fit");
    // where the card sits before any drag: the deck it fills
    const d = deckRef.current.getBoundingClientRect();
    const rect = { left: d.left, top: d.top, width: d.width, height: d.height };
    const key = c.id + ":" + performance.now();
    if (status === "approved") setFlying((f) => [...f, c.id]);
    setGhosts((g) => [...g, { key, id: c.id, status, url: shot.url, rect, from, vx }]);
  };

  const launch = useCallback(
    (el, g) => {
      if (!el || el.dataset.launched) return;
      el.dataset.launched = "1";
      setNow(el, { x: g.from.x, rotate: g.from.rotate || 0 });
      const done = () => {
        setGhosts((gs) => gs.filter((x) => x.key !== g.key));
        if (g.status === "approved") {
          setFlying((f) => f.filter((id) => id !== g.id));
          const pile = pileRef.current;
          if (pile) {
            setNow(pile, { scale: 1.08 });
            springTo(pile, { scale: 1 }, { response: 0.22, damping: 0.6 });
          }
        }
      };
      if (g.status === "approved") {
        const pile = pileRef.current?.getBoundingClientRect();
        const target = pile
          ? { x: pile.left + pile.width / 2 - (g.rect.left + g.rect.width / 2), y: pile.top + pile.height / 2 - (g.rect.top + g.rect.height / 2), scale: Math.max(0.05, (pile.height * 0.9) / g.rect.height) }
          : { x: window.innerWidth, y: -g.rect.height, scale: 0.2 };
        springTo(el, { ...target, rotate: 8 }, { response: 0.3, damping: 0.92, velocity: { x: g.vx } });
        // the pile takes it as it lands
        setTimeout(done, 290 * SLOW);
      } else {
        springTo(el, { x: -g.rect.width * 0.7, rotate: -4, opacity: 0 }, { response: 0.26, damping: 1, velocity: { x: g.vx } });
        setTimeout(done, 260 * SLOW);
      }
    },
    []
  );

  // The new front card comes forward from where it was peeking.
  const bringForward = () => {
    const el = cardRef.current;
    if (!el) return;
    const clear = (node) => () => (node.style.transform = node.style.opacity = "");
    if (reduce) {
      setNow(el, { x: 0, rotate: 0, scale: 1, opacity: 0 });
      springTo(el, { opacity: 1 }, { response: 0.22, damping: 1, onRest: clear(el) });
      return;
    }
    setNow(el, peekPose());
    springTo(el, { x: 0, y: 0, rotate: 0, scale: 1, opacity: 1 }, { response: 0.32, damping: 0.86, onRest: clear(el) });
    const p = peekRef.current;
    if (p) {
      const pose = peekPose();
      setNow(p, { ...pose, x: pose.x + 36, opacity: 0 });
      springTo(p, pose, { response: 0.34, damping: 1, onRest: clear(p) });
    }
  };

  // A new current clip: forward from the peek after a decision, otherwise just there
  // (with a short crossfade when motion is reduced).
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    if (forward.current) {
      forward.current = false;
      bringForward();
    } else if (reduce) {
      setNow(el, { opacity: 0 });
      springTo(el, { opacity: 1 }, { response: 0.22, onRest: () => (el.style.opacity = "") });
    } else {
      stop(el);
      setNow(el, { x: 0, y: 0, rotate: 0, scale: 1, opacity: 1 });
      el.style.transform = "";
    }
  }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- decisions -----------------------------------------------------------

  const patch = useCallback(
    async (c, body, optimistic) => {
      const before = { ...c };
      onCandidate({ ...c, ...optimistic });
      try {
        const res = await api.patchCandidate(job.id, c.id, body);
        if (res?.id) onCandidate(res);
        return res || true;
      } catch (e) {
        onCandidate(before);
        flash(`That change was not saved. ${e.message}`, "error");
        return null;
      }
    },
    [job.id, onCandidate, flash]
  );

  const decide = useCallback(
    (status, gesture) => {
      const c = cur;
      if (!c || mode === "trim") return;
      history.current.push({ id: c.id, status: c.status, start: c.start, end: c.end });
      if (history.current.length > 50) history.current.shift();
      const next = nextOf(c);
      if (!reduce) {
        throwCard(c, status, gesture?.from, gesture?.vx);
        if (status === "approved") clap();
      }
      if (c.status !== status) patch(c, { status }, { status });
      forward.current = !!next;
      setCurrentId(next?.id ?? null);
      if (mode === "blur") setMode("review");
    },
    [cur, mode, nextOf, reduce, patch] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const undo = useCallback(async () => {
    const h = history.current.pop();
    if (!h) return;
    const c = ranked.find((x) => x.id === h.id);
    if (!c) return;
    const body = {};
    if (c.status !== h.status) body.status = h.status;
    if (c.start !== h.start) body.start = h.start;
    if (c.end !== h.end) body.end = h.end;
    if (Object.keys(body).length) await patch(c, body, body);
    setCurrentId(c.id);
    flash(`Back to ${clipName(c).toLowerCase()}.`);
  }, [ranked, patch, flash]);

  const trim = useCallback(
    async (start, end) => {
      const c = cur;
      if (!c) return null;
      if (end - start < 3) {
        flash("A clip needs at least a few seconds.", "error");
        return null;
      }
      history.current.push({ id: c.id, status: c.status, start: c.start, end: c.end });
      return patch(c, { start, end }, { start, end, trimmed: true });
    },
    [cur, patch, flash]
  );

  const nudge = useCallback(
    (edge, dir) => {
      const c = cur;
      if (!c) return;
      const at = edge === "start" ? c.start : c.end;
      const v = nudgeEdge(sentences, at, edge, dir);
      if (v === at) return;
      const s = edge === "start" ? v : c.start;
      const e = edge === "end" ? v : c.end;
      if (e - s < 5) return;
      trim(s, e);
    },
    [cur, sentences, trim]
  );

  const pick = useCallback(
    (id) => {
      if (id === currentId) return;
      setCurrentId(id);
      if (mode === "blur") setMode("review");
    },
    [currentId, mode]
  );

  // ---- keys ------------------------------------------------------------------

  useEffect(() => {
    const on = (e) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === "z" && !isTyping(e.target)) {
          e.preventDefault();
          undo();
        }
        return;
      }
      if (e.altKey || isTyping(e.target)) return;
      const k = e.key;
      const onButton = e.target?.tagName === "BUTTON" || e.target?.tagName === "A";
      if (mode === "trim") {
        if (k === "Escape" || k.toLowerCase() === "t") {
          e.preventDefault();
          setMode("review");
        } else if (k === " " && !onButton) {
          e.preventDefault();
          player.toggle();
        }
        return;
      }
      if (mode === "blur" && k === "Escape") return; // the blur tool uses Escape itself
      const map = {
        ArrowRight: () => decide("approved"),
        a: () => decide("approved"),
        ArrowLeft: () => decide("skipped"),
        s: () => decide("skipped"),
        ",": () => nudge("start", -1),
        ".": () => nudge("start", 1),
        "[": () => nudge("end", -1),
        "]": () => nudge("end", 1),
        t: () => cur && setMode("trim"),
        b: () => cur && setMode((m) => (m === "blur" ? "review" : "blur")),
        z: undo,
      };
      if (k === " ") {
        if (onButton && e.target.matches(":focus-visible")) return;
        e.preventDefault();
        player.toggle();
        return;
      }
      if ((k === "ArrowRight" || k === "ArrowLeft") && e.target?.getAttribute?.("role") === "slider") return;
      const fn = map[k] || map[k.toLowerCase()];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [decide, nudge, undo, player, mode, cur]);

  // ---- swipe -----------------------------------------------------------------

  const drag = useRef(null);
  const onPointerDown = (e) => {
    if (mode !== "review" || e.button !== 0 || e.target.closest("button, a, .blur-layer.is-editing")) return;
    drag.current = { x0: e.clientX, y0: e.clientY, id: e.pointerId, hist: [[e.clientX, performance.now()]], locked: false };
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x0;
    if (!d.locked) {
      if (Math.abs(dx) < 10) return;
      if (Math.abs(e.clientY - d.y0) > Math.abs(dx)) {
        drag.current = null;
        return;
      }
      d.locked = true;
      d.grab = dx;
      stop(cardRef.current);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    d.hist.push([e.clientX, performance.now()]);
    if (d.hist.length > 6) d.hist.shift();
    const x = dx - Math.sign(d.grab) * 10;
    setNow(cardRef.current, { x, rotate: x / 26 });
    const lean = Math.max(-1, Math.min(1, x / 120));
    if (leanRef.current.a) leanRef.current.a.style.opacity = Math.max(0, lean);
    if (leanRef.current.s) leanRef.current.s.style.opacity = Math.max(0, -lean);
  };
  const onPointerUp = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.locked) return;
    if (leanRef.current.a) leanRef.current.a.style.opacity = 0;
    if (leanRef.current.s) leanRef.current.s.style.opacity = 0;
    const [x0, t0] = d.hist[0];
    const vx = ((e.clientX - x0) / Math.max(1, performance.now() - t0)) * 1000; // px per s
    const pose = springNow(cardRef.current);
    const w = cardRef.current?.offsetWidth || 360;
    const commit = Math.abs(pose.x) > w * 0.32 || (Math.abs(vx) > 500 && Math.sign(vx) === Math.sign(pose.x));
    if (commit) decide(pose.x > 0 ? "approved" : "skipped", { from: { x: pose.x, rotate: pose.rotate }, vx });
    else {
      const el = cardRef.current;
      springTo(el, { x: 0, rotate: 0 }, { response: 0.3, damping: 0.78, velocity: { x: vx }, onRest: () => (el.style.transform = "") });
    }
  };

  // ---- blur ------------------------------------------------------------------

  const [blurSel, setBlurSel] = useState(null);
  const [armed, setArmed] = useState(false);
  const [blurSpec, blurChange, blurSave] = useBlurDraft(cur?.blur ?? job.settings?.blur, cur?.id, async (spec, cid) => {
    const res = await api.patchCandidate(job.id, cid, { blur: spec });
    if (res?.id) onCandidate(res);
  });
  useEffect(() => {
    setBlurSel(null);
    setArmed(false);
  }, [cur?.id, mode]);
  const fit = cur ? reframeOf(job, cur) === "fit" : false;
  const box = useContentBox(frameRef, natural, fit ? "contain" : "cover");
  const labels = useMemo(() => trackLabelsFor(faces?.tracks || []), [faces?.tracks]);
  useEffect(() => {
    if (mode === "blur" || mode === "trim") player.pause();
  }, [mode, player]);

  // ---- render ----------------------------------------------------------------

  const renderNow = async () => {
    setRendering(true);
    try {
      await onRender(approved.map((c) => c.id));
    } catch (e) {
      flash(`Rendering did not start. ${e.message}`, "error");
      setRendering(false);
    }
  };

  const pile = approved.filter((c) => !flying.includes(c.id)).slice(-3);
  const rendered = ranked.filter((c) => c.render?.status === "done").length;
  const line = cur ? firstLine(cur, capWords, caps.edited) : "";

  return (
    <div className={"reel is-" + mode + (cur ? "" : " is-done")}>
      <Masthead job={job}>
        <div className="pile" ref={pileRef} aria-live="polite">
          <span className="pile-stack" aria-hidden="true">
            {pile.map((c, i) => (
              <img key={c.id} src={thumbAt(job, c.start + 0.4) || undefined} alt="" style={{ "--i": pile.length - 1 - i }} />
            ))}
            {!pile.length && <span className="pile-empty" />}
          </span>
          <span className="pile-count">
            <b>{approved.length - flying.length}</b> approved
            {skipped.length > 0 && <span className="pile-skipped">, {skipped.length} skipped</span>}
          </span>
        </div>
        <button type="button" className="btn btn-primary btn-render" disabled={!approved.length || rendering} onClick={renderNow}>
          {approved.length ? `Render ${plural(approved.length, "clip")}` : "Render"}
        </button>
      </Masthead>

      <main className="reel-stage">
        <h1 className="sr-only">Review clips from {job.source?.name}</h1>
        {cur ? (
          <>
            <div className="reel-left">
              {mode === "trim" ? (
                <Script
                  job={job}
                  clip={cur}
                  cues={caps.cues}
                  lowP={caps.lowP}
                  player={player}
                  onTrim={trim}
                  onEditWord={async (ci, wi, text) => {
                    try {
                      await caps.editWord(ci, wi, text);
                      flash("Caption fixed. Every render uses it.");
                    } catch (e) {
                      flash(`That fix was not saved. ${e.message}`, "error");
                    }
                  }}
                  onClose={() => setMode("review")}
                />
              ) : (
                <Slate ref={stickRef} clip={cur} line={line} total={ranked.length} onLineClick={() => setMode("trim")} />
              )}
            </div>

            <div className="deck" ref={deckRef}>
              {peek && mode === "review" && (
                <div className="peek" ref={peekRef} aria-hidden="true">
                  <img src={thumbAt(job, peek.start + 0.4) || undefined} alt="" draggable={false} />
                  <span className="peek-n">{peek.rank ?? "+"}</span>
                </div>
              )}
              <div
                className="card"
                ref={cardRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                <Card
                  job={job}
                  clip={cur}
                  player={player}
                  cues={caps.cues}
                  captionsOn={captionsOn}
                  frameRef={frameRef}
                  onNatural={setNatural}
                  label={`${clipName(cur)}, ${tc(cur.start)} to ${tc(cur.end)}`}
                >
                  {(mode === "blur" || !blurIsEmpty(blurSpec)) && (
                    <LiveBlurOverlay
                      player={player}
                      spec={blurSpec}
                      onChange={blurChange}
                      tracks={(faces?.tracks || []).filter((tr) => tr.end >= cur.start && tr.start <= cur.end)}
                      editing={mode === "blur"}
                      armed={armed}
                      onArmed={setArmed}
                      selected={blurSel}
                      onSelect={setBlurSel}
                      box={box}
                      trackLabels={labels}
                    />
                  )}
                  <span className="lean is-approve" ref={(el) => (leanRef.current.a = el)} aria-hidden="true">Approve</span>
                  <span className="lean is-skip" ref={(el) => (leanRef.current.s = el)} aria-hidden="true">Skip</span>
                </Card>
              </div>
              {ghosts.map((g) => (
                <div
                  key={g.key}
                  className={"ghost is-" + g.status}
                  style={{ left: g.rect.left, top: g.rect.top, width: g.rect.width, height: g.rect.height }}
                  ref={(el) => launch(el, g)}
                  aria-hidden="true"
                >
                  <img src={g.url} alt="" />
                  {g.status === "approved" && <span className="ghost-stamp">Approved</span>}
                </div>
              ))}
            </div>

            <div className="reel-right">
              {mode === "blur" ? (
                <div className="reel-blur">
                  <div className="reel-blur-head">
                    <h2 className="h-18">Blur in this clip</h2>
                    <button type="button" className="btn btn-chip" onClick={() => setMode("review")}>
                      Done <kbd>B</kbd>
                    </button>
                  </div>
                  <LiveBlurPanel
                    player={player}
                    spec={blurSpec}
                    onChange={blurChange}
                    faces={faces}
                    scope="clip"
                    range={{ start: cur.start, end: cur.end }}
                    selected={blurSel}
                    onSelect={setBlurSel}
                    armed={armed}
                    onArm={setArmed}
                    saveState={blurSave}
                    onSeek={(t) => player.seek(Math.max(cur.start, Math.min(cur.end, t)))}
                    duration={job.source?.duration}
                  />
                </div>
              ) : (
                <Controls
                  cur={cur}
                  mode={mode}
                  waiting={waiting.length}
                  total={ranked.length}
                  onDecide={(s) => decide(s)}
                  onNudge={nudge}
                  onTrim={() => setMode(mode === "trim" ? "review" : "trim")}
                  onBlur={() => setMode("blur")}
                  blurText={blurIsEmpty(blurSpec) ? null : blurSummary(blurSpec)}
                  captionsOn={captionsOn}
                  jobId={job.id}
                  onUndo={undo}
                />
              )}
            </div>
          </>
        ) : (
          <Done job={job} ranked={ranked} approved={approved} rendered={rendered} onPick={pick} onRender={renderNow} rendering={rendering} />
        )}
      </main>

      <Timeline job={job} cands={ranked} currentId={cur?.id} onPick={pick} player={cur ? player : null} />

      {toast && (
        <div key={toast.at} className={"toast is-" + toast.kind} role={toast.kind === "error" ? "alert" : "status"}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function Controls({ cur, mode, waiting, total, onDecide, onNudge, onTrim, onBlur, blurText, captionsOn, jobId, onUndo }) {
  const decided = cur.status !== "proposed";
  return (
    <section className="controls" aria-label="Decide">
      <p className="controls-left">
        {decided ? (cur.status === "approved" ? "Approved. Approve again to keep it, or skip it now." : "Skipped. Approve it to bring it back.") : `${plural(waiting, "clip")} of ${total} to decide`}
      </p>
      <button type="button" className={"decide is-approve" + (cur.status === "approved" ? " is-on" : "")} onClick={() => onDecide("approved")} disabled={mode === "trim"}>
        <span className="keycap" aria-hidden="true">A</span>
        <span className="decide-text">
          <b>Approve</b>
          <small>Render it later</small>
        </span>
        <span className="decide-alt" aria-hidden="true">→</span>
      </button>
      <button type="button" className={"decide is-skip" + (cur.status === "skipped" ? " is-on" : "")} onClick={() => onDecide("skipped")} disabled={mode === "trim"}>
        <span className="keycap" aria-hidden="true">S</span>
        <span className="decide-text">
          <b>Skip</b>
          <small>Leave it out</small>
        </span>
        <span className="decide-alt" aria-hidden="true">←</span>
      </button>

      <div className="nudge" role="group" aria-label="Trim by a sentence">
        <p className="nudge-h">Trim by a sentence</p>
        <div className="nudge-row">
          <span>Start</span>
          <button type="button" onClick={() => onNudge("start", -1)} aria-label="Start a sentence earlier">
            <kbd>,</kbd> earlier
          </button>
          <button type="button" onClick={() => onNudge("start", 1)} aria-label="Start a sentence later">
            <kbd>.</kbd> later
          </button>
        </div>
        <div className="nudge-row">
          <span>End</span>
          <button type="button" onClick={() => onNudge("end", -1)} aria-label="End a sentence earlier">
            <kbd>[</kbd> earlier
          </button>
          <button type="button" onClick={() => onNudge("end", 1)} aria-label="End a sentence later">
            <kbd>]</kbd> later
          </button>
        </div>
      </div>

      <div className="tools">
        <button type="button" className="tool" onClick={onTrim} aria-pressed={mode === "trim"}>
          <kbd>T</kbd> {mode === "trim" ? "Close the script" : "Fine trim in the script"}
        </button>
        <button type="button" className="tool" onClick={onBlur}>
          <kbd>B</kbd> {blurText || "Blur a face or an area"}
        </button>
        <a className="tool" href={`#/job/${jobId}/captions`}>
          {captionsOn ? "Fix the captions" : "Captions are off. Turn them on"}
        </a>
      </div>
      <p className="hint">
        <kbd>Space</kbd> play or pause <button type="button" className="hint-undo" onClick={onUndo}><kbd>Z</kbd> undo</button>
      </p>
    </section>
  );
}

function Done({ job, ranked, approved, rendered, onPick, onRender, rendering }) {
  return (
    <section className="done" aria-labelledby="done-h">
      <h2 id="done-h" className="done-big">
        {approved.length ? `${plural(approved.length, "clip")} to render.` : ranked.length ? "Nothing approved." : "No clips were found."}
      </h2>
      <p className="done-sub">
        {ranked.length
          ? "Every clip has a decision. Pick one to look at it again."
          : "The model found no moment that starts and ends on a full sentence. Try shorter clip lengths in a new job."}
      </p>
      {ranked.length > 0 && (
        <ol className="done-list">
          {ranked.map((c) => (
            <li key={c.id}>
              <button type="button" className={"done-item is-" + c.status} onClick={() => onPick(c.id)}>
                <span className="done-thumb" aria-hidden="true">
                  <img src={thumbAt(job, c.start + 0.4) || undefined} alt="" />
                </span>
                <span className="done-n mono">{c.rank ?? "+"}</span>
                <span className="done-hook">{c.hook}</span>
                <span className="done-time mono">{tc(c.start)}</span>
                <span className="done-s">{c.status === "approved" ? "Approved" : c.status === "skipped" ? "Skipped" : "To decide"}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="done-go">
        <button type="button" className="btn btn-primary btn-render btn-big" disabled={!approved.length || rendering} onClick={onRender}>
          {approved.length ? `Render ${plural(approved.length, "clip")}` : "Approve a clip to render it"}
        </button>
        <a className="btn btn-quiet" href={`#/job/${job.id}/captions`}>Check the captions first</a>
        {rendered > 0 && (
          <a className="btn btn-quiet" href={`#/job/${job.id}/render`}>
            See {plural(rendered, "rendered clip")}
          </a>
        )}
      </div>
    </section>
  );
}
