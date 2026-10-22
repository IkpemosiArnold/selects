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

## Light mode: speech to text on a free hosted whisper (chosen 22 Oct 2026)

Light mode sends compressed speech-only audio pieces (never the video) to be transcribed, judges as Smart mode does, and renders on the device. Everything here must cost nothing: free tiers that refuse at their limit, never a card on file, or the person's own free key. Full research: [`notes/research/slow-internet.md`](research/slow-internet.md).

| Role | Provider and model | Licence of the weights | Word timestamps | Free limit (fails closed) | Data use | Checked from Lagos (Airtel), 22 Oct 2026 |
|---|---|---|---|---|---|---|
| Primary (the shared transcriber, through `server-proxy`) | Groq, `whisper-large-v3` | MIT (OpenAI Whisper) | Yes: `response_format=verbose_json` with `timestamp_granularities[]=word`; the word entries have no punctuation, so `src/core/asr-words.mjs` puts it back from the text | 20 requests a minute, 2,000 a day, 7,200 audio seconds an hour, 28,800 a day; 25 MB a file; 10 s minimum billed a request. At the limit it answers 429 and charges nothing | Not retained by default, not used for training (services agreement 4.2) | API answered 401 (no key), not a geo-block; browser calls allowed (CORS `*`) |
| Failover | Cloudflare Workers AI, `@cf/openai/whisper-large-v3-turbo` | MIT | Yes, in `segments[].words[]` | 10,000 neurons a day on the free Workers plan, about 214 audio minutes; errors after that on the free plan | Not retained, not used for training | 401 through the Lagos edge, not a geo-block |
| The person's own key | Groq, `whisper-large-v3`, called from the tab | MIT | As above | That person's own free quota | As above; the key stays in the tab | As above |

Why `whisper-large-v3` and not `-turbo`: the same free limits, and a lower error rate (Groq's table: 10.3% against 12% WER); on African-accented English large-v3 measured about 21% WER on AfriSpeech-MultiBench (arXiv 2511.14255), still well ahead of any model small enough for a phone. Rejected: Hugging Face Inference Providers (no free monthly credits for free accounts, and only chunk-level timestamps through the router), DeepInfra and Fireworks (a card or prepaid credit; Fireworks' audio endpoint answered 503), fal (needs a public audio URL), and whisper.cpp on Render's free plan (0.1 CPU and 512 MB; a live test needed a new Render service, which was not created; the research estimates base.en at well under 1x real time there, and small.en does not fit in the memory). Sources: [Groq speech-to-text](https://console.groq.com/docs/speech-to-text), [Groq rate limits](https://console.groq.com/docs/rate-limits), [Groq data](https://console.groq.com/docs/your-data), [Cloudflare pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Cloudflare privacy](https://developers.cloudflare.com/workers-ai/platform/privacy/), [HF pricing](https://huggingface.co/docs/inference-providers/pricing), [Render free](https://render.com/docs/free), all read 22 Oct 2026.

Not set up yet: the proxy has no `GROQ_API_KEY`, so the shared transcriber is off. The page then does not choose Light by itself, says so when Light is picked, and Light works only with the person's own free Groq key.

### On-device speech model for phones (Private mode): the recommendation handed to the model builder

| Model | Download | Word timestamps on Selects' runtime (transformers.js) | Verdict |
|---|---|---|---|
| whisper base.en today (fp32 encoder, q8 decoder) | 140 MB (209 MB on WebGPU) | Yes | What failed on the iPhone |
| whisper base or base.en, all q8 | 76.9 MB | Yes | Recommended phone default for Private mode, after a q8 accuracy check on Nigerian clips |
| whisper tiny.en, q8 | 40.8 MB | Yes | Smallest usable; accuracy on Nigerian speech unknown |
| Moonshine tiny / base, q8 (Useful Sensors, MIT) | 28.1 / 62.9 MB | **No**: transformers.js returns no word times and the ONNX exports have no cross-attention outputs to align with | Rejected: Selects needs word times for cuts and captions |

Sizes from the Hugging Face listings, 22 Oct 2026. The q4 "timestamped" decoder is bigger than the q8 one (the token-embedding table stays unquantised), so all-q8 is the small set. The planned word-error-rate and speed comparison on the CC BY eval clips (a pseudo-reference from whisper large) was lost when this machine restarted on 22 Oct and has not been re-run: the numbers above are sizes and capabilities, not accuracy. For phones with no cached model, Light mode is now the default.
