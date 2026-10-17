// Turn a YouTube "Most Replayed" heatmap into labelled windows.
//
// The heatmap (yt-dlp info JSON field `heatmap`) is about 100 equal segments
// [{ start_time, end_time, value }] where value is relative replay intensity in 0..1
// (the busiest segment is 1). It is a proxy for "what viewers rewatch or seek to",
// not a direct judgement of what makes a good short.
//
// Method (deterministic, documented in eval/README.md):
// 1. Ignore segments in the first and last `edgeFrac` of the video (default 3%, at least 30 s):
//    the start is inflated by everyone pressing play, the end by end screens.
// 2. Threshold = the `quantile` (default 0.75) of the remaining values. A peak is a local
//    maximum (>= left neighbour, > right neighbour) at or above the threshold.
// 3. Expand each peak over neighbouring segments while they stay at or above half its
//    prominence over the median (a full-width-at-half-maximum rule), then clamp to
//    [minLen, maxLen] seconds centred on the peak segment.
// 4. For a long video evaluated on its first N minutes only, steps 1 to 3 run on the segments
//    inside that range (the end-screen rule is then skipped).
// 5. Keep the highest peaks first, dropping any window that overlaps a kept one, up to maxLabels.

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function heatmapToLabels(heatmap, opts = {}) {
  const { maxLabels = 5, minLen = 20, maxLen = 60, quantile: qq = 0.75, edgeFrac = 0.03, edgeMinSec = 30, rangeEnd = null } = opts;
  if (!Array.isArray(heatmap) || heatmap.length < 5) return [];
  const all = [...heatmap].sort((a, b) => a.start_time - b.start_time);
  const fullDuration = all[all.length - 1].end_time;
  // Evaluating only the first part of a long video: keep segments inside the range. The
  // end-screen exclusion applies only when the range reaches the real end.
  const clipped = rangeEnd != null && rangeEnd < fullDuration;
  const segs = clipped ? all.filter((s) => s.end_time <= rangeEnd) : all;
  if (segs.length < 5) return [];
  const duration = segs[segs.length - 1].end_time;
  const edge = Math.max(edgeMinSec, edgeFrac * fullDuration);
  const inside = (s) => s.start_time >= edge && (clipped || s.end_time <= duration - edge);
  const vals = segs.filter(inside).map((s) => s.value).sort((a, b) => a - b);
  if (!vals.length) return [];
  const thr = quantile(vals, qq);
  const med = quantile(vals, 0.5);

  const peaks = [];
  for (let i = 1; i < segs.length - 1; i++) {
    const s = segs[i];
    if (!inside(s)) continue;
    if (s.value >= thr && s.value >= segs[i - 1].value && s.value > segs[i + 1].value) peaks.push(i);
  }
  peaks.sort((a, b) => segs[b].value - segs[a].value);

  const out = [];
  for (const i of peaks) {
    const pv = segs[i].value;
    const half = med + (pv - med) / 2;
    let l = i, r = i;
    while (l - 1 >= 0 && segs[l - 1].value >= half && inside(segs[l - 1])) l--;
    while (r + 1 < segs.length && segs[r + 1].value >= half && inside(segs[r + 1])) r++;
    let start = segs[l].start_time, end = segs[r].end_time;
    const centre = (segs[i].start_time + segs[i].end_time) / 2;
    if (end - start > maxLen) {
      start = Math.max(start, centre - maxLen / 2);
      end = Math.min(end, start + maxLen);
      start = end - maxLen < start ? Math.max(segs[l].start_time, end - maxLen) : start;
    }
    if (end - start < minLen) {
      start = centre - minLen / 2;
      end = centre + minLen / 2;
    }
    start = Math.max(0, start);
    end = Math.min(duration, end);
    const win = { start: round(start), end: round(end), source: "heatmap", weight: round(pv, 3) };
    if (out.some((o) => Math.min(o.end, win.end) > Math.max(o.start, win.start))) continue;
    out.push(win);
    if (out.length >= maxLabels) break;
  }
  return out.sort((a, b) => a.start - b.start);
}

function round(x, d = 2) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

/** Time-weighted mean heatmap value over [start, end] (v2's per-window replay intensity). */
export function windowIntensity(heatmap, start, end) {
  let sum = 0, len = 0;
  for (const s of heatmap || []) {
    const o = Math.min(end, s.end_time) - Math.max(start, s.start_time);
    if (o > 0) { sum += o * s.value; len += o; }
  }
  return len ? sum / len : null;
}
