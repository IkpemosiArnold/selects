# Selects eval results

Generated 2026-10-16 01:43 UTC by `node eval/run-eval.mjs`. Machine: Intel i5-7360U (2 cores, 2017), 16 GB, no GPU.

Videos scored: **n = 6** of 6 in the manifest. Each method picks its top 5 clips (20 to 60 s) from the same candidate windows.

## Against YouTube Most Replayed peaks (proxy labels)

| Method | n | hit@3 (95% CI) | precision@3 | hit@5 | precision@5 | recall@5 | mean best IoU (95% CI) | judge time per video | s per window |
|---|---|---|---|---|---|---|---|---|---|
| random over all candidates (mean of 200 seeds) | 6 | 26% (22% to 31%) | 9% | 40% | 9% | 10% | 0.13 (0.12 to 0.15) | - | - |
| energy: loudness + speech rate, no LLM | 6 | 17% (0% to 50%) | 6% | 33% | 7% | 7% | 0.11 (0.03 to 0.21) | - | - |
| text rules over all candidates, no LLM | 6 | 33% (0% to 67%) | 17% | 33% | 10% | 12% | 0.09 (0.02 to 0.19) | - | - |
| random from the shortlist (mean of 200 seeds) | 6 | 30% (12% to 47%) | 11% | 43% | 10% | 11% | 0.10 (0.05 to 0.16) | - | - |
| **prefilter alone** (stage 1, no LLM) | 6 | 33% (0% to 67%) | 17% | 33% | 10% | 12% | 0.09 (0.02 to 0.19) | - | - |
| **prefilter + judge:qwen2.5:0.5b** | 1 | 100% | 67% | 100% | 40% | 50% | 0.32 | 2.0 min | 14.9 |
| ceiling: best possible from the shortlist | 6 | 67% (33% to 100%) | 28% | 67% | 17% | 18% | 0.17 (0.08 to 0.27) | - | - |
| ceiling: best possible from all candidates | 6 | 100% (100% to 100%) | 100% | 100% | 87% | 93% | 0.76 (0.71 to 0.81) | - | - |

## Against human picks

No human labels yet. Run `node eval/label.mjs` and mark 5 moments per video.

## Wall time per video and stage

| Video | evaluated length | windows (judged) | transcribe | judge qwen2.5:0.5b |
|---|---|---|---|---|
| "I'm a Machine" An interview with Fabiano Caruana / GibChess | 10:17 | 142 (8) | 3:21 | 1:59 |
| Lecture 1 - How to Start a Startup (Sam Altman, Dustin Mosko | 15:00 | 234 (8) | 3:34 | - |
| Sheryl Sandberg Gives UC Berkeley Commencement Keynote Speec | 15:00 | 230 (8) | 3:24 | - |
| DEF CON 32 - Inside the FBI’s Secret Encrypted Phone Company | 15:00 | 168 (8) | 5:06 | - |
| LIVE NURSING INTERVIEW | 17:10 | 114 (8) | 2:60 | - |
| IELTS Speaking Test- Perfect Band 9 [+ Free Speaking PDF] | 17:25 | 218 (8) | 4:27 | - |

## Judge cost per call (from Ollama's own counters)

| Model | calls | words per window | prompt tokens | prompt tok/s | output tokens | output tok/s | load s | wall s per call | wall per video (8 windows) | cost |
|---|---|---|---|---|---|---|---|---|---|---|
| qwen2.5:0.5b | 8 | 106.8 | 394.4 | 60.1 | 58.3 | 10.3 | 1.2 | 14.9 | 1:59 | $0 (local) |

Calls served from the cache are not counted. Load time is the model being read into memory, mostly on the first call.

## Best and worst examples (judge:qwen2.5:0.5b)

**Best: "I'm a Machine" An interview with Fabiano Caruana | GibChess** (mean best IoU 0.32)

- judge:qwen2.5:0.5b top pick: 3:39 to 4:34, best IoU with any peak 0.00. Hook: "How would you advise them that they should use the machine?" Reason: "The clip is a clear topic but no tension."
- Nearest replay peak: 5:14 to 5:34 (peak height 1)

## How to read this, and caveats

- **n is small (6 videos).** Confidence intervals are percentile bootstrap over videos; with n this small they are wide, and a difference whose interval crosses zero is not a finding.
- **Most Replayed is a proxy.** It records where viewers rewatch or seek to, which is not the same as where a good standalone short is. Replays also gather around slides, demos and jokes that need visual context, which an audio-only picker cannot see.
- **The heatmap is coarse.** YouTube gives about 100 segments per video (one per 6 to 27 s for these videos), so label boundaries are only accurate to a segment. Hit at IoU 0.5 is strict against such labels; the mean best IoU column and the two ceiling rows show how much is reachable at all.
- **Random is the chance level**, averaged over 200 seeds on the same candidate windows, so it is not a single lucky or unlucky draw.
- **The judge reads a shortlist**, as Selects does in a real job: the cheap text pre-score keeps ${videos[0]?.nShortlist ?? 8} windows spread over the video, and only those go to the model. With ${videos[0]?.nShortlist ?? 8} windows and k = 5, any picker takes most of the shortlist, so hit@3 and precision@3 are the columns that separate prefilter alone from prefilter + judge. The judge rows therefore measure the shipped pipeline (pre-score shortlist, then model). The shortlist ceiling row shows what that shortlist can reach at best.
- **Energy** scores loudness, loudness variation and words per second, the signals cheap clippers use. It does not read the words.
- Judge models run locally through Ollama on CPU. Time is wall time on this laptop while other work may share the CPU; treat it as an order of magnitude.
- Videos are Creative Commons BY on YouTube; see `eval/datasets/manifest.json` for each URL and licence.
