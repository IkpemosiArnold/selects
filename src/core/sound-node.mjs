// Sound events for the desktop app: YAMNet through onnxruntime-node over the recording's own
// audio (decoded by ffmpeg, a minute at a time), or the signal-processing laughter detector
// when the model or the runtime is missing. Saved per job as sound.json; a resumed job reads
// it back. Nothing here uses the network except the one-time model download (16 MB), which
// goes through the same resumable downloader as the browser build (src/browser/download.js),
// with a store on disk, and is checked against its size and SHA-256.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { config } from "./config.mjs";
import { addFrames, chunkSamples, CHUNK_SEC, eventsFromFrames, FRAMES_PER_CHUNK, framesToKeep, laughterHeuristic, soundRecord, YAMNET } from "./sound.mjs";
import { readJson, writeJsonAtomic } from "./util.mjs";

/** Where the model lives: <models>/yamnet/yamnet.onnx (SELECTS_YAMNET overrides). */
export function yamnetPath() {
  return process.env.SELECTS_YAMNET || path.join(config().modelsDir, "yamnet", YAMNET.file);
}

/** Whether onnxruntime-node is installed (without loading it into this process). */
export function ortInstalled() {
  try {
    createRequire(import.meta.url).resolve("onnxruntime-node");
    return true;
  } catch {
    return false;
  }
}

/** onnxruntime-node, or null when it is not installed or has no build for this machine. Loaded only in the child. */
export function loadOrt() {
  try {
    return createRequire(import.meta.url)("onnxruntime-node");
  } catch {
    return null;
  }
}

/** A download store on disk for resumableDownload: <dir>/<name>.part plus <name>.meta.json. */
export function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const name = (k) => path.join(dir, path.basename(new URL(k).pathname));
  return {
    kind: "file",
    async info(k) {
      const f = `${name(k)}.part`;
      return { bytes: fs.existsSync(f) ? fs.statSync(f).size : 0, meta: readJson(`${name(k)}.meta.json`, null) };
    },
    async append(k, bytes) {
      fs.appendFileSync(`${name(k)}.part`, bytes);
    },
    async setMeta(k, meta) {
      writeJsonAtomic(`${name(k)}.meta.json`, meta);
    },
    async blob(k) {
      return new Blob([fs.readFileSync(`${name(k)}.part`)]);
    },
    async reset(k) {
      fs.rmSync(`${name(k)}.part`, { force: true });
      fs.rmSync(`${name(k)}.meta.json`, { force: true });
    },
  };
}

/** The model file, downloading it once (resumable, checked) when it is missing. Resolves its path, or null offline. */
export async function ensureYamnet({ onProgress, fetchImpl } = {}) {
  const file = yamnetPath();
  if (fs.existsSync(file) && fs.statSync(file).size === YAMNET.bytes) return file;
  try {
    const { resumableDownload } = await import("../browser/download.js");
    const store = fileStore(path.dirname(file));
    await resumableDownload(YAMNET.url, { store, expect: { size: YAMNET.bytes, sha256: YAMNET.sha256 }, onProgress, ...(fetchImpl ? { fetchImpl } : {}), retries: 4 });
    const part = path.join(path.dirname(file), `${YAMNET.file}.part`);
    fs.renameSync(part, file);
    fs.rmSync(path.join(path.dirname(file), `${YAMNET.file}.meta.json`), { force: true });
    return file;
  } catch {
    return null;
  }
}

/**
 * Decode `source` to 16 kHz mono float samples with ffmpeg and hand them over a minute at a
 * time (plus one hop of overlap): onChunk(Float32Array, offsetSamples, isLast).
 */
async function decodeChunks(source, onChunk, { signal } = {}) {
  const rate = YAMNET.rate;
  const size = chunkSamples(rate);
  const step = CHUNK_SEC * rate;
  const ff = spawn(config().ffmpeg || "ffmpeg", ["-v", "error", "-i", source, "-vn", "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"], { stdio: ["ignore", "pipe", "pipe"] });
  const stop = () => ff.kill("SIGKILL");
  signal?.addEventListener("abort", stop, { once: true });
  let buf = new Float32Array(size * 2);
  let have = 0;
  let offset = 0;
  let carry = Buffer.alloc(0);
  let err = "";
  ff.stderr.on("data", (d) => (err += d));
  try {
    for await (const data of ff.stdout) {
      const bytes = carry.length ? Buffer.concat([carry, data]) : data;
      const whole = bytes.length - (bytes.length % 4);
      carry = bytes.subarray(whole);
      const f = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + whole));
      if (have + f.length > buf.length) {
        const nb = new Float32Array(Math.max(buf.length * 2, have + f.length));
        nb.set(buf.subarray(0, have));
        buf = nb;
      }
      buf.set(f, have);
      have += f.length;
      while (have >= size) {
        await onChunk(buf.slice(0, size), offset, false);
        buf.copyWithin(0, step, have);
        have -= step;
        offset += step;
      }
    }
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  const code = ff.exitCode ?? (await new Promise((r) => ff.on("close", r)));
  if (signal?.aborted) throw Object.assign(new Error("Stopped before it finished."), { name: "AbortError" });
  if (code !== 0) throw new Error(`ffmpeg could not read the audio: ${err.slice(0, 200)}`);
  if (have > 0) await onChunk(buf.slice(0, have), offset, true);
  return offset + have;
}

