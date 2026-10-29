# Exploratory: learning a creator's taste, with Most Replayed as the creator

Generated 2026-10-29 17:57 UTC by `node eval/explore-taste.mjs`. The plan was written and committed before the run: [TASTE-PLAN.md](../TASTE-PLAN.md). The v2 plan ([PLAN.md](../PLAN.md)) is unchanged. Same 19 videos and the same random sample R per video (24 windows) as [EXPLORE-hear.md](EXPLORE-hear.md), the same cached text judge answers (gemma-4-26b-a4b-it through the Gemini API, free tier), the same AUC and bootstrap (10,000 resamples, seed 7).

The model is src/core/taste.mjs as committed before the run: L2 logistic regression over the judge's sub-scores, the pre-score, laughter, pace, length and the like (never words), blended with the generic ranking at TASTE_RULE's weight (0.6 x m / (m + 8), m the smaller of Posts and Skips, from 8 answers). Labels: within each video, a window above the median Most Replayed intensity is a Post. Every AUC is on held-out windows only; 20 random splits per simulation where there is a split.

| Simulation | answers in a fit | taste weight | Generic AUC | Taste blend AUC | Taste alone AUC | Blend minus generic (95% CI) | sign-flip p |
|---|---|---|---|---|---|---|---|
| A. Half of each video held out, one model from the other halves of all videos | 228 | 0.56 | 0.54 (0.47 to 0.60) | 0.55 (0.49 to 0.60) | 0.54 (0.49 to 0.58) | 0.01 (-0.02 to 0.05) | 0.581 |
| B. The next video: fitted on the other 18 videos, scored on this one | 432 | 0.58 | 0.53 (0.46 to 0.60) | 0.52 (0.46 to 0.59) | 0.51 (0.45 to 0.57) | -0.01 (-0.05 to 0.04) | 0.754 |
| C. One video, 12 answers: fitted on its own half, scored on the other half | 12 | 0.23 | 0.54 (0.47 to 0.60) | 0.55 (0.49 to 0.62) | 0.61 (0.56 to 0.67) | 0.01 (0.00 to 0.03) | 0.036 |
| A with the cues hearing score as a feature (secondary) | 228 | 0.56 | 0.54 (0.47 to 0.60) | 0.55 (0.50 to 0.61) | 0.55 (0.50 to 0.59) | 0.02 (-0.02 to 0.06) | 0.314 |
| Control: labels from a rule (Post when the judge's hook score is 4 or 5), as A | 228 | 0.47 | 0.96 (0.94 to 0.99) | 0.98 (0.96 to 0.99) | 1.00 (1.00 to 1.00) | 0.02 (0.00 to 0.03) | 0.016 |

Taste alone minus generic: half 0.00 (-0.06 to 0.07); next -0.02 (-0.09 to 0.05); one 0.08 (0.01 to 0.15); halfHear 0.01 (-0.05 to 0.08); control 0.04 (0.01 to 0.06).

Fitted on every answer of all 19 videos, the model leans on: laughs +0.48, laughP -0.47, energy +0.22, peak -0.15, hook +0.14, pace -0.14, standalone +0.07, pre +0.06, exchanges -0.06, lateBeat -0.05, moment -0.05, len -0.05, share -0.03 (weights on standardised features).

Caveats: Most Replayed is what viewers rewatch in a long video, not what one creator posts, and every method so far scores about 0.50 to 0.56 on it. A null result here does not show the loop is useless for one person's taste, and a positive one would not show it finds any one creator's picks. The control shows only that the loop can learn a pattern that is in its features.
