# A judge that hears

Selects reads the transcript to pick clips. In a conversation, the moments people post are often in the delivery: a laugh, two voices at once, a voice going up, a pause before the punchline. This note covers which models can listen, where they run, what was built, and what was measured. Checked 29 Oct 2026.

## What was built (feat/audio-judge)

- **The hearing judge** (`src/core/hear-core.mjs`, `src/core/hear-node.mjs`). A listener scores 30 s stretches of the audio on a 15 s grid. A candidate window takes the best score among the stretches that overlap it by at least 15 s.
- **Two listeners:**
  - `cues`: no language model. It combines laughter (YAMNet frames, already computed for every job), how much two voices overlap (pyannote segmentation 3.0, int8, 1.5 MB, MIT) and how much the loudness moves. Each is a percentile within the recording, and the score is their mean.
  - `gemma3n`: Gemma 3n E2B listens to each stretch and answers one digit from 1 to 9. The score is read from the probabilities of the nine digits at the first answer token, so one forward pass is enough and the score is continuous.
- **Where it enters the ranking** (`HEAR_BLEND`, fixed before any private test):
  - The shortlist is drawn by 0.5 pre-score + 0.5 hearing, so a moment that sounds alive can reach the text judge even when its words look ordinary.
  - After judging, the total is 0.5 judge + 0.15 pre-score + 0.35 hearing.
- **Off by default.** The CLI turns it on with `--hear cues` or `--hear gemma3n`; the setting is `hear` in a job. If a listener cannot run, the job carries on from the words and says why (`job.hear.error`).

## Which runtimes take Gemma 3n audio (checked 29 Oct 2026)

