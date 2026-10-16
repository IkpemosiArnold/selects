# Selects eval

Question: can a free open model on a 2017 laptop pick clips as well as humans do?

This folder measures that. Every method picks its top 5 clips (20 to 60 s) from the **same candidate windows** (built by `src/core/candidates.mjs` from whisper sentence boundaries), and the picks are compared with moments people chose.

## Ground truth

1. **YouTube Most Replayed (proxy, primary).** YouTube publishes a replay heatmap for popular videos: about 100 equal segments, each with a relative intensity from 0 to 1. `eval/heatmap.mjs` turns it into labels:
   1. Drop segments in the first and last 3% of the video (at least 30 s). The start is inflated by everyone pressing play, and the end by end screens.
   2. Threshold = the 75th percentile of the remaining values. A peak is a local maximum at or above it.
   3. Grow each peak over neighbouring segments that stay at or above half its height above the median (full width at half maximum), then clamp to 20 to 60 s around the peak segment.
   4. Keep the highest peaks first, skipping any that overlap a kept one, up to 5 per video.

   Videos longer than 20 minutes are evaluated on their **first 15 minutes only** (manifest `evalRange`), because whisper and Gemma are slow on this laptop. Their heatmap is restricted to that range before steps 1 to 4, and the end-screen rule is skipped.

   This is a proxy for "what viewers rewatch or seek to". It is not the same as "what makes a good short", and it is only accurate to one segment (about 9 to 27 s for these videos).
2. **Human picks.** `node eval/label.mjs` opens a local page where Arnold marks his own best 5 moments per video (keys: Space, J, L, I, O, A). Labels are saved into the manifest with `source: "human"`. Label blind: do not look at the heatmap or the model's picks first.

## Dataset

`eval/datasets/manifest.json` lists each video's URL, licence, licence URL, the evidence for the licence (the `license` field of yt-dlp's info JSON), and its labels. Only videos marked **Creative Commons Attribution** on YouTube (CC BY 3.0) with a heatmap and a length of 10 to 45 minutes are included. Trimmed info JSON (title, licence, heatmap) is kept in `eval/datasets/info/` for all 50 videos screened; `eval/datasets/selected.json` lists the 6 chosen for variety (three interviews, a lecture, a conference talk, a commencement speech). Two first picks were dropped because the audio track downloaded was an auto-dubbed or non-English track and whisper produced no usable English: a 14-minute lecture (B8vSLgaW9WQ) and a conversation with Linus Torvalds (Efi9wa4Fwds). A third, a three-person panel (ASvx-QG6o04), transcribed fine but almost without punctuation, so only 3 candidate windows survived the "ends mid-thought" rule; it was replaced too. Replacements: Aj0nf3rKG_E and iqm-XEqpayc, after checking 15-second snippets of each with whisper. The fetcher now prefers the original-language track. Audio is downloaded at the lowest available bitrate into `eval/media/` (gitignored).

```
node eval/fetch-datasets.mjs fetch <youtube ids...>   # info + audio in one yt-dlp call (needs Chrome cookies)
node eval/fetch-datasets.mjs build                    # rebuild the manifest from cached info
node eval/fetch-datasets.mjs video <id>               # 720p video for the demo
```

## Methods

Selects picks in two stages: a cheap no-LLM prefilter (`shortlist` in `src/core/candidates.mjs`, text rules plus time coverage) keeps the top N windows (the app's default is 8), and only those go to the model. The headline comparison is **prefilter alone** against **prefilter + model** on the same N windows, so the difference is what the LLM adds.

- `random`: random scores over all windows, averaged over 200 seeds (the chance level). `random:shortlist@N`: the same, within the N prefiltered windows.
- `energy`: no LLM. Mean loudness, loudness variation and words per second per window (z-scored and averaged), the signals cheap clippers use.
- `prescore`: the core's text rules ranking all windows. `prefilter@N`: the N shortlisted windows ranked by those rules (stage 1 alone).
- `judge:<model>@N`: the model scores the N windows with the rubric in `src/core/prompts/judge.md`; ranked by the model's own score (`judgeTotal`), then `src/core/rank.mjs` picks the top 5 with overlap suppression.
- `shipped:<model>@N`: the same calls, ranked as the app does (0.7 model score + 0.3 text-rule score). `shipped+list:<model>@N`: plus the listwise final round (one extra call comparing the best 4 side by side).
- `oracle` and `oracle:shortlist@N`: ceilings. If no window in the pool overlaps a label at IoU 0.5, no picker can hit it.

The default plan (`--plan`) runs, in order: qwen2.5:0.5b at N = 8, 16, 24; gemma3-4b-hf at N = 8 with the listwise round; gemma3-4b-hf at N = 16; qwen2.5:0.5b on all windows. Each entry runs on every video before the next starts. Per-call seconds and token counts come from Ollama's response (`judge-calls.jsonl`) and feed the cost table.

With 8 windows and k = 5, any picker takes most of the shortlist, so hit@3 and precision@3 separate methods better than hit@5.

## Metrics (`eval/metrics.mjs`)

- Temporal IoU = overlap / union of two windows.
- hit@k: 1 if any of the top k picks has IoU 0.5 or more with any label, per video, then averaged.
- precision@5: share of the top 5 picks that hit a label. recall@5: share of labels found by the top 5.
- mean best IoU: for each of the top 5 picks, its best IoU with any label, averaged. Less brittle than the 0.5 cut-off.
- 95% confidence intervals: percentile bootstrap over videos (2,000 resamples), shown only when n is 3 or more. Paired bootstrap for "judge minus baseline" on the same videos.
- Wall time per stage per video (transcribe, judge per model) is recorded on first run and kept in the cache.

## Running

```
node eval/run-eval.mjs                 # all videos, the default plan; resumable after a crash or power loss
node eval/run-eval.mjs --limit 4       # the 4 shortest videos
node eval/run-eval.mjs --report        # rebuild results from caches only
node --test eval/*.test.mjs
```

Heavy steps take `.selects/heavy.lock` (shared with the other builders) and wait while someone else holds it. Outputs: `eval/results/results.json`, `eval/results/RESULTS.md`, and `eval/results/curves/<id>.json` (interest curve per method, heatmap and labels, for the chart).
