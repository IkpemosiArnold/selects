# Selects

Selects finds the best short clips in a long video and renders them as captioned 9:16 videos, using whisper.cpp and a Gemma model on your own computer, with nothing uploaded.

![The Selects review screen. A filmstrip of a 6-minute talk runs across the top with the model's interest curve under it and three numbered clip brackets. Below, clip 2 of 3 shows its opening line, its four rubric scores, its blended score and the model's one-line reason.](notes/screens/real-review-07m4-ranking.png)

## Why it exists

People who clip long videos for money are often paid per view, at rates as low as $0.40 per 1,000 views, so a $15 monthly subscription to a hosted clipper eats the first 37,500 views.
Selects has no subscription, no per-minute limit and no watermark, and it runs on hardware you already own, including a 2017 dual-core laptop with no GPU.
Every proposed clip shows the scores and the reason behind it, and nothing is rendered until you approve it.

## Quickstart

### Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Node.js | 20 or newer | Selects itself |
| ffmpeg and ffprobe | any build with the libx264 encoder | reading the video, cutting and rendering |
| whisper.cpp | `whisper-cli` plus the `ggml-base.en.bin` model | the transcript, with a time for every word |
| Ollama | a version that can run Gemma 3 | the judge model |
| A Gemma 3 model | `gemma3:4b`, or the same model imported from a GGUF file | scoring the clips |

Your ffmpeg does not need libass or drawtext. Selects draws the captions as images with `@napi-rs/canvas` and lays them over the video.

### 1. Install ffmpeg and Ollama

On macOS with Homebrew:

```sh
brew install ffmpeg
```

