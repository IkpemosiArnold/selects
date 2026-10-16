// The language-ID ensemble: several signals that fail in different ways, combined by a
// small weighted vote that is written down and tested (rule.test.mjs).
//
// Signals:
//   whisper-detect  whisper's own audio guess on the first 30 s. Biased against accents
//                   (it called an elderly Nigerian woman's English "Yoruba", p = 0.90).
//   whisper-decode  decode-and-compare: the samples decoded in each candidate language,
//                   ranked by mean word probability, with a decode that came out as English
//                   text unable to win (chooseLanguage in language.mjs).
//   text-608        olaverse lid-lite-608 reads each decode's text.
//   text-ng5        olaverse lid-lite-5 (English, Hausa, Igbo, Pidgin, Yoruba) does the same.
//
// The text signals only speak when whisper did not write what it was asked for. Told to
// write Yoruba, whisper writes English when the speech is English: that refutes Yoruba and
// is a vote for English. When every decode came out in the language asked for, the text
// models have no opinion (whisper can also translate, so "asked for English, wrote English"
// proves little).
import { languageName } from "../language.mjs";
import { iso3Of, NIGERIAN, WHISPER_LANGS } from "./codes.mjs";

/** Vote weights. The detector counts half: it is the signal known to fail on accents. */
export const WEIGHTS = { "whisper-detect": 0.5, "whisper-decode": 1.0, "text-608": 1.0, "text-ng5": 0.5 };
/** Below this share of the vote, the ensemble asks instead of deciding. */
export const MIN_CONFIDENCE = 0.6;
/** A text verdict needs this many decoded words and this probability to count. */
export const TEXT_MIN_WORDS = 8;
export const TEXT_MIN_P = 0.5;
/**
 * A decode with a mean word probability under this failed: whisper could not write the
 * speech in that language. Its text is noise (lid-lite-608 read a failed Welsh decode of
 * British English as Welsh, p = 1.0), so the text models skip it, and the failure itself
 * refutes that language.
 */
export const DECODE_FAIL = 0.3;
/**
 * Whisper's detector under this p is unsure. A non-English verdict that rests on an unsure
 * detector is asked about, not decided: on Hausa speech the detector said Romanian
 * (p = 0.17), and whisper's "Romanian" decode read as Romanian text too.
 */
export const DETECT_SURE = 0.5;
const NG5_CODES = { eng: "en", hau: "ha", ibo: "ig", pcm: "en", yor: "yo" };
const NG5_DOMAIN = new Set(["eng", ...NIGERIAN]);

/** lid-lite-5's verdict for one text: { code, p } from its class probabilities, or null. */
export function ng5Verdict(probs) {
  if (!probs) return null;
  const byCode = {};
  for (const [k, c] of Object.entries(NG5_CODES)) byCode[c] = (byCode[c] || 0) + (probs[k] || 0);
  const [code, p] = Object.entries(byCode).sort((a, b) => b[1] - a[1])[0];
  return { code, p: +p.toFixed(3) };
}

/**
 * One text signal across all decodes. decodes: [{ asked, words, meanP, verdict: { code, p } | null }].
 * A decode refutes its language when its text is in another language (p >= TEXT_MIN_P).
 * Failed decodes (meanP < DECODE_FAIL) are skipped.
 * Returns { verdict, p, refuted: codes[], detail: [...] } (verdict null = no opinion).
 */
export function textSignal(decodes, { minWords = TEXT_MIN_WORDS, minP = TEXT_MIN_P, failP = DECODE_FAIL } = {}) {
  const detail = [];
  const votes = {};
  const refuted = [];
  for (const d of decodes) {
    if (!d.verdict || d.words < minWords || (d.meanP != null && d.meanP < failP)) {
      const note = !d.verdict ? "no verdict" : d.words < minWords ? "too few words" : "the decode failed";
      detail.push({ asked: d.asked, text: null, p: null, note });
      continue;
    }
    const { code, p } = d.verdict;
    detail.push({ asked: d.asked, text: code, p });
    if (code !== d.asked && p >= minP) {
      refuted.push(d.asked);
      votes[code] = (votes[code] || []).concat(p);
    }
  }
  const ranked = Object.entries(votes).sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0));
  if (!ranked.length) return { verdict: null, p: null, refuted, detail };
  const [code, ps] = ranked[0];
  return { verdict: code, p: +(ps.reduce((a, b) => a + b, 0) / ps.length).toFixed(3), refuted, detail };
}

/**
 * Combine the signals. Inputs:
 *   setting   "auto" or the language the user chose
 *   detected  whisper's guess { code, p } or null
 *   decode    { best, margin } from chooseLanguage (best null when nothing was compared)
 *   compared  [{ code, words, text: { lid608: { code, p } | null, ng5: probs | null } }]
 * Returns { language, used, confidence, scores, signals, disagreement, reasons, question }.
 * `language` is what the evidence says; `used` is what Selects transcribes with (the
 * setting when the user chose one, else `language`).
 */
