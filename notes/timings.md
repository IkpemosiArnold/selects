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

## Ollama num_thread A/B

Pending: the run is queued behind the eval builder's transcriptions on heavy.lock.

## Earlier measurements (from review-tech-feasibility.md, not re-run here)

whisper base.en default beam search ran at 14.8x real time; greedy (`-bs 1 -bo 1`) at 1.57x. Selects uses greedy.
