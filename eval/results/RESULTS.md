# Selects eval results

Generated 2026-10-16 17:19 UTC by `node eval/run-eval.mjs`. Machine: Intel i5-7360U (2 cores, 2017), 16 GB, no GPU, on battery power at times.

Videos: **n = 6** (manifest: 6). Every method picks its top 5 clips (20 to 60 s) from the same sentence-snapped candidate windows. A pick hits when its time overlap with a label is IoU 0.5 or more. Rows marked with a smaller n are still running.

## Headline: against YouTube Most Replayed peaks (8 windows judged, the shipped default)

| Method | n | hit@3 (95% CI) | precision@3 | hit@5 | recall@5 | mean best IoU (95% CI) |
|---|---|---|---|---|---|---|
| random over all windows (mean of 200 seeds) | 6 | 26% (22% to 31%) | 9% | 40% | 10% | 0.13 (0.12 to 0.15) |
| energy: loudness + speech rate, no LLM | 6 | 17% (0% to 50%) | 6% | 33% | 7% | 0.11 (0.03 to 0.21) |
| **prefilter alone** (top 8 by text rules, no LLM) | 6 | 33% (0% to 67%) | 17% | 33% | 12% | 0.09 (0.02 to 0.19) |
| random from the 8 prefiltered windows | 6 | 30% (12% to 47%) | 11% | 43% | 11% | 0.10 (0.05 to 0.16) |
| **prefilter + qwen2.5:0.5b** (8 windows, model score only) | 6 | 33% (0% to 67%) | 17% | 33% | 12% | 0.11 (0.04 to 0.20) |
| **prefilter + gemma3-4b** (8 windows, model score only) | 6 | 17% (0% to 50%) | 6% | 17% | 3% | 0.06 (0.03 to 0.09) |
| prefilter + qwen2.5:0.5b, shipped blend 0.7 model + 0.3 text rules (8) | 6 | 33% (0% to 67%) | 17% | 33% | 12% | 0.11 (0.04 to 0.20) |
| prefilter + gemma3-4b, shipped blend 0.7 model + 0.3 text rules (8) | 6 | 17% (0% to 50%) | 6% | 17% | 3% | 0.06 (0.03 to 0.09) |
| prefilter + gemma3-4b, shipped blend + listwise round (8) | 6 | 17% (0% to 50%) | 6% | 17% | 3% | 0.06 (0.03 to 0.09) |
| ceiling: best possible from the 8 prefiltered windows | 6 | 67% (33% to 100%) | 28% | 67% | 18% | 0.17 (0.08 to 0.27) |
| ceiling: best possible from all windows | 6 | 100% (100% to 100%) | 100% | 100% | 93% | 0.76 (0.71 to 0.81) |

## Quality against time: how many windows the model reads

hit@3 / mean best IoU for each shortlist size, and estimated judge minutes per video (N windows times the measured seconds per call for that model on this laptop).

| windows judged | ceiling | prefilter alone | qwen2.5:0.5b | gemma3-4b | qwen2.5:0.5b min/video | gemma3-4b min/video |
|---|---|---|---|---|---|---|
| 8 | 67% / 0.17 | 33% / 0.09 | 33% / 0.11 | 17% / 0.06 | 3.7 | 7.0 |
| 16 | 100% / 0.40 | 33% / 0.09 | 33% / 0.13 | 33% / 0.15 | 7.4 | 14.0 |
| 24 | 100% / 0.51 | 33% / 0.09 | 17% / 0.10 | not run | 11.1 | - |
| all (184 on average) | 100% / 0.76 | 33% / 0.09 | 25% / 0.12 (n=4) | not run | 85 | - |

## Paired differences on the same videos

Bootstrap 95% CI over videos. An interval that includes 0 means no clear difference at this n.