export function ensemble({ setting = "auto", detected = null, decode = null, compared = [] } = {}) {
  const signals = [];
  const t608 = textSignal(compared.map((c) => ({ asked: c.code, words: c.words, meanP: c.meanP, verdict: c.text?.lid608 ? { code: c.text.lid608.code, p: c.text.lid608.p } : null })));
  // lid-lite-5 knows five languages and calls any other text one of them (it read a garbled
  // decode of American English as Hausa, p = 0.99), so it only speaks on text that
  // lid-lite-608 places in those five (or when lid-lite-608 is not installed)
  const inNg5 = (c) => !c.text?.lid608 || NG5_DOMAIN.has(iso3Of(c.text.lid608.label || ""));
  const tng5 = textSignal(compared.filter((c) => ["en", "yo", "ha", "ig"].includes(c.code)).map((c) => ({ asked: c.code, words: c.words, meanP: c.meanP, verdict: inNg5(c) ? ng5Verdict(c.text?.ng5) : null })));
  // a language is refuted when its decode came out in another language, or failed outright
  const failed = compared.filter((c) => c.meanP != null && (c.meanP < DECODE_FAIL || c.words < 5)).map((c) => c.code);
  const refutedByText = new Set([...t608.refuted, ...tng5.refuted, ...failed]);

  if (detected) {
    signals.push({ id: "whisper-detect", kind: "audio", model: "whisper (multilingual)", verdict: detected.code, p: detected.p, weight: WEIGHTS["whisper-detect"], refuted: refutedByText.has(detected.code) });
  }
  if (decode?.best) {
    // a close call between two decodes counts half
    const p = decode.margin == null || decode.margin >= 0.05 ? 1 : 0.5;
    signals.push({ id: "whisper-decode", kind: "decode", model: "whisper (multilingual)", verdict: decode.best, p, weight: WEIGHTS["whisper-decode"], margin: decode.margin ?? null, refuted: refutedByText.has(decode.best) });
  }
  if (compared.some((c) => c.text?.lid608)) {
    signals.push({ id: "text-608", kind: "text", model: "lid-lite-608", verdict: t608.verdict, p: t608.p, weight: WEIGHTS["text-608"], detail: t608.detail, refuted: false });
  }
  if (compared.some((c) => c.text?.ng5)) {
    signals.push({ id: "text-ng5", kind: "text", model: "lid-lite-5", verdict: tng5.verdict, p: tng5.p, weight: WEIGHTS["text-ng5"], detail: tng5.detail, refuted: false });
  }

  const scores = {};
  for (const s of signals) if (s.verdict) scores[s.verdict] = +((scores[s.verdict] || 0) + s.weight * s.p).toFixed(3);
  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1] || (a[0] === decode?.best ? -1 : b[0] === decode?.best ? 1 : 0));
  const fallback = setting !== "auto" ? setting : "en";
  // the winner must be a language whisper can transcribe (Igbo, for one, is not)
  const winner = ranked.find(([c]) => WHISPER_LANGS.has(c))?.[0] ?? fallback;
  const language = ranked.length ? winner : fallback;
  const confidence = total > 0 ? +((scores[language] || 0) / total).toFixed(3) : null;
  const used = setting !== "auto" ? setting : language;

  const reasons = [];
  for (const s of signals) {
    if (!s.verdict || s.verdict === language || s.refuted) continue;
    reasons.push(`${s.id} says ${languageName(s.verdict)}`);
  }
  if (confidence != null && confidence < MIN_CONFIDENCE) reasons.push(`only ${Math.round(confidence * 100)}% of the vote`);
  if (setting === "auto" && language !== "en" && detected?.code === language && detected.p < DETECT_SURE) reasons.push(`whisper's detector is unsure (p = ${detected.p})`);
  if (used !== language && total > 0) reasons.push(`you chose ${languageName(used)}, the evidence says ${languageName(language)}`);
  if (ranked.length && ranked[0][0] !== language) reasons.push(`${languageName(ranked[0][0])} cannot be transcribed by whisper`);
  const disagreement = reasons.length > 0;

  const question = disagreement
    ? {
        text: `Is the speaker using ${languageName(used)}?`,
        language: used,
        // other languages to offer first, best evidence first
        choices: [...new Set([...ranked.map(([c]) => c), ...compared.map((c) => c.code)])].filter((c) => c !== used && WHISPER_LANGS.has(c)),
      }
    : null;
  return { language, used, confidence, scores, signals, disagreement, reasons, question };
}
