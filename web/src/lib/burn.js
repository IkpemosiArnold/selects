// The captions a render burns in, worked out in the browser so the preview
// shows exactly what the MP4 will: the cues of captions.json inside the clip
// (a word belongs to the clip when its midpoint does, as clipCues does in
// src/core/captions.mjs), trailing commas and full stops dropped, the spoken
// word in marker yellow, and each cue held until the next one or 0.4 s after
// its last word (buildCaptionTrack in src/core/render.mjs).

/** Cues of the clip [start, end], in source seconds. */
export function clipCues(cues, start, end) {
  const out = [];
  for (const c of cues || []) {
    if (c.e < start - 1 || c.s > end + 1) continue;
    const ws = (c.words || []).filter((w) => (w.s + w.e) / 2 >= start && (w.s + w.e) / 2 <= end);
    if (ws.length) out.push({ s: ws[0].s, e: ws[ws.length - 1].e, words: ws });
  }
  return out;
}

/** Cues from bare words, the bold style's chunking (for jobs with no captions.json yet). */
export function cuesFromWords(words) {
  const out = [];
  let cur = [];
  const chars = (arr) => arr.reduce((a, w) => a + w.w.length + 1, -1);
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const brk =
      cur.length &&
      (cur.length >= 4 || chars([...cur, w]) > 22 || /[.!?]["')\]]*$/.test(prev.w) || (cur.length >= 2 && /[,;:]$/.test(prev.w)) || w.s - prev.e > 0.5);
    if (brk) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out.map((ws) => ({ s: ws[0].s, e: ws[ws.length - 1].e, words: ws }));
}

export const display = (w) => w.replace(/[,.;:]+$/, "");

/** The cue on screen at t and the index of the highlighted word, or null. */
export function burnAt(cues, t) {
  let lo = 0, hi = cues.length - 1, k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].s <= t + 0.02) {
      k = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (k < 0) return null;
  const c = cues[k];
  const hold = Math.min(cues[k + 1]?.s ?? Infinity, c.e + 0.4);
  if (t > hold) return null;
  let on = 0;
  for (let i = 0; i < c.words.length; i++) if (c.words[i].s <= t + 0.02) on = i;
  return { cue: c, on };
}
