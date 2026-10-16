# Measured timings (core)

Every number here comes from a real run on this Mac: Intel i5-7360U (2 cores, 4 threads), 16 GB, no GPU, Ollama 0.12.5, judge model `gemma3-4b-hf:latest` (Gemma 3 4B Q4_K_M imported from a Hugging Face GGUF), whisper.cpp `ggml-base.en`. None are estimates. Conditions were poor and are part of the result: load average between 30 and 300 during the runs, other builders' whisper and Ollama jobs, Time Machine, Spotlight and Chrome running.

Source: the 6-minute excerpt (03:00 to 09:00) of the EMF 2026 talk in `notes/test-media.md`, 720x576 SD, 360.2 s. Job `j_20261016_01j3`.

## End to end: 6 minutes of video to 3 captioned clips

Run 1 (16 Oct, 00:33 WAT): `selects .selects/media/strength-talk-6min.mp4 --yes --k 3`. It stopped on judge call 3 (see "Failures" below).
Run 2 (01:00 WAT), after the fix: `selects review j_20261016_01j3 --yes`. This re-ran candidates and judging on the saved transcript, then rendered.

| Stage | Wall time | Note |
|---|---|---|
| Probe and 60 filmstrip thumbnails | 3.2 s | keyframes only (58 thumbnails came out) |
| Transcribe (whisper greedy, 2 threads) | 419.9 s (7.0 min) | 1,232 words; 0.86x real time, so slower than the video itself; load average about 250 |
| Candidates and pre-score | under 0.1 s | 68 sentences; 37 windows passed the prefilter; 8 sent to the judge |
| Judge, 8 clips | 652.3 s (10.9 min) | 81.5 s per clip on average |
| Render 3 clips (1080x1920, x264 veryfast) | 45.8 s, 49.6 s, 41.7 s | for clips of 41.0 s, 50.9 s, 40.4 s: about 1.1x the clip length |
| Posting kit (Gemma, one call per clip) | 119.7 s, 98.2 s, 80.8 s | title, caption, hashtags |
| Render stage total | 7.3 min | renders plus posting kits |

Total for run 2: 1,089 s wall (18.2 min). With run 1's transcription, a 6-minute video took about 25 minutes of machine time from file to three posted-ready clips, under heavy load. Re-rendering the same 3 clips later (new caption layout) took 76.6 s, 62.3 s and 46.7 s, which shows how much the load moves these numbers.

## Judge calls, one row per Ollama request

Ollama options: temperature 0.2, num_ctx 2048, num_predict 80, keep_alive 30m, JSON schema format. Rubric (system message) about 200 tokens, the same bytes on every call. Calls 1 and 2 are from run 1 (old prompt, reason first); calls 3 to 10 are run 2.

| Call | Clip words | Prompt tokens | Prompt s | Prompt tok/s | Output tokens | Output s | Output tok/s | Load s | Wall s |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 99 | 397 | 519.0 | 0.76 | 54 | 88.1 | 0.61 | 27.9 | 643.7 |
| 2 | 81 | 377 | 122.2 | 3.08 | 53 | 39.8 | 1.33 | 0.8 | 165.7 |
| 3 | 65 | 352 | 36.8 | 9.55 | 59 | 19.2 | 3.07 | 0.3 | 58.1 |
| 4 | 92 | 379 | 21.8 | 17.38 | 80 (cut off, salvaged) | 41.6 | 1.92 | 0.5 | 70.1 |
| 5 | 182 | 497 | 71.1 | 6.99 | 66 | 51.3 | 1.29 | 0.5 | 125.1 |
| 6 | 142 | 449 | 50.5 | 8.89 | 72 | 21.3 | 3.38 | 0.6 | 74.0 |
| 7 | 100 | 394 | 63.1 | 6.24 | 61 | 29.3 | 2.08 | 0.4 | 94.4 |
| 8 | 158 | 467 | 54.6 | 8.56 | 61 | 20.6 | 2.97 | 0.6 | 77.8 |
| 9 | 191 | 517 | 59.1 | 8.74 | 59 | 23.8 | 2.48 | 0.6 | 85.4 |
| 10 | 162 | 469 | 44.7 | 10.50 | 52 | 20.4 | 2.55 | 0.4 | 67.4 |

