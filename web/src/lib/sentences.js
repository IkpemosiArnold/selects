// Sentence edges in the browser, from the core's own rules (src/core/sentences.mjs
// has no Node imports), so a trim previewed here lands where the server's
// snapTrim will put it. The server stays the authority: the UI always adopts
// the start and end the PATCH returns.
import { toSentences as coreSentences, snapTrim } from "../../../src/core/sentences.mjs";

export { snapTrim };

export function toSentences(words) {
  return coreSentences(words).map((x) => ({ ...x, i0: x.wordIdx[0], i1: x.wordIdx[1] }));
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
