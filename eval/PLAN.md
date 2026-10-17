# Selects eval v2: pre-registered plan

Written and committed on Saturday 17 October 2026, before any v2 judging ran. The hypotheses, metrics, tests and thresholds below are fixed. Anything added later is labelled exploratory in the results.

## The question

Can a free open model pick clips from a long talk the way people do? v1 (n = 6 videos, hit@3) could not answer this: one binary outcome per video has almost no statistical power, and it scored a shortlist built differently from the one the app ships. v2 fixes both and adds a blind human preference test.

## What is measured

1. **The shipped selection path.** Windows and the shortlist come from `selectCandidates` in `src/core/select.mjs`, the same function the desktop app (`job.mjs`) and the browser app (`engine.js`) call. The transcript goes through the same steps as a job: whisper base.en (greedy), non-speech split, punctuation restore when whisper left full stops out, and the loudness track the pre-score reads.
2. **Videos.** About 20 YouTube videos marked Creative Commons Attribution (CC BY 3.0) that have a Most Replayed heatmap: talks, interviews, podcasts and lectures, including African speakers where we can find them. Only the first 15 minutes of each video are evaluated, and its heatmap is cut to the same range. Videos whose audio track is not the original English (auto-dubbed) are excluded before judging, by a 15 second whisper check.
3. **Ground truth.** YouTube's replay heatmap (about 100 segments, relative replay intensity 0 to 1). It is a proxy for what viewers rewatch, not for what makes a good short. Each window's **replay intensity** is the time-weighted mean heatmap value over the window. For hit@k, peaks are turned into labelled windows exactly as in v1 (`eval/heatmap.mjs`).

## Methods

| Method | What it scores |
|---|---|
| `random` | uniform random scores (chance) |
| `energy` | loudness, loudness variation and words per second; no words read |
| `prescore` | Selects' stage 1 text and loudness rules (`pre`) |
| `gemma4` | Gemma 4 26B-A4B through the Gemini API, the rubric in `src/core/prompts/judge.md`, model score only (`judgeTotal`) |
| `shipped` | Selects as shipped in Smart mode: shortlist of 16 by the pre-score, then 0.7 Gemma score + 0.3 pre-score |
| `qwen` | qwen2.5 0.5B locally (Ollama), same rubric |
| `gemma3-4b` | Gemma 3 4B locally, only where cached from v1 (it takes about 75 s per window on this laptop) |

**Windows judged by models, per video:** the 16-window shipped shortlist, plus a uniform random sample of 24 other windows (seed 2026, drawn before judging). The random sample, called **R**, is the unbiased set for per-window metrics. The rules-based methods score every window.

## Metrics

Per video, then averaged over videos, with 95% percentile bootstrap intervals over videos (10,000 resamples, seed 7):

- **AUC**: the probability that a window with above-median replay intensity (median within that video's window set) scores higher than one below it. Ties count one half. 0.5 is chance.
- **Spearman rho** between method score and replay intensity.
- **hit@3 and hit@5** at IoU 0.5 against the heatmap peaks (v1 metric, kept for continuity), and mean best IoU.

AUC and rho for model judges use the windows in R. For a paired comparison, both methods are scored on exactly the same windows (R).

**Tests.** Paired comparisons use a sign-flip permutation test on the per-video differences (all 2^n flips when n is 20 or less, otherwise 100,000 random flips, two-sided). A one-sample test against chance uses the same sign-flip test on AUC minus 0.5. The four primary hypotheses are corrected with Holm's method at alpha 0.05.

## Primary hypotheses

- **H1.** Gemma 4 ranks windows by replay intensity better than chance: mean AUC on R is above 0.5.
- **H2.** Gemma 4 beats the pre-score on the same windows: mean paired AUC difference on R is above 0.
- **H3.** The pre-score beats chance over all windows: mean AUC above 0.5.
- **H4.** Gemma 4 beats the energy baseline on R.

## Secondary hypotheses (no correction; reported with their p-values)

- **H5.** Gemma 4 beats qwen2.5 0.5B on R (size matters).
- **H6.** The shipped pipeline has a higher hit@3 than the prefilter alone (stage 1 ranked by pre-score) at the same shortlist size. Low power; expected to be inconclusive.
- **H7.** In the blind preference test, raters prefer Selects' top pick to a random window of the same length from the same video more than half the time (Wilson 95% interval above 50%).
- **H8.** Raters prefer Selects' top pick to the pre-score's top pick more than half the time.

## Blind preference test

`eval/prefer.mjs` serves pairs of clips from the same video, side by side in random order, each as its transcript and an audio player. The method is hidden. Raters answer "Which would you rather post?" with A, B or Neither. About 30 pairs: Selects' top pick against a random window of the same length (seed fixed), and against the pre-score's top pick (when they differ). Win rate = Selects wins / (wins + losses), "Neither" reported separately; Wilson 95% interval. Raters: Arnold and 2 or 3 friends, 10 minutes each.

## Faithful-cuts check

Run the faithful-cut check on the top 5 picks of every video and report how often it flags a cut (verdict "check" or "misleading"). Twenty examples, half flagged and half not, go to Arnold to mark right or wrong, which gives a rough precision and false negative rate.

## Stopping and honesty rules

- No method, prompt, threshold or window set is changed after seeing v2 results. Bugs that stop a method from running are fixed and reported.
- Every number in RESULTS.md comes from `eval/results/results.json`, which `node eval/run-eval-v2.mjs --report` rebuilds from cached model answers.
- If the API quota or time runs out, the report states the n actually judged.
- v1 (n = 6) results stay in RESULTS.md as "v1".
