# Open models used

Everything runs on the laptop. Sizes are the files Selects reads (the download can be bigger, see the notes). All model files live in the shared models folder (`SELECTS_MODELS_DIR`, by default next to the whisper models), not in the repo.

| Job | Model | Licence | Size | Source | Runs with |
|---|---|---|---|---|---|
| Speech to text (English) | whisper base.en (ggml) | MIT | 148 MB | https://huggingface.co/ggerganov/whisper.cpp | whisper.cpp (MIT) |
| Speech to text, language check | whisper base, multilingual (ggml) | MIT | 148 MB | https://huggingface.co/ggerganov/whisper.cpp | whisper.cpp |
| Speech to text (optional, slower, better) | whisper small.en, medium.en-q5_0 (ggml) | MIT | 488 MB, 539 MB | https://huggingface.co/ggerganov/whisper.cpp | whisper.cpp |
| Nigerian-accented English | rishabbahal/whisper-small-nigerian-accent, converted to ggml with `tools/hf-whisper-to-ggml.mjs` | Apache-2.0 | 488 MB (967 MB download, float32 safetensors) | https://huggingface.co/rishabbahal/whisper-small-nigerian-accent | whisper.cpp |
| Text language ID, 608 languages | olaverse/lid-lite-608 (fastText, quantised) | Apache-2.0 | 37 MB | https://huggingface.co/olaverse/lid-lite-608 (revision 850998d) | fasttext.wasm.js (MIT), WebAssembly, no native build |
| Text language ID, Nigeria | olaverse/lid-lite-5 (TF-IDF and logistic regression, JSON weights): English, Hausa, Igbo, Nigerian Pidgin, Yoruba | Apache-2.0 | 1.1 MB | https://huggingface.co/olaverse/lid-lite-5 (revision 138a58f) | plain JavaScript (`src/core/langid/ng5.mjs`) |
| Punctuation and casing (English) | Edge-Punct-Casing CNN-BiLSTM, int8 (`sherpa-onnx-online-punct-en-2024-08-06`, `model.int8.onnx` and `bpe.vocab`) | Apache-2.0 (code and release) | 7.6 MB kept (30 MB download; the float32 copy is deleted after unpacking) | https://github.com/k2-fsa/sherpa-onnx/releases/tag/punctuation-models, from https://github.com/frankyoujian/Edge-Punct-Casing | sherpa-onnx-node (Apache-2.0), with ONNX Runtime (MIT) |
| Clip judge | Gemma 3 4B, Q4_K_M GGUF imported into Ollama as `gemma3-4b-hf` | Gemma Terms of Use | 2.5 GB | https://huggingface.co/google/gemma-3-4b-it | Ollama (MIT) |

Where each one goes: `<models>/langid/lid-lite-608/model.ftz`, `<models>/langid/lid-lite-5/lid-lite-5.json` (`SELECTS_LANGID_DIR` overrides), `<models>/ggml-small-nigerian-accent.bin` (`SELECTS_ACCENT_MODEL_NG`), `<models>/punct/sherpa-onnx-online-punct-en-2024-08-06/` (`SELECTS_PUNCT_DIR`). A missing model is never fatal: its signal or step is skipped and the job says why.

New downloads for the language and punctuation work on 16 Oct: 37.2 MB (lid-lite-608) + 1.1 MB (lid-lite-5) + 30.7 MB (punctuation tarball) + 26.6 MB (VoxLingua107, rejected) + 0.9 MB (Silero VAD) + 3.3 MB (fasttext.wasm.js) + 37 MB (sherpa-onnx-node for macOS x64) + about 70 MB (onnxruntime-node 1.21 in a scratch folder, for the VoxLingua107 test only) = about 207 MB, well under the 1.5 GB budget.

## Selects Web (in the browser)

The browser build downloads its own copies from Hugging Face's CDN on first use and keeps them in the browser's storage (nothing is bundled with the site, nothing is uploaded). Sizes are the bytes the browser fetches.

