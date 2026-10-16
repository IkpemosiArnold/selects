# Selects eval results

Generated 2026-10-16 02:26 UTC by `node eval/run-eval.mjs`. Machine: Intel i5-7360U (2 cores, 2017), 16 GB, no GPU, on battery power at times.

Videos: **n = 6** (manifest: 6). Every method picks its top 5 clips (20 to 60 s) from the same sentence-snapped candidate windows. A pick hits when its time overlap with a label is IoU 0.5 or more. Rows marked with a smaller n are still running.

## Headline: against YouTube Most Replayed peaks (8 windows judged, the shipped default)

| Method | n | hit@3 (95% CI) | precision@3 | hit@5 | recall@5 | mean best IoU (95% CI) |
|---|---|---|---|---|---|---|
| random over all windows (mean of 200 seeds) | 6 | 26% (22% to 31%) | 9% | 40% | 10% | 0.13 (0.12 to 0.15) |
| energy: loudness + speech rate, no LLM | 6 | 17% (0% to 50%) | 6% | 33% | 7% | 0.11 (0.03 to 0.21) |
| **prefilter alone** (top 8 by text rules, no LLM) | 6 | 33% (0% to 67%) | 17% | 33% | 12% | 0.09 (0.02 to 0.19) |
| random from the 8 prefiltered windows | 6 | 30% (12% to 47%) | 11% | 43% | 11% | 0.10 (0.05 to 0.16) |
| ceiling: best possible from the 8 prefiltered windows | 6 | 67% (33% to 100%) | 28% | 67% | 18% | 0.17 (0.08 to 0.27) |
| ceiling: best possible from all windows | 6 | 100% (100% to 100%) | 100% | 100% | 93% | 0.76 (0.71 to 0.81) |

## Quality against time: how many windows the model reads

hit@3 / mean best IoU for each shortlist size, and estimated judge minutes per video (N windows times the measured seconds per call for that model on this laptop).

| windows judged | ceiling | prefilter alone | qwen2.5:0.5b | gemma3-4b | qwen2.5:0.5b min/video | gemma3-4b min/video |
|---|---|---|---|---|---|---|
| 8 | 67% / 0.17 | 33% / 0.09 | not run | not run | 2.0 | - |
| 16 | 100% / 0.40 | 33% / 0.09 | not run | not run | 4.1 | - |
| 24 | 100% / 0.51 | 33% / 0.09 | not run | not run | 6.1 | - |
| all (184 on average) | 100% / 0.76 | 33% / 0.09 | not run | not run | 47 | - |

## Against human picks

No human labels yet. Run `node eval/label.mjs` and mark 5 moments per video.

## Ceiling by shortlist size (no LLM)

The best any judge could do if it were perfect, by how many prefiltered windows it reads (mean over videos):

| windows | 4 | 8 | 12 | 16 | 24 | 36 | all |
|---|---|---|---|---|---|---|---|
| ceiling hit@3 | 33% | 67% | 83% | 100% | 100% | 100% | 100% |
| ceiling recall@5 | 12% | 18% | 28% | 43% | 57% | 72% | 93% |
| ceiling mean best IoU | 0.09 | 0.17 | 0.28 | 0.40 | 0.51 | 0.61 | 0.76 |

## Wall time per video

| Video | evaluated length | windows | transcribe | judge qwen2.5:0.5b@8 | judge qwen2.5:0.5b@16 | judge qwen2.5:0.5b@24 | judge gemma3-4b@8 | judge gemma3-4b@16 | judge qwen2.5:0.5b@all |
|---|---|---|---|---|---|---|---|---|---|
| "I'm a Machine" An interview with Fabiano Caruana  | 10:17 | 142 | 3:21 | - | - | - | - | - | - |
| Lecture 1 - How to Start a Startup (Sam Altman, Du | 15:00 | 234 | 3:34 | - | - | - | - | - | - |
| Sheryl Sandberg Gives UC Berkeley Commencement Key | 15:00 | 230 | 3:24 | - | - | - | - | - | - |
| DEF CON 32 - Inside the FBI’s Secret Encrypted Pho | 15:00 | 168 | 5:06 | - | - | - | - | - | - |
| LIVE NURSING INTERVIEW | 17:10 | 114 | 2:60 | - | - | - | - | - | - |
| IELTS Speaking Test- Perfect Band 9 [+ Free Speaki | 17:25 | 218 | 4:27 | - | - | - | - | - | - |

Judge times are measured wall time for that run. A larger shortlist reuses cached calls for windows a smaller one already judged, so use the per-call cost below for estimates.

## Judge cost per call (Ollama's own counters)

| Model | call | calls | words in | prompt tokens | prompt tok/s | output tokens | output tok/s | load s | wall s per call | cost |
|---|---|---|---|---|---|---|---|---|---|---|
| qwen2.5:0.5b | one window | 48 | 115.3 | 405.6 | 68.2 | 60.3 | 11.2 | 0.5 | 15.2 | $0, local |

Only fresh calls are logged; cache hits cost nothing. Load is the model being read into memory, mostly on a model's first call.

## How to read this, and caveats

- **n is small (6 videos).** Confidence intervals are percentile bootstrap over videos (2,000 resamples); with n this small they are wide, and a difference whose interval includes zero is not a finding.
- **Most Replayed is a proxy.** It records where viewers rewatch or seek to, which is not the same as where a good standalone short is. Replays also gather around slides, demos and jokes that need visual context, which an audio-only picker cannot see.
- **The heatmap is coarse.** YouTube gives about 100 segments per video (one per 6 to 27 s for these videos), so label boundaries are only accurate to a segment. Hit at IoU 0.5 is strict against such labels; mean best IoU and the ceiling rows show how much is reachable at all.
- **Random is the chance level**, averaged over 200 seeds on the same windows, so it is not a single lucky or unlucky draw.
- **Two stages.** Selects first keeps 8 windows with cheap text rules spread over the video, then the model scores only those. With 8 windows and k = 5, any picker takes most of the shortlist, so hit@3 and precision@3 separate "prefilter alone" from "prefilter + model" better than hit@5. "Model score only" ranks by the model's rubric score; "shipped blend" is what the app ranks by (0.7 model score + 0.3 text-rule score).
- **Energy** scores loudness, loudness variation and words per second, the signals cheap clippers use. It does not read the words.
- Judge models run locally through Ollama on CPU. Times are wall time on this laptop with other apps open; treat them as an order of magnitude.
- Videos longer than 20 minutes are evaluated on their first 15 minutes, with labels from the heatmap inside that range.
- Videos are Creative Commons BY on YouTube; see `eval/datasets/manifest.json` for each URL and licence.