Install Ollama from [ollama.com](https://ollama.com), then open the app or run `ollama serve`.

### 2. Build whisper.cpp and download the English model

```sh
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build
cmake --build build -j --config Release
sh ./models/download-ggml-model.sh base.en

export SELECTS_WHISPER_BIN="$PWD/build/bin/whisper-cli"
export SELECTS_WHISPER_MODEL="$PWD/models/ggml-base.en.bin"
cd ..
```

Add the two `export` lines to your shell profile so they survive a new terminal. If `whisper-cli` is already on your PATH, you only need `SELECTS_WHISPER_MODEL`.

### 3. Get a Gemma 3 model

```sh
ollama pull gemma3:4b
```

Some older Ollama versions refuse the pull with "requires a newer version of Ollama". Ollama 0.12.5 did this on the build machine. Upgrading Ollama fixes it. If you can't upgrade, import the same model from a GGUF file on Hugging Face instead:

```sh
curl -L -o gemma-3-4b-it-Q4_K_M.gguf \
  https://huggingface.co/ggml-org/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf

cat > Modelfile <<'EOF'
FROM ./gemma-3-4b-it-Q4_K_M.gguf
TEMPLATE """{{- range $i, $_ := .Messages }}
{{- $last := eq (len (slice $.Messages $i)) 1 }}
{{- if or (eq .Role "user") (eq .Role "system") }}<start_of_turn>user
{{ .Content }}<end_of_turn>
{{ if $last }}<start_of_turn>model
{{ end }}
{{- else if eq .Role "assistant" }}<start_of_turn>model
{{ .Content }}{{ if not $last }}<end_of_turn>
{{ end }}
{{- end }}
{{- end }}"""
PARAMETER stop <end_of_turn>
PARAMETER temperature 0
EOF

ollama create gemma3-4b-hf -f Modelfile
```

The file is 2.49 GB. On the build machine it downloaded at 1.95 MB/s in 1,277 seconds, and `ollama create` took 4 minutes 20 seconds. Selects sends its own temperature (0.2) with every request, so the `temperature 0` line only affects other uses of the model.

Selects picks the judge model in this order: `--model`, then `SELECTS_MODEL`, then `gemma3:4b` if it is pulled, then the first installed model whose name starts with `gemma3`. The imported `gemma3-4b-hf` is found by that last rule, so you don't need to name it.

### 4. Install Selects and check the setup

```sh
git clone [PENDING: repo URL] selects
cd selects
npm install
npm link            # optional: puts the `selects` command on your PATH
selects doctor
```

Without `npm link`, replace `selects` with `node bin/selects.mjs` in every command in this README.

`selects doctor` checks Node, ffmpeg, whisper-cli, the whisper model, Ollama, the judge model, the caption font and free disk space. It prints a fix for each failed check and exits with code 1 if any check fails.

### 5. Clip a video

```sh
selects ~/Movies/talk.mp4 --k 3
```

Selects transcribes the video, scores the candidate clips, prints the top 3 with their scores and reasons, and asks you to approve each one. It renders only the clips you approve. The clips go to `./selects-out/<video-name>/`:

- `01-<title>.mp4`: the 1080x1920 clip with burned-in captions
- `01-<title>.srt`: the captions as a subtitle file
- `01-<title>.kit.json`: a suggested title, caption and hashtags, plus the credit line
- `clips.md`: every clip's source times, scores, reason and caption in one file

### 6. Review in the browser (optional)

```sh
cd web && npm install && npm run build && cd ..
selects serve
```

Open http://127.0.0.1:4317. The review page shows the filmstrip, the model's interest curve and each clip's scores. You can drag a clip's edges to trim it (trims snap to sentence boundaries), approve or skip it, and render the approved clips. The server listens only on 127.0.0.1.

## How it picks clips

Selects asks the model to judge a few short passages instead of reading the whole transcript. On a dual-core CPU, Gemma 3 4B could not finish picking 3 clips from a 2,957-word transcript within 30 minutes, while scoring one 100-word window takes about a minute. So the work is split into a cheap first stage with no model and a slow second stage that only sees a shortlist.

```
video file
  |  ffmpeg: 16 kHz mono audio
  v
whisper.cpp, greedy decoding --> a start and end time for every word
  |
  v
sentences (end punctuation, or a pause of 1.2 s or more)
  |
  v
windows of whole sentences, 20 to 60 s long
  |
  v
STAGE 1, no model
  drop windows that open on a back-reference or end mid-thought
  pre-score the rest from text, pace and loudness (0 to 1)
  shortlist the 8 best, spread across the video
  |
  v
STAGE 2, Gemma through Ollama
  one call per window, answer forced to a JSON schema:
  hook, stands alone, payoff, clarity (1 to 5 each), then a reason
  total = 0.7 x rubric + 0.3 x pre-score
  |
  v
LISTWISE ROUND, one more call
  the top 4 distinct windows, first and last sentence only
  the model orders them best to worst
  total = 0.85 x total + 0.15 x position score
  |
  v
top k, with overlapping windows removed --> you approve --> render
```

### Stage 1: windows and the pre-score

Every window starts and ends on a sentence boundary, so a clip never cuts a word in half. A window is dropped when its first sentence points back at something a viewer never saw (for example "As I said", "That's why" or a lowercase start) or when its last sentence stops mid-thought (for example "let me show you" or a trailing "and").

The pre-score rewards an opening with a hook phrase, a question or a number, a contrast word inside the window, a steady pace without long pauses, and moments louder than the talk's median. It penalises soft openers, filler words and windows that end on a question. The shortlist takes the best window from each third of the video first, then fills up to 8 by score, skipping windows that overlap a chosen one by more than 40%.

### Stage 2: the rubric

The full prompt is in [`src/core/prompts/judge.md`](src/core/prompts/judge.md). The model scores each clip as a stranger scrolling a feed would meet it:

| Score | 1 | 3 | 5 | Weight |
|---|---|---|---|---|
| Hook (first sentence) | filler, a greeting or slide talk | a clear topic but no tension | a surprising claim, a sharp question or a real stake | 0.35 |
| Stands alone | needs earlier context | one reference a viewer must guess | fully self-contained | 0.30 |
| Payoff (last sentence) | stops mid-thought or promises more later | ends, but fades out | lands an answer, a punchline or an insight | 0.20 |
| Clarity | several ideas or heavy filler | one idea with some wandering | one tight idea | 0.15 |

The answer must match a JSON schema with the four scores first and the reason last. If the model runs out of output tokens (80 per call), only the reason is cut short, and Selects keeps the scores. Answers are cached by model and clip text, so a resumed job does not pay for the same call twice.

The rubric score is blended with the pre-score (70% and 30%) because the model's scores alone tied too often. In the first full run, all three picks scored 3 for hook and 3 for stands alone, and two of them tied exactly.

### The listwise round

After the pointwise scores, the 4 best distinct windows go to the model together, as their first and last sentences only, and the model puts them in order with a reason of 10 words or fewer. The first place adds 0.15 to a clip's total and the last adds 0. The prompt is in [`src/core/prompts/listwise.md`](src/core/prompts/listwise.md). Turn the round off with `settings.listwise: false` in the job settings.

### Rendering

Each approved clip is cut with 0.08 s of padding before the first word and 0.35 s after the last, and loudness is normalised to -14 LUFS. Selects reframes 16:9 video to 9:16 by centre crop when the motion in the clip stays in the centre band, and otherwise places the whole frame over a blurred copy of itself ("fit"). Captions show up to 4 words at a time in Atkinson Hyperlegible Next, with the current word in yellow, above the bottom 18% of the frame where TikTok, Reels and Shorts draw their buttons.

## Performance on a 2017 laptop

All numbers come from real runs on one machine: a 2017 13-inch MacBook Pro with an Intel i5-7360U (2 cores, 4 threads), 16 GB of RAM and no GPU, running Ollama 0.12.5, Gemma 3 4B (Q4_K_M, imported from the GGUF above) and whisper.cpp `base.en`. Other jobs were running at the same time, so treat the numbers as typical rather than best case. The full log is in [`notes/timings.md`](notes/timings.md).

The test video was a 6-minute excerpt (360 s, 720x576) of a CC BY-SA 4.0 conference talk. Command: `selects strength-talk-6min.mp4 --yes --k 3 --credit "Jenni, EMF 2026" --license CC-BY-SA-4.0 --source-url <talk page>`. Load average was about 35.

| Stage | Wall time | Notes |
|---|---|---|
| Probe and filmstrip thumbnails | 0.8 s | |
| Transcribe | 129.7 s | 1,232 words, about 2.8 times faster than the video plays |
| Candidates and pre-score | under 0.1 s | 37 windows passed the filter, 8 went to the judge |
| Judge: 8 pointwise calls and 1 listwise call | 724.4 s | 72.9 s per pointwise call on average; the listwise call took 141.1 s |
| Render 3 clips (1080x1920) | 65.1 s, 23.4 s, 37.7 s | clips of 41.0 s, 23.3 s and 40.4 s |
| Posting kits (one Gemma call each) | 169.8 s, 43.3 s, 98.9 s | title, caption and hashtags |
| Whole run | 1,293.7 s (21.6 min) | from the video file to 3 captioned, credited clips |

Load changes these numbers a lot. The same 6 minutes of audio took 7.0 minutes to transcribe at a load average of about 250, which is slower than the video plays. Gemma read prompts at anywhere from 0.76 to 28 tokens per second depending on what else was running, and wrote output at about 1.3 to 3.6 tokens per second.

Some findings that shaped the defaults:

- Greedy decoding in whisper.cpp (`-bs 1 -bo 1`) took 31.3 s on a 20-second sample, against 107.7 s for the default beam search, and the text was nearly the same. Selects always uses greedy decoding.
- On this Ollama build the rubric is read again on every call. An identical prompt sent twice in a row took as long the second time, so a shorter rubric saves time on every call.
- Setting Ollama's `num_thread` to 2 was slower than Ollama's default in an alternating A/B test (median 47.1 s per call against 39.2 s), so Selects leaves it at the default. `SELECTS_THREADS` can still set it.
- `--judge-n` is the main speed control. Each extra window costs about one more model call.
- For long videos, use the overnight queue: `selects queue add <videos...>`, then `selects queue run`. Each job saves its progress after every stage, so after a crash, sleep or power cut, `selects review <job-id>` resumes from the last finished stage.

## CLI reference

```
selects <video> [options]      find clips, ask before cutting, render the approved ones
selects review <job-id>        review and render a job that already ran (for example overnight)
selects queue add <video...>   queue videos for overnight mode
selects queue run              work through the queue, one video at a time
selects queue                  show the queue
selects jobs                   list jobs
selects serve [--port 4317]    start the local review app
selects doctor                 check whisper, Ollama, the judge model and disk
```

| Option | Default | Meaning |
|---|---|---|
| `--model <name>` | `gemma3:4b`, else a local `gemma3` tag | the Ollama model that judges the clips |
| `--k <n>` | 5 | how many clips to propose |
| `--min <sec>` | 20 | shortest clip |
| `--max <sec>` | 60 | longest clip |
| `--judge-n <n>` | 8 | how many pre-scored windows the model reads (more is slower) |
| `--preview` | off | render fast 720x1280 drafts instead of final 1080x1920 clips |
| `--plain-kit` | off | skip the model for post titles and use the clip's first line |
| `--out <dir>` | `./selects-out/<video-name>` | where the clips go |
| `--credit <text>` | none | who to credit in each post caption, for example `"Jenni, EMF 2026"` |
| `--license <id>` | none | the source's licence, for example `CC-BY-SA-4.0` (adds the licence link) |
| `--source-url <url>` | none | where the source video lives (added to the credit) |
| `--yes`, `-y` | off | approve every proposed clip without asking |
| `--port <n>` | 4317 | port for `selects serve` |
| `--help`, `-h` | | show the help |

`selects review <job-id>` accepts `--credit`, `--license`, `--source-url`, `--yes`, `--preview`, `--plain-kit` and `--out`. Changing the credit on a finished job rewrites the posting kits without rendering again. `selects queue add` accepts `--model`, `--k` and `--judge-n`.

Without a terminal to ask in (for example in a script), `selects <video>` stops with exit code 2 after finding the clips, unless you pass `--yes`. The job is saved, and `selects review <job-id>` picks it up. Any other failure exits with code 1 and prints what happened, what to do, and the job id to resume.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `SELECTS_WHISPER_BIN` | `whisper-cli` on your PATH | path to whisper.cpp's `whisper-cli` |
| `SELECTS_WHISPER_MODEL` | none you can rely on; set it | path to `ggml-base.en.bin` |
| `SELECTS_WHISPER_THREADS` | half the logical CPUs | whisper threads |
| `SELECTS_WHISPER_ARGS` | none | extra arguments passed to `whisper-cli` |
| `SELECTS_OLLAMA_URL` | `http://127.0.0.1:11434` | the Ollama server |
| `SELECTS_MODEL` | see step 3 | the judge model, if `--model` is not given |
| `SELECTS_THREADS` | Ollama's default | Ollama's `num_thread` for judge calls |
| `SELECTS_HOME` | `<repo>/.selects` | where jobs, caches and the queue are kept |
| `PORT` | 4317 | port for `selects serve`, if `--port` is not given |

## Rights and attribution

A clip is an adaptation of someone else's work, so only clip video you have the rights to: your own recordings, a creator's paid clipping campaign, or a licence that allows adaptations, such as CC BY or CC BY-SA.

Pass the credit when you create a job:

```sh
selects talk.mp4 --credit "Jenni, EMF 2026" --license CC-BY-SA-4.0 \
  --source-url https://media.ccc.de/v/emf2026-160-1-how-i-became-nearly-as-strong-as-the-average-untrained-man
```

Selects appends one line to every caption in the posting kit, for example:

> Clip from Jenni, EMF 2026 (https://media.ccc.de/v/emf2026-160-1-how-i-became-nearly-as-strong-as-the-average-untrained-man). Licensed under CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/. Cut, reframed and captioned from the original. This clip is shared under CC BY-SA 4.0 too.

`--license` accepts ids such as `CC-BY-4.0`, `CC-BY-SA-4.0`, `CC-BY-3.0` and `CC0-1.0`, and spellings such as `"cc by-sa 4.0"`. An unknown id stops the command. A licence with ND (no derivatives) prints a warning that clips are not allowed without the creator's permission, and a licence with NC (non-commercial) prints a warning that paid clipping campaigns are out.

The talk's licence may not cover everything on screen. The test talk above is CC BY-SA 4.0, but one of its slides shows a figure from a 2020 journal paper that the slide itself marks as CC BY-NC-ND 4.0, and that slide appears in one of the rendered clips. A clip showing that slide is an adaptation of an ND work, so it should not be posted as it is. For that reason Selects prints this reminder after every render and puts it in every posting kit: "Check slides and on-screen media: a talk's licence may not cover every figure."

## Limitations

- English only. Selects uses whisper's `base.en` model and passes `-l en`, so speech in other languages, including Nigerian Pidgin and Yoruba, transcribes badly or not at all. A multilingual whisper model would be the fix, and Selects does not support one yet.
- Slide talks usually fall back to "fit". Centre crop is used only when the motion stays in the middle of the frame. In the test talk, the slides fill the frame and the speaker is a small inset in the corner, so all 3 clips were rendered as the full frame over a blurred background, with small slide text. There is no face tracking.
- Hook scores cluster. In every run so far, Gemma 3 4B gave every shortlisted window a hook score of 3, so the hook (the highest weight) separates nothing. The blend with the pre-score and the listwise round are there to break the ties.
- The shortlist limits what the model can find. The judge only reads 8 windows. In the eval below, the best possible picks from the shortlist matched a Most Replayed peak in 67% of videos, against 100% for the best possible picks from all windows.
- Audio and text only. The model never sees the video, so it cannot tell when a moment depends on a slide or a demo.
- Tested on macOS 13 on the machine above. Linux should work with the same prerequisites, but it has not been tested.

## Evaluation

The question the eval asks is whether a free open model on a 2017 laptop can pick clips as well as people do. The full method is in [`eval/README.md`](eval/README.md), and the latest results are in [`eval/results/RESULTS.md`](eval/results/RESULTS.md).

The dataset is 6 videos marked Creative Commons Attribution on YouTube: three interviews, a lecture, a conference talk and a commencement speech. Videos longer than 20 minutes are scored on their first 15 minutes. The labels come from YouTube's Most Replayed heatmap, turned into up to 5 peak segments per video. Most Replayed is a proxy for where viewers rewatch, which is not the same as where a good short is, and it is only accurate to about 9 to 27 seconds. Human labels are made blind with `node eval/label.mjs`. [PENDING: human-label results, once Arnold has labelled the videos.]

Every method picks its top 5 clips from the same candidate windows. A pick is a hit when its overlap with a label (intersection over union) is 0.5 or more. The confidence intervals are bootstrapped over videos, so with 6 videos they are wide.

Interim results against Most Replayed (hit@3 is the share of videos where one of the top 3 picks is a hit; mean best IoU is the average overlap of each pick with its nearest label):

| Method | Videos | hit@3 (95% CI) | Mean best IoU (95% CI) | Model time per video |
|---|---|---|---|---|
| Random over all windows (mean of 200 seeds) | 6 | 26% (22% to 31%) | 0.13 (0.12 to 0.15) | none |
| Loudness and speech rate, no model | 6 | 17% (0% to 50%) | 0.11 (0.03 to 0.21) | none |
| Stage 1 alone, no model | 6 | 33% (0% to 67%) | 0.09 (0.02 to 0.19) | none |
| Stage 1 + qwen2.5:0.5b | 5 | 40% (0% to 80%) | 0.12 (0.03 to 0.22) | 1.9 min |
| Stage 1 + Gemma 3 4B | [PENDING] | [PENDING] | [PENDING] | [PENDING] |
| Best possible from the shortlist | 6 | 67% (33% to 100%) | 0.17 (0.08 to 0.27) | none |
| Best possible from all windows | 6 | 100% | 0.76 (0.71 to 0.81) | none |

So far no method is clearly better than random, because every confidence interval overlaps. [PENDING: final eval numbers with the Gemma row.]

### Reproduce the eval

You need yt-dlp, and the fetcher reads YouTube cookies from Chrome to get the heatmap (set `SELECTS_YTDLP_COOKIES_BROWSER` to use another browser).

```sh
node eval/fetch-datasets.mjs fetch G9NabGlnDCs Aj0nf3rKG_E k4715CJ0Ii8 CBYhVcO4WgI uFyk5UOyNqI iqm-XEqpayc
node eval/fetch-datasets.mjs build              # write the manifest with heatmap labels
node eval/label.mjs                             # optional: add your own labels at http://127.0.0.1:4318
node eval/run-eval.mjs                          # all videos, all installed judge models
node eval/run-eval.mjs --models gemma3-4b-hf:latest,qwen2.5:0.5b
node eval/run-eval.mjs --report                 # rebuild the tables from the caches only
```

`--only id1,id2` runs a subset of videos, and `--limit 4` runs the 4 shortest. Transcripts and judge answers are cached in `eval/cache/`, so a second run only does new work.

## Tests

```sh
npm test
```

The tests use `node:test` and cover the core modules, the server and the eval code.

## Licence

MIT. The bundled Atkinson Hyperlegible Next font is under the SIL Open Font License; see `src/core/assets/OFL.txt`.
