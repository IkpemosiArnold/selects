# Exploratory: a judge that hears, against Most Replayed

Generated 2026-10-29 14:54 UTC by `node eval/explore-hear.mjs --report`. **Not pre-registered.** The v2 plan, hypotheses and thresholds ([PLAN.md](../PLAN.md)) are unchanged. Same videos and the same random sample R per video as [EXPLORE-exciting.md](EXPLORE-exciting.md), the same text judge (its cached answers: gemma-4-26b-a4b-it through the Gemini API, free tier), the same AUC and bootstrap (10,000 resamples, seed 7).

Hearing: each listener scores 30 s stretches on a 15 s grid, and a window takes its best overlapping stretch. The fused score is the one the app uses when hearing is on: 0.5 judge + 0.15 pre-score + 0.35 hearing. Every window of R is judged here, so the hearing score's other job in the app (drawing the shortlist) is not measured.

| Method | n videos | AUC on R (95% CI) |
|---|---|---|
| Text judge score only | 19 | 0.53 (0.47 to 0.61) |
| Text blend (0.7 judge + 0.3 pre-score), the baseline | 19 | 0.53 (0.46 to 0.60) |
| Pre-score (with delivery) | 19 | 0.53 (0.45 to 0.61) |
| Hearing only: cues (laughter, overlap, loudness spread) | 19 | 0.55 (0.47 to 0.64) |
| Fused with cues | 19 | 0.54 (0.48 to 0.61) |

| Paired difference (minus the text blend) | n | mean (95% CI) | sign-flip p |
|---|---|---|---|
| Fused with cues | 19 | 0.01 (-0.03 to 0.05) | 0.518 |
| Hearing only: cues (laughter, overlap, loudness spread) | 19 | 0.02 (-0.09 to 0.13) | 0.751 |

Speed on a 2017 MacBook Pro (i5-7360U, CPU only): cues 0.55 s per 30 s stretch (median of 1067).

Gemma 3n: not measured here. Its 4.6 GB of weights could not be downloaded on this connection during the work (see notes/HEARING.md).

Caveats: Most Replayed measures what viewers rewatch in a long video, not what makes a good short, and most of these videos are talks and lectures with little laughter or banter, which is what the listener is for. A null result here does not show that hearing is useless for picking posts, and a positive one would not show it is better at that.
