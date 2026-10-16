// The judge's runtimes. Each backend has the same shape:
//   { id, label, model, where: "device" | "google", load({ onProgress }), run(task) -> { data?, text, stats } }
// where a task is { kind: "judge" | "listwise" | "kit", candidate | top } (src/core/tasks.mjs).
//
// Private mode (default, nothing leaves the device):
//   gemma4-webgpu  Gemma 4 E2B, MediaPipe LLM Inference on WebGPU (2.0 GB, Apache-2.0)
//   gemma3-wasm    Gemma 3 1B Q4_0, llama.cpp in WebAssembly via wllama (722 MB, Gemma terms)
// Smart mode (only the shortlist's transcript text goes to Google):
//   gemini-key     Gemma on the Gemini API with the user's own AI Studio key
//   gemini-proxy   the same through server-proxy (the project's key, rate limited)
import { geminiGenerate } from "../core/gemini.mjs";
import { buildTask, slimTask, withSchemaHint } from "../core/tasks.mjs";
import judgeMd from "../core/prompts/judge.md?raw";
import listwiseMd from "../core/prompts/listwise.md?raw";
import kitMd from "../core/prompts/kit.md?raw";
import { cachedFetch } from "./cache.js";
import { MODELS } from "./models.js";

export const PROMPTS = { judge: judgeMd, listwise: listwiseMd, kit: kitMd };

const now = () => performance.now();
const secs = (t0) => +((performance.now() - t0) / 1000).toFixed(2);

// ------------------------------------------------------------- Gemma 3 1B, WebAssembly

export function wllamaBackend({ threads } = {}) {
  let w = null;
  return {
    id: "gemma3-wasm",
    label: "Gemma 3 1B on this device (CPU)",
    model: "gemma-3-1b-it-Q4_0",
    where: "device",
    bytes: MODELS.gemma3.bytes,
    async load({ onProgress } = {}) {
      if (w) return;
      const [{ Wllama, LoggerWithoutDebug }, { default: wasmUrl }] = await Promise.all([import("@wllama/wllama"), import("@wllama/wllama/esm/wasm/wllama.wasm?url")]);
      w = new Wllama({ default: wasmUrl }, { logger: LoggerWithoutDebug, allowOffline: true });
      const t0 = now();
      await w.loadModelFromUrl(MODELS.gemma3.url, {
        n_ctx: 2048,
        n_batch: 512,
        n_gpu_layers: 0, // the CPU path: WebGPU browsers use Gemma 4 through MediaPipe instead
        ...(threads ? { n_threads: threads } : {}),
        progressCallback: ({ loaded, total }) => onProgress?.({ loaded, total: total || MODELS.gemma3.bytes }),
      });
      this.loadSec = secs(t0);
      this.threads = threads || null;
      this.multiThread = typeof w.isMultithread === "function" ? w.isMultithread() : self.crossOriginIsolated;
    },
    async run(task) {
      const { messages, schema, maxTokens } = buildTask(task, PROMPTS);
      const t0 = now();
      const res = await w.createChatCompletion({
        messages,
        max_tokens: maxTokens,
        temperature: 0.2,
        // the same JSON schema Ollama gets on the desktop, enforced by llama.cpp's grammar
        response_format: { type: "json_schema", json_schema: { name: task.kind, schema } },
      });
      const text = res.choices?.[0]?.message?.content ?? "";
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {}
      return { data, text, stats: { wallSec: secs(t0), promptTokens: res.usage?.prompt_tokens ?? null, outTokens: res.usage?.completion_tokens ?? null, finish: res.choices?.[0]?.finish_reason ?? null } };
    },
    async unload() {
      await w?.exit?.();
      w = null;
    },
  };
}

// ------------------------------------------------------------- Gemma 4 E2B, WebGPU

/** Gemma 4's chat format, as the LiteRT-LM web demo writes it. */
export function gemma4Prompt(messages) {
  return (
    messages.map((m) => `<|turn>${m.role === "assistant" ? "model" : m.role}\n${m.content}<turn|>\n`).join("") + "<|turn>model\n"
  );
}

export function mediapipeBackend({ wasmBase = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@0.10.29/wasm" } = {}) {
  let llm = null;
  return {
    id: "gemma4-webgpu",
    label: "Gemma 4 E2B on this device (WebGPU)",
    model: "gemma-4-E2B-it",
    where: "device",
    bytes: MODELS.gemma4.bytes,
    async load({ onProgress } = {}) {
      if (llm) return;
      const { FilesetResolver, LlmInference } = await import("@mediapipe/tasks-genai");
      const res = await cachedFetch(MODELS.gemma4.url, { onProgress, expectedBytes: MODELS.gemma4.bytes });
      const t0 = now();
      const fileset = await FilesetResolver.forGenAiTasks(wasmBase);
      llm = await LlmInference.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: res.body.getReader() },
        maxTokens: 2048, // input and output together
        topK: 1,
        temperature: 0.2,
        randomSeed: 1,
      });
      this.loadSec = secs(t0);
    },
    async run(task) {
      const { messages, schema } = buildTask(task, PROMPTS);
      const prompt = gemma4Prompt(withSchemaHint(messages, schema));
      const t0 = now();
      let partial = "";
      // MediaPipe has no output cap per call, so stop as soon as the JSON object closes
      const text = await new Promise((resolve, reject) => {
        let stopped = false;
        llm
          .generateResponse(prompt, (piece, done) => {
            partial += piece;
            if (!stopped && /\}\s*$/.test(partial) && balanced(partial)) {
              stopped = true;
              try {
                llm.cancelProcessing();
              } catch {}
              resolve(partial);
            }
            if (done && !stopped) resolve(partial);
          })
          .catch((e) => (stopped ? null : reject(e)));
      });
      return { data: null, text, stats: { wallSec: secs(t0), promptTokens: llm.sizeInTokens?.(prompt) ?? null } };
    },
    async unload() {
      llm?.close();
      llm = null;
    },
  };
}

