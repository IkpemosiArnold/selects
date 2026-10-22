// The models Selects Web downloads, with their sizes, licences and sources. Sizes are the
// bytes the browser fetches (Hugging Face API, 16 Oct 2026), so the UI can say how much
// it is about to download before it starts. Nothing here is fetched until it is needed.

export const HF = "https://huggingface.co";

export const MODELS = {
  // Speech to text with word times. The "_timestamped" export carries the cross-attention
  // outputs that word-level timestamps need.
  whisper: {
    id: "onnx-community/whisper-base.en_timestamped",
    label: "Whisper base.en (speech to text)",
    licence: "MIT (OpenAI Whisper), ONNX export by onnx-community",
    source: `${HF}/onnx-community/whisper-base.en_timestamped`,
    // WASM: full-precision encoder (quantising whisper's encoder costs accuracy) and an
    // 8-bit decoder. WebGPU: the same encoder and a 4-bit decoder.
    dtype: { wasm: { encoder_model: "fp32", decoder_model_merged: "q8" }, webgpu: { encoder_model: "fp32", decoder_model_merged: "q4" } },
    bytes: { wasm: 82451730 + 53712196 + 4247506, webgpu: 82451730 + 123736279 + 4247506 },
    // size and SHA-256 of the large files (Hugging Face API, 22 Oct 2026), checked after a
    // resumable download; a file that changed upstream is loaded unverified
    files: {
      "onnx/encoder_model.onnx": { size: 82451730, sha256: "f9fafccf043f762fea42ce685a097b1c1f7c3a062d2208a568481716312f8e35" },
      "onnx/encoder_model_quantized.onnx": { size: 23159173, sha256: "9b4d25507aef3d3a8d718695b8adcb0488e66aad8e884333c3fa73a1c3baa906" },
      "onnx/decoder_model_merged_quantized.onnx": { size: 53712196, sha256: "afa8065a5f023f6e524417f9459cc09969023dd38149cd4dce16628b2c3a1773" },
    },
    cache: "Origin private file system (\"models\"), and Cache Storage for the small files",
  },
  // The smaller speech model, the default on iPhones, iPads and devices with 4 GB of memory or
  // less (devices.js). Same tokenizer and word timestamps as base.en; quality and size against
  // base.en on the test clips are in notes/timings.md ("Speech model for phones").
  whisperTiny: {
    id: "onnx-community/whisper-tiny.en_timestamped",
    label: "Whisper tiny.en (speech to text, smaller)",
    licence: "MIT (OpenAI Whisper), ONNX export by onnx-community",
    source: `${HF}/onnx-community/whisper-tiny.en_timestamped`,
    dtype: { wasm: { encoder_model: "fp32", decoder_model_merged: "q8" }, webgpu: { encoder_model: "fp32", decoder_model_merged: "q4" } },
    bytes: { wasm: 32894434 + 30729881 + 2692523, webgpu: 32894434 + 86803045 + 2692523 },
    files: {
      "onnx/encoder_model.onnx": { size: 32894434, sha256: "e19140280ff8ae5299e4a82566e6c33e809f45b635428f7674ac821dd64f2ccc" },
      "onnx/encoder_model_quantized.onnx": { size: 10097112, sha256: "697eaa5668bb13343965f423d6002273479b8508f592bd26970735516ed5039e" },
      "onnx/decoder_model_merged_quantized.onnx": { size: 30729881, sha256: "f2df67fbe1cf39c9b050d05029b55e217a9467f3453ae5110e2bcc0f5ba73652" },
    },
    cache: "Origin private file system (\"models\"), and Cache Storage for the small files",
  },
  // The judge when the browser has WebGPU: Gemma 4 E2B through Google's web runtime
  // (MediaPipe LLM Inference, @mediapipe/tasks-genai). Text only on the web.
  gemma4: {
    id: "litert-community/gemma-4-E2B-it-litert-lm",
    file: "gemma-4-E2B-it-web.task",
    url: `${HF}/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.task`,
    label: "Gemma 4 E2B (judge, WebGPU)",
    licence: "Apache-2.0",
    source: `${HF}/litert-community/gemma-4-E2B-it-litert-lm`,
    bytes: 2003697664,
    cache: "Cache Storage, \"selects-models\"",
  },
  // The judge without WebGPU: Gemma 3 1B through llama.cpp compiled to WebAssembly
  // (wllama). Gemma 4 E2B GGUFs are 2.2 GB and more, over wllama's 2 GB per-file limit
  // and far too slow on a CPU in a tab, so the CPU path keeps the 1B model.
  gemma3: {
    id: "unsloth/gemma-3-1b-it-GGUF",
    file: "gemma-3-1b-it-Q4_0.gguf",
    url: `${HF}/unsloth/gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_0.gguf`,
    label: "Gemma 3 1B, Q4_0 (judge, CPU)",
    licence: "Gemma Terms of Use",
    source: `${HF}/unsloth/gemma-3-1b-it-GGUF`,
    bytes: 721918496,
    cache: "Origin private file system (wllama's cache)",
  },
  // Text language check for the five main languages of Nigeria (plain JavaScript weights).
  ng5: {
    id: "olaverse/lid-lite-5",
    url: `${HF}/olaverse/lid-lite-5/resolve/main/lid-lite-5.json`,
    label: "lid-lite-5 (language check)",
    licence: "Apache-2.0",
    source: `${HF}/olaverse/lid-lite-5`,
    bytes: 1149514,
    cache: "Cache Storage, \"selects-models\"",
  },
};

/** Smart mode: Gemma served by Google through the Gemini API (text of the shortlist only). */
// The only Gemma models the Gemini API listed on 16 Oct 2026. The 26B MoE (about 4B active)
// answered judge calls in about 2 s; the 31B dense model took up to a minute.
export const SMART_MODELS = ["gemma-4-26b-a4b-it", "gemma-4-31b-it"];

/** whisper by size: "base" (the default on computers) or "tiny" (phones). */
export const SPEECH_MODELS = { base: "whisper", tiny: "whisperTiny" };
export const speechModel = (size = "base") => MODELS[SPEECH_MODELS[size] || "whisper"];

export const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;
export const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
export const size = (bytes) => (bytes >= 1e9 ? gb(bytes) : mb(bytes));
