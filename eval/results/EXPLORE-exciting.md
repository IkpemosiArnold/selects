# Exploratory: the social-worthiness judge against Most Replayed

Generated 2026-10-26 11:49 UTC by `node eval/explore-exciting.mjs --report`. **Not pre-registered.** The v2 plan, hypotheses and thresholds ([PLAN.md](../PLAN.md)) are unchanged, and nothing here replaces a v2 result. Same videos, same random sample R per video (rebuilt with the v2 code and checked against v2's own judge cache), same AUC, same bootstrap (10,000 resamples, seed 7). Judge: gemma-4-26b-a4b-it through the Gemini API, free tier.

| Method | n videos | AUC on R (95% CI) |
|---|---|---|
| v2 rubric, Gemma 4 score only | 19 | 0.56 (0.49 to 0.62) |
| new rubric, Gemma 4 score only | 19 | 0.53 (0.47 to 0.61) |
| v2: 0.7 judge + 0.3 v2 pre-score | 19 | 0.57 (0.51 to 0.64) |
| new: 0.7 judge + 0.3 new pre-score | 19 | 0.53 (0.46 to 0.60) |
| v2 pre-score | 19 | 0.54 (0.47 to 0.61) |
| new pre-score (with delivery) | 19 | 0.53 (0.45 to 0.61) |

| Paired difference (new minus v2) | n | mean (95% CI) | sign-flip p |
|---|---|---|---|
| judge score | 19 | -0.02 (-0.09 to 0.04) | 0.531 |
| blend | 19 | -0.04 (-0.10 to 0.01) | 0.152 |
| pre-score | 19 | -0.00 (-0.03 to 0.02) | 0.756 |

Sound: 19 of 19 videos analysed with YAMNet; 29 laughter events in all; 239 of 456 R windows carried a "(laughter)" or "(louder)" mark.

Caveats: Most Replayed measures what viewers rewatch in a long video, not what makes a good short; most of these 19 videos are talks and lectures, where the new rubric's target (laughs, banter, hot takes) is rare. A null result here does not show the new judge is worse at picking posts, and a positive one does not show it is better at that. The new rubric was written after a person named the moments they would post from one private recording; that recording is not part of this set.
