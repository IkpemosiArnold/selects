// The judge's runtimes. Each backend has the same shape:
//   { id, label, model, sigModel, where: "device" | "google", bytes, loaded, isCached(),
//     load({ onProgress }), run(task) -> { data?, text, stats } }
// sigModel is the configured model (the judgment signature's, signatures.mjs); loaded and
// isCached() let the engine use a private model as a fallback only when that needs no download.
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
import { PROMPTS } from "./prompts.js";
import { cachedFetch, downloadModelFile, isCached } from "./cache.js";
import { MODELS } from "./models.js";
import { runtimes } from "./devices.js";

export { PROMPTS };

const now = () => performance.now();
const secs = (t0) => +((performance.now() - t0) / 1000).toFixed(2);

// ------------------------------------------------------------- Gemma 3 1B, WebAssembly

/** About 120 tokens of plain text for the load-time benchmark. */
const BENCH_PROMPT = "Read this short passage and answer in one word, yes or no: is it about strength training? " + "Older adults can gain strength at any age, and regular training with heavier weights helps them keep their independence for longer. ".repeat(3);

const isWebKit = () => /AppleWebKit/.test(globalThis.navigator?.userAgent || "") && !/Chrome\/|Chromium\/|Edg\/|Android/.test(globalThis.navigator?.userAgent || "");

/** WebAssembly 64-bit memory, which wllama's default build needs (as wllama checks it). */
function memory64() {
  try {
    new WebAssembly.Memory({ address: "i64", initial: 1n });
    return true;
  } catch {
    return false;
  }
}

/** True when wllama's own cache (OPFS) already holds the whole Gemma 3 file. */
async function inWllamaCache() {
  try {
    const { CacheManager } = await import("@wllama/wllama");
    const cm = new CacheManager();
    return (await cm.getSize(await cm.getNameFromURL(MODELS.gemma3.url))) >= MODELS.gemma3.bytes;
  } catch {
    return false;
  }
}