| Comparison | n | hit@3 difference | mean best IoU difference |
|---|---|---|---|
| judge:qwen2.5:0.5b@8 vs prefilter@8 | 6 | +0.00 (0.00 to 0.00) | +0.01 (0.00 to 0.04) |
| judge:qwen2.5:0.5b@8 vs random | 6 | +0.07 (-0.29 to 0.45) | -0.02 (-0.10 to 0.07) |
| judge:qwen2.5:0.5b@16 vs prefilter@16 | 6 | +0.00 (-0.50 to 0.50) | +0.03 (-0.04 to 0.10) |
| judge:qwen2.5:0.5b@16 vs random | 6 | +0.07 (-0.28 to 0.42) | -0.00 (-0.08 to 0.07) |
| judge:qwen2.5:0.5b@24 vs prefilter@24 | 6 | -0.17 (-0.50 to 0.00) | +0.01 (-0.10 to 0.08) |
| judge:qwen2.5:0.5b@24 vs random | 6 | -0.10 (-0.30 to 0.23) | -0.03 (-0.08 to 0.03) |
| judge:gemma3-4b@8 vs prefilter@8 | 6 | -0.17 (-0.50 to 0.00) | -0.03 (-0.15 to 0.04) |
| judge:gemma3-4b@8 vs random | 6 | -0.10 (-0.30 to 0.23) | -0.07 (-0.11 to -0.03) |
| judge:gemma3-4b@16 vs prefilter@16 | 6 | +0.00 (-0.50 to 0.50) | +0.06 (-0.10 to 0.20) |
| judge:gemma3-4b@16 vs random | 6 | +0.07 (-0.27 to 0.41) | +0.02 (-0.06 to 0.10) |
| judge:qwen2.5:0.5b@all vs prefilter@all | 4 | +0.00 (-0.75 to 0.75) | +0.02 (-0.14 to 0.16) |
| judge:qwen2.5:0.5b@all vs random | 4 | -0.00 (-0.31 to 0.50) | -0.01 (-0.03 to 0.02) |
| judge:gemma3-4b@8 vs judge:qwen2.5:0.5b@8 | 6 | -0.17 (-0.50 to 0.00) | -0.05 (-0.16 to 0.03) |
| judge:gemma3-4b@16 vs judge:qwen2.5:0.5b@16 | 6 | +0.00 (-0.50 to 0.50) | +0.03 (-0.12 to 0.18) |
| shipped+list:gemma3-4b@8 vs shipped:gemma3-4b@8 | 6 | +0.00 (0.00 to 0.00) | +0.00 (0.00 to 0.00) |
| shipped:qwen2.5:0.5b@8 vs judge:qwen2.5:0.5b@8 | 6 | +0.00 (0.00 to 0.00) | +0.00 (0.00 to 0.00) |
| shipped:qwen2.5:0.5b@16 vs judge:qwen2.5:0.5b@16 | 6 | +0.00 (0.00 to 0.00) | +0.00 (0.00 to 0.00) |
| shipped:qwen2.5:0.5b@24 vs judge:qwen2.5:0.5b@24 | 6 | +0.00 (0.00 to 0.00) | +0.00 (0.00 to 0.00) |
| shipped:gemma3-4b@8 vs judge:gemma3-4b@8 | 6 | +0.00 (0.00 to 0.00) | +0.00 (0.00 to 0.00) |
| shipped:gemma3-4b@16 vs judge:gemma3-4b@16 | 6 | -0.17 (-0.50 to 0.00) | +0.00 (0.00 to 0.00) |
| shipped:qwen2.5:0.5b@all vs judge:qwen2.5:0.5b@all | 4 | +0.00 (0.00 to 0.00) | -0.02 (-0.06 to 0.00) |

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
| "I'm a Machine" An interview with Fabiano Caruana  | 10:17 | 142 | 3:21 | 1:53 | 2:12 | 1:11 | 6:14 + 92 s list | 7:28 | 16:12 |
| Lecture 1 - How to Start a Startup (Sam Altman, Du | 15:00 | 234 | 3:34 | 2:40 | 1:31 | 1:34 | 7:42 + 76 s list | 6:20 | 29:51 |
| Sheryl Sandberg Gives UC Berkeley Commencement Key | 15:00 | 230 | 3:24 | 2:27 | 0:58 | 1:12 | 6:42 + 83 s list | 6:12 | - |
| DEF CON 32 - Inside the FBI’s Secret Encrypted Pho | 15:00 | 168 | 5:06 | 1:35 | 1:28 | 1:26 | 6:05 + 75 s list | 9:30 | 282:04 |
| LIVE NURSING INTERVIEW | 17:10 | 114 | 2:60 | 2:16 | 1:46 | 1:06 | 5:54 + 114 s list | 9:07 | - |
| IELTS Speaking Test- Perfect Band 9 [+ Free Speaki | 17:25 | 218 | 4:27 | 1:54 | 1:08 | 1:22 | 6:47 + 82 s list | 5:58 | 27:40 |

Judge times are measured wall time for that run. A larger shortlist reuses cached calls for windows a smaller one already judged, so use the per-call cost below for estimates.

## Judge cost per call (Ollama's own counters)

| Model | call | calls | words in | prompt tokens | prompt tok/s | output tokens | output tok/s | load s | wall s per call | cost |
|---|---|---|---|---|---|---|---|---|---|---|
| qwen2.5:0.5b | one window | 861 | 123.0 | 414.7 | 112.4 | 60.3 | 17.9 | 0.3 | 27.7 | $0, local |
| gemma3-4b | one window | 96 | 113.8 | 416.5 | 15.7 | 60.6 | 3.3 | 0.4 | 52.5 | $0, local |
| gemma3-4b | listwise round | 6 | n/a | 336.5 | 7.2 | 135.7 | 3.6 | 0.2 | 87.0 | $0, local |

Only fresh calls are logged; cache hits cost nothing. Load is the model being read into memory, mostly on a model's first call.

## Best and worst examples (prefilter + gemma3-4b (8 windows, model score only))

**Best: LIVE NURSING INTERVIEW** (mean best IoU 0.11)

- Top pick: 9:05 to 10:00, best IoU with any replay peak 0.56. Opens: ""What do you think is the most important aspect of great customer service?"" Model's reason: "The 'feeling like they're the only one', instantly grabs attention, but the rambling loses focus."
- Nearest replay peak: 9:06 to 9:37 (peak height 0.427)

**Worst: Lecture 1 - How to Start a Startup (Sam Altman, Dustin Moskovitz)** (mean best IoU 0.00)

- Top pick: 1:16 to 1:58, best IoU with any replay peak 0.00. Opens: "Guest speakers are going to teach 17 of the 20 classes." Model's reason: "The ‘startups are the way of the future’ statement is a strong, memorable takeaway."
- Nearest replay peak: 4:16 to 5:16 (peak height 0.34)

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
