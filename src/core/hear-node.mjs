// The hearing judge on the desktop: listeners that score 30 s stretches of a recording's
// audio, on this computer only (the audio never leaves it). Two listeners:
//
//   gemma3n  Gemma 3n E2B (Google, Gemma terms), which takes audio input, through
//            transformers.js 3.8 and onnxruntime-node 1.21 on the CPU. About 4.6 GB on disk
//            (audio encoder q4, decoder q4, embeddings q8). Opt-in: slow on a laptop CPU.
//   cues     no language model: laughter (YAMNet frames from sound.json), how much two voices
//            overlap (pyannote segmentation 3.0, 1.5 MB int8, MIT) and how much the loudness
//            moves, each as a percentile within the recording (hear-core.mjs cueScores).
//
// onnxruntime-node aborts a process that calls process.exit() while it is loaded (the CLI
// exits that way), so both listeners run in a child Node process, like the sound model
// (sound-node.mjs). Results are cached per job in hear-<listener>.json, by stretch.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "./config.mjs";
import { HEAR_PROMPT, cueScores, scoreFromDigitLogits } from "./hear-core.mjs";
import { readJson, sha1, writeJsonAtomic } from "./util.mjs";

const RATE = 16000;

/** Gemma 3n E2B in ONNX, pinned to the revision transformers.js 3.x reads (26 Jun 2025). */
export const GEMMA3N = {
  id: "onnx-community/gemma-3n-E2B-it-ONNX",
  revision: "3f5a07f6dce5be35a9d61481c9995a35801b7b5d",
  licence: "Gemma terms of use (https://ai.google.dev/gemma/terms)",
  files: [
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "processor_config.json",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "chat_template.jinja",
    "onnx/audio_encoder_q4.onnx",
    "onnx/decoder_model_merged_q4.onnx",
    "onnx/embed_tokens_quantized.onnx",
    "onnx/embed_tokens_quantized.onnx_data",
    "onnx/embed_tokens_quantized.onnx_data_1",
  ],
  sessions: { embed_tokens: "embed_tokens_quantized.onnx", audio_encoder: "audio_encoder_q4.onnx", decoder_model_merged: "decoder_model_merged_q4.onnx" },
  approxBytes: 4.65e9,
};

/** pyannote segmentation 3.0 (int8), the same file the speaker check uses. */
export const SEGMENTATION = { dir: "sherpa-onnx-pyannote-segmentation-3-0", file: "model.int8.onnx", sec: 10 };

/** Where Gemma 3n lives: SELECTS_HEAR_MODEL, or ~/.selects/models/gemma-3n-E2B-it-ONNX. */
export function gemma3nDir() {
  return process.env.SELECTS_HEAR_MODEL || path.join(config().home ?? path.join(process.env.HOME || ".", ".selects"), "models", "gemma-3n-E2B-it-ONNX");
}

/** Where the segmentation model lives (SELECTS_SEGMENTATION overrides). */
export function segmentationPath() {
  if (process.env.SELECTS_SEGMENTATION) return process.env.SELECTS_SEGMENTATION;
  const home = config().home ?? path.join(process.env.HOME || ".", ".selects");
  return path.join(home, "models", "diarize", SEGMENTATION.dir, SEGMENTATION.file);
}

/** True when every Gemma 3n file is on disk. */
export function gemma3nReady(dir = gemma3nDir()) {
  return GEMMA3N.files.every((f) => fs.existsSync(path.join(dir, f)));
}

/** The transformers.js entry (an optional dependency, or SELECTS_TRANSFORMERS for a copy elsewhere), or null. */
export function transformersEntry() {
  if (process.env.SELECTS_TRANSFORMERS) return process.env.SELECTS_TRANSFORMERS;
  try {
    return createRequire(import.meta.url).resolve("@huggingface/transformers");
  } catch {
    return null;
  }
}

/** What a listener needs and whether it is here: { ok, why }. */
export function listenerStatus(listener) {
  if (listener === "gemma3n") {
    if (!transformersEntry()) return { ok: false, why: "transformers.js is not installed (npm install @huggingface/transformers@3.8.1)" };
    if (!gemma3nReady()) return { ok: false, why: `Gemma 3n is not downloaded (about 4.6 GB, into ${gemma3nDir()})` };
    return { ok: true, why: null };
  }
  if (listener === "cues") {
    if (!fs.existsSync(segmentationPath())) return { ok: false, why: "the speaker segmentation model is missing" };
    return { ok: true, why: null };
  }
  return { ok: false, why: `unknown listener ${listener}` };
}

