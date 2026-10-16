// Pure helpers for the caption editor: words with character offsets, word
// timings for edited text, and splitting or merging cues at word boundaries.
// The server keeps the real word timings; these only decide the cue edges sent.

let seq = 0;
export const newKey = () => "q" + ++seq;

export function fromCues(cues) {
  return (cues || []).map((c) => ({ k: newKey(), s: c.s, e: c.e, text: c.text, base: c.text, words: c.words || [], touched: false }));
}

// Non-space tokens with their [start, end) offsets in the text.
export function tokensOf(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) out.push({ t: m[0], a: m.index, b: m.index + m[0].length });
  return out;
}

// Times for each token: the word's own time when the count still matches,
// otherwise spread over the cue by length, as the server does.
export function tokenTimes(item, toks = tokensOf(item.text)) {
  const ws = item.words || [];
  if (ws.length === toks.length && ws.length) return ws.map((w) => ({ s: w.s, e: w.e }));
  const s0 = ws.length ? ws[0].s : item.s;
  const e0 = ws.length ? ws[ws.length - 1].e : item.e;
  const weights = toks.map((x) => x.t.length + 1);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = s0;
  return toks.map((_, i) => {
    const d = ((e0 - s0) * weights[i]) / total;
    const r = { s: t, e: t + d * 0.92 };
    t += d;
    return r;
  });
}

// Which token boundary a caret position means: before token j (0 < j < n), or -1.
export function splitIndex(text, caret) {
  const toks = tokensOf(text);
  for (let j = 0; j < toks.length; j++) {
    const tk = toks[j];
    if (caret <= tk.a) return j;
    if (caret < tk.b) return caret - tk.a < tk.b - caret ? j : j + 1;
  }
  return toks.length;
}

export function splitItem(item, caret) {
  const toks = tokensOf(item.text);
  const j = splitIndex(item.text, caret);
  if (j <= 0 || j >= toks.length) return null;
  const times = tokenTimes(item, toks);
  const matched = (item.words || []).length === toks.length;
  const words = (from, to) =>
    matched ? item.words.slice(from, to) : toks.slice(from, to).map((x, i) => ({ w: x.t, s: times[from + i].s, e: times[from + i].e, p: 1, edited: true }));
  const t1 = toks.slice(0, j).map((x) => x.t).join(" ");
  const t2 = toks.slice(j).map((x) => x.t).join(" ");
  const r = (v) => Math.round(v * 1000) / 1000;
  const a = { k: newKey(), s: r(times[0].s), e: r(times[j - 1].e), text: t1, base: t1, words: words(0, j), touched: true };
  const b = { k: newKey(), s: r(times[j].s), e: item.e, text: t2, base: t2, words: words(j), touched: true };
  // A split of unsaved text: both halves still differ from what the server has.
  if (item.text !== item.base) {
    a.base = null;
    b.base = null;
  }
  return [a, b, toks[j].t];
}

export function mergeItems(a, b) {
  const text = [a.text.trim(), b.text.trim()].filter(Boolean).join(" ");
  return {
    k: newKey(),
    s: a.s,
    e: Math.max(a.e, b.e),
    text,
    base: a.text === a.base && b.text === b.base ? text : null,
    words: [...(a.words || []), ...(b.words || [])],
    touched: true,
    joinAt: a.text.trim().length + (a.text.trim() && b.text.trim() ? 1 : 0),
  };
}

// Tokens whisper was unsure of, as [start, end) offsets in the current text.
export function unsureSpans(item, lowP) {
  const toks = tokensOf(item.text);
  const ws = item.words || [];
  if (ws.length !== toks.length) return [];
  const out = [];
  toks.forEach((tk, i) => {
    const w = ws[i];
    if (w && !w.edited && w.w === tk.t && Number.isFinite(w.p) && w.p < lowP) out.push(tk);
  });
  return out;
}

export function isEdited(item) {
  return item.touched || item.text !== item.base || (item.words || []).some((w) => w.edited);
}

// Index of the cue on screen at time t (binary search on start), or -1.
export function cueAt(items, t) {
  let lo = 0;
  let hi = items.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].s <= t + 0.02) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best < 0) return -1;
  const next = items[best + 1]?.s ?? Infinity;
  return t <= Math.min(items[best].e + 0.6, next) ? best : -1;
}
