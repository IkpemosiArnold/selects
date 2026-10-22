// One word-timing shape for every speech-to-text provider: [{ w, s, e }], seconds, in order,
// with the punctuation and casing the sentence splitter needs (src/core/sentences.mjs splits
// on it). The browser's whisper already gives that shape (src/browser/asr.worker.js). Hosted
// whisper APIs that follow OpenAI's verbose_json give words WITHOUT punctuation and the full
// text separately, so wordsFromVerbose puts the punctuation back from the text.

const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");

/** Keep times sane and in order: no negative or reversed words, no word starting before the previous one. */
export function cleanWords(words, { offset = 0, prevEnd = 0 } = {}) {
  const out = [];
  let last = prevEnd;
  for (const x of words || []) {
    const w = String(x.w ?? x.word ?? x.text ?? "").trim();
    let s = Number(x.s ?? x.start);
    let e = Number(x.e ?? x.end);
    if (!w || !Number.isFinite(s)) continue;
    if (!Number.isFinite(e) || e < s) e = s + 0.2;
    s += offset;
    e += offset;
    // a word placed before the previous one's end is a repeat across a chunk edge
    if (s < last - 0.05) continue;
    s = Math.max(s, last);
    e = Math.max(e, s + 0.02);
    out.push({ w, s: +s.toFixed(3), e: +e.toFixed(3) });
    last = e;
  }
  return out;
}

/**
 * Words with their punctuation, from an OpenAI-style verbose_json transcription:
 * { text, segments?: [{ text }], words: [{ word, start, end }] }. Each word takes the matching
 * whitespace-separated token of the text ("Hello," for "Hello"); a token that covers several
 * words ("well-known" for "well" and "known") becomes one word spanning them. Words the text
 * does not account for keep their own spelling. Returns null when there are no word times
 * (segment times alone are not enough for Selects).
 */
export function wordsFromVerbose(json) {
  const raw = Array.isArray(json?.words) ? json.words : null;
  if (!raw || (!raw.length && String(json?.text || "").trim())) return null;
  const text = Array.isArray(json.segments) && json.segments.length ? json.segments.map((s) => s.text || "").join(" ") : String(json.text || "");
  const tokens = text.split(/\s+/).filter((t) => norm(t));
  const out = [];
  let t = 0;
  for (let i = 0; i < raw.length; i++) {
    const x = raw[i];
    const nw = norm(x.word);
    if (!nw) continue;
    // look a few tokens ahead for this word (the text can carry an extra token or two)
    let found = -1;
    for (let k = t; k < Math.min(tokens.length, t + 4); k++) {
      const nt = norm(tokens[k]);
      if (nt === nw || (nt.startsWith(nw) && nt.length > nw.length)) {
        found = k;
        break;
      }
    }
    if (found < 0) {
      out.push({ w: String(x.word).trim(), s: x.start, e: x.end });
      continue;
    }
    const token = tokens[found];
    const nt = norm(token);
    let end = x.end;
    let joined = nw;
    // one token, several words: take the following words until the token is spelled out
    while (joined.length < nt.length && i + 1 < raw.length && nt.startsWith(joined + norm(raw[i + 1].word))) {
      i++;
      joined += norm(raw[i].word);
      end = raw[i].end;
    }
    out.push({ w: token, s: x.start, e: end });
    t = found + 1;
  }
  return cleanWords(out);
}
