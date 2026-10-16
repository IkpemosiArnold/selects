# Selects eval results

Generated 2026-10-16 00:27 UTC by `node eval/run-eval.mjs`. Machine: Intel i5-7360U (2 cores, 2017), 16 GB, no GPU.

Videos scored: **n = 1** of 6 in the manifest. Each method picks its top 5 clips (20 to 60 s) from the same candidate windows.

## Against YouTube Most Replayed peaks (proxy labels)

| Method | n | hit@3 (95% CI) | precision@3 | hit@5 | precision@5 | recall@5 | mean best IoU (95% CI) | judge time per video | s per window |
|---|---|---|---|---|---|---|---|---|---|
| random over all candidates (mean of 200 seeds) | 1 | 18% | 6% | 26% | 6% | 7% | 0.12 | - | - |
| energy: loudness + speech rate, no LLM | 1 | 0% | 0% | 0% | 0% | 0% | 0.10 | - | - |
| text rules over all candidates, no LLM | 1 | 100% | 67% | 100% | 40% | 50% | 0.32 | - | - |
| random from the shortlist (mean of 200 seeds) | 1 | 68% | 27% | 94% | 28% | 35% | 0.22 | - | - |
| **prefilter alone** (stage 1, no LLM) | 1 | 100% | 67% | 100% | 40% | 50% | 0.32 | - | - |
| ceiling: best possible from the shortlist | 1 | 100% | 67% | 100% | 40% | 50% | 0.40 | - | - |
| ceiling: best possible from all candidates | 1 | 100% | 100% | 100% | 60% | 75% | 0.69 | - | - |

## Against human picks

No human labels yet. Run `node eval/label.mjs` and mark 5 moments per video.

## Wall time per video and stage

| Video | evaluated length | windows (judged) | transcribe |
|---|---|---|---|
| "I'm a Machine" An interview with Fabiano Caruana / GibChess | 10:17 | 142 (8) | 3:21 | 

## How to read this, and caveats

- **n is small (1 video).** Confidence intervals are percentile bootstrap over videos; with n this small they are wide, and a difference whose interval crosses zero is not a finding.
- **Most Replayed is a proxy.** It records where viewers rewatch or seek to, which is not the same as where a good standalone short is. Replays also gather around slides, demos and jokes that need visual context, which an audio-only picker cannot see.
- **The heatmap is coarse.** YouTube gives about 100 segments per video (one per 6 to 27 s for these videos), so label boundaries are only accurate to a segment. Hit at IoU 0.5 is strict against such labels; the mean best IoU column and the two ceiling rows show how much is reachable at all.
- **Random is the chance level**, averaged over 200 seeds on the same candidate windows, so it is not a single lucky or unlucky draw.
- **The judge reads a shortlist**, as Selects does in a real job: the cheap text pre-score keeps ${videos[0]?.nShortlist ?? 8} windows spread over the video, and only those go to the model. With ${videos[0]?.nShortlist ?? 8} windows and k = 5, any picker takes most of the shortlist, so hit@3 and precision@3 are the columns that separate prefilter alone from prefilter + judge. The judge rows therefore measure the shipped pipeline (pre-score shortlist, then model). The shortlist ceiling row shows what that shortlist can reach at best.
- **Energy** scores loudness, loudness variation and words per second, the signals cheap clippers use. It does not read the words.
- Judge models run locally through Ollama on CPU. Time is wall time on this laptop while other work may share the CPU; treat it as an order of magnitude.
- Videos are Creative Commons BY on YouTube; see `eval/datasets/manifest.json` for each URL and licence.