export function wllamaBackend({ threads } = {}) {
  let w = null;
  return {
    id: "gemma3-wasm",
    label: "Gemma 3 1B on this device (CPU)",
    model: "gemma-3-1b-it-Q4_0",
    sigModel: "gemma-3-1b-it-Q4_0",
    where: "device",
    bytes: MODELS.gemma3.bytes,
    get loaded() {
      return !!w;
    },
    /** True when wllama's cache (from before) or the resumable download already holds the whole model file. */
    async isCached() {
      return (await inWllamaCache()) || (await isCached(MODELS.gemma3.url));
    },
    async load({ onProgress } = {}) {
      if (w) return;
      const [{ Wllama, LoggerWithoutDebug }, { default: wasmUrl }] = await Promise.all([import("@wllama/wllama"), import("@wllama/wllama/esm/wasm/wllama.wasm?url")]);
      w = new Wllama({ default: wasmUrl }, { logger: LoggerWithoutDebug, allowOffline: true });
      // Safari (no JSPI or memory64) needs wllama's compat build, which wllama would fetch from
      // cdn.jsdelivr.net; it is built into this site instead (the worker code as text, per its README)
      if (!WebAssembly.Suspending || !memory64()) {
        const [{ default: compatWasm }, { default: compatWorker }] = await Promise.all([import("@wllama/wllama-compat/wasm/wllama.wasm?url"), import("@wllama/wllama-compat/wasm/wllama.js?raw")]);
        w.setCompat({ wasm: compatWasm, worker: { code: compatWorker } });
      }
      const t0 = now();
      const params = {
        n_ctx: 2048,
        n_batch: 512,
        n_gpu_layers: 0, // the CPU path: WebGPU browsers use Gemma 4 through MediaPipe instead
        ...(threads ? { n_threads: threads } : {}),
        // WebKit on one thread, as for whisper (asr.worker.js): threads crashed the WebKit tab
        ...(!threads && isWebKit() ? { n_threads: 1 } : {}),
      };
      // a copy wllama saved before resumable downloads existed is used as it is; otherwise the
      // 722 MB file comes down in resumable pieces (download.js) and is handed to wllama whole
      const blob = (await inWllamaCache()) ? null : await downloadModelFile(MODELS.gemma3.url, { onProgress: ({ loaded, total, cached }) => onProgress?.({ loaded, total: total || MODELS.gemma3.bytes, cached }) });
      if (blob) {
        await w.loadModel([blob], params);
      } else {
        await w.loadModelFromUrl(MODELS.gemma3.url, { ...params, progressCallback: ({ loaded, total }) => onProgress?.({ loaded, total: total || MODELS.gemma3.bytes }) });
      }
      this.loadSec = secs(t0);
      this.threads = threads || null;
      this.multiThread = typeof w.isMultithread === "function" ? w.isMultithread() : self.crossOriginIsolated;
      // a short benchmark on this device, so the time the page states is measured, not guessed:
      // one small chat call, scaled to a judge call (about 500 prompt tokens and 60 out,
      // notes/timings.md); prompt tokens are cheaper than generated ones, so this errs long
      try {
        const b0 = now();
        const res = await w.createChatCompletion({ messages: [{ role: "user", content: BENCH_PROMPT }], max_tokens: 16, temperature: 0 });
        const tokens = (res.usage?.prompt_tokens || 120) + (res.usage?.completion_tokens || 16);
        this.secPerCall = +(((now() - b0) / 1000) * (560 / tokens)).toFixed(1);
        onProgress?.({ secPerCall: this.secPerCall });
      } catch {
        this.secPerCall = null;
      }
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

/** MediaPipe's WebAssembly, built into this site (never fetched from a CDN at run time). */
async function mediapipeFileset(FilesetResolver) {
  const simd = await FilesetResolver.isSimdSupported();
  const [loader, binary] = simd
    ? await Promise.all([import("@mediapipe/tasks-genai/genai_wasm_internal.js?url"), import("@mediapipe/tasks-genai/genai_wasm_internal.wasm?url")])
    : await Promise.all([import("@mediapipe/tasks-genai/genai_wasm_nosimd_internal.js?url"), import("@mediapipe/tasks-genai/genai_wasm_nosimd_internal.wasm?url")]);
  return { wasmLoaderPath: loader.default, wasmBinaryPath: binary.default };
}

export function mediapipeBackend({ wasmBase = null } = {}) {
  let llm = null;
  return {
    id: "gemma4-webgpu",
    label: "Gemma 4 E2B on this device (WebGPU)",
    model: "gemma-4-E2B-it",
    sigModel: "gemma-4-E2B-it",
    where: "device",
    bytes: MODELS.gemma4.bytes,
    get loaded() {
      return !!llm;
    },
    isCached: () => isCached(MODELS.gemma4.url),
    async load({ onProgress } = {}) {
      if (llm) return;
      const { FilesetResolver, LlmInference } = await import("@mediapipe/tasks-genai");
      const res = await cachedFetch(MODELS.gemma4.url, { onProgress, expectedBytes: MODELS.gemma4.bytes });
      const t0 = now();
      const fileset = wasmBase ? await FilesetResolver.forGenAiTasks(wasmBase) : await mediapipeFileset(FilesetResolver);
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

export function geminiKeyBackend({ key, model = "gemma-4-26b-a4b-it", timeoutMs = 25000, perMinute = 25 }) {
  let features = {};
  const pace = pacer(perMinute); // Google's free tier: about 30 requests a minute
  return {
    id: "gemini-key",
    label: `Gemma (${model}) through the Gemini API, your key`,
    model,
    sigModel: model,
    where: "google",
    bytes: 0,
    loaded: true,
    isCached: async () => true,
    async load() {},
    async run(task) {
      await pace();
      const { messages, schema, maxTokens } = buildTask(slimTask(task), PROMPTS);
      // Gemma 4 can spend output tokens on a thought before answering: leave headroom
      const r = await geminiGenerate({ key, model, messages, schema, maxTokens: Math.max(256, maxTokens * 3), temperature: 0.2, features, timeoutMs });
      features = r.features;
      return { data: null, text: r.text, stats: { wallSec: r.wallSec, promptTokens: r.promptTokens, outTokens: r.outTokens, finish: r.finish } };
    },
  };
}

/**
 * Space calls to at most `perMinute` starts in any minute. The proxy allows 20 model calls a
 * minute per visitor, and a long recording now sends 40 or more windows, so the page keeps
 * under that instead of hitting the limit and losing clips to it. sleep is replaceable in tests.
 */
export function pacer(perMinute, { now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const starts = [];
  let chain = Promise.resolve();
  return () => {
    chain = chain.then(async () => {
      for (;;) {
        const t = now();
        while (starts.length && t - starts[0] >= 60000) starts.shift();
        if (starts.length < perMinute) {
          starts.push(t);
          return;
        }
        await sleep(60000 - (t - starts[0]) + 50);
      }
    });
    return chain;
  };
}

/**
 * Smart mode through server-proxy. The proxy sleeps when idle on a free host, so load()
 * pings /healthz until it answers (up to `wakeSec`), calling onWaking(secondsSoFar).
 */
export function proxyBackend({ url, model = null, wakeSec = 90, callTimeoutMs = 60000, perMinute = 18, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const base = url.replace(/\/+$/, "");
  const pace = pacer(perMinute, { sleep });
  return {
    id: "gemini-proxy",
    label: "Gemma through the Gemini API, via the Selects proxy",
    model: model || "gemma (proxy default)",
    // the model the page asked for; the proxy's own default can change without a new judgment
    sigModel: model || "proxy-default",
    where: "google",
    bytes: 0,
    isCached: async () => true,
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
    async run(task, { retried = false } = {}) {
      await pace();
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
      // over the per-minute limit anyway (another tab, a retry): wait as asked, once
      if (r.status === 429 && !retried) {
        const wait = Math.min(60, Number(r.headers?.get?.("retry-after")) || 20);
        if (!/day/i.test(String(j.error || ""))) {
          await sleep(wait * 1000);
          return this.run(task, { retried: true });
        }
      }
      if (!r.ok) throw Object.assign(new Error(j.error || `Proxy ${r.status}`), { status: r.status, transient: !!j.transient, hint: j.hint || "Try again in a minute, or switch to Private mode." });
      return { data: null, text: j.text, stats: { wallSec: secs(t0), promptTokens: j.promptTokens ?? null, outTokens: j.outTokens ?? null, model: j.model } };
    },
  };
}

/**
 * The Private-mode backend for this browser: Gemma 4 E2B on WebGPU when an adapter exists
 * (and the device reports enough memory), otherwise Gemma 3 1B on the CPU. The rule is
 * chooseRuntimes in devices.js, which the download estimate uses too.
 */
export async function privateBackend({ prefer = "auto" } = {}) {
  const { judge } = await runtimes({ prefer });
  return judge === "gemma4-webgpu" ? mediapipeBackend() : wllamaBackend();
}
