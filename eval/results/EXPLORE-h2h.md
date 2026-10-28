# Exploratory: the head-to-head round against Most Replayed

Generated 2026-10-28 11:53 UTC by `node eval/explore-h2h.mjs --report`. **Not pre-registered.** The v2 plan, hypotheses and thresholds ([PLAN.md](../PLAN.md)) are unchanged. Same videos and the same random sample R per video as [EXPLORE-exciting.md](EXPLORE-exciting.md), the same absolute judge (its cached answers), the same AUC and bootstrap (10,000 resamples, seed 7). Judge: gemma-4-26b-a4b-it through the Gemini API, free tier.

The head-to-head round as the app runs it in Smart mode: the best 12 distinct windows of R by the absolute blend (half of R's 24) play 6 Swiss rounds in both orders, ordered by a Bradley-Terry fit with a first-position term; the rest keep the blend's order. 1368 pair calls in all.

| Method | n videos | AUC (95% CI) |
|---|---|---|
| Absolute judge score only | 19 | 0.53 (0.47 to 0.61) |
| Absolute blend (0.7 judge + 0.3 pre-score), the baseline | 19 | 0.53 (0.46 to 0.60) |
| Blend, then head-to-head on the top 12 | 19 | 0.50 (0.45 to 0.56) |
| Inside the gate: the blend's order | 19 | 0.53 (0.45 to 0.61) |
| Inside the gate: the head-to-head order | 19 | 0.52 (0.42 to 0.63) |

| Paired difference (head-to-head minus blend) | n | mean (95% CI) | sign-flip p |
|---|---|---|---|
| whole ranking of R | 19 | -0.03 (-0.06 to 0.01) | 0.192 |
| inside the gate | 19 | -0.01 (-0.08 to 0.07) | 0.833 |

Position bias: the fitted first-position term averaged 0.272 on the logit scale (the clip shown first won about 57% of evenly matched pairs), and the two orders of one pair agreed 80% of the time. Asking both orders is what keeps that habit out of the ranking. "Inside the gate" leaves out videos whose gated windows were all above or all below the median.

Caveats: Most Replayed measures what viewers rewatch in a long video, not what makes a good short, and most of these videos are talks and lectures. The gate here is half of a random sample, not the best windows of a video, so the round compares ordinary windows, not near-equals at the top.
