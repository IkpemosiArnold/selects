// Client-side sentence boundaries, used only to preview where a trim will
// snap while dragging. The server's snapTrim is the authority; the UI always
// adopts the value the PATCH returns.
export function toSentences(words) {
  const out = [];
  let i0 = 0;
  for (let i = 0; i < words.length; i++) {
    if (/[.?!]["')\]]?$/.test(words[i].w) || i === words.length - 1) {
      out.push({ s: words[i0].s, e: words[i].e, i0, i1: i });
      i0 = i + 1;
    }
  }
  return out;
}

function nearest(list, t) {
  let best = list[0];
  for (const v of list) if (Math.abs(v - t) < Math.abs(best - t)) best = v;
  return best;
}

export function snapEdge(sentences, t, edge) {
  if (!sentences.length) return t;
  return nearest(sentences.map((x) => (edge === "start" ? x.s : x.e)), t);
}

// Move an edge by one sentence in a direction (-1 earlier, +1 later).
export function nudgeEdge(sentences, t, edge, dir) {
  const pts = sentences.map((x) => (edge === "start" ? x.s : x.e));
  if (dir > 0) return pts.find((p) => p > t + 0.05) ?? t;
  for (let i = pts.length - 1; i >= 0; i--) if (pts[i] < t - 0.05) return pts[i];
  return t;
}

export function wordsIn(words, s, e) {
  // Binary search for the first word ending after s.
  let lo = 0, hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].e <= s) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < words.length && words[i].s < e; i++) out.push(i);
  return out;
}