What the calls show:
- **keep_alive works.** Only call 1 paid a model load (27.9 s); every later call loaded in under 1 s.
- **The prefix cache is not visible in prompt_eval_count.** It stays at the full prompt length (352 to 517 tokens) on every call, including the identical repeat in the A/B below. Prompt speed varied from 0.76 to 17 tok/s, following machine load rather than call order.
- **Output is the steady cost:** about 50 to 80 tokens at 1.3 to 3.4 tok/s, so 20 to 50 s per call even when the prompt is quick.

## Failures and what changed

- **Run 1, call 3: invalid JSON, job stopped.** The prompt asked for the reason first. Gemma wrote a long reason, ignored the schema's maxLength, hit the 80-token cap and was cut off mid-string, twice (with the retry). Fix: scores now come before the reason, and a cut-off answer keeps its four scores with the reason trimmed to whole words. Call 4 of run 2 was cut off the same way and was salvaged.
- **A/B run 1: invalid JSON again.** Gemma closed the reason with a curly quote (”) instead of a straight one, then looped ("11 words. 11 words."). The salvage now cuts the reason at that quote.

## Ollama num_thread A/B (16 Oct, 02:01 to 02:22 WAT, load average about 35)

Same model and options as above. Four blocks alternate the setting to balance drift in machine load: Ollama's default, then num_thread 2, then the default, then 2. Each block starts with a warm-up call (a third clip, 497 prompt tokens) that absorbs the model reload a num_thread change causes. Then it sends clip A (352 prompt tokens), clip B (379) and clip A again, an identical prompt that tests prefix caching. Script: `ab2.mjs` in the session scratchpad.

| Block | num_thread | Call | Wall s | Load s | Prompt tokens | Prompt s | Prompt tok/s | Output tokens | Output tok/s |
|---|---|---|---|---|---|---|---|---|---|
| 1 | default | warm-up | 202.0 | 38.5 | 497 | 140.4 | 3.54 | 66 | 3.14 |
| 1 | default | A | 31.9 | 0.4 | 352 | 12.5 | 28.28 | 58 | 3.30 |
| 1 | default | B | 37.5 | 0.4 | 379 | 17.1 | 22.19 | 64 | 3.44 |
| 1 | default | A again | 40.5 | 0.4 | 352 | 17.7 | 19.93 | 59 | 2.83 |
| 2 | 2 | warm-up | 115.6 | 19.4 | 497 | 76.4 | 6.50 | 66 | 3.61 |
| 2 | 2 | A | 38.9 | 0.6 | 352 | 15.2 | 23.13 | 59 | 2.78 |
| 2 | 2 | B | 52.1 | 0.5 | 379 | 26.9 | 14.07 | 58 | 2.50 |
| 2 | 2 | A again | 44.4 | 1.0 | 352 | 23.2 | 15.16 | 56 | 3.21 |
| 3 | default | warm-up | 179.3 | 17.7 | 497 | 129.6 | 3.83 | 64 | 2.21 |
| 3 | default | A | 65.7 | 0.7 | 352 | 26.6 | 13.24 | 57 | 1.56 |
| 3 | default | B | 51.5 | 0.4 | 379 | 21.4 | 17.73 | 64 | 2.29 |
| 3 | default | A again | 38.0 | 0.4 | 352 | 16.3 | 21.55 | 57 | 2.94 |
| 4 | 2 | warm-up | 152.0 | 18.1 | 497 | 113.1 | 4.39 | 66 | 3.42 |
| 4 | 2 | A | 81.8 | 0.5 | 352 | 33.1 | 10.62 | 60 | 1.31 |
| 4 | 2 | B | 49.9 | 0.4 | 379 | 29.3 | 12.94 | 61 | 3.32 |
| 4 | 2 | A again | 41.9 | 0.4 | 352 | 18.3 | 19.20 | 59 | 2.76 |

Medians over the 6 measured calls per setting (warm-ups excluded):

| num_thread | Prompt tok/s | Output tok/s | Wall s per call |
|---|---|---|---|
| Ollama default | 20.7 | 2.9 | 39.2 |
| 2 | 14.6 | 2.8 | 47.1 |

Decision: keep Ollama's default. num_thread 2 was slower to read the prompt and no faster to write. `SELECTS_THREADS` can still set it.