function balanced(t) {
  const i = t.indexOf("{");
  if (i < 0) return false;
  let d = 0;
  let s = false;
  for (let k = i; k < t.length; k++) {
    const c = t[k];
    if (s) {
      if (c === "\\") k++;
      else if (c === '"') s = false;
    } else if (c === '"') s = true;
    else if (c === "{") d++;
    else if (c === "}") d--;
  }
  return d === 0;
}

// ------------------------------------------------------------- Smart mode: Gemini API

export function geminiKeyBackend({ key, model = "gemma-4-26b-a4b-it", timeoutMs = 25000 }) {
  let features = {};
  return {
    id: "gemini-key",
    label: `Gemma (${model}) through the Gemini API, your key`,
    model,
    where: "google",
    bytes: 0,
    async load() {},
    async run(task) {
      const { messages, schema, maxTokens } = buildTask(slimTask(task), PROMPTS);
      // Gemma 4 can spend output tokens on a thought before answering: leave headroom
      const r = await geminiGenerate({ key, model, messages, schema, maxTokens: Math.max(256, maxTokens * 3), temperature: 0.2, features, timeoutMs });
      features = r.features;
      return { data: null, text: r.text, stats: { wallSec: r.wallSec, promptTokens: r.promptTokens, outTokens: r.outTokens, finish: r.finish } };
    },
  };
}

/**
 * Smart mode through server-proxy. The proxy sleeps when idle on a free host, so load()
 * pings /healthz until it answers (up to `wakeSec`), calling onWaking(secondsSoFar).
 */
export function proxyBackend({ url, model = null, wakeSec = 90, callTimeoutMs = 60000 }) {
  const base = url.replace(/\/+$/, "");
  return {
    id: "gemini-proxy",
    label: "Gemma through the Gemini API, via the Selects proxy",
    model: model || "gemma (proxy default)",
    where: "google",
    bytes: 0,
    async load({ onWaking } = {}) {
      const t0 = now();
      for (;;) {
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 15000);
          const r = await fetch(`${base}/healthz`, { signal: ctl.signal, credentials: "omit" });
          clearTimeout(timer);
          if (r.ok) {
            const j = await r.json().catch(() => ({}));
            if (j.model) this.model = j.model;
            this.wakeSec = secs(t0);
            return;
          }
        } catch {}
        const waited = (now() - t0) / 1000;
        if (waited > wakeSec) throw Object.assign(new Error("The Smart mode server did not wake up."), { hint: "Try again in a minute, use your own Gemini API key, or switch to Private mode." });
        onWaking?.(Math.round(waited));
        await new Promise((r) => setTimeout(r, 3000));
      }
    },
    async run(task) {
      const t0 = now();
      // the proxy allows 25 s per Google call plus one retry; past that, give up and let
      // the judge fall back to the device for this clip
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), callTimeoutMs);
      let r;
      try {
        r = await fetch(`${base}/v1/task`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...slimTask(task), ...(model ? { model } : {}) }), credentials: "omit", signal: ctl.signal });
      } catch (e) {
        throw Object.assign(new Error(ctl.signal.aborted ? "The Smart mode server did not answer in time." : "Could not reach the Smart mode server."), { status: 0, transient: true });
      } finally {
        clearTimeout(timer);
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(j.error || `Proxy ${r.status}`), { status: r.status, transient: !!j.transient, hint: j.hint || "Try again in a minute, or switch to Private mode." });
      return { data: null, text: j.text, stats: { wallSec: secs(t0), promptTokens: j.promptTokens ?? null, outTokens: j.outTokens ?? null, model: j.model } };
    },
  };
}

/**
 * The Private-mode backend for this browser: Gemma 4 E2B on WebGPU when an adapter exists
 * (and the device reports enough memory), otherwise Gemma 3 1B on the CPU.
 */
export async function privateBackend({ prefer = "auto" } = {}) {
  if (prefer === "gemma3-wasm") return wllamaBackend();
  if (prefer === "gemma4-webgpu") return mediapipeBackend();
  let gpu = false;
  try {
    gpu = !!(navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {}
  const memOk = !navigator.deviceMemory || navigator.deviceMemory >= 4;
  return gpu && memOk ? mediapipeBackend() : wllamaBackend();
}
