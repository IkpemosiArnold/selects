// Whisper writes what it hears that is not speech as bracketed notes: [BLANK_AUDIO], [Music],
// (laughs), (speaking in foreign language), * applause *. With one word per segment (-ml 1)
// a note arrives split over several tokens, so it has to be found as a run, not one token.
// None of it is speech: it must never reach a sentence, a candidate, a caption or a prompt.
// The time it covers stays a gap between words (a pause signal), and laughter is kept as an
// event the pre-score can use.

const CLOSE = { "[": "]", "(": ")", "*": "*", "♪": "♪" };
const OPENER = /[[(*♪]/;
// a note wholly inside one token, like "[BLANK_AUDIO]" or "word(laughs)"
const EMBEDDED = /\[[^\]]*\]|\([^)]*\)|\*[^*\s][^*]*\*|♪[^♪]*♪/g;
const MAX_RUN = 12; // a note is a few words; an opener with no close this soon is left alone
const HAS_TEXT = /[\p{L}\p{N}]/u;

/** What a note is: laughter, applause, music, silence, inaudible, foreign or other. */
export function eventType(text) {
  const t = String(text).toLowerCase();
  if (/laugh|chuckl|giggl/.test(t)) return "laughter";
  if (/applau|clapp|cheer/.test(t)) return "applause";
  if (/music|♪|\bsing/.test(t)) return "music";
  if (/blank|silen|no speech|pause/.test(t)) return "silence";
  if (/inaudible|unintelligible|indistinct|crosstalk|mumbl/.test(t)) return "inaudible";
  if (/foreign|speaking|non-english/.test(t)) return "foreign";
  return "other";
}

const trailingPunct = (t) => t.replace(/[.,!?;:"']+$/, "");

/** Index of the token that closes a note opened in token i (at char idx), or -1. */
function findClose(words, i, idx) {
  const t = String(words[i].w);
  const close = CLOSE[t[idx]];
  if (trailingPunct(t.slice(idx + 1)).endsWith(close)) return i;
  for (let k = i + 1; k < Math.min(words.length, i + MAX_RUN); k++) {
    const tk = String(words[k].w).trim();
    if (OPENER.test(tk[0]) && close !== tk[0]) return -1; // another note opens first: not a run
    if (trailingPunct(tk).endsWith(close)) return k;
  }
  return -1;
}

/**
 * Split words into speech and non-speech events.
 * @param {{w:string,s:number,e:number,p?:number}[]} words
 * @returns {{words: object[], events: {type:string,s:number,e:number}[]}}
 *   `words` keeps every speech word with its own times (so the notes leave gaps);
 *   `events` lists each note dropped.
 */
export function splitNonSpeech(words) {
  const out = [];
  const events = [];
  const event = (text, s, e) => events.push({ type: eventType(text), s, e });
  for (let i = 0; i < (words || []).length; i++) {
    const w = words[i];
    let t = String(w.w ?? "").trim();
    // notes wholly inside this token
    const inside = t.match(EMBEDDED);
    if (inside) {
      for (const n of inside) event(n, w.s, w.e);
      t = t.replace(EMBEDDED, "").trim();
    }
    // a note that opens here and closes in a later token
    const idx = t.search(OPENER);
    if (idx >= 0) {
      const j = findClose([{ ...w, w: t }, ...words.slice(i + 1)], 0, idx);
      if (j > 0) {
        const end = words[i + j];
        event([t.slice(idx), ...words.slice(i + 1, i + j + 1).map((x) => x.w)].join(" "), w.s, end.e);
        const before = t.slice(0, idx).trim();
        if (HAS_TEXT.test(before)) out.push({ ...w, w: before });
        i += j;
        continue;
      }
    }
    if (!HAS_TEXT.test(t)) {
      // nothing left but brackets, music marks or stray punctuation
      if (inside || /^[\s[\]()*♪-]+$/.test(t) || !t) continue;
    }
    out.push(t === w.w ? w : { ...w, w: t });
  }
  return { words: out, events };
}

/** Speech words only (drops notes). */
export const speechOnly = (words) => splitNonSpeech(words).words;
