// A person's decisions on candidates (approve or skip, a trim, a faithful accept or fix),
// kept apart from what the judge computed, so a new judgment (another model, another setting)
// never loses them and never puts them on the wrong clip.
//
// Decisions are keyed by the window they were made on: its start and end as the selection
// produced it (origStart and origEnd, kept when a trim moves the clip). Candidate ids are
// window numbers, so another length range gives the same id to a different window; the key
// does not. A decision is put back only where that exact window is a candidate again.
// Pure and browser-safe: no Node imports.
import { snapTrim, toSentences } from "./sentences.mjs";

const r2 = (x) => Math.round(Number(x) * 100) / 100;

/** The window a candidate came from, before any trim. */
export const windowKey = (c) => `${r2(c.origStart ?? c.start)}-${r2(c.origEnd ?? c.end)}`;

/** True when a person changed something on this candidate. */
function decided(c) {
  return (c.status && c.status !== "proposed") || c.trimmed || c.faithful?.accepted || c.faithful?.applied;
}

/**
 * The decisions on these candidates, merged over earlier ones (a candidate set back to
 * "proposed" with no trim drops its entry). Returns { [windowKey]: decision }.
 */
export function captureDecisions(candidates = [], prev = {}) {
  const out = { ...(prev || {}) };
  for (const c of candidates || []) {
    const k = windowKey(c);
    if (!decided(c)) {
      delete out[k];
      continue;
    }
    out[k] = {
      id: c.id,
      status: c.status || "proposed",
      ...(c.trimmed ? { trimmed: true, start: c.start, end: c.end } : {}),
      ...(c.faithful?.accepted ? { accepted: true } : {}),
      ...(c.faithful?.applied ? { applied: true } : {}),
    };
  }
  return out;
}

/**
 * Put decisions back on freshly computed candidates. A trim is snapped again to the current
 * words (the same rule as a trim in the review). Returns { candidates, applied, unmatched }:
 * unmatched are the keys whose window is not a candidate this time (kept, not applied).
 */
export function applyDecisions(candidates = [], decisions = {}, { words = null } = {}) {
  const keys = new Set(Object.keys(decisions || {}));
  let applied = 0;
  const out = (candidates || []).map((c0) => {
    const k = windowKey(c0);
    const d = decisions?.[k];
    if (!d) return c0;
    keys.delete(k);
    applied++;
    const c = { ...c0, status: d.status || "proposed" };
    if (d.trimmed && Number.isFinite(d.start) && Number.isFinite(d.end)) {
      const snapped = words?.length ? snapTrim(words, d.start, d.end) : { start: d.start, end: d.end };
      c.origStart = c0.origStart ?? c0.start;
      c.origEnd = c0.origEnd ?? c0.end;
      c.start = snapped.start;
      c.end = snapped.end;
      if (words?.length) {
        const ws = words.filter((w) => w.s >= c.start - 1e-6 && w.e <= c.end + 1e-6);
        c.text = ws.map((w) => w.w).join(" ");
        c.hook = toSentences(ws)[0]?.text ?? c.text;
      }
      c.trimmed = true;
      c.render = null;
    }
    if (c.faithful && (d.accepted || d.applied)) c.faithful = { ...c.faithful, ...(d.accepted ? { accepted: true } : {}), ...(d.applied ? { applied: true } : {}) };
    return c;
  });
  return { candidates: out, applied, unmatched: [...keys] };
}