/** Run YAMNet over `source` in a child Node process. Resolves the frames; onProgress(secondsDone). */
function yamnetInChild(source, model, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--yamnet-child", source, model], { stdio: ["ignore", "pipe", "pipe"] });
    const stop = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", stop, { once: true });
    let out = "";
    let err = "";
    let frames = null;
    child.stdout.on("data", (d) => {
      out += d;
      let i;
      while ((i = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.done != null) onProgress?.(m.done);
          if (m.frames) frames = m.frames;
        } catch {}
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) return reject(Object.assign(new Error("Stopped before it finished."), { name: "AbortError" }));
      if (frames) return resolve(frames);
      reject(new Error(`the sound model stopped (${code}): ${err.slice(-200)}`));
    });
  });
}

/** The child's side: decode, run the model a minute at a time, print progress and then the frames as JSON lines. */
async function yamnetChildMain(source, model) {
  const ort = loadOrt();
  const session = await ort.InferenceSession.create(model, { intraOpNumThreads: 1, interOpNumThreads: 1 });
  const input = session.inputNames[0];
  const output = session.outputNames[0];
  const frames = { hop: YAMNET.hop, laughter: [], applause: [], shout: [] };
  await decodeChunks(source, async (pcm, offset, last) => {
    const out = await session.run({ [input]: new ort.Tensor("float32", pcm, [pcm.length]) });
    addFrames(frames, out[output].data, last ? framesToKeep(0, pcm.length) : FRAMES_PER_CHUNK);
    process.stdout.write(JSON.stringify({ done: (offset + pcm.length) / YAMNET.rate }) + "\n");
  });
  await session.release?.();
  process.stdout.write(JSON.stringify({ frames }) + "\n");
}

/**
 * Sound events for a job: sound.json when it is there, otherwise computed now from `source`.
 * by: "yamnet" (the model) or "dsp" (the fallback detector). words: speech words, for the
 * fallback's check that a laugh is not someone talking.
 * Returns { by, events, sec, ... } and writes <dir>/sound.json.
 */
export async function ensureSound(dir, source, { words = null, onProgress, signal, duration = null, allowDownload = true, ort = undefined } = {}) {
  const file = path.join(dir, "sound.json");
  const saved = readJson(file, null);
  if (saved?.events) return saved;
  // a file ffmpeg cannot read fails here, before any model is loaded or downloaded
  const probe = spawnSync(config().ffmpeg || "ffmpeg", ["-v", "error", "-t", "1", "-i", source, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { maxBuffer: 1 << 20 });
  if (probe.status !== 0 || !probe.stdout?.length) throw new Error(`ffmpeg could not read the audio of ${path.basename(source)}`);
  const t0 = Date.now();
  const runtime = ort === undefined ? ortInstalled() : !!ort;
  const model = runtime ? (fs.existsSync(yamnetPath()) ? yamnetPath() : allowDownload ? await ensureYamnet() : null) : null;
  let rec = null;
  let why = !runtime ? "onnxruntime-node is not installed" : !model ? "the sound model could not be downloaded" : null;
  const total = duration ? duration * YAMNET.rate : null;
  if (runtime && model) {
    // in a child process: onnxruntime-node aborts the process (exit 134) when process.exit()
    // is called while it is loaded, and the CLI exits that way, so it never loads in this one
    try {
      const frames = await yamnetInChild(source, model, { signal, onProgress: (done) => total && onProgress?.({ progress: Math.min(1, (done * YAMNET.rate) / total), note: "listening for laughter" }) });
      rec = soundRecord({ frames, events: eventsFromFrames(frames), by: "yamnet", sec: +((Date.now() - t0) / 1000).toFixed(1) });
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      why = `the sound model could not run here (${String(e.message).slice(0, 120)})`;
    }
  }
  if (!rec) {
    const events = [];
    await decodeChunks(source, async (pcm, offset) => {
      const t = offset / YAMNET.rate;
      const ws = words ? words.filter((w) => w.e >= t && w.s <= t + CHUNK_SEC + 1).map((w) => ({ ...w, s: w.s - t, e: w.e - t })) : null;
      for (const e of laughterHeuristic(pcm.subarray(0, Math.min(pcm.length, CHUNK_SEC * YAMNET.rate)), { words: ws })) events.push({ ...e, s: +(e.s + t).toFixed(2), e: +(e.e + t).toFixed(2) });
      if (total) onProgress?.({ progress: Math.min(1, (offset + pcm.length) / total), note: "listening for laughter" });
    }, { signal });
    rec = { ...soundRecord({ events, by: "dsp", sec: +((Date.now() - t0) / 1000).toFixed(1) }), why };
  }
  writeJsonAtomic(file, rec);
  return rec;
}

if (process.argv[2] === "--yamnet-child" && process.argv[1] === fileURLToPath(import.meta.url)) {
  yamnetChildMain(process.argv[3], process.argv[4]).catch((e) => {
    process.stderr.write(String(e?.stack || e));
    process.exitCode = 1;
  });
}
