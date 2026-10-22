# Open models and tools for a zero-cost clipper (non-speech audio, noisy audio, ASR incl. Nigerian languages, vision, video LLMs, beat tracking)

Research date and access date for every source below: 22 Oct 2026 unless stated. Release dates are given where the source states them. "UNVERIFIED" means I did not confirm the claim from a primary source in this session (it comes from training knowledge or a secondary source only). "Fetched" means I read the page this session.

Zero-cost rule used for flags: OK = permissive licence (MIT, Apache-2.0, BSD, ISC, CC0, CC-BY), no billing. NC-BLOCK = non-commercial or research-only licence (fine for a hobby or research build, blocks any monetised Selects). AGPL/GPL = copyleft obligations (AGPL means a hosted web service must publish its source). BILLING = needs a card or paid tier.

## Master comparison table (dense)

| Category | Model / tool | Size (params / file) | Licence | Runtimes | Speed figure | Browser on mid laptop / Android? | Zero-cost flag |
|---|---|---|---|---|---|---|---|
| Audio events | YAMNet (Google) | 3.7M params, 69.2M multiplies per 0.96 s frame; 521 AudioSet classes | Apache-2.0 (UNVERIFIED for weights; tensorflow/models repo is Apache-2.0) | TF, TFLite, TF.js, MediaPipe Audio Classifier (Web, Android, iOS, Python) | 12.29 ms per 0.975 s clip on Pixel 6 CPU (MediaPipe) | Yes, easily; few MB | OK |
| Audio events | PANNs CNN14 | ~80M params (UNVERIFIED); mAP 0.431; Wavegram-Logmel 0.439; MobileNet variant 0.383 at 5% of params | MIT (UNVERIFIED) | PyTorch; ONNX export possible | none found | Laptop maybe, phone heavy; MobileNet variant feasible | OK |
| Audio events | EfficientAT (mn04 to mn40, dymn) | 0.98M (mn04, mAP 43.2) / 4.88M (mn10, 47.1) / 68.4M (mn40_as_ext, 48.7) | MIT | PyTorch (ONNX not mentioned) | MACs only: mn10 0.54 GMACs per 10 s clip | Yes for mn04/mn10 after ONNX export (export UNVERIFIED) | OK, best accuracy per MB |
| Audio events | AST (MIT) | ~87M params (UNVERIFIED); mAP 0.485 (ensemble) per third-party leaderboard | BSD-3 (UNVERIFIED) | PyTorch, HF transformers, transformers.js (AST listed) | none found | Laptop yes (~350 MB fp32, UNVERIFIED); phone marginal | OK |
| Audio events | BEATs (Microsoft) | ~90M params; mAP 0.498 per third-party leaderboard, 48.6 often quoted (conflict) | MIT (UNVERIFIED, microsoft/unilm) | PyTorch; not in transformers.js list | none found | Not out of the box | OK |
| Audio zero-shot | LAION-CLAP | checkpoints 630k-*, music_speech_audioset; ESC-50 zero-shot 89.98 to 90.14% | Code CC0-1.0; checkpoint licence not stated | PyTorch, HF transformers, transformers.js (CLAP listed) | none found | Laptop yes (transformers.js); phone marginal | OK for code; weight licence gap |
| Audio zero-shot | MS-CLAP (Microsoft) | UNVERIFIED | MIT (UNVERIFIED) | PyTorch | none | Not out of the box | likely OK |
| Speech enhancement | DeepFilterNet 2/3 | small (UNVERIFIED ~2M params); PESQ 3.17 (DF3) vs 3.08 (DF2) on VoiceBank+Demand | MIT or Apache-2.0 (dual) | Rust binary (48 kHz only), Python/PyTorch, LADSPA/PipeWire; WASM not mentioned in repo | RTF 0.19 (DF1, 1 thread notebook CPU); 0.04 (DF2, Core i5) | WASM ports are community only (UNVERIFIED) | OK, but see "denoising can hurt ASR" |
| Speech enhancement | RNNoise | very small (UNVERIFIED) | BSD (UNVERIFIED) | C, community WASM builds (UNVERIFIED) | none found | Yes (UNVERIFIED) | OK |
| Source separation | HTDemucs v4 (htdemucs, _ft, _6s) | size not stated; 9.0 dB SDR MUSDB HQ | MIT; repo ARCHIVED 1 Jan 2025, fixes go to adefossez/demucs | PyTorch | ~1.5x track duration; GPU needs 3 to 7 GB | No (too heavy) | OK but unmaintained |
| VAD | Silero VAD | ~2 MB JIT | MIT (README), one badge says CC BY-NC 4.0 (conflict) | PyTorch, ONNX (CPU/GPU), C++; used by whisper.cpp --vad | <1 ms per 30+ ms chunk on 1 CPU thread | Yes (ONNX Runtime Web) | OK (resolve badge conflict) |
| ASR | Whisper large-v3 | 1.55B | MIT | PyTorch, faster-whisper, whisper.cpp, transformers.js | OpenASR avg WER 7.44, RTFx 145.51 | Laptop WebGPU only for small sizes | OK |
| ASR | Whisper large-v3-turbo | 809M (decoder 32 to 4 layers) | MIT | same | vendor: 13.40% vs 13.20% WER long-form, 129.5x vs 55.3x RT (UNVERIFIED) | Laptop WebGPU possible (q4); phone no | OK |
| ASR | whisper.cpp ggml | tiny 75 MiB / base 142 MiB / small 466 MiB / medium 1.5 GiB / large 2.9 GiB (RAM 273 MB to 3.9 GB) | MIT | C/C++, WASM (whisper.wasm), quantization (Q5_0 etc.), Core ML | no numbers in README | tiny/base/small in WASM; phone tiny/base | OK |
| ASR | NVIDIA Parakeet TDT 0.6B v2 | 0.6B | CC-BY-4.0 (UNVERIFIED for v2; v3 confirmed) | NeMo, ONNX, transformers.js (Parakeet listed) | OpenASR avg WER 6.05, RTFx 3386 | Laptop yes (UNVERIFIED size) | OK |
| ASR | NVIDIA Parakeet TDT 0.6B v3 | 0.6B, 25 European langs (no African) | CC-BY-4.0 | NeMo, transformers.js | avg WER 6.34; RTFx 3332.74; noise: 7.12% @10 dB, 8.23% @5 dB, 11.66% @0 dB, 19.88% @-5 dB | Laptop yes | OK |
| ASR | Canary-Qwen 2.5B | 2.5B | CC-BY-4.0 (UNVERIFIED) | NeMo | avg WER 5.63 (rank 1 in paper), RTFx 418 | No | OK |
| ASR | Moonshine tiny / base | 27M / 61M | MIT | ONNX, transformers.js (Moonshine listed) | base: mean WER 9.99, AMI 17.49, RTFx 565.97 | Yes, best phone option for English | OK |
| ASR Nigerian | NaijaVox-V1 / 2.0 (Whisper large-v3 LoRA) | 1.55B base | check card (UNVERIFIED) | PyTorch; community int8 GGUF exists | Pidgin WER 16.8% (50 samples), Yoruba 28.8%, Hausa 31.0% FLEURS (50 samples) | No (large) | depends on card; trained on NC data? |
| ASR Nigerian | pidgin-wav2vec2-xlsr53 | ~300M (UNVERIFIED) | Apache-2.0 | PyTorch, transformers.js (Wav2Vec2 listed) | Pidgin test WER 29.6% | Laptop yes | OK |
| ASR African | Meta MMS-1B-all | 1B (UNVERIFIED) | CC-BY-NC 4.0 (UNVERIFIED) | HF transformers, transformers.js (MMS listed) | NaijaVoices: zero-shot >100% WER Yoruba; fine-tuned base ~51.65% | Laptop marginal | NC-BLOCK (UNVERIFIED) |
| ASR African | Intron Sahara v2 | closed | proprietary API | API only | 12.4% WER AfriSpeech-MultiBench vs 40 to 70% open | n/a | BILLING after free credits |
| Data | NaijaVoices (1,800 h, ~600 h each Igbo/Hausa/Yoruba) | dataset | CC BY-NC-SA 4.0, commercial waivers via membership | n/a | fine-tuning WER gains 75.86% (Whisper) | n/a | NC-BLOCK |
| Data | AfriSpeech-200 (~200 h, 120 accents, 67% Nigerian) | dataset | CC BY-NC-SA 4.0 (UNVERIFIED) | n/a | baseline Whisper-medium dev WER 0.349 | n/a | likely NC |
| Vision embed | SigLIP 2 (so400m-patch14-384 etc.) | ~1B listed for so400m checkpoint (F32 safetensors size field) | Apache-2.0 | HF transformers; transformers.js lists SigLIP (SigLIP2 not seen) | none | base sizes on laptop WebGPU (UNVERIFIED) | OK |
| Vision embed | OpenCLIP / CLIP | ViT-B/32 ~150M (UNVERIFIED) | MIT (OpenAI CLIP), OpenCLIP MIT (UNVERIFIED) | PyTorch, ONNX, transformers.js (CLIP listed) | none | Yes ViT-B/32 | OK |
| Vision embed | MobileCLIP / MobileCLIP2 (Apple) | S0: 11.4M img + 42.4M text, 1.5+1.6 ms; MobileCLIP2-S0 71.5% IN-1k zero-shot | Code MIT; WEIGHTS "Apple ML Research Model TOU" research-only, revocable | PyTorch, OpenCLIP, iOS app, transformers.js (MobileCLIP listed) | 1.5 ms image latency (S0, iPhone per paper) | Yes, smallest CLIP | NC-BLOCK (weights) |
| Aesthetics | LAION aesthetic predictor v2 (MLP on CLIP ViT-L/14) | tiny MLP + CLIP L/14 | MIT (UNVERIFIED) | PyTorch | n/a | Laptop if CLIP L/14 fits | OK (UNVERIFIED) |
| Faces | MediaPipe Face Detector (BlazeFace short range) | <1 MB (UNVERIFIED) | Apache-2.0 (UNVERIFIED) | MediaPipe Web/Android/iOS | real-time on phones (UNVERIFIED) | Yes | OK |
| OCR | Florence-2 base/large | 0.23B / 0.77B (UNVERIFIED) | MIT (UNVERIFIED) | HF, transformers.js (Florence2 listed) | none | Laptop WebGPU yes (base) | OK |
| OCR | Tesseract.js | ~ few MB per language traineddata (UNVERIFIED) | Apache-2.0 (UNVERIFIED) | WASM | none | Yes | OK |
| OCR | PaddleOCR / EasyOCR | PP-OCR mobile models small (UNVERIFIED) | Apache-2.0 (UNVERIFIED) | Python, ONNX, Paddle.js (UNVERIFIED) | none | Paddle mobile models yes (UNVERIFIED) | OK |
| OCR | TrOCR | UNVERIFIED | MIT (UNVERIFIED) | transformers.js (listed) | none | Laptop | OK |
| Shots | PySceneDetect | n/a (OpenCV histogram/content) | BSD-3-Clause; v0.6.7 on 24 Aug 2025 | Python, CLI | 86 FPS on MSU-Shot (secondary) | No (but ffmpeg.wasm scene filter is) | OK |
| Shots | TransNetV2 | small CNN (UNVERIFIED ~few MB) | MIT (UNVERIFIED) | TF, PyTorch ports | "fast"; no FPS found | Possible via ONNX (UNVERIFIED) | OK (UNVERIFIED) |
| Shots | ffmpeg scene filter (select='gt(scene,0.4)') | n/a | LGPL/GPL depending on build (UNVERIFIED) | CLI, ffmpeg.wasm | n/a | Yes via ffmpeg.wasm (~30 MB core, UNVERIFIED) | OK (watch GPL build flags) |
| Video LLM | Gemma 4 E2B | 2.3B effective (5.1B with embeddings), 128K ctx, text+image+audio(+video as frames) | Apache-2.0 | transformers.js (Gemma 4 listed; onnx-community/gemma-4-E2B-it-ONNX q4f16), LiteRT-LM, llama.cpp, MLX, Chrome built-in APIs, AI Edge Gallery | no tokens/sec published in tutorial | Laptop with WebGPU: q4f16 download ~3.38 GB visible files; phone via AI Edge Gallery/LiteRT not browser | OK; download too big for low-data users |
| Video LLM | Gemma 4 E4B | 4.5B effective (8B with embeddings), 128K, audio yes | Apache-2.0 | same | none | Laptop heavy; no | OK |
| Video LLM | Gemma 4 12B Unified | 11.95B, 256K, audio yes | Apache-2.0 | llama.cpp etc. | none | No | OK |
| Video LLM | Gemma 4 26B A4B MoE | 25.2B total, 3.8B active, 256K, text+image | Apache-2.0 | AI Studio / Gemini API free tier, llama.cpp | none | No | OK; free API, data used for training |
| Video LLM | Gemma 4 31B dense | 30.7B, 256K | Apache-2.0 | AI Studio / Gemini API free tier | Arena #3 open model at launch | No | OK; same |
| Video LLM | Qwen3-VL 2B/4B/8B/32B, 30B-A3B, 235B-A22B | dense + MoE, 256K ctx (to 1M) | Apache-2.0 (2B card fetched) | HF, llama.cpp (UNVERIFIED), transformers.js (Qwen3-VL listed) | Charades-STA 64.8 (235B, third-party, UNVERIFIED) | 2B on laptop WebGPU possibly | OK |
| Video LLM | Qwen2.5-VL-3B | 3B; Charades-STA mIoU 38.8, VideoMME 67.6/61.5, LVBench 43.3 | "qwen-research" non-commercial (UNVERIFIED; card fetch showed no licence name) | HF, transformers.js (Qwen2.5-VL listed) | n/a | Laptop | NC-BLOCK (UNVERIFIED) |
| Video LLM | SmolVLM2 256M / 500M / 2.2B | as named | Apache-2.0 | HF, llama.cpp, Ollama, LM Studio, transformers.js (SmolVLM listed) | 2.2B needs 5.2 GB GPU RAM for video; Video-MME 52.1/42.2/33.7 | 256M/500M yes in browser; 2.2B laptop only | OK |
| Video LLM | InternVL3, LLaVA-Video, VideoLLaMA3 | 1B to 78B (UNVERIFIED) | code MIT/Apache, weights inherit Qwen2/2.5 base licences (UNVERIFIED) | PyTorch | no numbers found | No (except InternVL3-1B maybe) | check per checkpoint |
| Video LLM API | Gemini API free tier (Gemini 3.8 Flash, 3.6 Flash, 3 Flash Preview, 2.5 Flash, Flash-Lite 3.5/3.1/2.5, Gemma 4) | n/a | ToS; free tier inputs "used to improve our products" | REST, BYO key | video: ~100 tokens/s at low res (66 per frame + 32 audio), 1 fps; free YouTube 8 h/day; File API 2 GB free | n/a (server or BYO-key client) | OK if user brings own free key; privacy flag |
| Beats | librosa | n/a | ISC (UNVERIFIED) | Python | n/a | No (Python), Pyodide possible | OK |
| Beats | Essentia / essentia.js | n/a | AGPLv3 for non-commercial, commercial licence from UPF; pre-trained models CC BY-NC-ND 4.0 | C++, Python, essentia.js WASM | n/a | Yes (WASM) | AGPL + NC-BLOCK (models) |
| Beats | madmom | n/a | Code BSD; models/data CC BY-NC-SA 4.0 (commercial use needs contact with G. Widmer) | Python | n/a | No | NC-BLOCK (models) |
| Beats | BeatNet | UNVERIFIED | CC BY 4.0 (UNVERIFIED) | Python, depends on madmom (UNVERIFIED) | real-time (UNVERIFIED) | No | inherits madmom issue (UNVERIFIED) |
| Beats | aubio | n/a | GPL-3.0 (UNVERIFIED) | C, Python, aubiojs WASM (UNVERIFIED) | n/a | Yes | GPL copyleft |
| Motion | Frame-difference / optical flow (OpenCV Farneback, opencv.js) | n/a | Apache-2.0 (OpenCV 4.5+, UNVERIFIED) | OpenCV, opencv.js WASM | n/a | Yes | OK |

