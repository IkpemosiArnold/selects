// Shared data layer for the design directions. Each direction reads the same
// job, words and candidates, and keeps its decisions in this tab only: the
// prototypes never write to the real job folder.
//
// URL params:
//   job=<id>              which job (default: the real strength-talk job, or the mock demo with mock=1)
//   screen=review|language  force a screen (default: language when the transcript gate stopped the job)
//   approved=c_1,c_2       start with these approved (for screenshots)
//   skipped=c_3            start with these skipped
//   keep=1                 keep the statuses saved in job.json instead of starting fresh
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isMock } from "../../lib/api.js";
import { toSentences, wordsIn } from "../../lib/sentences.js";

export const params = new URLSearchParams(location.search);
export { api, isMock };

const list = (k) => (params.get(k) || "").split(",").filter(Boolean);

function initialCandidates(job) {
  const keep = params.get("keep") === "1";
  const approved = list("approved");
  const skipped = list("skipped");
  return [...(job.candidates || [])]
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
    .map((c) =>
      keep
        ? { ...c, mine: !!c.trimmed }
        : {
            ...c,
            status: approved.includes(c.id) ? "approved" : skipped.includes(c.id) ? "skipped" : "proposed",
            trimmed: false,
            mine: false,
          }
    );
}

export function screenFor(job) {
  const forced = params.get("screen");
  if (forced) return forced;
  const q = job?.transcriptQuality;
  if (job?.stage === "error" && (q?.verdict === "unreliable" || ["language", "transcribe"].includes(job.error?.stage))) return "language";
  return "review";
}

// Sentence index containing time t (the last sentence starting at or before t).
function sentenceAt(sentences, t) {
  let lo = 0, hi = sentences.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sentences[mid].s <= t + 0.01) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

export function useDirectionJob() {
  const jobId = params.get("job") || (isMock ? "j_20261015_demo" : "j_20261016_07m4");
  const [job, setJob] = useState(null);
  const [words, setWords] = useState([]);
  const [error, setError] = useState(null);
  const [cands, setCands] = useState([]);
  const history = useRef([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const j = await api.getJob(jobId);
        const w = await api.getWords(jobId).catch(() => []);
        if (!alive) return;
        setJob(j);
        setWords(Array.isArray(w) ? w : []);
        setCands(initialCandidates(j));
      } catch (e) {
        if (alive) setError(e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [jobId]);

  const sentences = useMemo(() => toSentences(words), [words]);

  const textOf = useCallback(
    (s, e) =>
      wordsIn(words, s, e)
        .map((i) => words[i].w)
        .join(" "),
    [words]
  );

  // Expand any range to whole sentences, as the core's snapTrim does.
  const snap = useCallback(
    (s, e) => {
      if (!sentences.length) return { start: s, end: e };
      const a = sentences[sentenceAt(sentences, s)];
      const b = sentences[sentenceAt(sentences, Math.max(s, e - 0.05))];
      return { start: a.s, end: b.e };
    },
    [sentences]
  );

  const commit = (fn) =>
    setCands((cs) => {
      history.current.push(cs);
      if (history.current.length > 50) history.current.shift();
      return fn(cs);
    });

  const decide = useCallback((id, status) => commit((cs) => cs.map((c) => (c.id === id ? { ...c, status: c.status === status ? "proposed" : status } : c))), []);

  const retime = useCallback(
    (id, s, e) => {
      const r = snap(s, e);
      commit((cs) =>
        cs.map((c) => {
          if (c.id !== id) return c;
          const text = textOf(r.start, r.end);
          const hook = sentences.find((x) => Math.abs(x.s - r.start) < 0.01);
          return { ...c, ...r, text, hook: hook ? textOf(hook.s, hook.e) : c.hook, trimmed: true, mine: true };
        })
      );
      return r;
    },
    [snap, textOf, sentences]
  );

  const addClip = useCallback(
    (s, e) => {
      const r = snap(s, e);
      const id = "u_" + Math.random().toString(36).slice(2, 6);
      const hook = sentences.find((x) => Math.abs(x.s - r.start) < 0.01);
      const clip = {
        id,
        rank: null,
        ...r,
        text: textOf(r.start, r.end),
        hook: hook ? textOf(hook.s, hook.e) : "",
        scores: null,
        reason: null,
        status: "approved",
        trimmed: true,
        mine: true,
        render: null,
      };
      commit((cs) => [...cs, clip]);
      return clip;
    },
    [snap, textOf, sentences]
  );

  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (prev) setCands(prev);
    return !!prev;
  }, []);

  return { jobId, job, words, sentences, cands, error, decide, retime, addClip, undo, snap, textOf };
}

// A clip is the person's once they approved, trimmed or made it.
export const isMine = (c) => c.status === "approved" || c.trimmed || c.mine;

export function thumbFor(job, t) {
  const th = job?.thumbs;
  if (!th?.count) return null;
  const n = Math.min(th.count, Math.max(1, Math.floor(t / th.interval) + 1));
  return api.thumbUrl(job.id, n);
}

// A rendered 9:16 clip when one exists and still matches the window; otherwise
// the source, played between start and end.
export function mediaFor(job, c) {
  if (!job) return { src: null };
  if (c && c.render?.status === "done" && !c.trimmed) {
    const src = api.clipUrl(job.id, c.id);
    if (src) return { src, start: 0, end: c.end - c.start, offset: c.start, rendered: true };
  }
  return { src: api.sourceUrl(job.id), start: c?.start ?? 0, end: c?.end ?? job.source?.duration ?? 0, offset: 0, rendered: false };
}

export function useKeys(map, deps) {
  useEffect(() => {
    const on = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) {
        if ((e.metaKey || e.ctrlKey) && e.key === "z" && map.undo) {
          e.preventDefault();
          map.undo();
        }
        return;
      }
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
      const fn = map[e.key] || map[e.key.toLowerCase()];
      if (fn) {
        // Space and arrows on a focused button should still reach the button.
        if ((e.key === " " || e.key === "Enter") && t?.tagName === "BUTTON") return;
        e.preventDefault();
        fn(e);
      }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
