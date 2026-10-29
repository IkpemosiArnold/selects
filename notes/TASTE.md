# Learning one creator's taste

Four ways of ranking clips (the text judge, a social-worthiness rubric, head to head and a judge that hears) all missed the four moments one podcast host would post from his own 51-minute recording: none of them had any of the four in its top 5. On the public eval every method scores about 0.50 to 0.56 AUC against Most Replayed. A generic "what is viral" judge does not find one person's taste, so Selects now asks the person and learns from the answers. Written 29 Oct 2026.

## What was built (feat/taste)

- **About ten clips per video, none overlapping** (`k` 10, `REVIEW_IOU` 0 in src/core/rank.mjs). A short video with fewer distinct moments is filled up to ten with clips that overlap a kept one a little (at most 0.3, the old limit).
- **Post or Skip.** The review's Approve is now Post (P, A or the right arrow). Each card leads with why the clip is worth posting. The clip's opening line, its times, the judge's scores and the trim tools sit behind a tap. Saving or sharing a rendered clip also counts as a Post. Bulk "approve the best N" and `--yes` do not count.
- **Labels stay on the device** and keep numbers only, never words, times or audio: the judge's four sub-scores, the pre-score, the hearing score (when hearing is on), laughter, raised voices, quick short lines (a stand-in for turns between speakers, since there is no diarisation), pace, length, and whether the window was built around a laugh (src/core/taste.mjs `TASTE_FEATURES`).
  - Browser: IndexedDB, beside the saved jobs (src/browser/taste-store.js).
  - Desktop and CLI: `~/.selects/taste/labels.json`, or the file `--labels <file>` names (src/core/taste-node.mjs).
- **The model:** L2-regularised logistic regression over standardised features, balanced between Posts and Skips, fitted in a few Newton steps (milliseconds, so it refits in the tab after every answer).
- **When it counts** (`TASTE_RULE`, fixed before any test): from 8 answers with at least one Post and one Skip. Then the ranking sorts by (1 - w) x percentile(generic total) + w x percentile(taste), where w = 0.6 x m / (m + 8) and m is the smaller of Posts and Skips. So 4 Posts and 8 Skips give w = 0.2, and w never reaches 0.6. The generic total is kept for the quality bar.
- **The quiet line:** "Learning from your 12 picks" (or "3 picks so far"), with what it means and "Forget my picks" behind a tap.
- **CLI:** `--labels <file>` learns from and adds to that file; `selects review <job> --labels <file>` ranks a judged job again without judging; `selects taste` shows the answers and what the model leans on; `selects taste reset` forgets them.
- **Setting:** `taste` is `"auto"` by default; `"off"` ignores the answers for a job.

## Results

### Public: does the loop learn at all? ([EXPLORE-taste.md](../eval/results/EXPLORE-taste.md))
Plan written and committed before the run ([TASTE-PLAN.md](../eval/TASTE-PLAN.md)). Most Replayed stands in for a creator: within each of the 19 eval v2 videos, a window above the median intensity is a Post.

| Simulation | Generic AUC | Taste blend AUC | Blend minus generic (95% CI) |
|---|---|---|---|
| A. Half of each video held out (the main test, 228 answers) | 0.54 | 0.55 | +0.01 (-0.02 to 0.05), p 0.58 |
| B. The next video (fitted on the other 18) | 0.53 | 0.52 | -0.01 (-0.05 to 0.04), p 0.75 |
| C. One video, 12 answers | 0.54 | 0.55 | +0.01 (0.00 to 0.03), p 0.04 |
| Control: a learnable rule (hook score 4 or 5) | 0.96 | 0.98 | +0.02 (0.00 to 0.03) |

- By the rule set beforehand, A's interval includes 0: **no evidence the blend helps on Most Replayed.** That can also mean Most Replayed is not learnable from these features.
- The control shows the loop itself works: taste alone reaches AUC 1.00 on a pattern that is in its features.
- One hint, not a finding: within a single video, a model from 12 answers alone scored 0.61 (0.56 to 0.67) against 0.54 for the generic score. Most Replayed varies more within a video than across videos, which is what a per-creator loop would need. The shipped blend, shrunk at 12 answers, kept only a sliver of that (+0.01).

### Private: one host's four picks, leave one out
Protocol written before the run and kept with the private data. Each fit used 3 of his picks as Posts and 9 random judged windows as Skips (12 answers, so w = 0.16), 50 seeds.
- As shipped, the held-out picks' ranks did not move (median ranks equal to the generic ranking's for all four; top-10 hits 1 and 1). Verdict by the rule written beforehand: **no visible change.**
- At the most the rule ever allows (w = 0.6), it was worse: top-10 hits 1 to 0, mean reciprocal rank 0.061 to 0.052.
- One pick was never judged, so no model applied after judging can lift it. A model that chose what the judge reads would have to; that is not built.
- Four picks is a tiny sample, and the Skips were drawn at random, not his own.

## Decision
- Collecting answers stays on: it costs nothing, stays on the device, and it is the only way to get the data that would show whether this works.
- The blend stays on `"auto"`: below 8 answers it does nothing, and at a few dozen answers it moves the order a little. It has **not** been shown to help. Test it again on the host's own Post and Skip answers once there are about 30, and turn it off by default if it does not beat the generic order then.
