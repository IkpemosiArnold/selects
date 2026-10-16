# Selects eval results

Generated 2026-10-16 01:02 UTC by `node eval/run-eval.mjs`. Machine: Intel i5-7360U (2 cores, 2017), 16 GB, no GPU.

Videos scored: **n = 4** of 6 in the manifest. Each method picks its top 5 clips (20 to 60 s) from the same candidate windows.

## Against YouTube Most Replayed peaks (proxy labels)

| Method | n | hit@3 (95% CI) | precision@3 | hit@5 | precision@5 | recall@5 | mean best IoU (95% CI) | judge time per video | s per window |
|---|---|---|---|---|---|---|---|---|---|
| random over all candidates (mean of 200 seeds) | 4 | 27% (20% to 33%) | 10% | 41% | 10% | 11% | 0.14 (0.13 to 0.15) | - | - |
| energy: loudness + speech rate, no LLM | 4 | 25% (0% to 75%) | 8% | 50% | 10% | 10% | 0.15 (0.05 to 0.25) | - | - |
| text rules over all candidates, no LLM | 4 | 25% (0% to 75%) | 17% | 25% | 10% | 13% | 0.09 (0.00 to 0.24) | - | - |
| random from the shortlist (mean of 200 seeds) | 4 | 25% (0% to 51%) | 10% | 35% | 9% | 11% | 0.11 (0.03 to 0.19) | - | - |
| **prefilter alone** (stage 1, no LLM) | 4 | 25% (0% to 75%) | 17% | 25% | 10% | 13% | 0.09 (0.00 to 0.24) | - | - |
| ceiling: best possible from the shortlist | 4 | 50% (0% to 100%) | 25% | 50% | 15% | 18% | 0.17 (0.05 to 0.32) | - | - |
| ceiling: best possible from all candidates | 4 | 100% (100% to 100%) | 100% | 100% | 85% | 94% | 0.79 (0.72 to 0.84) | - | - |

## Against human picks

No human labels yet. Run `node eval/label.mjs` and mark 5 moments per video.

## Wall time per video and stage

| Video | evaluated length | windows (judged) | transcribe |
|---|---|---|---|
| "I'm a Machine" An interview with Fabiano Caruana / GibChess | 10:17 | 142 (8) | 3:21 | 
| Lecture 1 - How to Start a Startup (Sam Altman, Dustin Mosko | 15:00 | 234 (8) | 3:34 | 
| Sheryl Sandberg Gives UC Berkeley Commencement Keynote Speec | 15:00 | 230 (8) | 3:24 | 
| DEF CON 32 - Inside the FBI’s Secret Encrypted Phone Company | 15:00 | 168 (8) | 5:06 | 

## How to read this, and caveats

- **n is small (4 videos).** Confidence intervals are percentile bootstrap over videos; with n this small they are wide, and a difference whose interval crosses zero is not a finding.
- **Most Replayed is a proxy.** It records where viewers rewatch or seek to, which is not the same as where a good standalone short is. Replays also gather around slides, demos and jokes that need visual context, which an audio-only picker cannot see.
- **The heatmap is coarse.** YouTube gives about 100 segments per video (one per 6 to 27 s for these videos), so label boundaries are only accurate to a segment. Hit at IoU 0.5 is strict against such labels; the mean best IoU column and the two ceiling rows show how much is reachable at all.
- **Random is the chance level**, averaged over 200 seeds on the same candidate windows, so it is not a single lucky or unlucky draw.
- **The judge reads a shortlist**, as Selects does in a real job: the cheap text pre-score keeps ${videos[0]?.nShortlist ?? 8} windows spread over the video, and only those go to the model. With ${videos[0]?.nShortlist ?? 8} windows and k = 5, any picker takes most of the shortlist, so hit@3 and precision@3 are the columns that separate prefilter alone from prefilter + judge. The judge rows therefore measure the shipped pipeline (pre-score shortlist, then model). The shortlist ceiling row shows what that shortlist can reach at best.
- **Energy** scores loudness, loudness variation and words per second, the signals cheap clippers use. It does not read the words.
- Judge models run locally through Ollama on CPU. Time is wall time on this laptop while other work may share the CPU; treat it as an order of magnitude.
- Videos are Creative Commons BY on YouTube; see `eval/datasets/manifest.json` for each URL and licence.
