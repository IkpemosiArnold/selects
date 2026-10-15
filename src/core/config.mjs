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
export const PROMPTS_DIR = path.join(REPO, "src/core/prompts");

export const DEFAULT_SETTINGS = {
  model: null, // resolved at run time by resolveModel()
  k: 5,
  minLen: 20,
  maxLen: 60,
  preset: "shorts",
  judgeN: 8, // how many pre-scored windows the LLM judge reads (the slow step on a CPU)
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
