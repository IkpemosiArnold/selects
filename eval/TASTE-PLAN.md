# Taste model: evaluation plan (written before any taste run)

Written 29 Oct 2026, before the taste model (src/core/taste.mjs) has scored any eval window.
The model, its features and the rule for when it joins the ranking are fixed in commit
eaf73db (TASTE_RULE: minLabels 8, maxWeight 0.6, half 8, l2 4) and will not be changed
after seeing the results. There is also a private test on one creator's podcast (leave one of
his four picks out); its protocol and results stay on his machine and are not in this repo.

## Question
Does the learning loop work at all: when a creator's answers follow a pattern, does a model
fitted on some answers rank the other windows better than the generic ranking does?

## Data
The 19 videos of eval v2 and the same random sample R per video as
[EXPLORE-hear.md](results/EXPLORE-hear.md) (24 windows each, rebuilt with the eval v2 core at
commit 3eb0794), with the cached text judge answers (explore-exciting), the pre-score with
delivery and the cached cues hearing scores. Labels stand in for one creator: within each video,
a window above the median Most Replayed intensity is a Post, the rest Skips (the same split the
AUC uses). Nothing new is downloaded or judged.

## Simulations
- **A, half held out (the main test).** 20 repeats. In each, every video's R is split at random
  into two halves of 12. One model is fitted on the training halves of all 19 videos (about 228
  answers) and scores the other halves. Per video, AUC on the held-out half, averaged over the
  repeats.
- **B, the next video.** Leave one video out: fit on all R answers of the other 18 videos, score
  the held-out video's R.
- **C, one video, 12 answers.** Within each video only: fit on its own training half (12
  answers, as a creator answering one review), score its other half. 20 repeats.
- **Control.** As A, but the labels come from a rule over the features (Post when the judge's
  hook score is at least 4), to check the loop can learn a taste that is learnable.

## Arms (compared on the same held-out windows)
- Generic: the text blend, 0.7 judge + 0.3 pre-score (hearing off, as shipped).
- Taste blend, as shipped: TASTE_RULE's weight for the number of answers in the fit.
- Taste alone.
- Secondary: the taste blend with the cues hearing score as a feature.

## Statistics and what counts
Mean AUC over videos with a 95% bootstrap CI (10,000 resamples, seed 7), and the paired
difference (taste blend minus generic) with its CI and a sign-flip p, as in EXPLORE-hear.md.
The loop **works on this data** if the paired difference in A has a 95% CI above 0. If the CI
includes 0, the result is "no evidence it helps on Most Replayed", which can also mean Most
Replayed is not learnable from these features. The control should be high (AUC above 0.8); if
it is not, the loop itself is broken.

Caveats: Most Replayed is what viewers rewatch in a long video, not what one creator posts, and
every method so far scores 0.50 to 0.56 on it. A null result does not show the loop is useless
for one person's taste, and a positive one does not show it finds any one creator's picks.