| Runtime | Gemma 3n audio? | Source and date |
|---|---|---|
| Hugging Face transformers (Python) | Yes, since 4.53.0. Audio is capped at 30 s (`max_length=480_000` at 16 kHz), 6.25 audio tokens a second (188 per 30 s). | Release notes, 26 Jun 2025: https://github.com/huggingface/transformers/releases/tag/v4.53.0 ; feature extractor on main, read 29 Oct 2026: https://github.com/huggingface/transformers/blob/main/src/transformers/models/gemma3n/feature_extraction_gemma3n.py |
| Same, on this Mac | Not practical. E2B loads over 5B parameters without PLE caching (about 10 to 12 GB in bf16). The last PyTorch build for Intel Macs is 2.2.2, and current transformers needs torch 2.6 or newer. | https://ai.google.dev/gemma/docs/gemma-3n (updated 1 Nov 2025); https://dev-discuss.pytorch.org/t/pytorch-macos-x86-builds-deprecation-starting-january-2024/1690 |
| transformers.js 3.6 to 3.8 (Node, onnxruntime-node 1.21) | Yes. 3.6.0 added Gemma 3n with an audio example, Node only at the time. 3.x pins onnxruntime-node 1.21.0, the last release with a macOS Intel build. | https://github.com/huggingface/transformers.js/releases/tag/3.6.0 (26 Jun 2025) |
| transformers.js 4.x | Yes in the browser (WebGPU). In Node it needs onnxruntime-node 1.24 or newer, which ships no macOS x86_64 build and needs macOS 14. | https://github.com/microsoft/onnxruntime/releases/tag/v1.24.1 (6 Feb 2026) |
| ONNX weights | `onnx-community/gemma-3n-E2B-it-ONNX` at revision 3f5a07f (26 Jun 2025), the files transformers.js 3.x reads: audio encoder q4 430 MB, decoder q4 1,518 MB, embeddings q8 2,660 MB, about 4.6 GB in all. The current revision (March 2026, for v4) is smaller (q4f16 about 3.3 GB), but v4 cannot run in Node on this Mac. | https://huggingface.co/onnx-community/gemma-3n-E2B-it-ONNX/commits/main |
| llama.cpp | No. Gemma 3n gained image input only (PR #18256, merged 9 Jan 2026). | https://github.com/ggml-org/llama.cpp/pull/18256 |
| Ollama | No. The gemma3n page lists text and image input. | https://ollama.com/library/gemma3n (read 29 Oct 2026) |
| MLX / mlx-vlm | Yes, but MLX needs Apple silicon and macOS 14; this Mac is Intel. | https://ml-explore.github.io/mlx/build/html/install.html ; https://simonwillison.net/b/8801 (26 Jun 2025) |
| Gemini API, free tier | No audio for Gemma. The Gemma-on-Gemini-API page lists only `gemma-4-31b-it` and `gemma-4-26b-a4b-it` (updated 2 Jul 2026), and neither takes audio. Gemma 3n's API preview (20 May 2025) was text only. | https://ai.google.dev/gemini-api/docs/changelog ; https://ai.google.dev/gemma/docs/core/model_card_4 (updated 30 Jul 2026) |

Gemma 4 for comparison: E2B, E4B and 12B take audio (also capped at 30 s, but 25 tokens a second, four times Gemma 3n's). llama.cpp runs Gemma 4 E2B audio on the CPU (PR #21421, merged 12 Apr 2026; Q4_0 2.84 GB plus a 557 MB projector), and transformers.js 4.1+ runs it in the browser (`onnx-community/gemma-4-E2B-it-ONNX`, q4f16 about 3.3 GB). Ollama lists text and image only for gemma4. Sources: https://ai.google.dev/gemma/docs/capabilities/audio (updated 10 Oct 2026), https://github.com/ggml-org/llama.cpp/pull/21421.

**Chosen runtime for Gemma 3n on the desktop:** transformers.js 3.8.1 on onnxruntime-node 1.21.0, CPU, in a child process. It is the only path found that takes Gemma 3n audio on an Intel Mac with macOS 13. The repo already ships onnxruntime-node 1.21.0. The listener builds the three sessions it needs itself, so the vision encoder should never be downloaded or loaded; that has not been run end to end (below).

## What could not be done here

The Gemma 3n weights could not be downloaded during this work. The connection ran at 12 to 70 KB/s (HF, GitHub and Google all measured slow, and transfers were reset several times). At that rate 4.6 GB takes more than a day. So:

- The Gemma 3n listener is written and its processor path is checked: the prompt plus 30 s of audio is 308 tokens, the features are 2,997 x 128, the digits 1 to 9 are single tokens, and feature extraction takes 0.6 s.
- It has **not** produced a score. Its speed on this Mac, and whether it hears anything useful, are unmeasured.
- To finish the test, run `~/.selects/hear-lab/fetch-gemma3n.sh` (resumable), then `--phase gemma3n` in both eval scripts.
- Gemini models that do take audio (Flash) were not used as a stand-in. Unlike Gemma, they are paid on a billed project, and this work could not confirm that the key's project fails closed.

## Results so far

**Public eval v2** ([eval/results/EXPLORE-hear.md](../eval/results/EXPLORE-hear.md)). On 19 videos, the same random sample of 24 windows each:
- The `cues` listener alone scores AUC 0.55 (95% CI 0.47 to 0.64) against Most Replayed.
- Fused with the text judge, it scores 0.54 (0.48 to 0.61), against 0.53 for the text blend. The paired difference is +0.01 (-0.03 to 0.05, sign-flip p = 0.52).
- That is chance, like every text method before it.

**One private podcast.** A host named the four moments he would post. Ranked among 974 candidate windows, with the metric written down before the run:
- With the text judge as shipped, his picks rank 17, 44, 28 and 8: 0 in the top 5 and 1 in the top 10.
- Fused with `cues`, they rank 21, 38, not found and 9: again 0 and 1, and the mean reciprocal rank is lower (0.046 against 0.061).
- The listener does hear two of the picks as lively (their stretches rank 18th and 24th of 206). But many other stretches sound as lively, and one pick sounds calm to it.
- By the rule set beforehand, this is no gain. Four picks is a tiny sample.

**Speed on the 2017 MacBook Pro** (i5-7360U, CPU, other jobs running):
- `cues`: about 0.3 to 0.55 s per 30 s stretch, so a 51-minute recording (206 stretches) takes about 1.5 minutes.
- Gemma 3n: not measured. Two numbers set the scale. Its audio input is 188 tokens per 30 s, and the whole prompt is 308 tokens. On this laptop, Ollama read Gemma 3 4B prompts at about 12 to 21 tokens a second (notes/timings.md). The listener needs only that prompt pass and no generated text, so expect very roughly 15 to 40 s per stretch, which is about one to two hours for a 51-minute recording (206 stretches). That is an estimate, not a measurement.

**Decision:** hearing stays off by default and is labelled experimental. Turning it on is a choice to make only after Gemma 3n is measured on these same two tests.

## In the browser and on a phone

- **`cues` in the browser:** everything needed is already there or small. The browser build already runs YAMNet (sound.worker.js) on ONNX Runtime Web. Adding the 1.5 MB segmentation model to the same worker, and the loudness spread from the decoded PCM, would make it work. It is light enough for a phone: about 17 MB of models and well under a second per stretch on a laptop CPU.
- **Gemma 3n in the browser:** transformers.js 4.x (the browser build already uses 4.3.1) runs `onnx-community/gemma-3n-E2B-it-ONNX` on WebGPU, about 3.3 GB at q4f16. Gemma 4 E2B (`onnx-community/gemma-4-E2B-it-ONNX`, about 3.3 GB at q4f16, transformers.js 4.1+) also takes audio, at 25 tokens a second. Either would be a desktop-only, WebGPU-only, opt-in path, a second multi-GB download next to the 2 GB text judge. Not measured. Whether MediaPipe's web Gemma 4 E2B `.task` (the text judge the browser uses now) accepts audio was not verified.
- **On a phone:** no. Phones already skip the in-tab text judge (`inTabJudgeFits`). A 3 GB listener is further out of reach. Only `cues` fits a phone.
