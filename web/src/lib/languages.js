// Spoken languages offered in the brief and in the one-click override. Codes
// are ISO 639-1, as whisper takes them. The first few are the ones this
// project's users speak most; the rest follow alphabetically.
export const LANGUAGES = [
  ["en", "English"],
  ["yo", "Yoruba"],
  ["ig", "Igbo"],
  ["ha", "Hausa"],
  ["fr", "French"],
  ["af", "Afrikaans"],
  ["am", "Amharic"],
  ["ar", "Arabic"],
  ["bn", "Bengali"],
  ["zh", "Chinese"],
  ["da", "Danish"],
  ["nl", "Dutch"],
  ["fi", "Finnish"],
  ["de", "German"],
  ["el", "Greek"],
  ["he", "Hebrew"],
  ["hi", "Hindi"],
  ["id", "Indonesian"],
  ["ga", "Irish"],
  ["it", "Italian"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["ln", "Lingala"],
  ["no", "Norwegian"],
  ["fa", "Persian"],
  ["pl", "Polish"],
  ["pt", "Portuguese"],
  ["ru", "Russian"],
  ["sn", "Shona"],
  ["so", "Somali"],
  ["es", "Spanish"],
  ["sw", "Swahili"],
  ["sv", "Swedish"],
  ["th", "Thai"],
  ["tr", "Turkish"],
  ["uk", "Ukrainian"],
  ["ur", "Urdu"],
  ["vi", "Vietnamese"],
  ["cy", "Welsh"],
  ["zu", "Zulu"],
];

const NAMES = Object.fromEntries(LANGUAGES);

export function languageName(code) {
  if (!code) return "unknown";
  if (code === "auto") return "Detect automatically";
  if (NAMES[code]) return NAMES[code];
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code;
  } catch {
    return code;
  }
}

// Speech models the core knows by name. "auto" lets the core pick: base.en
// for English, the best multilingual model it has otherwise.
export const ASR_MODELS = [
  ["auto", "Let Selects choose"],
  ["base.en", "base.en: fast, English only"],
  ["small.en", "small.en: slower, better with accents"],
  ["medium.en-q5_0", "medium.en: slowest, most accurate English"],
  ["small-nigerian-accent", "small-nigerian-accent: tuned for Nigerian English"],
  ["base", "base: any language, fast"],
  ["small", "small: any language, better"],
];

export const pct = (x) => (x == null || !Number.isFinite(x) ? "?" : `${Math.round(x * 100)}%`);
