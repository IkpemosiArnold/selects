// YAMNet in a Web Worker (ONNX Runtime Web, WebAssembly, one thread), for sound events:
// where people laugh, clap or raise their voices (src/core/sound.mjs). The 16 MB model comes
// through the same resumable downloader as whisper (download.js: byte ranges kept in OPFS,
// checked by size and SHA-256), once, and then from this browser's storage. ONNX Runtime's
// WebAssembly is served from this site, not a CDN.
import * as ort from "onnxruntime-web/wasm";
import ortPlainMjs from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import ortPlainWasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { memoryStore, opfsStore, resumableDownload } from "./download.js";
import { YAMNET } from "../core/sound.mjs";

ort.env.wasm.wasmPaths = { mjs: ortPlainMjs, wasm: ortPlainWasm };
// one thread: whisper or Gemma may be busy on the others, and this model is small
ort.env.wasm.numThreads = 1;

let session = null;
const post = (m, transfer) => self.postMessage(m, transfer || []);

async function load() {
  if (session) return post({ type: "loaded", cached: true });
  const store = (await opfsStore()) || memoryStore();
  const blob = await resumableDownload(YAMNET.url, { store, expect: { size: YAMNET.bytes, sha256: YAMNET.sha256 }, onProgress: (p) => post({ type: "download", loaded: p.loaded, total: p.total || YAMNET.bytes, cached: !!p.cached }) });
  session = await ort.InferenceSession.create(new Uint8Array(await blob.arrayBuffer()), { executionProviders: ["wasm"] });
  post({ type: "loaded" });
}

async function run({ id, pcm }) {
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", pcm, [pcm.length]) });
  const scores = out[session.outputNames[0]].data;
  const copy = new Float32Array(scores);
  post({ type: "scores", id, scores: copy }, [copy.buffer]);
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === "load") await load();
    else if (m.type === "run") await run(m);
  } catch (e) {
    post({ type: "error", id: m.id ?? null, during: m.type, message: String(e?.message || e), kind: e?.kind || null });
  }
};
