// Language codes. whisper.cpp speaks ISO 639-1 (plus "haw" and "yue"); the olaverse text
// models speak ISO 639-3 with a script ("yor_Latn"). This maps one to the other.

/** Languages whisper can transcribe (whisper.cpp's list). */
export const WHISPER_LANGS = new Set(
  "en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue".split(" "),
);

// ISO 639-3 (as lid-lite-608 and lid-lite-5 label them) to whisper's codes. Macro-language
// varieties map to their whisper language (Egyptian, Moroccan and Levantine Arabic are "ar").
const ISO3 = {
  eng: "en", cmn: "zh", zho: "zh", deu: "de", spa: "es", rus: "ru", kor: "ko", fra: "fr", jpn: "ja", por: "pt", tur: "tr",
  pol: "pl", cat: "ca", nld: "nl", arb: "ar", ary: "ar", arz: "ar", apc: "ar", ars: "ar", acm: "ar", aeb: "ar", swe: "sv",
  ita: "it", ind: "id", hin: "hi", fin: "fi", vie: "vi", heb: "he", ukr: "uk", ell: "el", zsm: "ms", msa: "ms", ces: "cs",
  ron: "ro", dan: "da", hun: "hu", tam: "ta", nob: "no", nor: "no", tha: "th", urd: "ur", hrv: "hr", bul: "bg", lit: "lt",
  lat: "la", mri: "mi", mal: "ml", cym: "cy", slk: "sk", tel: "te", pes: "fa", fas: "fa", lvs: "lv", lav: "lv", ben: "bn",
  srp: "sr", azj: "az", azb: "az", slv: "sl", kan: "kn", ekk: "et", est: "et", mkd: "mk", bre: "br", eus: "eu", isl: "is",
  hye: "hy", npi: "ne", khk: "mn", bos: "bs", kaz: "kk", als: "sq", aln: "sq", swh: "sw", swc: "sw", glg: "gl", mar: "mr",
  pan: "pa", sin: "si", khm: "km", sna: "sn", yor: "yo", som: "so", afr: "af", oci: "oc", kat: "ka", bel: "be", tgk: "tg",
  snd: "sd", guj: "gu", amh: "am", ydd: "yi", lao: "lo", uzn: "uz", fao: "fo", hat: "ht", pbt: "ps", tuk: "tk", nno: "nn",
  mlt: "mt", san: "sa", ltz: "lb", mya: "my", bod: "bo", fil: "tl", tgl: "tl", plt: "mg", asm: "as", tat: "tt", haw: "haw",
  lin: "ln", hau: "ha", bak: "ba", jav: "jw", sun: "su", yue: "yue",
  // Not whisper languages, but they matter here. Nigerian Pidgin is written with English
  // spelling and transcribed as English; Igbo has no whisper model, so it is a verdict only.
  pcm: "en", ibo: "ig",
};

/** "yor_Latn" or "yor" -> "yo"; null for labels with no whisper equivalent (and the noise class). */
export function toWhisperCode(label) {
  const iso3 = String(label || "").replace(/^__label__/, "").split("_")[0];
  return ISO3[iso3] ?? null;
}

/** The ISO 639-3 part of a label ("pcm_Latn" -> "pcm"). */
export const iso3Of = (label) => String(label || "").replace(/^__label__/, "").split("_")[0];

/** Nigerian languages (ISO 639-3), for the accent cue. */
export const NIGERIAN = new Set(["yor", "hau", "ibo", "pcm"]);
/** The same, as whisper codes (Pidgin has none: it is transcribed as English). */
export const NIGERIAN_WHISPER = new Set(["yo", "ha", "ig"]);
