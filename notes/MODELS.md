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
