// Which language is spoken? Whisper's own detector looks at the first 30 seconds and is
// biased against accented English: it called an elderly Nigerian woman's English "Yoruba"
// with p = 0.88. So Selects decodes a few short samples in each candidate language and keeps
// the one whisper is most confident in, and treats the detector's guess as a hint only.
import fs from "node:fs";
import path from "node:path";
import { languageCheckModel } from "./config.mjs";
import { ensemble } from "./langid/rule.mjs";
import { identifyTexts as realIdentifyTexts } from "./langid/textlid.mjs";
import { detectLanguage, extractAudio, runWhisper, wordsFromWhisperJson } from "./transcribe.mjs";
import { readJson, writeJsonAtomic } from "./util.mjs";

/** Bumped when the decision changes, so a cached language.json from an older rule is redone. */
export const LANGUAGE_RULE = "ensemble-1";

export const LANGUAGE_NAMES = {
  en: "English", yo: "Yoruba", ig: "Igbo", ha: "Hausa", sw: "Swahili", fr: "French", es: "Spanish", pt: "Portuguese",
  de: "German", it: "Italian", nl: "Dutch", ar: "Arabic", zh: "Chinese", ja: "Japanese", ko: "Korean", hi: "Hindi",
  ru: "Russian", tr: "Turkish", pl: "Polish", uk: "Ukrainian", am: "Amharic", so: "Somali", zu: "Zulu", af: "Afrikaans",
  ln: "Lingala", sn: "Shona", ur: "Urdu", bn: "Bengali", id: "Indonesian", vi: "Vietnamese", th: "Thai", fa: "Persian",
  he: "Hebrew", el: "Greek", sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish", cy: "Welsh", ga: "Irish",
};
let displayNames = null;
try {
  displayNames = new Intl.DisplayNames(["en"], { type: "language" });
} catch {}
/** "yo" -> "Yoruba"; any other code through Intl ("ro" -> "Romanian"), else the code itself. */
export const languageName = (c) => {
  if (LANGUAGE_NAMES[c]) return LANGUAGE_NAMES[c];
  try {
    const n = displayNames?.of(c);
    if (n && n !== c && !/unknown/i.test(n)) return n;
  } catch {}
  return c;
};

// Common English function words (no single letters: Yoruba "a" and "o" are words too).
const EN_FUNCTION = new Set(
  "the an and or but of to in on at for with from by as is are was were be been it its this that these those you he she we they me him her us them my your his our their not no yes do does did have has had will would can could should there here what which who when where why how so if then than just very all some any one two about up out into over after because".split(" "),
);

/**
 * Share of decoded words that are common English function words. English text runs at
 * about 0.3 to 0.5; text in most other languages is near 0. When whisper is told to write
 * Yoruba and still writes English, the speech is English.
 */
