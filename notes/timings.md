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

## Final run with the shipped pipeline (16 Oct, 02:44 to 03:06 WAT, load average about 35)

Command: `selects .selects/media/strength-talk-6min.mp4 --yes --k 3 --credit "Jenni, EMF 2026" --license CC-BY-SA-4.0 --source-url <talk page>` (job `j_20261016_07m4`, output `selects-out/strength-talk-6min-final/`). This is the rubric as above, blended with the pre-score, plus the listwise round and credit in each kit.

| Stage | Wall time | Note |
|---|---|---|
| Probe and thumbnails | 0.8 s | |
| Transcribe | 129.7 s (2.2 min) | 1,232 words, 2.78x real time (the same audio took 7.0 min at load average 250) |
| Candidates and pre-score | under 0.1 s | 37 windows passed, 8 to the judge |
| Judge: 8 pointwise calls and 1 listwise call | 724.4 s (12.1 min) | pointwise mean 72.9 s per call (prompt 11.7 tok/s, output 2.82 tok/s on average), none cut off or failed; listwise 141.1 s (318 prompt tokens at 4.8 tok/s, 144 output tokens at 2.0 tok/s) |
| Render, 3 clips | 65.1 s, 23.4 s, 37.7 s | clips of 41.0 s, 23.3 s, 40.4 s |
| Posting kit, 3 calls | 169.8 s, 43.3 s, 98.9 s | |
| Whole run | 1,293.7 s (21.6 min) | from the video file to 3 captioned, credited clips |

Picks: c_0014 (02:33, 41 s, total 0.68), c_0001 (00:23, 23 s, 0.63; first in the listwise round), c_0020 (03:44, 40 s, 0.56). Run 2 had picked c_0012 instead of c_0001; the listwise round moved it down ("Generic statement, lacks a strong hook or payoff").

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

## Accented English, captions and blur (16 Oct, feature engineer)

Test video: a private phone recording (an elderly Nigerian woman speaking English to camera, lav mic), 165 s, HEVC 3840x2160 at 59.94 fps stored with rotation -90 (portrait), mono AAC 44.1 kHz at 39 kb/s. Integrated loudness -18.3 LUFS, peaks at 0 dBFS, many 1 to 4 s pauses. Only speeds and confidence numbers are recorded here, never content. The transcripts are in `.selects/private/asr-compare.md` (gitignored) for a person to rate.

### Speech recognition on 60 s of her audio (20 s to 80 s), greedy decoding, 2 threads