## Audio event detection (laughter, applause, cheering, crowd, music, gunshots, explosions)

### Takeaway
YAMNet via MediaPipe Audio Classifier is the safest browser and Android pick (3.7M params, 521 AudioSet classes, about 12 ms per second of audio on a Pixel 6), but its accuracy is low (balanced mAP 0.306). EfficientAT mn10 (4.88M params, mAP 47.1, MIT) gives far better accuracy for a similar footprint if exported to ONNX. All AudioSet-trained models cover the target classes because these are AudioSet ontology classes.

### Cited Findings
- YAMNet: MobileNet_v1, about 3.7M weights, 69.2M multiplies per 960 ms frame; balanced mAP 0.306, d-prime 2.318 on AudioSet eval (20,366 segments); 521 classes; drops 6 of 527 AudioSet classes (Male/Female Speech, Male/Female Singing, Battle cry, Funny music); needs 975 ms of 16 kHz audio for first output; relies on Keras 2. Source: [tensorflow/models YAMNet README](https://github.com/tensorflow/models/blob/master/research/audioset/yamnet/README.md) (fetched)
- MediaPipe Audio Classifier supports Android, iOS, Python and Web; default/recommended model is YAMNet; input 1 x 15600 float32; 12.29 ms average CPU latency on Pixel 6; page last updated 2026-10-09. Source: [Google AI Edge MediaPipe Audio Classifier](https://developers.google.com/edge/mediapipe/solutions/audio/audio_classifier) (fetched)
- EfficientAT (MIT): mn04_as 0.983M params / 0.11 GMACs / mAP 43.2; mn10_as 4.88M / 0.54 / 47.1; dymn10_as 10.57M / 0.58 / 47.7; mn40_as_ext 68.43M / 8.03 / 48.7; ensemble 49.8. Trained in fp16, "slight performance degradation" on fp32 CPU; no ONNX or mobile timing published. Source: [fschmid56/EfficientAT](https://github.com/fschmid56/EfficientAT) (fetched)
- PANNs CNN14 mAP 0.431 vs AudioSet baseline 0.314; Wavegram-Logmel-CNN 0.439; MobileNet variant 0.383 at 6.7% flops and 5.0% params of CNN14. Source: [PANNs paper, arXiv 1912.10211](https://arxiv.org/pdf/1912.10211) (2019, via search snippet)
- AST credited with mAP 0.485 and BEATs with 0.498 (90M params, AudioSet-2M, 2023) on a third-party leaderboard. Source: [Codesota audio classification](https://codesota.com/audio/classification); the commonly quoted BEATs figure of 48.6 could not be confirmed, so the BEATs number is conflicting and UNVERIFIED
- LAION-CLAP repo licence CC0-1.0; checkpoints 630k-audioset-best, 630k-audioset-fusion-best, music_audioset (ESC-50 zero-shot 90.14%), music_speech_audioset (89.98%); training data cannot be released for copyright reasons; checkpoint licence not stated; larger checkpoints released 2023-04-07. Source: [LAION-AI/CLAP](https://github.com/LAION-AI/CLAP) (fetched)
- transformers.js supports Audio Spectrogram Transformer, CLAP, Moonshine, Whisper, Wav2Vec2, MMS, Parakeet, Voxtral, Ultravox; BEATs not seen in list; repo Apache-2.0; install example uses @huggingface/transformers@4.3.1. Source: [huggingface/transformers.js README](https://github.com/huggingface/transformers.js) (fetched)
- transformers.js v3 (released 22 Oct 2024) added WebGPU via device: 'webgpu'; zero-shot audio classification is a supported task. Source: [HF blog: Transformers.js v3](https://www.huggingface.co/blog/transformersjs-v3)

### Inferences
- For a zero-cost clipper, a two-stage audio pipeline makes sense: YAMNet (MediaPipe, a few MB) runs on every second of audio in the browser to score "Laughter", "Applause", "Cheering", "Crowd", "Music", "Gunshot, gunfire", "Explosion" logits, then optional CLAP zero-shot prompts on candidate windows for custom events ("crowd shouting in Yoruba", "airhorn").
- YAMNet's low mAP matters most for rare classes such as gunshots; for crowd, applause, music and laughter it is usually adequate because those classes have many AudioSet training examples (inference, not measured here).
- EfficientAT mn10 is the best accuracy per byte (~20 MB fp32 by params x 4, inference) but needs a self-made ONNX export and a mel front end in JS.

### Gaps
- Per-class AP for laughter/applause/cheering/gunshot/explosion for YAMNet, PANNs or EfficientAT: not found.
- Exact file sizes for YAMNet TFLite and TF.js packages: not found on fetched pages.
- Licences for PANNs, AST, BEATs, MS-CLAP weights: UNVERIFIED (training knowledge says MIT/BSD-3/MIT/MIT).
- CPU real-time factors for PANNs/AST/BEATs in WASM: none published that I found.

## Speech enhancement, noise suppression, VAD, vocal isolation, and the effect on ASR

### Takeaway
Do not put a denoiser in front of modern ASR by default. Two 2025 to 2026 studies found enhancement increased WER for Whisper and Parakeet in every tested condition. Use Silero VAD (about 2 MB, under 1 ms per chunk) to cut silence, and keep denoising (DeepFilterNet, RNNoise) for the exported clip audio a human hears, not for the ASR input. Demucs vocal isolation is too heavy for the browser and its repo is archived.

### Cited Findings
- MetricGAN+ denoising before Whisper, Parakeet, Gemini Flash 2.0 and Parrotlet-a on 500 medical recordings, nine noise conditions: original noisy audio had lower semWER than enhanced audio in all 40 configurations; degradation 1.1% to 46.6% absolute; Whisper at 10 dB SNR went from 8.82% to 25.83% semWER. Source: [When De-noising Hurts, arXiv 2512.17562](https://arxiv.org/pdf/2512.17562) (Dec 2025)
- SAM-Audio enhancement before Whisper on Bengali YouTube and English noisy sets consistently increased WER and CER despite better signal quality; degradation worse for larger Whisper models. Source: [arXiv 2603.04710](https://arxiv.org/abs/2603.04710) (Mar 2026)
- DeepFilterNet: dual MIT or Apache-2.0; Rust deep-filter binary (48 kHz only), PyPI deepfilternet (PyTorch), LADSPA plugin for PipeWire; DeepFilterNet2 is the default model; repo does not mention WASM or ONNX. Source: [Rikorose/DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) (fetched)
- DeepFilterNet3 PESQ 3.17 vs DF2 3.08 vs DF1 2.81 on VoiceBank+Demand; DF1 RTF 0.19 single-thread notebook CPU; DF2 RTF 0.04 on Core i5. Source: [DeepFilterNet paper, arXiv 2305.08227](https://arxiv.org/pdf/2305.08227) (Interspeech 2023)
- Silero VAD: about 2 MB JIT model, under 1 ms per 30+ ms chunk on one CPU thread, 8 and 16 kHz, ONNX available (may be 4 to 5x faster), trained on 6000+ languages; README says MIT but one badge reads CC BY-NC 4.0. Source: [snakers4/silero-vad](https://github.com/snakers4/silero-vad) (fetched)
- whisper.cpp supports --vad with a Silero-VAD model. Source: [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) (fetched)
- Demucs: MIT; archived and read-only since 1 Jan 2025, bug fixes only at adefossez/demucs; htdemucs default, htdemucs_ft ~4x slower; 9.0 dB SDR on MUSDB HQ; processing roughly 1.5x track duration; GPU needs 3 GB minimum, about 7 GB default. Source: [facebookresearch/demucs](https://github.com/facebookresearch/demucs) (fetched)

### Inferences
- For Nigerian creator content (street interviews, owambe parties, church services, football viewing centres), background music and crowd noise are common. The safest ASR path is raw audio into a noise-robust ASR (Whisper large-v3/turbo or Parakeet) with VAD gating, not denoise-then-ASR.
- Music-under-speech is the one case where vocal isolation could help, but HTDemucs costs about 1.5x real time and several GB, so it belongs in an optional desktop or server path only.

### Gaps
- RNNoise WASM build size and licence: not verified (training knowledge: BSD-3, tiny model, many WASM ports).
- MDX-Net / UVR models: not researched (licences vary per checkpoint).
- DeepFilterNet3 RTF and any official WASM build: not found.

## Noise-robust ASR and African-language / Nigerian-accent support

### Takeaway
Whisper large-v3 is still the best open baseline for Nigerian-accented English (26.53% WER on the AfriSpeech-MultiBench Nigeria subset, better than Parakeet), but all open models sit at 20 to 40% WER on African accents vs about 12% for the commercial Intron Sahara v2. For Yoruba, Hausa, Igbo and Pidgin, only community fine-tunes exist, with small-sample self-reported WERs of 17 to 31%, and the best training corpus (NaijaVoices) is non-commercial. Parakeet v3 is far faster and more noise-robust on European languages but does not cover any Nigerian language.

### Cited Findings
- Open ASR Leaderboard paper: Conformer + LLM decoders best average English WER but slower; CTC/TDT decoders much faster. Canary-Qwen 2.5B avg WER 5.63, RTFx 418.28; Parakeet TDT 0.6B v2 6.05 / 3386.02; v3 6.32 / 3332.74. Source: [Open ASR Leaderboard, arXiv 2510.06961](https://arxiv.org/html/2510.06961v3) (Oct 2025)
- Whisper-large-v3 avg WER 7.44, RTFx 145.51 (as cited in the Canary-1B-v2 paper). Source: [Canary-1B-v2 & Parakeet-TDT-0.6B-v3 paper, arXiv 2509.14128](https://arxiv.org/pdf/2509.14128) (Sep 2025, via search snippet)
- A third-party listing says IBM Granite Speech 4.1 2B now leads at 5.33% WER (UNVERIFIED). Source: [benchmarklist.com Open ASR](https://benchmarklist.com/benchmarks/open_asr_leaderboard/)
- Live leaderboard table did not load in fetch. Source: [hf-audio/open_asr_leaderboard](https://huggingface.co/spaces/hf-audio/open_asr_leaderboard)
- Parakeet TDT 0.6B v3: released 14 Aug 2025; CC-BY-4.0, "ready for commercial/non-commercial use"; 25 European languages (no African languages); MUSAN noise WER: clean 6.34%, SNR 10 7.12%, SNR 5 8.23%, SNR 0 11.66%, SNR -5 19.88%; FLEURS avg 11.97%; RTFx 3332.74; up to 24 min full attention or 3 h local attention; word/segment/char timestamps. Source: [nvidia/parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (fetched)
- Whisper large-v3-turbo: 809M params, decoder cut from 32 to 4 layers; vendor-reported long-form YouTube-commons WER 13.40% vs 13.20% (large-v3) at 129.5x vs 55.3x real time; faster-whisper GPU: turbo 19.2 s for 13 min audio vs large-v3 52.0 s vs distil-large-v3 26.1 s. Source: [Whisper Notes blog](https://whispernotes.app/blog/introducing-whisper-large-v3-turbo) (secondary, vendor, UNVERIFIED)
- whisper.cpp (MIT): tiny 75 MiB/~273 MB RAM, base 142 MiB/~388 MB, small 466 MiB/~852 MB, medium 1.5 GiB/~2.1 GB, large 2.9 GiB/~3.9 GB; WebAssembly supported via whisper.wasm; integer quantization (e.g. Q5_0); no CPU benchmark numbers in README. Source: [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) (fetched)
- Moonshine tiny 27M / base 61M, MIT, English-focused; base mean WER 9.99, AMI 17.49, RTFx 565.97; paper 21 Oct 2024. Source: [UsefulSensors/moonshine-base](https://huggingface.co/UsefulSensors/moonshine-base) (fetched)
- AfriSpeech-MultiBench, Nigeria subset WER: Whisper-large-v3 26.53%, Parakeet-tdt-1.1B 28.65%, Parakeet-tdt-0.6B-v2 32.60%, Parakeet-rnnt-1.1B 32.76%; Whisper best cross-country average 21.19% vs best Parakeet 22.54%. Source: [AfriSpeech-MultiBench, arXiv 2511.14255](https://arxiv.org/pdf/2511.14255) (Nov 2025, via search snippet)
- Same benchmark: Intron Sahara V2 leads with 12.4% WER vs 40 to 70% for open-source models (context of this figure differs from the Nigeria subset above). Source: [arXiv 2511.14255](https://arxiv.org/pdf/2511.14255)
- Whisper Large-v3 WER rises from about 2.0% (LibriSpeech) to 26 to 38% (AfriSpeech, NCHLT). Source: [Probing Multilingual and Accent Robustness of Speech LLMs, EACL 2026](https://aclanthology.org/2026.eacl-long.122.pdf)
- AfriSpeech-200: ~200 h, 120 accents, 13 countries, Nigerian accents 67%; test 18.77 h; Whisper-medium dev WER 0.349, Whisper-small-en 0.434; fine-tuning gives average 16.2% relative gain. Source: [intron-innovation/AfriSpeech-200](https://github.com/intron-innovation/AfriSpeech-200); [TACL paper](https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00627/118796/AfriSpeech-200-Pan-African-Accented-Speech-Dataset)
- Intron Sahara v2: commercial API, 24 African languages, 500+ African English accents, proprietary training data (14M clips, 50,000+ h claimed); v2.5 promo offers free credits; no open weights found. Source: [TechEconomy.ng, 19 Aug 2026](https://techeconomy.ng/intron-sahara-v2-african-voice-ai); [Africa.com](https://africa.com/intron-launches-voice-ai-for-africa/)
- NaijaVoices: 1,800 h, 5,000+ speakers, ~600 h each Igbo/Hausa/Yoruba; licence CC BY-NC-SA 4.0 with commercial waivers via paid membership; fine-tuning WER improvements 75.86% (Whisper), 52.06% (MMS), 42.33% (XLSR); a review flags possible sentence-level train/test leakage. Source: [NaijaVoices paper, arXiv 2505.20564](https://arxiv.org/html/2505.20564) (Interspeech 2025); [HF dataset](https://huggingface.co/datasets/naijavoices/naijavoices-dataset)
- On NaijaVoices Yoruba, zero-shot Whisper Large and MMS Base both exceed 100% WER (hallucination/repetition); fine-tuned MMS Base ~51.65%, Whisper Small ~58.10%. Source: [convertaudiototext.com summary](https://convertaudiototext.com/fr/blog/yoruba-transcription-future) (secondary, UNVERIFIED against the paper)
- NaijaVox-V1 (Whisper-large-v3 + LoRA): Pidgin WER 16.8% on a 50-sample test; Yoruba 28.8% and Hausa 31.0% on FLEURS with 50 samples each; NaijaVox-2.0 trained on 25,866 samples across 7 datasets with noise augmentation. Source: [Axiveri/NaijaVox-V1](https://huggingface.co/Axiveri/NaijaVox-V1); [Axiveri/NaijaVox-2.0](https://huggingface.co/Axiveri/NaijaVox-2.0) (self-reported, small samples)
- pidgin-wav2vec2-xlsr53: Apache-2.0, Pidgin WER 29.6% test / 31.6% validation. Source: [asr-nigerian-pidgin README](https://huggingface.co/asr-nigerian-pidgin/pidgin-wav2vec2-xlsr53/blob/ef054d180073f6515a0396ff8dcffa296116563a/README.md); [arXiv 2010.11123](https://arxiv.org/abs/2010.11123v2)
- Sunbird faster-whisper-51-african-languages: Whisper large-v3 fine-tune covering 51 African languages (CTranslate2 format). Source: [Sunbird on HF](https://huggingface.co/Sunbird/faster-whisper-51-african-languages) (Pidgin/Yoruba numbers not seen)
- Gemma 4 E2B/E4B/12B do ASR and speech translation, audio up to 30 s; FLEURS WER 0.09 (E2B), 0.08 (E4B), 0.069 (12B) averaged over FLEURS languages. Source: [Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4) (fetched; last updated 2026-07-30)

### Inferences
- Default pipeline: Whisper large-v3-turbo (q5/q8 via whisper.cpp or faster-whisper) on the creator's own machine, or whisper base/small in-browser via whisper.wasm/transformers.js on weak devices, accepting the accuracy drop. Add a "language: Yoruba/Hausa/Igbo/Pidgin" option that switches to a community fine-tune only after its licence is checked.
- Pidgin and code-switched Nigerian English is the realistic worst case. Clip selection should lean on non-speech signals (laughter, cheering, music drops, motion) so that ASR errors do not dominate highlight choice.
- Do not fine-tune on NaijaVoices or AfriSpeech-200 if Selects will ever charge money, unless a commercial waiver is obtained.

### Gaps
- Official Whisper FLEURS WER for Yoruba/Hausa (Whisper paper appendix) not retrieved; reportedly very high (UNVERIFIED).
- Meta MMS licence (CC-BY-NC 4.0 per training knowledge) not confirmed.
- Spitch API pricing, free tier, and whether it requires a card: no results found.
- Google USM: not an open model; availability via Chirp in Google Cloud needs billing (UNVERIFIED).
- CHiME benchmark WER for Whisper/Parakeet: not found in this session.
- distil-whisper (distil-large-v3.5) numbers: not found. Note distil-whisper models are English-only (UNVERIFIED).
- Whether Gemma 4's FLEURS average includes Yoruba/Hausa/Igbo: not stated.

## Vision: embeddings, aesthetics, faces, OCR, shots, motion

### Takeaway
For browser use, CLIP ViT-B/32 or SigLIP (base) through transformers.js, MediaPipe face detection, Tesseract.js or Florence-2 base for OCR, and ffmpeg scene filtering or simple frame differencing cover the main visual signals at zero cost. MobileCLIP is the most phone-friendly CLIP, but its weights are research-only, so it is blocked for a commercial product. TransNetV2 clearly beats PySceneDetect on hard shot transitions.

### Cited Findings
- SigLIP 2 so400m-patch14-384: Apache-2.0; paper 20 Feb 2025; multilingual; checkpoint safetensors size field shows ~1B params. Source: [google/siglip2-so400m-patch14-384](https://huggingface.co/google/siglip2-so400m-patch14-384) (fetched)
- transformers.js lists CLIP, SigLIP, MobileCLIP, Florence2, TrOCR, SAM/SAM2/SAM3; SigLIP2 not seen. Source: [transformers.js README](https://github.com/huggingface/transformers.js) (fetched)
- MobileCLIP / MobileCLIP2: S0 11.4M image + 42.4M text params, 1.5 + 1.6 ms latency, 67.8% IN-1k zero-shot; MobileCLIP2-S0 71.5%; MobileCLIP2-S4 81.9%; v1 weights on HF 13 Jun 2024; MobileCLIP2 released 28 Aug 2025; code MIT, models under Apple ML Research Model TOU, data CC-BY-NC-ND. Source: [apple/ml-mobileclip](https://github.com/apple/ml-mobileclip) (fetched)
- Apple ML Research Model TOU: "exclusively for Research Purposes", excludes "any commercial exploitation, product development or use in any commercial product or service", revocable; derivatives also research-only. Source: [LICENSE_MODELS](https://github.com/apple/ml-mobileclip/blob/main/LICENSE_MODELS) (fetched)
- TransNetV2 ClipShots F1 77.9 (authors). Source: [TransNetV2 paper, arXiv 2008.04838](https://arxiv.org/pdf/2008.04838); in NVIDIA's Cosmos evaluation, TransNetV2 0.726 vs PySceneDetect 0.477 on ClipShots, 0.967 vs 0.889 on BBC. Source: [Cosmos paper, arXiv 2501.03575](https://arxiv.org/pdf/2501.03575)
- PySceneDetect: BSD-3-Clause; v0.6.7 dated 24 Aug 2025. Source: [ecosyste.ms](https://science.ecosyste.ms/projects/33269); 86 FPS on MSU-Shot (secondary). Source: [hyper.ai](https://vercel.hyper.ai/en/papers/1705.03281)

### Inferences
- A cheap "visual interest" score per second can be built from: shot-cut density (ffmpeg scene or TransNetV2), motion energy (mean absolute frame difference on downscaled frames), face presence and size (MediaPipe), and CLIP/SigLIP text-prompt similarity ("people dancing", "goal celebration"). All run in a browser tab.
- Aesthetic scoring (LAION predictor) needs CLIP ViT-L/14 (~900 MB fp32, inference), which is heavy for low-data users; using it server-side or skipping it is more realistic.

### Gaps
- Licences and sizes for LAION aesthetic predictor, BlazeFace/MediaPipe Face Detector, Tesseract.js, PaddleOCR, EasyOCR, Florence-2, TransNetV2, OpenCLIP: not fetched this session (training knowledge: MIT, Apache-2.0, Apache-2.0, Apache-2.0, Apache-2.0, MIT, MIT, MIT respectively; all UNVERIFIED).
- SigLIP 2 base/large sizes and ImageNet numbers: shown only in image tables.
- Optical-flow speed in opencv.js on Android: no source found.

## Video LLMs (Gemma 4, Qwen-VL, InternVL3, LLaVA-Video, VideoLLaMA3, SmolVLM2) and free API tiers

### Takeaway
Gemma 4 is real and verified: released 2 Apr 2026 under Apache-2.0 in E2B, E4B, 26B A4B MoE and 31B sizes, with a 12B "Unified" audio-capable model added later (card lists five sizes). Video is handled as frames, capped at 60 s at 1 fps per the model card, so it is a clip-judge, not a full-video scanner. Gemma 4 and Gemini Flash/Flash-Lite are "Free of charge" on the Gemini API free tier with no billing needed, but free-tier inputs are used to improve Google products. Exact free-tier rate limits are only shown in AI Studio and conflict across secondary sources.

### Cited Findings
- Gemma 4 announced 2 Apr 2026; sizes E2B, E4B, 26B MoE (3.8B active), 31B dense; Apache-2.0 "commercially permissive"; "All models natively process video and images"; E2B/E4B add native audio input; 128K (edge) / 256K (larger) context; E2B/E4B run offline on phones, Raspberry Pi, Jetson Orin Nano; 31B and 26B available in Google AI Studio, E2B/E4B via AI Edge Gallery; 31B ranked #3 open model, 26B #6 on Arena text leaderboard at launch. Source: [Google blog: Gemma 4](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/) (2 Apr 2026, fetched)
- Gemma 4 model card (last updated 2026-07-30): E2B 2.3B effective (5.1B with embeddings), 35 layers, 128K, text/image/audio; E4B 4.5B effective (8B), 42 layers, 128K, text/image/audio; 12B Unified 11.95B, 48 layers, 256K, text/image/audio; 26B A4B 25.2B total / 3.8B active (8 of 128 experts + 1 shared), 256K, text/image; 31B 30.7B, 60 layers, 256K, text/image. "Video supports a maximum of 60 seconds assuming the images are processed at one frame per second." Audio max 30 s, ASR and speech translation only, E2B/E4B/12B only. Image token budgets 70/140/280/560/1120, lower recommended for video. No video benchmarks reported. Licence Apache-2.0. Page notes docs moving to gemma.ai. Source: [Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4) (fetched)
- 12B said to be added June 2026 by a third-party guide (UNVERIFIED date). Source: [Codersera Gemma 4 guide](https://codersera.com/blog/gemma-4-complete-guide-2026/); drafter models for speculative decoding reportedly released 16 Apr 2026 (UNVERIFIED) - same guide; Wikipedia gives 2 Apr 2026 release. Source: [Wikipedia: Gemma](https://en.wikipedia.org/wiki/Gemma_(language_model))
- Browser: onnx-community/gemma-4-E2B-it-ONNX q4f16 runs in transformers.js with WebGPU (Chrome/Edge 113+), with image and audio input; first run "may take several minutes"; no tokens/s figures; video not covered. Source: [PyImageSearch, 27 Jul 2026](https://pyimagesearch.com/2026/07/27/running-gemma-4-in-the-browser-with-transformers-js-and-webgpu/) (fetched)
- q4f16 files visible in that repo: decoder 1.52 GB + embed_tokens 1.59 GB + audio encoder 171 MB + vision encoder 99.2 MB, about 3.38 GB total (listing truncated). Source: [onnx-community/gemma-4-E2B-it-ONNX files](https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/tree/main/onnx) (fetched)
- A community text-only WebGPU W4 build of E2B strips vision and audio weights. Source: [NZM0/gemma-4-E2B-it-webgpu-w4](https://huggingface.co/NZM0/gemma-4-E2B-it-webgpu-w4)
- Gemini API pricing page (last updated 2026-10-19): Free tier "Free of charge" for Gemma 4, Gemini 3.8 Flash, 3.6 Flash, 3 Flash Preview, 2.5 Flash, 3.5 Flash-Lite, 3.1 Flash-Lite, 2.5 Flash-Lite; free-tier content "used to improve our products": Yes (paid: No); Gemma 4 has no paid tier ("Not available"); Batch and Flex have no free tier; paid examples: 3.8/3.6 Flash $0.75 per 1M input through 31 Dec 2026, rising to $1.50 from 1 Jan 2027; 2.5 Flash-Lite $0.10 text/image/video, $0.30 audio. Source: [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) (fetched)
- Gemini rate-limits page (last updated 2026-10-15) does not publish free-tier numbers; refers to AI Studio; Free tier qualification is "Active project or free trial"; moving to paid requires setting up billing. Source: [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) (fetched)
- Secondary sources conflict on free RPD: about 20 RPD for 3.x Flash and 500 RPD for Flash-Lite (Sep to Oct 2026 guides) vs 1,500 RPD in others; Pro models said to be removed from free tier in April 2026. Source: [TinkerLLM](https://tinkerllm.com/blog/gemini-api-free-tier-limits-rate-quotas/); [AIPromptsHub](https://aipromptshub.co/blog/gemini-api-free-tier-rate-limits); [PE Collective](https://pecollective.com/tools/gemini-free-tier-guide/) (all UNVERIFIED)
- Gemini video understanding (last updated 2026-10-13): default 1 fps; low media resolution ~100 tokens/s (66 per frame + 32 audio), high ~300 tokens/s (258 per frame); 1M-token models handle up to 3 h (low res) or 1 h (high res); YouTube URLs free preview, public only, free tier up to 8 h of YouTube video per day; up to 10 videos per request for 2.5+; File API 2 GB free / 20 GB paid; MM:SS timestamp queries supported. Source: [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) (fetched)
- Qwen3-VL family: dense 2B, 4B, 8B, 32B; MoE 30B-A3B, 235B-A22B; 256K native context (1M with extension); paper 27 Nov 2025; Charades-STA evaluated at 4 fps; 235B reaches 100% needle accuracy in videos up to 30 min; 2B card Apache-2.0 with "timestamp-grounded event localization". Source: [Qwen3-VL Technical Report](https://arxiv.org/html/2511.21631v2); [Qwen/Qwen3-VL-2B-Instruct](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct) (fetched)
- Qwen3-VL-235B-A22B Instruct at 64.8 on Charades-STA per an aggregator (zero-shot status unclear, UNVERIFIED). Source: [benchmarklist / anotherwrapper](https://anotherwrapper.com/tools/llm-pricing/evals/charadessta)
- Qwen2.5-VL-3B: Charades-STA mIoU 38.8, VideoMME 67.6/61.5, LVBench 43.3; January 2025; licence name not shown in fetched text. Source: [Qwen/Qwen2.5-VL-3B-Instruct](https://huggingface.co/Qwen/Qwen2.5-VL-3B-Instruct) (fetched)
- SmolVLM2 2.2B/500M/256M: Apache-2.0; Video-MME 52.1/42.2/33.7; MLVU 55.2/47.3/40.6; MVBench 46.27/39.73/32.7; 5.2 GB GPU RAM for video on 2.2B; quantized for llama.cpp, Ollama, LM Studio; paper 7 Apr 2025. Source: [HuggingFaceTB/SmolVLM2-2.2B-Instruct](https://huggingface.co/HuggingFaceTB/SmolVLM2-2.2B-Instruct) (fetched)

### Inferences
- Best zero-cost architecture: cheap on-device signals (audio events, motion, cuts, faces, ASR keywords) pick 10 to 30 candidate windows; then a VLM judges each 30 to 60 s window. On a strong laptop that judge can be Gemma 4 E2B in WebGPU (3.4 GB download once) or SmolVLM2 500M; otherwise the user's own free Gemini/Gemma API key with a hard stop on 429 (fail closed). The 60 s video cap on Gemma 4 fits this windowed design.
- For Nigerian users on low data budgets, any browser VLM over a few hundred MB is unrealistic on mobile data. The Gemini API with YouTube URL input (no upload, free tier 8 h/day) is the lowest-data path, but only for public YouTube videos, and Google may use the content to improve products, which must be disclosed.
- Because free-tier quotas are not published outside AI Studio and have been cut repeatedly in 2026 per secondary sources, the product should read 429/quota errors and degrade to on-device scoring rather than assume a fixed RPD.

### Gaps
- Official free-tier RPM/TPM/RPD per model (AI Studio dashboard, login required): not obtainable.
- Whether the Gemini API free tier is available to Nigerian accounts in Oct 2026: not checked.
- QVHighlights numbers for any of these VLMs: none found. Charades-STA numbers per Qwen3-VL size: table not readable.
- InternVL3, LLaVA-Video, VideoLLaMA3 sizes, licences and benchmarks: not fetched; their weights generally inherit Qwen2/Qwen2.5 base licences (UNVERIFIED), and Qwen2.5-VL-3B is believed to use the non-commercial "Qwen Research" licence (UNVERIFIED).
- Gemma 4 E2B tokens/s on WebGPU and on Android (LiteRT-LM): no published figures found.

## Beat tracking and music analysis

### Takeaway
librosa (ISC, Python) and aubio are the clean options; Essentia/essentia.js and madmom carry licence traps: Essentia is AGPLv3 for non-commercial use with paid commercial licences, and its pre-trained models plus madmom's models are non-commercial. For a browser beat detector, a small custom onset/tempo function in Web Audio or aubio WASM (GPL) is safer than essentia.js for a commercial product.

### Cited Findings
- Essentia: "Affero GPLv3, for non-commercial applications", commercial licence from UPF; some algorithms use GPL/LGPL third-party libraries UPF cannot sublicense; all pre-trained models CC BY-NC-ND 4.0 for non-commercial use, proprietary licence on request. Source: [Essentia licensing](https://essentia.upf.edu/licensing_information.html) (via search snippet)
- madmom: source code BSD; model and data files CC BY-NC-SA 4.0; commercial use of files or technology using them requires contacting Gerhard Widmer; supports Python 2.7 / 3.5+. Source: [CPJKU/madmom](https://github.com/CPJKU/madmom) (fetched)

### Inferences
- essentia.js's own licence was not confirmed, but since it wraps Essentia, AGPL obligations would apply to a hosted web app that serves it (inference). If Selects stays fully open source under AGPL and non-commercial, this is workable; otherwise avoid.
- BeatNet likely inherits madmom's model licence issue if it depends on madmom features (UNVERIFIED).

### Gaps
- librosa licence (ISC per training knowledge), aubio licence (GPL-3.0), BeatNet licence (CC BY 4.0 per training knowledge): not confirmed in this session.
- No CPU speed figures for any beat tracker were found.

## Browser and phone feasibility for Nigerian users on low data budgets

### Takeaway
Under ~100 MB total, a browser tab can run YAMNet (MediaPipe), Silero VAD, MediaPipe face detection, Moonshine tiny/base or whisper tiny/base (whisper.wasm 75 to 142 MiB), CLIP-B/32-class embeddings (quantized), and ffmpeg.wasm scene detection. Anything VLM-class (Gemma 4 E2B q4f16 ~3.4 GB, SmolVLM2 2.2B) is laptop-only and a heavy one-time download; on Android it is better served by Google's AI Edge Gallery or LiteRT-LM than the browser.

### Cited Findings
- MediaPipe Audio Classifier runs on Web and Android, 12.29 ms on Pixel 6 CPU. Source: [MediaPipe Audio Classifier](https://developers.google.com/edge/mediapipe/solutions/audio/audio_classifier)
- whisper.cpp disk/RAM table and WASM support. Source: [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- Moonshine tiny 27M params. Source: [moonshine-base card](https://huggingface.co/UsefulSensors/moonshine-base)
- Silero VAD ~2 MB. Source: [silero-vad](https://github.com/snakers4/silero-vad)
- Gemma 4 E2B q4f16 ONNX ~3.38 GB visible; WebGPU requires Chrome/Edge 113+. Source: [HF files](https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/tree/main/onnx); [PyImageSearch](https://pyimagesearch.com/2026/07/27/running-gemma-4-in-the-browser-with-transformers-js-and-webgpu/)
- WebGPU global support about 70% as of Oct 2024 (old figure). Source: [HF transformers.js v3 blog](https://www.huggingface.co/blog/transformersjs-v3)
- Gemma 4 E2B/E4B run offline on phones via AI Edge Gallery. Source: [Google blog](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/)

### Inferences
- Rough data budget for a "lite" Selects in a tab: YAMNet (~4 MB, inference from 3.7M fp32 params) + Silero (~2 MB) + face detector (<1 MB, UNVERIFIED) + whisper base q5 (~60 MB, inference from 142 MiB fp16) + ffmpeg.wasm core (~30 MB, UNVERIFIED) is about 100 MB, cached after first load. That is a realistic one-time cost for Nigerian users; a 3.4 GB VLM is not.
- Low-end Android browsers often lack WebGPU, so WASM (CPU) paths must be the default and WebGPU an upgrade.

### Gaps
- Measured WASM real-time factors for whisper base/small on a mid-range Android phone: none found.
- Current (2026) WebGPU coverage on Android Chrome in Nigeria: not found.