export function englishShare(texts) {
  const ws = texts.map((w) => String(w).toLowerCase().replace(/[^a-z']/g, "")).filter(Boolean);
  if (!texts.length) return 0;
  return +(ws.filter((w) => EN_FUNCTION.has(w)).length / texts.length).toFixed(3);
}

/** Three ~20 s samples spread over the video (at 15%, 50% and 85%), or one if it is short. */
export function sampleRanges(duration, { n = 3, len = 20 } = {}) {
  if (!duration || duration <= len * n + 10) return [{ start: 0, dur: Math.min(duration || 60, 60) }];
  return [0.15, 0.5, 0.85].slice(0, n).map((f) => ({ start: +Math.max(0, Math.min(duration - len, duration * f - len / 2)).toFixed(2), dur: len }));
}

/**
 * Pick a language from decode results.
 * results: [{ code, meanP, words }]. setting: "auto" or a code the user chose.
 * Rules: a candidate needs some words to count. The winner is the highest mean word
 * probability. With an explicit setting, the setting is kept, and a warning is raised when
 * another language decoded clearly better (by more than `warnMargin`).
 * Returns { used, best, margin, decided, warning }.
 */
export function chooseLanguage(results, { setting = "en", detected = null, minWords = 5, warnMargin = 0.08, englishText = 0.2 } = {}) {
  // Mean word probability alone is not comparable across languages: on English speech from
  // an elderly Nigerian speaker, decoding "as Yoruba" scored 0.80 against 0.65 for English,
  // while 100% of the "Yoruba" words were plain English. So a non-English decode that came
  // out as English text cannot win; it is evidence for English.
  const wroteEnglish = (r) => r.code !== "en" && r.englishShare != null && r.englishShare >= englishText;
  const usable = results.filter((r) => r.words >= minWords && !wroteEnglish(r)).sort((a, b) => b.meanP - a.meanP);
  const best = usable[0] || null;
  const second = usable[1] || null;
  const margin = best && second ? +(best.meanP - second.meanP).toFixed(3) : null;
  let used;
  let decided;
  if (setting && setting !== "auto") {
    used = setting;
    decided = "setting";
  } else {
    used = best?.code || detected?.code || "en";
    decided = best ? "compare" : detected ? "detector" : "default";
  }
  const pick = (c) => results.find((r) => r.code === c);
  let warning = null;
  const fooled = results.find((r) => wroteEnglish(r) && r.code === detected?.code);
  if (fooled && used === "en") {
    warning = `Whisper's quick guess was ${languageName(fooled.code)} (p = ${detected.p.toFixed(2)}), but when asked to write ${languageName(fooled.code)} it wrote English, so this is English. Accented English is often misread as another language; change it if this is wrong.`;
  } else if (best && used !== best.code && (margin == null || best.meanP - (pick(used)?.meanP ?? 0) > warnMargin)) {
    warning = `${languageName(best.code)} decoded with more confidence than ${languageName(used)} (${best.meanP.toFixed(2)} against ${(pick(used)?.meanP ?? 0).toFixed(2)}). If the speech is ${languageName(best.code)}, set the language to ${best.code}.`;
  } else if (detected && detected.code !== used) {
    const usedR = pick(used);
    const detR = pick(detected.code);
    warning = `Whisper's quick guess was ${languageName(detected.code)} (p = ${detected.p.toFixed(2)})${usedR && detR ? `, but ${languageName(used)} decoded with more confidence (${usedR.meanP.toFixed(2)} against ${detR.meanP.toFixed(2)})` : ""}. Using ${languageName(used)}. Accented English is often misread as another language; change it if this is wrong.`;
  }
  return { used, best: best?.code ?? null, margin, decided, warning };
}

/**
 * Decide the language for a video. Cached in <cacheDir>/language.json per setting.
 * Cheap: one ~60 s WAV of three samples, a detector pass, and one multilingual base decode
 * per candidate language (only when the detector disagrees with the setting).
 */
export async function decideLanguage(videoPath, { duration, setting = "en", remembered = null, cacheDir, audioStream = null, signal, onProgress, deps = {} } = {}) {
  const cacheFile = path.join(cacheDir, "language.json");
  const cached = readJson(cacheFile, null);
  if (cached && cached.setting === setting && cached.remembered === remembered && cached.rule === LANGUAGE_RULE) return cached;
  const t0 = Date.now();
  const model = deps.model ?? languageCheckModel();
  if (!model) {
    // no multilingual model: trust the setting, say we could not check
    const res = { rule: LANGUAGE_RULE, setting, remembered, used: setting === "auto" ? "en" : setting, detected: null, compared: [], margin: null, decided: "setting", warning: setting === "auto" ? "No multilingual whisper model is installed, so the language could not be checked. Using English." : null, ensemble: ensemble({ setting }), sec: 0 };
    writeJsonAtomic(cacheFile, res);
    return res;
  }
  const extract = deps.extractAudio || extractAudio;
  const detect = deps.detectLanguage || detectLanguage;
  const decode = deps.decode || (async (wav, code, outBase) => wordsFromWhisperJson(await runWhisper(wav, { outBase, model, language: code, signal })));
  const identifyTexts = deps.identifyTexts || realIdentifyTexts;
  fs.mkdirSync(cacheDir, { recursive: true }); // ffmpeg and whisper write their samples here
  const wav = path.join(cacheDir, "langcheck.wav");
  const ranges = sampleRanges(duration);
  try {
    await extract(videoPath, wav, { stream: audioStream, ranges, signal });
    onProgress?.({ progress: 0.1, note: "checking the language" });
    const detected = await detect(wav, { model, signal });
    const candidates = [...new Set([setting !== "auto" ? setting : null, remembered, detected?.code, "en"].filter(Boolean))];
    const needCompare = setting === "auto" || (detected && detected.code !== setting) || (remembered && remembered !== setting);
    const compared = [];
    const texts = [];
    if (needCompare) {
      let i = 0;
      for (const code of candidates) {
        const outBase = path.join(cacheDir, `langcheck-${code}`);
        const words = await decode(wav, code, outBase);
        fs.rmSync(`${outBase}.json`, { force: true });
        const meanP = words.length ? words.reduce((a, w) => a + (w.p ?? 1), 0) / words.length : 0;
        compared.push({ code, meanP: +meanP.toFixed(3), words: words.length, englishShare: englishShare(words.map((w) => w.w)) });
        texts.push(words.map((w) => w.w).join(" "));
        onProgress?.({ progress: 0.1 + (0.85 * ++i) / candidates.length, note: `decoded the samples as ${languageName(code)}` });
      }
    }
    // text language ID on each decode (the words never leave the machine and are not stored)
    let textLid = null;
    if (compared.length) {
      const t1 = Date.now();
      const r = await identifyTexts(texts, { tmpDir: cacheDir, signal });
      r.results.forEach((x, i) => {
        compared[i].text = { lid608: x.lid608 ? { label: x.lid608.label, code: x.lid608.code, p: x.lid608.p, pcm: x.lid608.pcm } : null, ng5: x.ng5 || null };
      });
      textLid = { models: r.models, sec: r.sec ?? +((Date.now() - t1) / 1000).toFixed(1), error: r.error || null };
    }
    const pick = chooseLanguage(compared, { setting, detected });
    const ens = ensemble({ setting, detected, decode: { best: pick.best, margin: pick.margin }, compared });
    let used = pick.used;
    let decided = pick.decided;
    let warning = pick.warning;
    if (setting === "auto" && ens.used !== pick.used) {
      warning = `Decoding alone pointed to ${languageName(pick.used)}, but the text of the decodes points to ${languageName(ens.used)}, so Selects uses ${languageName(ens.used)}. Change it if this is wrong.`;
      used = ens.used;
      decided = "ensemble";
    }
    const res = { rule: LANGUAGE_RULE, setting, remembered, used, detected, compared, margin: pick.margin, best: pick.best, decided, warning, ensemble: ens, question: ens.question, textLid, model: path.basename(model), sec: +((Date.now() - t0) / 1000).toFixed(1) };
    writeJsonAtomic(cacheFile, res);
    return res;
  } finally {
    fs.rmSync(wav, { force: true });
  }
}