Other jobs (the eval builder's Ollama calls) ran on the machine at the same time. "Unsure" is the share of words with probability under 0.5. Confidence is not accuracy: a fine-tune can be confidently wrong.

| Run | Model size | Time | Speed | Words | Mean word p | Unsure words |
|---|---|---|---|---|---|---|
| base.en | 148 MB | 10.1 s | 5.95x | 88 | 0.748 | 20.5% |
| base.en, audio cleaned | 148 MB | 9.4 s | 6.36x | 90 | 0.753 | 20.0% |
| base.en, with a neutral `--prompt` | 148 MB | 10.4 s | 5.77x | 85 | 0.776 | 14.1% |
| small.en | 488 MB | 32.2 s | 1.86x | 90 | 0.797 | 12.2% |
| small.en, audio cleaned | 488 MB | 37.2 s | 1.61x | 90 | 0.797 | 8.9% |
| small, fine-tuned for Nigerian-accented English (rishabbahal/whisper-small-nigerian-accent, Apache 2.0, converted with `tools/hf-whisper-to-ggml.mjs`) | 488 MB | 36.7 s | 1.64x | 90 | 0.927 | 2.2% |
| medium.en, 5-bit quantised (`medium.en-q5_0`) | 539 MB | 92.3 s | 0.65x | 91 | 0.873 | 4.4% |

"Audio cleaned" is highpass 80 Hz, lowpass 7.6 kHz and loudness normalisation to -18 LUFS. Downloads for this: small.en 196 s, the fine-tune (967 MB of float32 safetensors) 393 s, medium.en-q5_0 218 s, about 2.5 MB/s. Converting the fine-tune to ggml in Node took 11.2 s. Not tried: intronhealth/afrispeech-whisper-medium-all (Apache 2.0, the AfriSpeech-200 authors' model) is 3.06 GB of float32 weights, over the 2 GB download budget; the converter handles it the same way. ElevenLabs Scribe (cloud, opt-in) is a possible later provider behind `src/core/asr/`.

### Transcript quality gate: calibration

Score = mean word p minus the share of unsure words above 5%, minus penalties for repeated 3-word loops and per-80-word compression above 2.4. Good at 0.8 or more, unreliable under 0.65.

| Transcript | Words | Mean p | Unsure | Repeats | Worst chunk compression | Score | Verdict |
|---|---|---|---|---|---|---|---|
| EMF talk, base.en (clean conference audio) | 1232 | 0.942 | 0.5% | 0.011 | 1.86 | 0.942 | good |
| Eval video ASvx-QG6o04, base.en | 2316 | 0.936 | 2.2% | 0.015 | 2.08 | 0.936 | good |
| Eval video Aj0nf3rKG_E, base.en | 2973 | 0.892 | 4.2% | 0.015 | 1.97 | 0.892 | good |
| Eval video CBYhVcO4WgI, base.en | 3142 | 0.948 | 1.2% | 0.011 | 1.93 | 0.948 | good |
| Eval video G9NabGlnDCs, base.en | 1931 | 0.903 | 3.3% | 0.010 | 1.88 | 0.903 | good |
| Eval video iqm-XEqpayc, base.en | 1817 | 0.952 | 0.4% | 0.012 | 1.84 | 0.952 | good |
| Eval video k4715CJ0Ii8, base.en | 2899 | 0.937 | 1.3% | 0.013 | 1.96 | 0.937 | good |
| Eval video uFyk5UOyNqI, base.en | 2512 | 0.904 | 3.1% | 0.002 | 1.75 | 0.904 | good |
| Elderly speaker, whole video, base.en | 246 | 0.767 | 17.9% | 0.004 | 1.77 | 0.638 | unreliable: the run stopped before judging (exit 1 after 127.6 s: probe 36.0 s, language 39.8 s, transcribe 50.3 s at 3.29x real time) |

The share of unsure words separates the two groups much better than the mean: 0.4% to 4.2% for clean talks against 18% to 20% for the elderly speaker with base.en. The margin is thin on the unreliable side (0.638 against the 0.65 line), so these thresholds come from one bad recording and eight good ones and should move as more recordings are rated.

### Language check

Whisper's own detector (multilingual base, first 30 s of three 20 s samples) said Yoruba, p = 0.906 (0.88 in Arnold's earlier run on the start of the video). The first version of decode-and-compare ranked languages by mean word probability and also picked Yoruba: decoding the samples "as Yoruba" scored 0.798 (18% unsure) against 0.650 for English (31% unsure). But every word of the "Yoruba" decode was plain ASCII and 93% were English dictionary words: told to write Yoruba, whisper wrote English. So mean probability is not comparable across languages, and the check now treats a non-English decode that comes out as English text (a share of common English function words of 0.2 or more) as evidence for English. With that rule (run B2 below, `--language auto`), the samples decoded as Yoruba had an English function-word share of 0.519 and as English 0.513, so Yoruba was ruled out and English chosen, with this warning: "Whisper's quick guess was Yoruba (p = 0.90), but when asked to write Yoruba it wrote English, so this is English."

The language check costs one 60 s WAV of samples, a detector pass and one multilingual base decode per candidate language: 27.2 s to 49.6 s in four runs (2 candidates each).

### Decoding 4K HEVC at 60 fps on the dual-core

20 s of the source, decoded and scaled to 1080x1920 (no encode):

| Path | Time for 20 s |
|---|---|
| CPU decode, CPU scale, all 60 fps (the old render path) | 80.4 s |
| CPU decode, drop to 30 fps, CPU scale | 72.1 s |
| VideoToolbox decode, drop to 30 fps, CPU scale | 34.2 s |
| VideoToolbox decode, drop to 30 fps, scale on the GPU (`scale_vt`), download, turn upright | 22.7 s |

Selects now uses the last path for 8-bit H.264 and HEVC on macOS (with a fallback to the others if ffmpeg refuses), so the decode is 3.5 times faster than before. The upright frame from that path matched ffmpeg's own autorotate output (PSNR 50.2 dB). Probing plus 60 keyframe thumbnails of this file took 26.7 s to 36.0 s with CPU decoding.

### Face detection (tools/faces, Apple Vision)

661 frames (4 per second over 165 s), downscaled to 960 px on the long side: 70.6 s, two frames at a time (about 140 ms of Vision per frame on this Intel CPU). Every frame had exactly one face; the tracker made one track covering 0 to 165 s, marked it as the main speaker, and turned it into a single blur box (the face barely moved). Linking the 661 frames took 10 ms. The 30 s test on the EMF talk took 9 to 10 s for 120 frames.

### The real runs (16 Oct, 04:24 to 04:52 WAT, SELECTS_HOME in `.selects/private/home`)

| Run | Command | Result | Wall time |
|---|---|---|---|
| A | `selects IMG_1922.MOV --k 2 --yes --blur-faces others` (defaults: language en, base.en) | stopped by the quality gate before judging (score 0.638, unreliable), exit 1 | 127.6 s: probe 36.0, language 39.8, transcribe 50.3 (3.29x real time) |
| B | `selects caption IMG_1922.MOV --language auto --asr-model small.en` (first language rule) | the language check chose Yoruba, then stopped safely: "ggml-small.en.bin only knows English, but the language is set to yo" | 78.1 s |
| C | `selects IMG_1922.MOV --k 2 --yes --asr-model small.en --judge-n 6 --blur-faces others` | 2 clips, 1080x1920 at 30 fps; transcript shaky (score 0.787, mean p 0.834, 9.7% unsure); 22 windows passed the filter, 5 judged; one face track, the main speaker, so nothing blurred. The clips came out sideways (see below) | 717.6 s: probe 28.3, language 34.0, transcribe 89.1 (1.85x), judge 316.9 (5 calls, 45.8 s each, plus the listwise call), faces 72.7, renders 36.7 and 39.1 for clips of 20.5 and 24.2 s, kits 60.2 and 37.8 |
| C2 | re-render C's clips after the rotation fix (`selects review <job> --yes`) | upright 1080x1920 clips, her face unblurred, captions in the lower third | 158.4 s: renders 32.7 and 39.2 s, kits 43.2 and 42.3 s |
| B2 | B again with the English-text rule | language English (decided by compare), transcript shaky (0.787), whole video captioned at 1080x1920, 30 fps, bold style, GPU decode | 386.0 s: probe 8.0 (thumbnails now hardware-decoded), language 27.2, transcribe 101.9 (1.62x), render 247.0 (1.5x the video's length) |

Bug found and fixed by run C: on the GPU path, `-noautorotate` made ffmpeg copy the source's -90 rotation into the output, so players turned the already-upright frames sideways. The input now uses `-display_rotation:v 0`. A second bug came from the web builder's test with blur on the public EMF clip: crop, boxblur and overlay on nv12 frames left the blurred boxes green; the GPU path now converts to planar yuv420p after the download.

## Language ID ensemble, accent routing, punctuation and VAD (16 Oct, speech-ML)

Same machine. Other builders were running Gemma judge calls and Chrome at the same time (load average 25 to 120 during the decodes), so the decode times are high and vary. Only codes, probabilities and times are recorded for the private recording, never its words; its decodes stay in `.selects/private/` (gitignored).

### Test set

- The elderly Nigerian speaker speaking English (private phone recording, 165 s).
- The EMF talk excerpt (British English, 360 s).
- The 6 eval videos (English; full cached audio in `eval/media`, read only).
- FLEURS dev utterances (CC BY 4.0, google/fleurs): 7 in Yoruba (92 s) and 7 in Hausa (138 s), joined into one file each. These check the other direction: real Yoruba or Hausa must not be relabelled English.

Each recording went through Selects' language check: three 20 s samples (one sample for short files), whisper's detector (multilingual base), and a decode of the samples in the detector's language and in English. To stress the text signals, every recording was also decoded as Yoruba (and the Hausa set as Hausa).

### Each signal's verdict, `--language auto` (the detector's language and English decoded)

"Decode by mean p only" is the first decode-and-compare rule (highest mean word probability wins). "Decode-compare" is the rule shipped before today (a decode that comes out as English text cannot win). The time column is samples plus detector, then the decodes, then the text models (a child process that loads both; 2.6 to 3.1 s when the model file is not in the page cache).

| Recording | Spoken | whisper detector | Decode by mean p only | Decode-compare | lid-lite-608 | lid-lite-5 | Ensemble (share of vote) | Question? | Default setting (en) | Time (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| Elderly Nigerian speaker (private, 165 s) | en | yo (0.9), refuted | yo | en | en (0.994) | en (0.999) | **en** (0.847) | no | en, no | 6.7 + 48.3 + 1.6 |
| EMF talk, British speaker (6 min) | en | cy (0.633), refuted | en | en | no opinion | no opinion | **en** (0.759) | no | en, no | 5.0 + 139.9 + 1.5 |
| Eval G9NabGlnDCs | en | en (0.987) | en | en | no opinion | no opinion | **en** (1) | no | en, no | 4.5 + 36.0 + 1.8 |
| Eval CBYhVcO4WgI | en | en (0.998) | en | en | no opinion | no opinion | **en** (1) | no | en, no | 5.9 + 16.4 + 1.6 |
| Eval iqm-XEqpayc | en | en (0.996) | en | en | no opinion | no opinion | **en** (1) | no | en, no | 7.9 + 22.1 + 1.6 |
| Eval uFyk5UOyNqI | en | en (0.973) | en | en | no opinion | no opinion | **en** (1) | no | en, no | 4.5 + 24.1 + 1.6 |
| Eval Aj0nf3rKG_E | en | en (0.997) | en | en | no opinion | no opinion | **en** (1) | no | en, no | 3.8 + 17.4 + 1.6 |
| Eval k4715CJ0Ii8 | en | en (0.985) | en | en | no opinion | no opinion | **en** (1) | no | en, no | 3.8 + 13.2 + 1.4 |
| FLEURS Yoruba, 7 utterances (92 s) | yo | yo (0.54) | yo | yo | no opinion | no opinion | **yo** (1) | no | en, yes (English?) | 3.0 + 24.6 + 1.6 |
| FLEURS Hausa, 7 utterances (138 s) | ha | ro (0.173) | ro | ro | no opinion | no opinion | **ro** (1) | yes (Romanian?) | en, yes (English?) | 3.8 + 20.3 + 1.6 |

What each signal contributed:

- **whisper detector**: wrong on 3 of 10 (Yoruba for the Nigerian speaker, Welsh for the British speaker, Romanian at p 0.17 for Hausa). Both accented English speakers were mislabelled.
- **decode by mean p only**: wrong on the Nigerian speaker (Yoruba, 0.798 against 0.650 for English) and on Hausa.
- **lid-lite-608 on the decodes**: on the Nigerian speaker it read the "Yoruba" decode as English (p 0.994), which on its own refutes Yoruba. This is the signal that fails differently: it never hears the accent, only the words whisper wrote. Elsewhere it had no opinion, because every decode came out in the language asked for, or failed.
- **lid-lite-5**: agreed with lid-lite-608 on the Nigerian speaker (English, p 0.999).
- **The ensemble**: 9 of 10 right, the 10th (Hausa) asked about instead of decided. No English recording was relabelled and no English recording raised the question.
- **With the default setting (English)**, Selects keeps the user's choice and transcribes English, so the last column only shows whether it asks: it asks "Is the speaker using English?" for both FLEURS sets (offering Yoruba and Romanian first) and for none of the English recordings.

Stress run, every recording also decoded as Yoruba (the case where a profile or the detector brings Yoruba in):

| Recording | Spoken | whisper detector | Decode by mean p only | Decode-compare | lid-lite-608 | lid-lite-5 | Ensemble (share of vote) | Question? | Default setting (en) | Time (s) |
|---|---|---|---|---|---|---|---|---|---|---|
| Elderly Nigerian speaker (private, 165 s) | en | yo (0.9), refuted | yo | en | en (0.994) | en (0.999) | **en** (0.847) | no | en, no | 6.7 + 48.3 + 1.6 |
| EMF talk, British speaker (6 min) | en | cy (0.633), refuted | en | en | no opinion | no opinion | **en** (0.759) | no | en, no | 5.0 + 205.5 + 1.5 |
| Eval G9NabGlnDCs | en | en (0.987) | en | en | no opinion | no opinion | **en** (1) | no | en, no | 4.5 + 142.1 + 1.8 |
| Eval CBYhVcO4WgI | en | en (0.998) | en | en | en (0.99) | en (0.998) | **en** (1) | no | en, no | 5.9 + 99.1 + 1.6 |
| Eval iqm-XEqpayc | en | en (0.996) | en | en | en (0.681) | en (0.994) | **en** (1) | no | en, no | 7.9 + 116.3 + 1.6 |
| Eval uFyk5UOyNqI | en | en (0.973) | en | en | en (0.985) | en (1) | **en** (1) | no | en, no | 4.5 + 43.9 + 1.6 |
| Eval Aj0nf3rKG_E | en | en (0.997) | en | en | no opinion | no opinion | **en** (1) | no | en, no | 3.8 + 63.5 + 1.6 |
| Eval k4715CJ0Ii8 | en | en (0.985) | en | en | en (0.989) | en (0.999) | **en** (1) | no | en, no | 3.8 + 46.2 + 1.4 |
| FLEURS Yoruba, 7 utterances (92 s) | yo | yo (0.54) | yo | yo | no opinion | no opinion | **yo** (1) | no | en, yes (English?) | 3.0 + 24.6 + 1.6 |
| FLEURS Hausa, 7 utterances (138 s) | ha | ro (0.173) | ha | ha | ha (0.951) | no opinion | **ha** (0.958) | yes (Hausa?) | en, yes (English?) | 3.8 + 44.3 + 1.6 |


The stress run found two faults in the first version of the rule, both fixed before the tables above were computed:

- **Text models reading failed decodes.** Asked to write Welsh, whisper produced junk for the British speaker (mean word p 0.064), and lid-lite-608 still read the junk as Welsh (p 1.0); the forced Yoruba decode (p 0.098) also read as Welsh (0.71), and the first rule picked Welsh. Now a decode with mean word p under 0.3 (or under 5 words) counts as failed: its text is ignored and its language is refuted.
- **lid-lite-5 outside its five languages.** The forced Yoruba decode of an American nursing interview came out garbled (mean p 0.58, no English words); lid-lite-608 said French at only p 0.20, and lid-lite-5, which only knows five languages, said Hausa at p 0.99. lid-lite-5 now only votes on text that lid-lite-608 places in English, Hausa, Igbo, Pidgin or Yoruba.

A third case is a limit, not a fault: on the Hausa set, the detector said Romanian at p 0.17 and the Romanian decode read as Romanian text, so nothing in the default run points to Hausa. A non-English verdict that rests on a detector under p 0.5 now raises the question instead.

### End to end: the elderly Nigerian speaker with `--language auto` (16 Oct, 07:01 WAT)

`createJob(IMG_1922.MOV, { mode: "caption", language: "auto" })` and `runJob`, with `SELECTS_HOME` in `.selects/private/home` (job `j_20261016_0mab`). Caption mode, so it stops before rendering.

| Step | Result | Wall time |
|---|---|---|
| Probe and thumbnails | | 9.7 s |
| Language check | English, 85% of the vote, no question. Detector: Yoruba p 0.90, refuted. Decoded as Yoruba: mean p 0.798, read as English by lid-lite-608 (0.994) and lid-lite-5. Decoded as English: 0.650, read as English (0.990). | 25.0 s, of which text models 1.3 s |
| Accent routing | routed to `ggml-small-nigerian-accent.bin`, on the audio cue (the detector heard Yoruba in speech that is English) | |
| Transcribe | 1.98x real time; transcript quality score 0.915, mean word p 0.915, 3.1% unsure: **good** | 83.6 s |
| Whole run | | 118.3 s |

The same video with the defaults before today (`base.en`, run A above) scored 0.638 and stopped as unreliable after a 50.3 s transcription; with `small.en` (run C) it scored 0.787, shaky. So routing costs about 33 s more transcription on this 165 s video than base.en and turns a stopped run into one that passes the gate. The score is whisper's own confidence, and a fine-tune can be confidently wrong, so the transcripts still need rating by a person who knows the speaker.

### Time cost per video

The ensemble itself adds only the text models: 1.2 to 1.8 s per video (a child process that loads lid-lite-608 in 0.6 to 3 s and frees its 225 MB afterwards). Everything else in the table above is the decode-and-compare that already existed: 3 to 8 s for the samples and the detector, then 10 to 40 s per decode, or more when whisper retries a decode in the wrong language (up to 121 s for the Welsh decode of the British talk under heavy load). When the setting is English and the detector agrees, which was the case for all 6 eval videos, no decodes run and the language check costs only the detector pass (3.8 to 7.9 s). Punctuation adds 1 to 5 s, only for sparse English transcripts. Accent routing adds the fine-tune's slower transcription (about 2x real time against about 3 to 6x for base.en on this machine).

### Decoding without temperature fallback (`-nf`): faster, and it breaks the check

The junk decodes are slow because whisper retries them at higher temperatures. With `-nf` they were much faster (EMF as Welsh: 121.1 s down to 14.3 s; G9NabGlnDCs as Yoruba: 106.1 s down to 14.0 s), but the confidence numbers stopped meaning anything: the Welsh junk scored mean p 0.87, and the forced Yoruba decode of an English interview scored 0.906, above English (0.864). Worse, the Nigerian speaker's "Yoruba" decode stopped coming out as English text (English function-word share 0.519 with fallback, 0.026 without; lid-lite-608 read it as Punjabi), and the ensemble chose Yoruba. The fallback is what makes whisper either give up or write the language it actually hears, so the language check keeps it.

### Audio language ID (VoxLingua107 ECAPA, int8 ONNX): rejected

Run with onnxruntime-node 1.21 (the last release with a macOS x64 build) on 20 s windows, 2 threads, about 2.2 to 3.9 s per window (10 s for 60 s of audio) under load, 0.5 s to load the 26.6 MB model.

| Recording | Windows | Verdicts |
|---|---|---|
| Elderly Nigerian speaker | 0-20 s, 15-35 s, 62-82 s, 130-150 s, first 60 s, all 165 s | Yoruba 0.37, Hausa 0.49, Croatian 0.47, Korean 0.33, Swahili 0.28, Croatian 0.29 |
| EMF talk, British speaker | 3 windows of 20 s, first 60 s | Welsh 0.95, 0.93, 0.95, 0.93 (English second at 0.05 to 0.07) |
| Eval ASvx-QG6o04, American | 2 windows, 60 s | English 0.999, 0.996, 0.997 |
| Eval iqm-XEqpayc, American | 2 windows, 60 s | English 0.94, 0.995, 0.99 |

It fails differently from whisper, but on exactly the speakers the ensemble exists for, and confidently (Welsh at 0.95). As a voter it would have turned the British talk into a question or a wrong answer. Not adopted. sherpa-onnx's spoken-language ID was not tried: it runs whisper's own encoder, so it would fail the same way as the detector.

### Punctuation restoration (Edge-Punct-Casing, int8, via sherpa-onnx-node)

Controlled test: whisper's punctuation removed from 7 well-punctuated transcripts, then sentence ends put back by (a) the pause-based fallback in `sentences.mjs` (a pause of 0.6 s ends a sentence, no sentence over 12 s) and (b) the model, in chunks of 150 words. Scored against whisper's original sentence ends, counting a boundary within one word as a hit.

| Transcript | Words | Whisper's ends | Pauses: P / R / F1 | Model: P / R / F1 | Model time |
|---|---|---|---|---|---|
| Aj0nf3rKG_E | 2,962 | 138 | 0.29 / 0.27 / 0.28 | 0.51 / 0.76 / 0.61 | 4.7 s |
| CBYhVcO4WgI | 3,136 | 193 | 0.38 / 0.23 / 0.28 | 0.74 / 0.76 / 0.75 | 3.6 s |
| G9NabGlnDCs | 1,881 | 143 | 0.68 / 0.39 / 0.50 | 0.81 / 0.73 / 0.77 | 1.4 s |
| iqm-XEqpayc | 1,802 | 141 | 0.56 / 0.42 / 0.48 | 0.81 / 0.75 / 0.77 | 1.7 s |
| k4715CJ0Ii8 | 2,899 | 250 | 0.70 / 0.39 / 0.50 | 0.90 / 0.79 / 0.84 | 2.6 s |
| uFyk5UOyNqI | 2,512 | 154 | 0.20 / 0.15 / 0.17 | 0.67 / 0.81 / 0.73 | 2.6 s |
| EMF talk | 1,232 | 67 | 0.27 / 0.21 / 0.23 | 0.83 / 0.79 / 0.81 | 0.9 s |
| Mean | | | F1 0.35 | F1 0.76 | |

Loading the model takes about 1.5 s. Every chunk came back with the same number of words, so whisper's word timings carry over unchanged. On the one transcript that really is sparse (ASvx-QG6o04: 12 sentence ends in 2,316 words), the model changed 422 words in 4.6 s and turned 85 pause-based sentences (mean 7.5 s) into 166 sentences (mean 3.8 s, close to the 4 to 6.5 s of the well-punctuated talks). The candidate windows that pass the filter went from 143 to 125, because the stricter rules for punctuated text now apply. Adopted, for English transcripts that `isSparsePunctuation` flags.

### VAD (whisper.cpp's built-in Silero VAD v6.2.0): rejected

whisper `base.en`, greedy, 2 threads, with and without `--vad -vm ggml-silero-v6.2.0.bin`. Words matched between the two runs by longest common subsequence.

| Recording | Without VAD | With VAD | Words matched | Start-time shift (median, 90th percentile, max) | Pauses of 1 s or more (mean length without, with) |
|---|---|---|---|---|---|
| Elderly Nigerian speaker, 165 s | 41.6 s, 246 words, mean p 0.767, 17.9% unsure | 18.1 s, 253 words, 0.792, 12.6% unsure | 80.5% | 0.70 s, 2.31 s, 4.00 s | 26 pauses: 1.88 s, 0.99 s |
| EMF talk, 360 s | 62.6 s, 1,232 words, 0.942 | 83.6 s, 1,239 words, 0.944 | 99.4% | 0.21 s, 0.59 s, 2.56 s | 2 pauses: 1.72 s, 0.00 s |
| G9NabGlnDCs, first 300 s | 63.0 s, 958 words, 0.914 | 51.1 s, 937 words, 0.915 | 95.3% | 0.18 s, 0.61 s, 3.12 s | 9 pauses: 1.53 s, 0.21 s |

VAD helped the pause-heavy phone recording (2.3 times faster, fewer unsure words), but the time saved on talks was small or negative, and whisper.cpp maps its timestamps back from the speech-only audio loosely: word times moved by up to 4 s and real pauses shrank or vanished. Captions, cut snapping, the pause-based sentence fallback and the pre-score's pause feature all depend on those times, so VAD is not used. The speech-boundary hint for cuts was not built: the word gaps and the loudness track already mark pauses, and a separate VAD pass was not shown to add anything.

### Speaker diarization

Not built (stretch goal). Feasible on this machine: sherpa-onnx-node's macOS x64 build includes `OfflineSpeakerDiarization` (pyannote segmentation 3.0, about 6 MB, plus a speaker-embedding model of 25 to 40 MB).
