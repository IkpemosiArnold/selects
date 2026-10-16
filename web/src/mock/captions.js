// Mock stand-ins for the core's captions.json handling (src/core/captions.mjs):
// cues built from words, and edits applied the way the server applies them,
// so the demo behaves like the real thing (timings kept, changed words p = 1).

const STYLES = {
  bold: { maxWords: 4, maxChars: 22, pause: 0.5, commaMin: 2, maxDur: Infinity },
  subtitle: { maxWords: 16, maxChars: 76, pause: 0.9, commaMin: 7, maxDur: 6 },
};

export function cuesFromWords(words, style = "bold") {
  const o = STYLES[style] || STYLES.bold;
  const chunks = [];
  let cur = [];
  const chars = (arr) => arr.reduce((a, w) => a + w.w.length + 1, -1);
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const brk =
      cur.length &&
      (cur.length >= o.maxWords ||
        chars([...cur, w]) > o.maxChars ||
        w.e - cur[0].s > o.maxDur ||
        /[.!?]["')\]]*$/.test(prev.w) ||
        (cur.length >= o.commaMin && /[,;:]$/.test(prev.w)) ||
        w.s - prev.e > o.pause);
    if (brk) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((ws) => ({ s: ws[0].s, e: ws[ws.length - 1].e, text: ws.map((x) => x.w).join(" "), words: ws.map((x) => ({ ...x })) }));
}

const tokens = (text) => String(text).trim().split(/\s+/).filter(Boolean);

export function applyCueEdits(oldCues, edits) {
  const old = oldCues.flatMap((c) => c.words || []).sort((a, b) => a.s - b.s);
  const out = [];
  const sorted = edits
    .map((c) => ({ s: Number(c.s), e: Number(c.e), text: c.text ?? "" }))
    .filter((c) => Number.isFinite(c.s) && Number.isFinite(c.e) && c.e > c.s)
    .sort((a, b) => a.s - b.s);
  for (const c of sorted) {
    const toks = tokens(c.text);
    if (!toks.length) continue;
    const inside = old.filter((w) => {
      const mid = (w.s + w.e) / 2;
      return mid >= c.s - 1e-3 && mid <= c.e + 1e-3;
    });
    let words;
    if (inside.length === toks.length) {
      words = inside.map((w, i) => (w.w === toks[i] ? { ...w } : { ...w, w: toks[i], p: 1, edited: true }));
    } else {
      const s0 = inside.length ? inside[0].s : c.s;
      const e0 = inside.length ? inside[inside.length - 1].e : c.e;
      const weights = toks.map((t) => t.length + 1);
      const total = weights.reduce((a, b) => a + b, 0);
      let t = s0;
      words = toks.map((w, i) => {
        const d = ((e0 - s0) * weights[i]) / total;
        const word = { w, s: +t.toFixed(3), e: +(t + d * 0.92).toFixed(3), p: 1, edited: true };
        t += d;
        return word;
      });
    }
    const prev = out[out.length - 1];
    let s = +Math.min(c.s, words[0].s).toFixed(3);
    if (prev && s < prev.e) s = prev.e;
    out.push({ s, e: +Math.max(c.e, words[words.length - 1].e).toFixed(3), text: words.map((w) => w.w).join(" "), words });
  }
  return out;
}

const pad = (n, w = 2) => String(n).padStart(w, "0");
function stamp(t, sep) {
  const ms = Math.round(t * 1000);
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`;
}
export function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.s, ",")} --> ${stamp(c.e + 0.2, ",")}\n${c.text}\n`).join("\n");
}
export function toVtt(cues) {
  return "WEBVTT\n\n" + cues.map((c) => `${stamp(c.s, ".")} --> ${stamp(c.e + 0.2, ".")}\n${c.text}\n`).join("\n");
}

// Accented speech: whisper is unsure of some words. Lower p on a deterministic
// scatter of them, with a few plausible mishearings, so the demo has words to fix.
const MISHEARD = { invoice: "envoys", queue: "cue", retries: "retrace", bank: "bunk", worker: "walker", database: "data", index: "indies" };
export function accentedWords(words, share = 0.07) {
  let s = 1234567;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return words.map((w) => {
    const bare = w.w.toLowerCase().replace(/[^a-z]/g, "");
    if (MISHEARD[bare] && r() < 0.55) {
      const tail = w.w.match(/[^A-Za-z]*$/)[0];
      return { ...w, w: MISHEARD[bare] + tail, p: +(0.18 + r() * 0.2).toFixed(2) };
    }
    if (r() < share) return { ...w, p: +(0.2 + r() * 0.28).toFixed(2) };
    return w;
  });
}
