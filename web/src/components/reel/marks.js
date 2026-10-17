// Where the timeline strip puts each clip, rank number and time label. Pure, so it is
// tested without a browser (src/core/timeline-marks.test.mjs). On a 2 hour video a
// 30 s clip is a few pixels wide and neighbours touch, so clips that would touch go
// on a second or third lane, and a number or a time is shown only where it has room.
import { tc } from "../../lib/time.js";

export const MIN_W = 6; // px: the narrowest marker, as .tl-clip's min-width
export const CH = 6.7; // px per character of the strip's 11 px mono numbers

/**
 * Lanes for the markers: each clip goes on the lowest lane where it does not touch
 * the one before it. Past maxLanes, it shares the lane that frees up first.
 * Returns { lanes, lane: { [id]: n } }, lane 0 at the bottom.
 */
export function packLanes(cands, dur, width, { maxLanes = 3, minW = MIN_W, gap = 2 } = {}) {
  const lane = {};
  const ends = [];
  if (!(dur > 0) || !(width > 0)) {
    for (const c of cands) lane[c.id] = 0;
    return { lanes: 1, lane };
  }
  const px = width / dur;
  for (const c of [...cands].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const x0 = c.start * px;
    const x1 = x0 + Math.max(minW, (c.end - c.start) * px);
    let l = ends.findIndex((e) => e + gap <= x0);
    if (l < 0) l = ends.length < maxLanes ? ends.length : ends.indexOf(Math.min(...ends));
    ends[l] = x1;
    lane[c.id] = l;
  }
  return { lanes: Math.max(1, ends.length), lane };
}

/**
 * Which rank numbers fit: the current clip's first, then the best ranks, each placed
 * at its clip's left edge (pulled in at the right end) and kept only when it clears
 * every number already placed. Returns { [id]: x } in px.
 */
export function fitLabels(cands, dur, width, currentId, { ch = CH, pad = 4 } = {}) {
  const out = {};
  if (!(dur > 0) || !(width > 0)) return out;
  const order = [...cands].sort((a, b) => (b.id === currentId) - (a.id === currentId) || (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.start - b.start);
  const boxes = [];
  for (const c of order) {
    const w = String(c.rank ?? "+").length * ch;
    const x = Math.max(0, Math.min(width - w, (c.start / dur) * width));
    if (boxes.some(([a, b]) => x < b + pad && a < x + w + pad)) continue;
    boxes.push([x, x + w]);
    out[c.id] = x;
  }
  return out;
}

// Steps the strip may use, in seconds; the shortest that leaves room for the labels wins.
const STEPS = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400];

/** The times to label under the strip (the end time is always shown as well). */
export function tickTimes(dur, width, { ch = CH } = {}) {
  if (!(dur > 0)) return [];
  // the steps the strip used before it knew its width: never denser than these
  const base = dur > 5400 ? 900 : dur > 1800 ? 300 : dur > 600 ? 120 : dur > 120 ? 60 : 10;
  const out = [];
  if (!(width > 0)) {
    for (let t = 0; t <= dur - base * 0.6; t += base) out.push(t);
    return out;
  }
  const endW = tc(dur).length * ch;
  const room = endW + 16;
  const step = STEPS.find((s) => s >= base && (s / dur) * width >= room) ?? dur;
  for (let t = 0; t < dur; t += step) {
    const x = (t / dur) * width;
    const w = tc(t).length * ch;
    // centred labels (the first is left aligned) must clear the right-aligned end time
    if ((t === 0 ? w : x + w / 2) + 12 > width - endW) break;
    out.push(t);
  }
  return out;
}