Two more findings from the same calls:
- **No prefix-cache reuse.** "A again" is the identical prompt sent right after B, and it still evaluated all 352 prompt tokens in 16 to 23 s, about as long as the first A. On this Ollama build and model, the shared rubric is re-read on every call, so the rubric's length is a real per-call cost.
- **The first call after a model load is slow.** Every warm-up read its prompt at 3.5 to 6.5 tok/s, against 10 to 28 tok/s for the calls after it. The reload itself (17 to 39 s) is separate from that. keep_alive 30m avoids both within a job.

An earlier attempt at this A/B (01:28, one block per setting, no warm-up) was confounded: load average fell from about 250 to 28 while it ran, and it stopped when Gemma closed a JSON string with a curly quote (see "Failures").

## Spreading the judge's scores (16 Oct, 02:22 to 02:41 WAT)

The problem: in the end-to-end run all three picks scored hook 3 and stands alone 3, and two of them tied at 0.675, so the ranking came down to tie-breaks. All variants below use the same 8 shortlisted windows. The spread is the standard deviation of the 8 totals (each 0..1); "distinct" counts different totals.

| Variant | SD of totals | Distinct totals | Extra model time |
|---|---|---|---|
| Rubric as shipped in the e2e run (anchors at 1, 3, 5), judge only | 0.093 | 7 of 8 | none |
| (b) all five levels anchored, each with a short example, judge only | 0.077 | 3 of 8 | 8 calls, 685.7 s (85.7 s each); rubric 220 words instead of 140 |
| (c) old rubric, blended 0.7 judge + 0.3 pre-score | 0.079 | 8 of 8 | none |
| (c) then (a): blend, then the listwise round on the top 4 | 0.104 | 8 of 8 | 1 call, 71.3 s (318 prompt tokens, 142 output tokens) |
| (b) then (c) then (a), for reference | 0.097 | 8 of 8 | the listwise call took 112.6 s (299 prompt, 149 output tokens) |

Kept: the old rubric, (c) and (a). Dropped: (b). It made scores bunch higher (most windows went to standalone 4, payoff 5, clarity 5; hook stayed at 3 for all 8), and the anchor example "I slept four hours a night for a year" turned up in a reason as if the speaker had said it.

What the listwise round did with the shipped rubric. Order: c_0001, c_0014, c_0020, c_0012.

| Window | Pointwise scores (hook, standalone, payoff, clarity) | Judge | Pre | Blended | Final | Listwise rank and reason |
|---|---|---|---|---|---|---|
| c_0014 | 3, 3, 5, 5 | 0.675 | 0.712 | 0.686 | 0.683 | 2: "Sets up a compelling story, intriguing, strong initial statement." |
| c_0001 | 3, 3, 3, 5 | 0.575 | 0.536 | 0.563 | 0.629 | 1: "Direct, relatable motivation; clear risk statement, immediate scroll stop." |
| c_0020 | 3, 3, 4, 5 | 0.625 | 0.533 | 0.597 | 0.557 | 3: "Vague intro, payoff is overly simplistic and unconvincing." |
| c_0012 | 3, 3, 5, 5 | 0.675 | 0.537 | 0.634 | 0.539 | 4: "Generic statement, lacks a strong hook or payoff." |
| c_0027 | 3, 3, 2, 4 | 0.487 | 0.650 | 0.536 | 0.456 | not in the round |
| c_0036 | 3, 3, 3, 3 | 0.500 | 0.617 | 0.535 | 0.455 | not in the round |
| c_0004 | 3, 3, 2, 3 | 0.450 | 0.473 | 0.457 | 0.388 | not in the round |
| c_0016 | 3, 2, 3, 3 | 0.425 | 0.462 | 0.436 | 0.371 | not in the round |

A caution for the eval: the listwise judgment depends on which clips share the round. With the (b) judgments the round held c_0012, c_0014, c_0027 and c_0036, and c_0012 came first. In the round above it came last ("generic statement"). Comparing side by side spreads the scores, but whether it agrees with people more is for the eval to show (`judgeTotal` for the judge alone, `total` for the full pipeline).

## Earlier measurements (from review-tech-feasibility.md, not re-run here)

whisper base.en default beam search ran at 14.8x real time; greedy (`-bs 1 -bo 1`) at 1.57x. Selects uses greedy.
