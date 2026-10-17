# Selects eval results

v2, generated 2026-10-17 17:57 UTC by `node eval/run-eval-v2.mjs --report`. The plan, hypotheses and tests were committed before judging: [eval/PLAN.md](../PLAN.md).

**n = 19 videos** (the first 15 minutes of each, 3591 candidate windows in total, 456 in the random sample R that the models judged). Excluded before judging: _iUeydyJc20 (whisper's transcript is unreliable); 74HTXDSsa-Q (whisper's transcript is unreliable); lDDq_HbDpN4 (36 foreign-language markers (dubbed audio?)); o_a-mslVsA0 (whisper's transcript is unreliable).

## Headline: does the model rank windows the way viewers replay them?

AUC is the chance that a window viewers replayed more than the video's median scores higher than one they replayed less (0.5 is a coin flip). Spearman rho is the rank correlation with replay intensity. Mean over videos, 95% bootstrap interval.

| Method | windows | n videos | AUC (95% CI) | Spearman rho (95% CI) |
|---|---|---|---|---|
| random (mean of 200 seeds) | random sample R | 19 | 0.50 (0.50 to 0.50) | 0.00 (-0.00 to 0.01) |
| energy: loudness and pace, no words | random sample R | 19 | 0.50 (0.42 to 0.58) | -0.03 (-0.17 to 0.10) |
| Selects stage 1 rules (pre-score) | random sample R | 19 | 0.54 (0.47 to 0.61) | 0.08 (-0.05 to 0.21) |
| **Gemma 4 26B-A4B** (Gemini API) | random sample R | 19 | 0.56 (0.49 to 0.62) | 0.09 (-0.02 to 0.20) |
| random (mean of 200 seeds) | all windows | 19 | 0.50 (0.50 to 0.50) | 0.00 (-0.00 to 0.00) |
| energy: loudness and pace, no words | all windows | 19 | 0.46 (0.40 to 0.53) | -0.10 (-0.22 to 0.02) |
| Selects stage 1 rules (pre-score) | all windows | 19 | 0.51 (0.46 to 0.57) | 0.03 (-0.08 to 0.14) |

## Pre-registered hypotheses

| | Hypothesis | n | effect (95% CI) | p | p (Holm) | result |
|---|---|---|---|---|---|---|
| H1 | Gemma 4 AUC on R above chance | 19 | 0.056 (-0.007 to 0.116) | 0.107 | 0.428 | not supported at this n |
| H2 | Gemma 4 minus pre-score, AUC on R | 19 | 0.020 (-0.058 to 0.094) | 0.643 | 1.000 | not supported at this n |
| H3 | Pre-score AUC over all windows above chance | 19 | 0.014 (-0.044 to 0.074) | 0.641 | 1.000 | not supported at this n |
| H4 | Gemma 4 minus energy, AUC on R | 19 | 0.056 (-0.025 to 0.130) | 0.192 | 0.575 | not supported at this n |
| H5 | Gemma 4 minus qwen 0.5B, AUC on R | 0 | not run | | | |
| H6 | Shipped (16) minus prefilter alone (16), hit@3 | 19 | -0.053 | 1.000 | - | not supported at this n |
| H7, H8 | Blind preference test | 0 | waiting for ratings | | | |

Effects are mean differences in AUC (H2, H4, H5), AUC minus 0.5 (H1, H3), or hit@3 difference (H6). p is a two-sided sign-flip permutation test over videos; H1 to H4 are Holm-corrected.

## Exploratory (not pre-registered)

| Analysis | windows | n | AUC (95% CI) | rho (95% CI) |
|---|---|---|---|---|
| Gemma 4, hook score alone | R | 19 | 0.56 (0.51 to 0.62) | 0.12 (-0.00 to 0.24) |
| Gemma 4, standalone score alone | R | 19 | 0.55 (0.50 to 0.61) | 0.05 (-0.07 to 0.18) |
| Gemma 4, payoff score alone | R | 19 | 0.52 (0.47 to 0.57) | 0.05 (-0.04 to 0.14) |
| Gemma 4, clarity score alone | R | 19 | 0.51 (0.45 to 0.57) | 0.01 (-0.09 to 0.12) |
| Gemma 4 blended with the pre-score (what the app ranks by) | R | 19 | 0.57 (0.51 to 0.64) | 0.12 (0.01 to 0.23) |
| Gemma 4 on the shortlist plus R | J | 19 | 0.51 (0.45 to 0.58) | 0.01 (-0.11 to 0.13) |
| pre-score on the shortlist plus R | J | 19 | 0.52 (0.46 to 0.58) | 0.05 (-0.06 to 0.16) |

Power: at the effects observed here, about 52 videos would give 80% power for Gemma 4 against chance, and about 633 for Gemma 4 against the pre-score (two-sided, alpha 0.05, normal approximation).

## Top picks against replay peaks (v1 metric)

| Method | n | hit@3 (95% CI) | hit@5 | mean best IoU (95% CI) |
|---|---|---|---|---|
| random | 19 | 24% (20% to 28%) | 37% | 0.12 (0.10 to 0.14) |
| energy | 19 | 16% (0% to 32%) | 16% | 0.10 (0.06 to 0.14) |
| pre-score over all windows | 19 | 32% (11% to 53%) | 47% | 0.12 (0.08 to 0.17) |
| prefilter alone (8) | 19 | 32% (11% to 53%) | 47% | 0.12 (0.08 to 0.17) |
| prefilter alone (16) | 19 | 32% (11% to 53%) | 47% | 0.12 (0.08 to 0.17) |
| Gemma 4 score only (8) | 19 | 5% (0% to 16%) | 32% | 0.10 (0.06 to 0.15) |
| Gemma 4 score only (16) | 19 | 16% (0% to 32%) | 32% | 0.11 (0.08 to 0.16) |
| Gemma 4 blend (16) | 19 | 16% (0% to 32%) | 32% | 0.11 (0.07 to 0.16) |
| **Selects as shipped** (8, blend + listwise) | 19 | 21% (5% to 42%) | 32% | 0.10 (0.06 to 0.14) |
| **Selects Smart mode** (16, blend + listwise) | 19 | 26% (11% to 47%) | 32% | 0.11 (0.07 to 0.16) |
| ceiling: best of the 8 | 19 | 53% (32% to 74%) | 53% | 0.21 (0.15 to 0.27) |
| ceiling: best of the 16 | 19 | 89% (74% to 100%) | 89% | 0.37 (0.33 to 0.42) |
| ceiling: best of all windows | 19 | 100% (100% to 100%) | 100% | 0.77 (0.73 to 0.81) |

## Faithful cuts

The check flagged 10 of 95 top picks (11%, 95% CI 6% to 18%) as "check" or "misleading". By issue: quote 3, qualifier 2, turn 3, reference 2. Its precision needs Arnold's marks on eval/results/faithful-review.md.

## Cost and time

Gemma 4 through the Gemini API: 895 fresh calls logged, free tier, $0. Rate-limited to 28 requests a minute. See the per-video `calls` in results-v2.json.

## Best and worst videos for Gemma 4 (AUC on R)

- **DEF CON 32 - Inside the FBI’s Secret Encrypted Phone Company ‘Anom’ - Joseph Cox** (DEFCONConference): AUC 0.82, pre-score 0.61. Selects' top pick, 10:07 to 10:29: "The DOJ is never going to admit this." Gemma: "Strong conspiracy hook, but ends abruptly on a server location without a punchline."
- **IELTS Speaking Test- Perfect Band 9 [+ Free Speaking PDF]** (IELTS Advantage): AUC 0.25, pre-score 0.26. Selects' top pick, 9:53 to 10:49: "Pronunciation is one of your strong points." Gemma: "The topic is clear, but the payoff ends on a demonstration rather than a punchline."

## Per video

| Video | windows | punctuation restored | Gemma 4 AUC (R) | pre-score AUC (R) | energy AUC (R) | shipped hit@3 |
|---|---|---|---|---|---|---|
| [LIVE NURSING INTERVIEW](https://www.youtube.com/watch?v=Aj0nf3rKG_E) | 101 | no | 0.62 | 0.67 | 0.30 | 1 |
| [💥7 POWERFUL Body Language Hacks for Job Interviews](https://www.youtube.com/watch?v=ASvx-QG6o04) | 122 | yes | 0.68 | 0.73 | 0.58 | 0 |
| [Lecture 1: Introduction to Information Theory](https://www.youtube.com/watch?v=BCiZc0n6COY) | 134 | no | 0.53 | 0.59 | 0.50 | 0 |
| [Lecture 1: The Keys to Critical Thinking](https://www.youtube.com/watch?v=C5FzMblXU4M) | 158 | no | 0.44 | 0.54 | 0.38 | 0 |
| [Lecture 1 - How to Start a Startup (Sam Altman, Dustin ](https://www.youtube.com/watch?v=CBYhVcO4WgI) | 234 | no | 0.66 | 0.38 | 0.59 | 0 |
| ["I'm a Machine" An interview with Fabiano Caruana / Gib](https://www.youtube.com/watch?v=G9NabGlnDCs) | 142 | no | 0.72 | 0.60 | 0.63 | 1 |
| [Nigerians Are Better Off Than Kenyans - Tinubu; Ghana P](https://www.youtube.com/watch?v=Gij3hiWXJ88) | 218 | no | 0.61 | 0.58 | 0.88 | 0 |
| [Sheryl Sandberg Gives UC Berkeley Commencement Keynote ](https://www.youtube.com/watch?v=iqm-XEqpayc) | 234 | no | 0.60 | 0.35 | 0.40 | 1 |
| [Keynote — Blender Conference 2025](https://www.youtube.com/watch?v=JXm0-ilIknE) | 204 | no | 0.62 | 0.30 | 0.70 | 1 |
| [IELTS Speaking Test- Perfect Band 9 [+ Free Speaking PD](https://www.youtube.com/watch?v=k4715CJ0Ii8) | 182 | no | 0.25 | 0.26 | 0.22 | 0 |
| [Research Methods S1 - Why We Do Research](https://www.youtube.com/watch?v=luM2Y4otHUY) | 196 | no | 0.51 | 0.52 | 0.41 | 0 |
| [Lecture 1: Course Overview + Introduction to the Shell](https://www.youtube.com/watch?v=MSgoeuMqUmU) | 213 | no | 0.66 | 0.79 | 0.33 | 0 |
| [Machine Intelligence - Lecture 1 (methods, history, def](https://www.youtube.com/watch?v=tExPpuk-UQ8) | 231 | no | 0.57 | 0.50 | 0.38 | 1 |
| [DEF CON 32 - Inside the FBI’s Secret Encrypted Phone Co](https://www.youtube.com/watch?v=uFyk5UOyNqI) | 168 | no | 0.82 | 0.61 | 0.81 | 0 |
| [An Honest Conversation on AI and Humanity / World Econo](https://www.youtube.com/watch?v=VoRbPxyo2uU) | 205 | no | 0.43 | 0.35 | 0.53 | 0 |
| [Teni The Entertainer On How Her Career Has Evolved - He](https://www.youtube.com/watch?v=vRVV1hq9WXE) | 224 | no | 0.30 | 0.75 | 0.69 | 0 |
| [Craig Ferguson: The TRUTH about Late Night / FULL EPISO](https://www.youtube.com/watch?v=wBoEsrpnPHA) | 223 | no | 0.39 | 0.38 | 0.27 | 0 |
| [Living as an Intersex Individual (Hermaphrodite) in Lag](https://www.youtube.com/watch?v=xlAyUkscaFg) | 256 | no | 0.56 | 0.55 | 0.44 | 0 |
| [The Power of Being Alone / Sadhguru Jaggi Vasudev](https://www.youtube.com/watch?v=Yiaatr-Noh0) | 146 | no | 0.63 | 0.74 | 0.49 | 0 |

## Caveats

- **Most Replayed is a proxy** for what people rewatch or seek to. It is not a judgement of which moment makes the best short, and replays cluster around visual moments an audio-only picker cannot see.
- **The heatmap is coarse:** about 100 segments per video, so each value covers 9 to 54 s of the full video. Window intensities that overlap the same segments are not independent.
- **R is a random sample of 24 windows per video** outside the shortlists, so model AUCs measure ranking across the whole talk, not only among the strong candidates. AUC among the shortlist alone (column J in results-v2.json) is reported separately.
- **Videos are not a random sample of talks.** They are the CC BY videos with heatmaps that YouTube search returned, filtered to English audio.
- **n videos is the unit of inference.** Per-window AUCs are averaged within a video first, so long videos do not count more.
- Gemma 3 4B is not in v2: at about 75 s per window on this laptop it could not judge 40 windows for 20 videos in time. v1 has its numbers.

## v1 (16 Oct, n = 6, hit@k only)

See [RESULTS-v1.md](RESULTS-v1.md) for the full v1 report. Its headline: the shipped 8-window shortlist could reach at most 67% hit@3, and no judge beat the prefilter alone at that n.