| Job | Model | Licence | Size | Source | Runs with | Cached in |
|---|---|---|---|---|---|---|
| Speech to text with word times | whisper base.en, `onnx-community/whisper-base.en_timestamped` (exports the cross-attentions word timestamps need): fp32 encoder with a q8 decoder on the CPU, or a q4 decoder on WebGPU | MIT (OpenAI Whisper) | 140 MB (CPU) or 209 MB (WebGPU) | https://huggingface.co/onnx-community/whisper-base.en_timestamped | transformers.js 4.3.1 (Apache-2.0) on ONNX Runtime Web (MIT) | Cache Storage `transformers-cache` |
| Clip judge, WebGPU browsers | Gemma 4 E2B, `gemma-4-E2B-it-web.task` (LiteRT-LM web build, text only) | Apache-2.0 | 2,004 MB | https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm | @mediapipe/tasks-genai 0.10.29 (Apache-2.0), MediaPipe LLM Inference on WebGPU | Cache Storage `selects-models` |
| Clip judge, no WebGPU | Gemma 3 1B instruct, Q4_0 GGUF | Gemma Terms of Use | 722 MB | https://huggingface.co/unsloth/gemma-3-1b-it-GGUF | @wllama/wllama 3.8.1 (MIT), llama.cpp in WebAssembly | wllama's cache in the origin private file system |
| Clip judge, Smart mode | Gemma 4 26B A4B instruct (`gemma-4-26b-a4b-it`), falling back to `gemma-4-31b-it` | Apache-2.0 | none on the device | Google's Gemini API (only these two Gemma models were listed on 16 Oct 2026) | `src/core/gemini.mjs`, from the page with the user's key or through `server-proxy` | nothing |
| Language check | olaverse/lid-lite-5 (as on the desktop) | Apache-2.0 | 1.1 MB | https://huggingface.co/olaverse/lid-lite-5 | `src/core/langid/ng5.mjs` | Cache Storage `selects-models` |

Why these: Google's own web runtime is the natural home for Gemma on the web, and its Gemma 3 1B web files (`litert-community/Gemma3-1B-IT`) are gated behind a Hugging Face login, which a public page cannot use. The Gemma 4 E2B web files are not gated and are Apache-2.0, so the WebGPU judge is Gemma 4 E2B. Google says the MediaPipe route is in maintenance mode and LiteRT-LM is the way forward; its npm package (`@litert-lm/core` 0.18.0) shipped no documentation, and Google's own Gemma 4 web demo uses MediaPipe, so Selects does too. Gemma 4 E2B GGUFs are 2.2 GB and more, over wllama's 2 GB per-file limit and too slow on a CPU in a tab, so the CPU judge stays Gemma 3 1B. The Nigerian-accent whisper, lid-lite-608 and the punctuation model are desktop only.

Downloads on 16 Oct for the browser build: 209 + 140 MB (whisper, both sets), 2,004 MB (Gemma 4 E2B), 722 MB (Gemma 3 1B), 1.1 MB (lid-lite-5), plus about 560 MB of npm packages in `src/browser/node_modules` (transformers.js pulls in onnxruntime-node and sharp for Node use). The test Chrome profile with the cached models is in `.selects/chrome-profile` (gitignored); delete it to free the space.

## Tried and rejected

| Model | Licence, size | Why not |
|---|---|---|
| VoxLingua107 ECAPA-TDNN (speechbrain/lang-id-voxlingua107-ecapa), int8 ONNX export by krut42 | Apache-2.0 (data CC BY 4.0), 26.6 MB | Audio language ID that does not use whisper, so it should fail differently. It did, but worse: English for the American eval speakers (p 0.94 to 0.999), Welsh for the British EMF speaker (p 0.93 to 0.95 on every sample), and Yoruba, Hausa, Swahili, Croatian or Korean for the elderly Nigerian speaker depending on the 20 s window (never English). It also needs onnxruntime-node 1.21, the last release with a macOS x64 build (212 MB installed). |
| sherpa-onnx spoken-language ID | Apache-2.0 | It runs whisper's own encoder and decoder, so it fails the same way as whisper's detector. Not added. |
| fastText lid.176.ftz | CC BY-SA 3.0, 0.9 MB | The named fallback. Not needed because the olaverse models work. It has Yoruba but no Hausa, Igbo or Pidgin, and it read two Yoruba test sentences as Irish and Esperanto. |
| olaverse/lid-neural-5 (XLM-R) and lid-neural-608 (mmBERT) | Apache-2.0, 503 MB and about 560 MB | The lite models already decide every case measured here; 13 to 40 times bigger for a point or two of accuracy on short text. |
| Silero VAD v6.2.0 (ggml, for whisper.cpp's built-in `--vad`) | MIT, 0.9 MB, https://huggingface.co/ggml-org/whisper-vad | Measured with base.en on 3 recordings: 2.3 times faster on the pause-heavy phone recording, 1.2 times faster on an interview, 1.3 times slower on the talk. But word start times moved (median 0.2 to 0.7 s, worst 2.6 to 4.0 s) and real pauses were squashed (1.9 s pauses became 1.0 s; on the talk, 1.7 s became 0). Captions, cut snapping and pause-based sentences all rely on those times. |
| Speaker diarization (sherpa-onnx: pyannote segmentation 3.0 plus a speaker-embedding model) | MIT and Apache-2.0, about 6 MB plus 25 to 40 MB | Not built (stretch goal). Feasible: `OfflineSpeakerDiarization` is in the macOS x64 build of sherpa-onnx-node. |
| ct-transformer zh-en punctuation (FunASR) | FunASR model licence, 65 MB int8 | English-only transcripts here; the 7.5 MB English model is enough. |