/** 16 kHz mono float samples of [s, e] of `source`, decoded by ffmpeg. */
export function decodeRange(source, s, e) {
  return new Promise((resolve, reject) => {
    const ff = spawn(config().ffmpeg || "ffmpeg", ["-v", "error", "-ss", String(Math.max(0, s)), "-t", String(Math.max(0.1, e - s)), "-i", source, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let err = "";
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.stderr.on("data", (d) => (err += d));
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not read the audio: ${err.slice(0, 200)}`));
      const b = Buffer.concat(chunks);
      const n = Math.floor(b.length / 4);
      resolve(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + n * 4)));
    });
  });
}

/** Loudness spread of a stretch: the standard deviation of 0.5 s dB levels over the speech in it. */
export function loudSpread(pcm, rate = RATE) {
  const n = Math.round(0.5 * rate);
  const db = [];
  for (let i = 0; i + n <= pcm.length; i += n) {
    let s = 0;
    for (let k = i; k < i + n; k++) s += pcm[k] * pcm[k];
    const d = 10 * Math.log10(s / n + 1e-10);
    if (d > -50) db.push(d);
  }
  if (db.length < 4) return null;
  const m = db.reduce((a, b) => a + b, 0) / db.length;
  return +Math.sqrt(db.reduce((a, b) => a + (b - m) ** 2, 0) / db.length).toFixed(3);
}

/** The best YAMNet laughter frame inside [s, e] (frames from sound.json), or null without frames. */
export function laughIn(frames, s, e) {
  const xs = frames?.laughter;
  if (!xs?.length) return null;
  const hop = frames.hop || 0.48;
  let best = 0;
  for (let i = Math.max(0, Math.floor(s / hop)); i < Math.min(xs.length, Math.ceil(e / hop)); i++) best = Math.max(best, xs[i]);
  return +best.toFixed(4);
}

// ------------------------------------------------------------------ the parent side

/** The cache key of one stretch for a listener: changes when the prompt or the model changes. */
export function stretchKey(listener, g) {
  const ver = listener === "gemma3n" ? sha1(`${GEMMA3N.revision}|${HEAR_PROMPT}`).slice(0, 10) : "cues1";
  return `${listener}|${ver}|${g.s}|${g.e}`;
}

/**
 * Score `stretches` ([{ s, e }]) of `source` with a listener, using and filling the cache file
 * (hear-<listener>.json in `dir`). Returns [{ s, e, score, ...features }] in the input order.
 * For "cues", `soundFrames` (sound.json's frames) give the laughter feature; scores are
 * percentiles within the stretches scored together.
 * onProgress({ done, total, secPer }).
 */
export async function hearStretches(dir, source, stretches, { listener = "gemma3n", soundFrames = null, onProgress, signal, threads = null } = {}) {
  const st = listenerStatus(listener);
  if (!st.ok) throw Object.assign(new Error(`The hearing judge cannot run: ${st.why}.`), { why: st.why });
  const file = path.join(dir, `hear-${listener}.json`);
  const cache = readJson(file, {});
  const todo = stretches.filter((g) => !cache[stretchKey(listener, g)]);
  if (todo.length) {
    const tasks = path.join(dir, `hear-${listener}.tasks.json`);
    writeJsonAtomic(tasks, { source, listener, stretches: todo.map((g) => ({ s: g.s, e: g.e })), threads });
    let done = 0;
    const times = [];
    await runChild(tasks, {
      signal,
      onLine: (m) => {
        if (m.s == null) return;
        const g = { s: m.s, e: m.e };
        cache[stretchKey(listener, g)] = { ...m };
        writeJsonAtomic(file, cache);
        done++;
        if (m.sec) times.push(m.sec);
        onProgress?.({ done, total: todo.length, secPer: times.length ? +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1) : null });
      },
    });
    fs.rmSync(tasks, { force: true });
  }
  const rows = stretches.map((g) => ({ ...cache[stretchKey(listener, g)], s: g.s, e: g.e }));
  if (listener === "cues") {
    const feats = rows.map((r) => ({ ...r, laugh: laughIn(soundFrames, r.s, r.e) }));
    const sc = cueScores(feats);
    return feats.map((r, i) => ({ ...r, score: sc[i].score }));
  }
  return rows;
}

function runChild(tasksFile, { signal, onLine }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--hear-child", tasksFile], { stdio: ["ignore", "pipe", "pipe"] });
    const stop = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", stop, { once: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
      let i;
      while ((i = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        try {
          onLine(JSON.parse(line));
        } catch {}
      }
    });
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) return reject(Object.assign(new Error("Stopped before it finished."), { name: "AbortError" }));
      if (code === 0) return resolve();
      reject(new Error(`the hearing judge stopped (${code}): ${err.slice(-300)}`));
    });
  });
}

// ------------------------------------------------------------------ the child side

/** onnxruntime-node as transformers.js loads it (the same module instance, so tensors match). */
function ortFrom(entry) {
  const req = createRequire(entry);
  return req("onnxruntime-node");
}

/**
 * Gemma 3n as a listener. The sessions are built here rather than by from_pretrained, so the
 * vision encoder (not needed to listen) is never loaded or downloaded.
 */
export async function loadGemma3n({ dir = gemma3nDir(), threads = null } = {}) {
  const entry = transformersEntry();
  const T = await import(pathToFileURL(entry).href);
  const ort = ortFrom(entry);
  T.env.allowRemoteModels = false;
  T.env.localModelPath = path.dirname(dir);
  const name = path.basename(dir);
  const opts = { executionProviders: ["cpu"], graphOptimizationLevel: "all", ...(threads ? { intraOpNumThreads: threads, interOpNumThreads: 1 } : {}) };
  const sessions = {};
  for (const [k, f] of Object.entries(GEMMA3N.sessions)) sessions[k] = await ort.InferenceSession.create(path.join(dir, "onnx", f), opts);
  const cfg = await T.AutoConfig.from_pretrained(name);
  const genCfg = new T.GenerationConfig(readJson(path.join(dir, "generation_config.json"), {}));
  const model = new T.Gemma3nForConditionalGeneration(cfg, sessions, { generation_config: genCfg });
  const processor = await T.AutoProcessor.from_pretrained(name);
  const digitIds = {};
  for (const d of "123456789") {
    const ids = processor.tokenizer.encode(d, { add_special_tokens: false });
    if (ids.length === 1) digitIds[d] = ids[0];
  }
  const prompt = processor.apply_chat_template([{ role: "user", content: [{ type: "audio" }, { type: "text", text: HEAR_PROMPT }] }], { add_generation_prompt: true });
  return {
    async score(pcm) {
      const inputs = await processor(prompt, null, pcm);
      const out = await model.forward(inputs);
      const logits = out.logits;
      const [, seq, vocab] = logits.dims;
      const base = (seq - 1) * vocab;
      const data = logits.data;
      const dl = Object.fromEntries(Object.entries(digitIds).map(([d, id]) => [d, Number(data[base + id])]));
      // the model's own first choice, to show it answers with a digit at all
      let top = 0;
      for (let v = 1; v < vocab; v++) if (data[base + v] > data[base + top]) top = v;
      return { score: scoreFromDigitLogits(dl), top: processor.tokenizer.decode([top]), logits: dl, tokens: seq };
    },
  };
}

/** Overlapped speech: the mean probability, over the stretch, that two or more voices speak at once. */
async function overlapScorer() {
  const ort = createRequire(import.meta.url)("onnxruntime-node");
  const session = await ort.InferenceSession.create(segmentationPath(), { intraOpNumThreads: 1, interOpNumThreads: 1 });
  const n = SEGMENTATION.sec * RATE;
  return async (pcm) => {
    let sum = 0;
    let frames = 0;
    for (let i = 0; i < pcm.length; i += n) {
      const x = new Float32Array(n);
      x.set(pcm.subarray(i, Math.min(pcm.length, i + n)));
      const used = Math.min(1, (pcm.length - i) / n);
      const o = await session.run({ x: new ort.Tensor("float32", x, [1, 1, n]) });
      const y = o.y;
      const [, F, C] = y.dims;
      const keep = Math.floor(F * used);
      for (let f = 0; f < keep; f++) {
        let p = 0;
        for (let c = 4; c < C; c++) p += Math.exp(y.data[f * C + c]); // powerset classes {1,2}, {1,3}, {2,3}
        sum += p;
        frames++;
      }
    }
    return frames ? +(sum / frames).toFixed(4) : null;
  };
}

async function childMain(tasksFile) {
  const t = readJson(tasksFile);
  const say = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  if (t.listener === "gemma3n") {
    const t0 = Date.now();
    const g = await loadGemma3n({ threads: t.threads });
    say({ loaded: true, sec: +((Date.now() - t0) / 1000).toFixed(1) });
    for (const st of t.stretches) {
      const t1 = Date.now();
      const pcm = await decodeRange(t.source, st.s, st.e);
      const r = await g.score(pcm);
      say({ s: st.s, e: st.e, score: r.score, top: r.top, logits: r.logits, tokens: r.tokens, sec: +((Date.now() - t1) / 1000).toFixed(2) });
    }
  } else if (t.listener === "cues") {
    const ov = await overlapScorer();
    for (const st of t.stretches) {
      const t1 = Date.now();
      const pcm = await decodeRange(t.source, st.s, st.e);
      say({ s: st.s, e: st.e, overlap: await ov(pcm), loudSpread: loudSpread(pcm), sec: +((Date.now() - t1) / 1000).toFixed(2) });
    }
  }
}

if (process.argv[2] === "--hear-child" && fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) {
  childMain(process.argv[3]).catch((e) => {
    process.stderr.write(String(e?.stack || e));
    process.exitCode = 1;
  });
}
