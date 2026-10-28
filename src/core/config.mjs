// Paths, binaries and defaults: one config(), resolved in this order for every value:
//   1. an environment variable (SELECTS_*),
//   2. the user's config file (<data dir>/config.json, or the file SELECTS_CONFIG names),
//   3. a per-user default (models in <data dir>/models) or, for programs, the PATH.
// The data dir is ~/.selects (%LOCALAPPDATA%\selects on Windows). Nothing here depends on
// where the repo or the npm package lives, except the old <repo>/.selects job folder, which
// is still used when it exists (with a one-line note) so older installs keep their jobs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The per-user folder for config, models and (by default) jobs. */
export function userDataDir() {
  if (process.env.SELECTS_DATA_DIR) return expandHome(process.env.SELECTS_DATA_DIR);
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "selects");
  return path.join(os.homedir(), ".selects");
}

const expandHome = (p) => (typeof p === "string" ? p.replace(/^~(?=$|[\\/])/, os.homedir()) : p);

export const configFile = () => expandHome(process.env.SELECTS_CONFIG) || path.join(userDataDir(), "config.json");

let fileCache = { file: null, mtime: 0, data: {} };
function readConfigFile() {
  const file = configFile();
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return {};
  }
  if (fileCache.file === file && fileCache.mtime === st.mtimeMs) return fileCache.data;
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
  } catch {
    process.stderr.write(`Selects: ignoring ${file}: it is not a JSON object.\n`);
  }
  fileCache = { file, mtime: st.mtimeMs, data };
  return data;
}

/** An executable on the PATH, as an absolute path, or null. Cached per PATH. */
const onPath = new Map();
export function findOnPath(name) {
  const key = `${name}\0${process.env.PATH || ""}`;
  if (!onPath.has(key)) onPath.set(key, searchPath(name));
  return onPath.get(key);
}
function searchPath(name) {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const f = path.join(dir, name + ext);
      try {
        fs.accessSync(f, fs.constants.X_OK);
        if (fs.statSync(f).isFile()) return f;
      } catch {}
    }
  }
  return null;
}

let legacyNoted = false;
function defaultHome() {
  const legacy = path.join(REPO, ".selects");
  if (fs.existsSync(legacy)) {
    if (!legacyNoted) {
      legacyNoted = true;
      process.stderr.write(`Selects: using the old job folder ${legacy}. Move it to ${userDataDir()} (or set SELECTS_HOME) to keep jobs outside the install.\n`);
    }
    return legacy;
  }
  return userDataDir();
}

/**
 * The resolved configuration, frozen. Read fresh on each call (env and the config file can
 * change between tests), so callers should not cache it across jobs.
 * Config file keys are the same names as below, for example
 *   { "whisperBin": "/opt/whisper.cpp/build/bin/whisper-cli", "modelsDir": "~/models/whisper" }
 */
export function config() {
  const env = process.env;
  const file = readConfigFile();
  const pick = (envKey, fileKey) => (env[envKey] != null && env[envKey] !== "" ? env[envKey] : file[fileKey] ?? null);
  const pickPath = (envKey, fileKey) => expandHome(pick(envKey, fileKey));
  const explicitModel = pickPath("SELECTS_WHISPER_MODEL", "whisperModel");
  const modelsDir = pickPath("SELECTS_MODELS_DIR", "modelsDir") || (explicitModel ? path.dirname(explicitModel) : path.join(userDataDir(), "models"));
  const prog = (envKey, fileKey, name) => pickPath(envKey, fileKey) || findOnPath(name) || name;
  return Object.freeze({
    configFile: configFile(),
    dataDir: userDataDir(),
    home: pickPath("SELECTS_HOME", "home") || defaultHome(),
    modelsDir,
    whisperModel: explicitModel || path.join(modelsDir, "ggml-base.en.bin"),
    whisperBin: prog("SELECTS_WHISPER_BIN", "whisperBin", "whisper-cli"),
    ffmpeg: prog("SELECTS_FFMPEG", "ffmpeg", "ffmpeg"),
    ffprobe: prog("SELECTS_FFPROBE", "ffprobe", "ffprobe"),
    langidDir: pickPath("SELECTS_LANGID_DIR", "langidDir") || path.join(modelsDir, "langid"),
    accentModelNg: pickPath("SELECTS_ACCENT_MODEL_NG", "accentModelNg") || path.join(modelsDir, "ggml-small-nigerian-accent.bin"),
    punctDir: pickPath("SELECTS_PUNCT_DIR", "punctDir") || path.join(modelsDir, "punct", "sherpa-onnx-online-punct-en-2024-08-06"),
    facesBin: pickPath("SELECTS_FACES_BIN", "facesBin") || path.join(REPO, "tools/faces/faces"),
    ollamaUrl: String(pick("SELECTS_OLLAMA_URL", "ollamaUrl") || "http://127.0.0.1:11434").replace(/\/$/, ""),
    model: pick("SELECTS_MODEL", "model"),
    // tuning knobs (null means the module's own default)
    threads: pick("SELECTS_THREADS", "threads"),
    whisperThreads: pick("SELECTS_WHISPER_THREADS", "whisperThreads"),
    whisperArgs: pick("SELECTS_WHISPER_ARGS", "whisperArgs"),
    chunkSec: pick("SELECTS_CHUNK_SEC", "chunkSec"),
    hwaccel: String(pick("SELECTS_HWACCEL", "hwaccel") ?? "") !== "0",
    gpuScale: String(pick("SELECTS_GPU_SCALE", "gpuScale") ?? "") !== "0",
    reuse: String(pick("SELECTS_REUSE", "reuse") ?? "") !== "0",
  });
}

export const whisperBin = () => config().whisperBin;
export const whisperModel = () => config().whisperModel;

/** The folder whisper models live in (SELECTS_MODELS_DIR, else <data dir>/models). */
export const modelsDir = () => config().modelsDir;

/** Text language-ID models (lid-lite-608, lid-lite-5): SELECTS_LANGID_DIR, else <models>/langid. */
export const langidDir = () => config().langidDir;

/**
 * Accent fine-tunes of whisper for English, by accent. "ng": Nigerian-accented English
 * (rishabbahal/whisper-small-nigerian-accent, converted to ggml). SELECTS_ACCENT_MODEL_NG
 * overrides the path.
 */
export function accentModel(accent) {
  if (accent === "ng") return config().accentModelNg;
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
    if (requested.includes("/") || requested.endsWith(".bin")) return path.resolve(expandHome(requested));
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

export const ollamaUrl = () => config().ollamaUrl;

/** Where jobs, queue and caches live: SELECTS_HOME, else <data dir> (or an existing <repo>/.selects). */
export const selectsHome = () => config().home;

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
  h2h: false, // the head-to-head round in place of it: the top 8 compared two at a time, about 12 calls (h2h-core.mjs)
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
  if (config().model) return config().model;
  const names = (await ollamaModels()).map((m) => m.name);
  if (names.includes("gemma3:4b")) return "gemma3:4b";
  const g = names.filter((n) => n.startsWith("gemma3")).sort((a, b) => (/4b/.test(b) ? 1 : 0) - (/4b/.test(a) ? 1 : 0));
  return g[0] || "gemma3:4b";
}
