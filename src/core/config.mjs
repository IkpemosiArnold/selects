// Paths, binaries and defaults. Every value can be overridden with an env var.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const PIPELINE = "/Users/mac/Documents/DevProjects/road-to-50k/crew/video-weekend/pipeline";

export function whisperBin() {
  if (process.env.SELECTS_WHISPER_BIN) return process.env.SELECTS_WHISPER_BIN;
  const local = path.join(PIPELINE, "vendor/whisper.cpp/build/bin/whisper-cli");
  return fs.existsSync(local) ? local : "whisper-cli";
}

export function whisperModel() {
  return process.env.SELECTS_WHISPER_MODEL || path.join(PIPELINE, "models/ggml-base.en.bin");
}

/** The folder whisper models live in (SELECTS_MODELS_DIR, else the default model's folder). */
export function modelsDir() {
  return process.env.SELECTS_MODELS_DIR || path.dirname(whisperModel());
}

/** Text language-ID models (lid-lite-608, lid-lite-5): SELECTS_LANGID_DIR, else <models>/langid. */
export function langidDir() {
  return process.env.SELECTS_LANGID_DIR || path.join(modelsDir(), "langid");
}

/**
 * Accent fine-tunes of whisper for English, by accent. "ng": Nigerian-accented English
 * (rishabbahal/whisper-small-nigerian-accent, converted to ggml). SELECTS_ACCENT_MODEL_NG
 * overrides the path.
 */
export function accentModel(accent) {
  if (accent === "ng") return process.env.SELECTS_ACCENT_MODEL_NG || path.join(modelsDir(), "ggml-small-nigerian-accent.bin");
  return null;
}

// Multilingual models in order of preference when the language is not English. medium is
// left out of "auto" on purpose: on a dual-core CPU it is far slower than real time.
const MULTILINGUAL_AUTO = ["small", "small-q5_1", "base"];

/** Installed ggml whisper models: [{ name, path, sizeMb, english }]. */
export function asrModels() {
  const dir = modelsDir();
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {}
  return files
    .filter((f) => /^ggml-.+\.bin$/.test(f) && !/silero|vad/.test(f))
    .map((f) => {
      const name = f.replace(/^ggml-/, "").replace(/\.bin$/, "");
      return { name, path: path.join(dir, f), sizeMb: Math.round(fs.statSync(path.join(dir, f)).size / 1e6), english: /\.en(-q\d_\d)?$/.test(name) };
    });
}

/**
 * Pick the whisper model file. requested: "auto", a name ("small.en", "base") or a path.
 * Auto: base.en (or SELECTS_WHISPER_MODEL) for English, else the best installed multilingual model.
 */
export function resolveAsrModel(requested = "auto", language = "en") {
  if (requested && requested !== "auto") {
    if (requested.includes("/") || requested.endsWith(".bin")) return path.resolve(requested.replace(/^~(?=\/)/, process.env.HOME || ""));
    return path.join(modelsDir(), `ggml-${requested}.bin`);
  }
  if (language === "en") return whisperModel();
  const have = new Map(asrModels().map((m) => [m.name, m.path]));
  for (const n of MULTILINGUAL_AUTO) if (have.has(n)) return have.get(n);
  return path.join(modelsDir(), "ggml-base.bin");
}

/** A multilingual model for language checks (cheap: base if present). null if none is installed. */
export function languageCheckModel() {
  const have = new Map(asrModels().map((m) => [m.name, m.path]));
  return have.get("base") || have.get("small") || have.get("tiny") || [...have.entries()].find(([n]) => !/\.en/.test(n))?.[1] || null;
}

export function ollamaUrl() {
  return (process.env.SELECTS_OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
}

export function selectsHome() {
  return process.env.SELECTS_HOME || path.join(REPO, ".selects");
}

export function jobsDir() {
  return path.join(selectsHome(), "jobs");
}

export const FONT_PATH = path.join(REPO, "src/core/assets/AtkinsonHyperlegibleNext-Bold.ttf");
// Atkinson Hyperlegible Next has no dot-below vowels (Yoruba ẹ ọ ṣ) or U+0323; Noto Sans covers them
export const FONT_FALLBACK_PATH = path.join(REPO, "src/core/assets/NotoSans-Bold.ttf");
export const PROMPTS_DIR = path.join(REPO, "src/core/prompts");

export const DEFAULT_SETTINGS = {
  model: null, // resolved at run time by resolveModel()
  k: 5,
  minLen: 20,
  maxLen: 60,
  preset: "shorts",
  madeFor: "shorts", // where the clips go: "shorts" (Shorts, Reels or TikTok), "linkedin", "x" or "story"; sets the length range, the caption style and the kit's format
  judgeN: null, // how many pre-scored windows the LLM judge reads (the slow step on a CPU); null = auto, scaled with k and the length and capped by a time budget (judgeCount in select.mjs)
  listwise: true, // a final side-by-side round on the best few clips (one extra model call)
  faithful: "model", // check each top pick still says what the speaker meant: "model" (one call per pick), "rules" (no model) or "off"
  credit: null, // who to credit in each posting kit, for example "Jenni, EMF 2026"
  license: null, // the source's licence id, for example "CC-BY-SA-4.0"
  sourceUrl: null, // where the source video lives
  mode: "clips", // "clips" or "caption" (caption the whole video, no clipping)
  language: "en", // never trust whisper's auto-detect for accented English; "auto" runs decode-and-compare
  asrModel: "auto", // base.en for English, the best installed multilingual model otherwise
  asrPrompt: null, // a short neutral context for whisper (--prompt)
  asrPreprocess: "none", // "none" or "clean" (highpass, lowpass, loudness) before whisper
  punctuate: true, // restore full stops and casing with a punctuation model when whisper left them out (English)
  accent: "auto", // "auto" (route accented English to a fine-tune when the language check finds cues), "ng" (Nigerian English), "none"
  captions: true, // burn captions into rendered clips
  captionLang: "source", // "source"; "en" and "both" are planned
  captionStyle: "auto", // "bold", "subtitle", or auto (bold for portrait and clips, subtitle for landscape caption mode)
  blur: null, // { faces: { mode, tracks }, regions: [...] } for caption mode
};

/** List local Ollama models. Returns [] if Ollama is not reachable. */
export async function ollamaModels({ timeoutMs = 3000 } = {}) {
  try {
    const r = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.models || []).map((m) => ({ name: m.name, sizeGb: +(m.size / 1e9).toFixed(2) }));
  } catch {
    return [];
  }
}

/** Pick the judge model: SELECTS_MODEL, else gemma3:4b, else the first gemma3* tag present. */
export async function resolveModel(requested) {
  if (requested) return requested;
  if (process.env.SELECTS_MODEL) return process.env.SELECTS_MODEL;
  const names = (await ollamaModels()).map((m) => m.name);
  if (names.includes("gemma3:4b")) return "gemma3:4b";
  const g = names.filter((n) => n.startsWith("gemma3")).sort((a, b) => (/4b/.test(b) ? 1 : 0) - (/4b/.test(a) ? 1 : 0));
  return g[0] || "gemma3:4b";
}
