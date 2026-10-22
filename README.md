# Selects

Selects finds the best short clips in a long video and renders them as captioned 9:16 videos, using whisper.cpp and a Gemma model on your own computer, with nothing uploaded.

![The Selects review screen. Clip 2 of 3 from a 6-minute talk plays at 9:16 in the middle with the captions the render will burn in. On the left, a clapperboard slate shows the clip number, in point, out point and length, with the opening line written large, Gemma's reason in blue and its four scores. On the right are the Approve and Skip keys and the sentence trims. The next clip peeks out from behind the card, and a strip along the bottom shows the interest curve and where the three clips sit](notes/screens/v2/reel-review-dark.png)

## Why it exists

People who clip long videos for money are often paid per view. One clipping gig posted on r/naijaremote in September 2026 offered $0.40 per 1,000 views. That rate comes from a note made while the post was up; the post could not be reopened on 21 October 2026, so treat it as unverified. At that rate, Opus Clip's Starter plan ($15 a month, billed monthly, on [its pricing page](https://www.opus.pro/pricing) on 21 October 2026) costs the first 37,500 views of every month.
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

mkdir -p ~/.selects/models
mv models/ggml-base.en.bin ~/.selects/models/
cd ..
```

Selects looks for models in `~/.selects/models` and for `whisper-cli` on your PATH. If `whisper-cli` is not on your PATH, tell Selects where it is in `~/.selects/config.json` (or with `SELECTS_WHISPER_BIN`):

```json
{ "whisperBin": "/full/path/to/whisper.cpp/build/bin/whisper-cli" }
```

`selects doctor` prints where every path was found.

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
git clone https://github.com/IkpemosiArnold/selects.git
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

Open http://127.0.0.1:4317. Review shows one clip at a time, at 9:16 with the captions the render will burn in, beside a slate with its times, its opening line, the model's reason and its scores. Press A or the right arrow to approve, S or the left arrow to skip, or swipe on a phone. The comma and full stop move the start by a sentence, and the square brackets move the end. Press T to open the clip's words as a script: drag the line in the margin or select words to trim (trims snap to sentence boundaries), and double-click a word to fix its caption. Press B to blur a face or an area. Then render the approved clips. The server listens only on 127.0.0.1.

### 7. Caption a whole video

```sh
selects caption ~/Movies/interview.mov
```

Caption mode keeps the whole video and its own shape: a portrait phone video stays portrait and a landscape talk stays landscape. Nothing is clipped and no model judges anything. It writes `<name>-captioned.mp4` with the captions burned in, plus `<name>.srt` and `<name>.vtt`, into `./selects-out/<video-name>/`. Portrait video gets the big short-form captions; landscape video gets two-line subtitles (`--style bold` or `--style subtitle` to choose).

Speech recognition makes mistakes, especially with accents, so check the words before you burn them in. Either fix them in the browser (the caption review step in `selects serve`), or in any text editor:

```sh
selects caption interview.mov --edit          # writes interview.edit.srt and waits while you fix it
selects caption j_20261016_ab12 --srt fixed.srt   # or hand back a corrected SRT later
```

Change the words, and join or split lines if you like. Every word keeps its time from the audio: a line with the same number of words keeps each word's exact time, and a line with more or fewer words spreads them over the same stretch. The same corrected captions are used for clips rendered from that job.

Rendered clips get captions by default too. Add `--no-captions` to turn them off.

### 8. Blur faces or parts of the frame

```sh
selects caption party.mov --blur-faces others        # blur everyone except the main speaker
selects talk.mp4 --blur-region 0.6,0.05,0.35,0.12@12-30   # blur a box from 0:12 to 0:30
```

`--blur-faces all` blurs every face; `--blur-faces others` keeps the main speaker (the largest face that is on screen longest) and blurs the rest. Faces are found with Apple's Vision framework by a small Swift tool, so face blur works on macOS only; build it once with `sh tools/faces/build.sh`. On other systems, use `--blur-region`, which works everywhere. A region is `x,y,w,h` as fractions of the upright frame (0,0 is the top left), optionally followed by `@start-end` in seconds, and you can repeat the flag. Typical uses: a phone number on screen, a third-party logo, or a figure under a licence that does not allow adaptations. In the browser you can draw the boxes on the preview and choose which faces to blur.

## Made for: Shorts, LinkedIn, X or a story

Tell Selects where the clips will go with `--made-for` (or `settings.madeFor`). A preset changes only three things: the length range, the caption style, and the posting kit's tone and format. Clip selection stays the same, except for `story`.

| Preset | Clip length | Captions | Posting kit |
|---|---|---|---|
| `shorts` (default) | 20 to 60 s | bold, 2 to 4 words, current word in yellow | Shorts, Reels or TikTok: a title under 60 characters, one or two sentences, 3 to 5 topic hashtags |
| `linkedin` | 30 to 90 s | subtitle, two lines, no highlight | a first sentence under 120 characters that earns the click before "see more", then two or three plain sentences; 0 to 3 hashtags, only ones that name the field |
| `x` | 15 to 45 s | bold | one or two short sentences under 200 characters; no hashtag, or one |
| `story` | 60 to 90 s | bold | like `shorts`, but the title and caption set up the story without giving away the ending |

`story` also adds one line to the judge's prompt: score "stands alone" and "payoff" high only when the clip tells a complete story, with a setup, a turn and a resolution. The line is in [`src/core/prompts/judge.md`](src/core/prompts/judge.md), and each preset's kit format is in [`src/core/prompts/kit.md`](src/core/prompts/kit.md). `--min`, `--max` and `--style` still win over a preset. There is no outrage or controversy preset, on purpose.

## Selects Web: the same clipper in your browser

Selects Web runs the whole pipeline in a browser tab: speech to text, the clip judge and the captioned 9:16 render. The host only serves static files, and in Private mode the video, its audio and its transcript never leave the device.

### Private mode and Smart mode

| Mode | What runs where | What leaves the device |
|---|---|---|
| Private (the default) | Everything in the tab: whisper, Gemma and the render | Nothing. The models are downloaded once and cached by the browser |
| Smart | Whisper and the render in the tab; the judge is Gemma 4 26B on Google's Gemini API | The transcript text of the 8 shortlisted passages, sent to Google. Never the video or the audio |

Smart mode works with your own free key from Google AI Studio (kept in the tab for the session and sent only to Google), or through a small Selects proxy that holds the project's key. The proxy accepts only Selects judge requests, limits how often each visitor can call it, and does not log the text. If Google's free tier is slow on one clip (calls time out after 25 seconds and are tried once more), that clip is judged on your device when the private model is already saved in the browser, and otherwise keeps its first-stage score; the page says which. If Smart mode does not answer at all, the page never starts the private model's download on its own: with the model already saved it judges on the device and says so, and otherwise it asks whether to try Smart mode again, use the preliminary ranking (the first-stage score, no model) now, or download the private model, showing its size, an estimate on your connection, and a warning on mobile data where the browser reports it.

### What runs in the browser

| Step | How | Model |
|---|---|---|
| Read the video, audio and thumbnails | mediabunny over WebCodecs; WebAudio resamples to 16 kHz mono | none |
| Speech to text with a time for every word | transformers.js (ONNX Runtime Web) in a worker, WebGPU or WebAssembly | whisper base.en, timestamped export (140 MB for the CPU, 209 MB for WebGPU) |
| Sentences, windows, pre-score, shortlist, ranking, curve, trims | the same code as the desktop (`src/core`) | none |
| Judge (WebGPU) | MediaPipe LLM Inference | Gemma 4 E2B (2.0 GB, Apache-2.0) |
| Judge (no WebGPU) | llama.cpp compiled to WebAssembly (wllama) | Gemma 3 1B Q4_0 (722 MB) |
| Language check | plain JavaScript | lid-lite-5 (1.1 MB) |
| Render | each frame drawn on a canvas with the desktop's caption layout, encoded to H.264 and AAC with WebCodecs, muxed to MP4 | none |

The judge reads the same prompt files as the desktop (`src/core/prompts/`), and its answers are scored, blended with the pre-score and put through the listwise round by the same code.

### On a phone

Phones pause background tabs, so Selects Web does not promise to keep working when you leave. It saves after every step instead: the audio, the transcript, the scores, your approvals and trims, caption edits and rendered clips stay on the device (IndexedDB, and the video itself in the browser's private file storage when it fits). Open the page again, or choose the same video again, and it carries on from the last finished step. While it works it keeps the screen awake, shows progress in the tab title, and can notify you when the clips are ready if you allow it. It installs as an app (a web manifest and a service worker that only caches the page itself).

### Limits

- Best for videos up to about 10 to 15 minutes. Longer videos are slow in a tab and can run out of memory.
- English speech only. For other languages, Nigerian-accented English, face blur, whole-video captions or long videos, use the desktop app.
- The first run downloads 0.9 GB (CPU) or 2.2 GB (WebGPU) of models once.
- No transcript quality gate yet: the browser's whisper does not report word confidence.
- Measured on the 2017 laptop (details in [`notes/timings.md`](notes/timings.md), "Browser build"): 2 minutes of video took 11.2 minutes to analyse on the WebGPU path (whisper at 0.31 times real time on the Intel GPU, Gemma 4 E2B at about 19 seconds a call), and a 41-second clip rendered in 57 seconds. On this machine whisper on the CPU was faster (0.75 times real time).

### Build and run it locally

```sh
npm --prefix src/browser ci            # the engine's runtimes (ONNX Runtime Web, wllama, MediaPipe)
npm --prefix web ci
npm --prefix web run build:web          # the review app on the browser engine, writes dist-web/
npm --prefix web run preview:web        # http://localhost:4173 with the right headers
```

The same React app runs on either engine: `npm --prefix web run build` talks to `selects serve` on a laptop, and `build:web` (`VITE_ENGINE=browser`) runs everything in the tab. The engine's own test page still builds with `npm --prefix src/browser run build` (into `dist-engine/`). To try Smart mode without a key, run the stand-in API and the proxy:

```sh
PORT=8788 node server-proxy/mock-gemini.mjs
PORT=8787 GEMINI_API_KEY=test GEMINI_BASE=http://127.0.0.1:8788/v1beta ALLOWED_ORIGINS=http://localhost:4173 node server-proxy/server.mjs
```

### Deploy

Any static host works if it sends two headers on every page, which multithreaded WebAssembly needs:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

`credentialless` keeps model downloads from Hugging Face's CDN working. `src/browser/public/_headers` sets them on Netlify and Cloudflare Pages.

On Render, `render.yaml` describes both services: the static site `selects-web` (the React app in `web/` built on the browser engine, published from `dist-web`, with the headers) and the free web service `selects-smart-proxy` (`node server-proxy/server.mjs`). In the Render dashboard, create a Blueprint from the repository, then set three values: `GEMINI_API_KEY` on the proxy (from Google AI Studio; never commit it), `ALLOWED_ORIGINS` on the proxy (the static site's URL), and `VITE_SELECTS_PROXY_URL` on the static site (the proxy's URL). A free Render web service sleeps after 15 minutes without requests and takes up to about a minute to wake; the page shows "Waking the Smart mode server" while it waits.

### The Smart mode proxy: limits

The proxy spends one shared, free Gemini quota, so its limits are the protection, not CORS. `ALLOWED_ORIGINS` only stops other web pages from calling it from a visitor's browser; any script can send any `Origin` header. Each task request goes through three gates in this order:

| Gate | Limit | What a refusal costs |
|---|---|---|
| Ingress, per client IP, before the body is read | 60 a minute, 2,000 a day | nothing: 429, the body is not read |
| Body cap and task check | 16 KB; only the judge, listwise, faithful and kit task shapes | nothing: 413 or 400, no model quota used |
| Model quota, per client IP and for everyone | 20 a minute and 300 a day per IP; 25 a minute and 12,000 a day in total | charged only when every counter has room |

The client IP is read from `X-Forwarded-For` with 3 trusted hops on Render (the client, Cloudflare's edge, Render), so a client cannot pick its own key by sending the header. At capacity the proxy answers 429 with `retry-after` and says whether the limit was this visitor's or everyone's. Nothing is queued: the page keeps that clip's first-stage score, or judges it on the device when the private model is already saved in the browser. `GET /healthz` shows the limits and counts.

## How it fails safely

A clipper that trusts a bad transcript picks bad clips: the windows, the judge, the cuts and the captions all sit on the words. So Selects checks the transcript before it spends any model time on it.

- **Transcript quality gate.** After whisper finishes, Selects scores the transcript from whisper's own word probabilities: the mean, the share of words below 0.5, and a check for the loops whisper falls into when it loses the audio (repeated phrases, and text that compresses too well). Eight clean English recordings scored between 0.89 and 0.95. If the transcript is unreliable, Selects stops before judging and says what to try (a bigger model, or the right language); `--force` judges it anyway. If it is shaky, Selects carries on and warns you to check the captions.
- **Language check with several models, and a question when they disagree.** Whisper's built-in language detector is known to fail on accents, so Selects does not trust it alone. It decodes samples of the video in each likely language, has two small text models read what whisper wrote, and combines the answers with a short written rule. When the answers disagree, it asks you one question instead of guessing. Details are under "Languages and accents" below.
- **No pretending a weak video is a good one.** If no proposed clip scores 0.55 or more, Selects says "No strong clips in this video" and offers only the closest 2, each with the model's reason. The bar was set from real runs: a private phone video whose clips the model itself called weak scored 0.40 to 0.52, while a conference talk scored 0.56 to 0.68 and the best clip of each of the 6 eval videos scored 0.60 to 0.68. Clips below the bar in an otherwise strong video are marked weak.
- **A video is transcribed once.** The language check and the transcript are saved per source file, so a second job on the same video (caption mode after clip mode, another `--k`, a different `--made-for`) skips both and starts at the clip finding. The file is recognised by its size, its modified time and its first and last 4 MB, so a copy with the same content is recognised too; another whisper model, language, prompt or audio clean-up makes a new transcript. `--fresh` does both again.
- **Clips only from words whisper heard.** The first stage marks down windows with low word confidence and keeps them out of the shortlist, so the judge never reads words whisper did not really hear. In the caption review, unsure words are underlined so you can fix those first.

## Languages and accents

Selects is built for English first, and for English spoken with any accent. Other languages work where whisper's multilingual models work, which for many African languages is not well.

**Which language is spoken?** Whisper's own detector listens to the first 30 seconds and guesses. On English from an elderly Nigerian speaker, it said Yoruba (p = 0.90). On a British conference speaker, it said Welsh (p = 0.63). Research on accented speech finds the same problem ([arXiv 2203.16972](https://arxiv.org/abs/2203.16972)), and finds that reading the transcript helps. So Selects collects four signals that fail in different ways:

1. Whisper's detector (the audio guess). It counts half, because it is the one known to fail on accents.
2. Decode and compare. Three 20-second samples are decoded in the detector's language, in English and in the language you set, and whisper's confidence is compared.
3. [lid-lite-608](https://huggingface.co/olaverse/lid-lite-608), a 37 MB text model for 608 languages, reads each decode.
4. [lid-lite-5](https://huggingface.co/olaverse/lid-lite-5), a 1 MB text model for English, Hausa, Igbo, Nigerian Pidgin and Yoruba, does the same.

The text models answer a simple question: when whisper was told to write Yoruba, did it write Yoruba? On the elderly speaker it wrote English (both text models agreed, p 0.99), so the speech is English. A decode that fails outright (whisper's word confidence under 0.3, as with the Welsh decode of the British speaker) counts against its language. The signals then vote with fixed weights. If a signal that was not ruled out disagrees, if the winner has less than 60% of the vote, or if the evidence goes against the language you set, Selects asks "Is the speaker using English?" (or the language it found). Answering yes keeps the transcript. Choosing another language transcribes again. The rule is in `src/core/langid/rule.mjs` and its tests in `src/core/langid.test.mjs`.

Measured on 10 recordings (details in `notes/timings.md`): the elderly Nigerian speaker, the British speaker and 6 English eval talks all came out English, with no question asked. A Yoruba test set came out Yoruba. A Hausa test set did not: whisper's detector said Romanian with p = 0.17, so Selects asked instead of deciding. The text check adds about 1 to 3 seconds per video.

**Accents.** When the language check finds signs of Nigerian English (whisper's detector hearing Yoruba, Hausa or Igbo in speech that turns out to be English, or Nigerian words and Pidgin in the English text), Selects transcribes with a community whisper model fine-tuned for Nigerian-accented English. On the same minute of the elderly speaker it was unsure of 2% of the words, against 20% for the default model, but it runs about 3.5 times slower. On the whole 165-second video, with `--language auto`, the language check and transcription took 118 s and the transcript passed the quality gate (score 0.915), where the default model had stopped as unreliable (0.638). Its accuracy has not been rated by a person yet, and confidence is not accuracy. `--accent ng` always uses it for English (a saved profile can remember this), `--accent none` never does, and choosing a model with `--asr-model` always wins.

**Punctuation.** Whisper sometimes writes long stretches with no full stops, which makes clip boundaries and captions worse. When that happens in English, a 7.5 MB punctuation model puts full stops, commas, question marks and capitals back, and keeps whisper's words and timings. In a test on 7 talks (with whisper's own punctuation removed and then restored), it found sentence ends with an F1 score of 0.76 on average, against 0.35 for splitting at pauses, which is what Selects did before and still does if the model is missing.

The models, their licences and sizes are listed in [`notes/MODELS.md`](notes/MODELS.md).

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
top k, with overlapping windows removed
  |
  v
FAITHFUL CUTS, one call per pick
  the sentence before, the clip, the sentence after
  does the cut change what the speaker meant?
  |
  v
quality bar --> you approve (and take or leave each fix) --> render
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

### Faithful cuts

Other clippers rank clips for how well they might do. None checks whether the clip still says what the speaker meant. A cut that stops one sentence early can turn "people say you're too old to start, and that's not true" into "you're too old to start". So Selects checks each top pick once more, with the sentence before it and the sentence after it.

1. A rule check reads the words: does the next sentence open like a turn ("But ...", "That's not true"), does the clip report what other people think ("people say", "they think", "we're told"), does it open on "This" or "He" with something before it, is there a known ironic phrase.
2. The model answers five narrow questions: the clip's last point, what the next sentence does to it (agrees, adds, limits, reverses or changes the subject), whose view it is, whether it is sarcastic, and whether it needs the sentence before.
3. A short written rule turns both into a verdict: **faithful**, **check** or **misleading**, with the issue (a turn, a quote, sarcasm, a missing qualifier or a reference). A model answer only counts where the words back it up, because a 4B model leans one way on these questions.

The note quotes the words outside the clip, for example: Right after the clip, the speaker says "But the pendulum has swung way out of whack here." Where growing the clip to the next sentence boundary would fix it, Selects suggests the new start or end. Nothing changes until you say so. A misleading clip moves below the others until you keep it as it is or take the fix. With `--yes`, misleading clips are left out.

Real examples, and the two prompts that did not work (one called every clip misleading, the next called every clip "check"), are in [`notes/faithful-examples.md`](notes/faithful-examples.md). Those examples, including the one above from Sam Altman's startup lecture and the picks from the EMF talk (CC BY-SA 4.0), came from Gemma 3 4B running locally. In eval v2, with Gemma 4 26B through the Gemini API, the check flagged 10 of 95 top picks as "check" or "misleading"; how often those flags are right has not been measured yet. The prompt is [`src/core/prompts/faithful.md`](src/core/prompts/faithful.md). It costs one model call per pick: on the 2017 laptop, 86 to 126 s per call when the machine was quiet and about 210 s under heavy load, so 5 to 10 minutes for 5 picks. `--faithful rules` uses the rule check alone (no model), and `--faithful off` skips it.

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
- A 1-hour video (two EMF 2026 talks, CC BY-SA 4.0) took 36.6 minutes from the file to 30 previews and 5 finished clips. That run used Smart mode's judge, Gemma 4 26B through the Gemini API, not local Gemma 3; the transcription alone took 13.6 minutes. Details are in [`notes/timings.md`](notes/timings.md), "Long videos".
- For long videos, use the overnight queue: `selects queue add <videos...>`, then `selects queue run`. Each job saves its progress after every stage, so after a crash, sleep or power cut, `selects review <job-id>` resumes from the last finished stage.

### Phone video: 4K HEVC at 60 fps, portrait

A 165-second iPhone clip (3840x2160 HEVC at 59.94 fps, stored sideways with a rotation flag) is the hard case for this CPU. Decoding and scaling 20 seconds of it took 80.4 s on the CPU alone. Selects now decodes with Apple's VideoToolbox, drops to 30 fps and scales on the GPU before copying frames back, which took 22.7 s for the same 20 seconds, and it turns the frame upright itself. Portrait sources skip the crop and are scaled straight into 1080x1920. Clips of 20.5 s and 24.2 s from that video rendered in 32.7 s and 39.2 s, and captioning the whole 165 seconds took 247 s. Full numbers are in [`notes/timings.md`](notes/timings.md).

## CLI reference

```
selects <video> [options]      find clips, ask before cutting, render the approved ones
selects caption <video>        caption the whole video at its own aspect: MP4, SRT and VTT
selects caption <job-id>       render a caption job again (for example with --srt fixed.srt)
selects review <job-id>        review and render a job that already ran (for example overnight)
selects queue add <video...>   queue videos for overnight mode
selects queue run              work through the queue, one video at a time
selects queue                  show the queue
selects jobs                   list jobs
selects serve [--port 4317]    start the local review app
selects doctor [--json]        show the resolved config; check whisper, Ollama, the judge model and disk
```

| Option | Default | Meaning |
|---|---|---|
| `--model <name>` | `gemma3:4b`, else a local `gemma3` tag | the Ollama model that judges the clips |
| `--k <n>` | 5 | how many clips to propose |
| `--made-for <p>` | `shorts` | where the clips go: `shorts`, `linkedin`, `x` or `story` (see "Made for" above) |
| `--min <sec>` | 20 (from `--made-for`) | shortest clip |
| `--max <sec>` | 60 (from `--made-for`) | longest clip |
| `--judge-n <n>` | 8 | how many pre-scored windows the model reads (more is slower) |
| `--faithful <m>` | `model` | check each pick still says what the speaker meant: `model` (one call per pick), `rules` (no model) or `off` |
| `--preview` | off | render fast 720x1280 drafts instead of final 1080x1920 clips |
| `--plain-kit` | off | skip the model for post titles and use the clip's first line |
| `--out <dir>` | `./selects-out/<video-name>` | where the clips go |
| `--credit <text>` | none | who to credit in each post caption, for example `"Jenni, EMF 2026"` |
| `--license <id>` | none | the source's licence, for example `CC-BY-SA-4.0` (adds the licence link) |
| `--source-url <url>` | none | where the source video lives (added to the credit) |
| `--yes`, `-y` | off | approve every proposed clip without asking |
| `--force` | off | judge clips even when the transcript looks unreliable |
| `--language <code>` | `en` | the spoken language: an ISO code such as `en` or `yo`, or `auto` (decode and compare) |
| `--asr-model <name>` | `auto` | the whisper model: a name in the models folder (`base.en`, `small.en`, `medium.en-q5_0`, `small`) or a path. Auto is `base.en` for English and the best installed multilingual model otherwise |
| `--prompt <text>` | none | a short neutral context sentence passed to whisper |
| `--accent <a>` | `auto` | `auto` uses the Nigerian-accent whisper model for English when the language check finds signs of a Nigerian accent; `ng` always uses it for English; `none` never does |
| `--fresh` | off | check the language and transcribe again, even if this video was done before |
| `--clean-audio` | off | cut rumble below 80 Hz and hiss above 7.6 kHz and even out loudness before whisper |
| `--no-captions` | off | render clips without burned-in captions |
| `--style <s>` | auto | `bold` (2 to 4 big words, current word in yellow) or `subtitle` (up to two lines); auto is bold for portrait and clips, subtitle for landscape caption mode |
| `--captions <lang>` | `source` | `source` captions in the spoken language. `en` (translated) and `both` (bilingual) are planned, not built |
| `--edit` | off | caption mode: write an editable SRT, wait while you fix it, then render |
| `--srt <file>` | none | caption mode: use your corrected SRT (words keep their timings) |
| `--blur-faces <mode>` | off | `all`, or `others` (everyone except the main speaker). macOS only |
| `--blur-region <r>` | none | `x,y,w,h` as fractions of the frame, optionally `@start-end` in seconds. Repeat for more regions |
| `--port <n>` | 4317 | port for `selects serve` |
| `--help`, `-h` | | show the help |

`selects review <job-id>` accepts `--credit`, `--license`, `--source-url`, `--yes`, `--preview`, `--plain-kit`, `--force` and `--out`. Changing the credit on a finished job rewrites the posting kits without rendering again. `selects queue add` accepts `--model`, `--k`, `--judge-n` and `--made-for`.

Without a terminal to ask in (for example in a script), `selects <video>` stops with exit code 2 after finding the clips, unless you pass `--yes`. The job is saved, and `selects review <job-id>` picks it up. Any other failure exits with code 1 and prints what happened, what to do, and the job id to resume.

### Environment variables and the config file

Every value is resolved in this order: the environment variable, then the same setting in `~/.selects/config.json` (camelCase keys: `whisperBin`, `whisperModel`, `modelsDir`, `home`, `ollamaUrl`, `model`, `ffmpeg`, `ffprobe`, `langidDir`, `punctDir`, `accentModelNg`, `facesBin`, `threads`, `whisperThreads`, `whisperArgs`, `chunkSec`, `hwaccel`, `gpuScale`, `reuse`), then the default below. `SELECTS_CONFIG` points at another config file, and `SELECTS_DATA_DIR` moves `~/.selects` (on Windows the default is `%LOCALAPPDATA%\selects`). `selects doctor` prints the resolved values, and `selects doctor --json` prints them as JSON.

| Variable | Default | Meaning |
|---|---|---|
| `SELECTS_WHISPER_BIN` | `whisper-cli` on your PATH | path to whisper.cpp's `whisper-cli` |
| `SELECTS_WHISPER_MODEL` | `<models>/ggml-base.en.bin` | path to the English whisper model |
| `SELECTS_FFMPEG`, `SELECTS_FFPROBE` | on your PATH | paths to ffmpeg and ffprobe (shown by `selects doctor`) |
| `SELECTS_WHISPER_THREADS` | half the logical CPUs | whisper threads |
| `SELECTS_WHISPER_ARGS` | none | extra arguments passed to `whisper-cli` |
| `SELECTS_OLLAMA_URL` | `http://127.0.0.1:11434` | the Ollama server |
| `SELECTS_MODEL` | see step 3 | the judge model, if `--model` is not given |
| `SELECTS_THREADS` | Ollama's default | Ollama's `num_thread` for judge calls |
| `SELECTS_HOME` | `~/.selects` (an existing `<repo>/.selects` from an older version is still used, with a note) | where jobs, caches and the queue are kept |
| `SELECTS_MODELS_DIR` | `~/.selects/models`, or the folder of `SELECTS_WHISPER_MODEL` when only that is set | where `--asr-model` names are looked up (`ggml-<name>.bin`) |
| `SELECTS_HWACCEL` | on (macOS) | set to `0` to stop using Apple's hardware video decoder |
| `SELECTS_FACES_BIN` | `tools/faces/faces` | the face detector used for face blur |
| `SELECTS_LANGID_DIR` | `<models>/langid` | the text language models (`lid-lite-608/model.ftz`, `lid-lite-5/lid-lite-5.json`) |
| `SELECTS_ACCENT_MODEL_NG` | `<models>/ggml-small-nigerian-accent.bin` | the whisper model for Nigerian-accented English |
| `SELECTS_PUNCT_DIR` | `<models>/punct/sherpa-onnx-online-punct-en-2024-08-06` | the punctuation model |
| `SELECTS_REUSE` | on | set to `0` to never reuse a saved language check or transcript |
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

- Accented English is the weak spot, and how weak is not rated yet. On a test recording of an elderly Nigerian speaker talking in English, whisper `base.en` was unsure of about a fifth of the words. `small.en`, `medium.en` and a community fine-tune for Nigerian-accented English were compared on the same minute (details in [`notes/timings.md`](notes/timings.md)), and no person has rated their accuracy yet. Until then, review the captions before you post, and expect to fix words.
- The language check has been measured on 10 recordings, not hundreds. It got all 8 English recordings and the Yoruba set right, and asked about the Hausa set instead of getting it right. Whisper's small local models transcribe Yoruba and Hausa poorly (on the Hausa set, whisper's "Hausa" output did not read as Hausa to either text model), so a correct language label does not mean a usable transcript. Igbo has no whisper model at all. The Nigerian-accent routing has fired on one speaker; the text cue for it has not fired on any recording yet. Translated (`--captions en`) and bilingual captions are planned, not built.
- Face blur needs macOS (Apple's Vision framework). Elsewhere, blur regions by hand. Faces are sampled 4 times a second and boxes are interpolated in between, so a face that moves fast or turns away can slip out of the box for a fraction of a second; check the result before you post.
- Slide talks usually fall back to "fit". Centre crop is used only when the motion stays in the middle of the frame. In the test talk, the slides fill the frame and the speaker is a small inset in the corner, so all 3 clips were rendered as the full frame over a blurred background, with small slide text. Face tracking is used only for privacy blur, not for reframing.
- Hook scores cluster. In every run so far, Gemma 3 4B gave every shortlisted window a hook score of 3, so the hook (the highest weight) separates nothing. The blend with the pre-score and the listwise round are there to break the ties.
- The shortlist limits what the model can find. The judge reads 8 windows by default (`--judge-n`). In eval v2, a perfect pick from those 8 would have put a Most Replayed peak in the top 3 for 53% of the 19 videos, from a shortlist of 16 for 89%, and from all windows for 100%.
- Audio and text only. The model never sees the video, so it cannot tell when a moment depends on a slide or a demo.
- Tested on macOS 13 on the machine above. Linux should work with the same prerequisites, but it has not been tested.

## Evaluation

The question is whether a free open model picks the moments viewers come back to. Eval v2 was pre-registered: the plan, hypotheses and tests in [`eval/PLAN.md`](eval/PLAN.md) were committed before any judging ran. The full report is [`eval/results/RESULTS.md`](eval/results/RESULTS.md).

- **Data.** 19 YouTube videos marked CC BY that have a Most Replayed heatmap, scored on their first 15 minutes. Four more were excluded before judging (three failed the transcript quality gate, and one had too many non-English words, probably dubbed audio). The channels are based in the United States (9), Nigeria (2), the United Kingdom (2), Canada, Ghana, Gibraltar, India, the Netherlands and Switzerland. Most Replayed is a proxy for what viewers rewatch, not for what makes a good short.
- **Judge.** Gemma 4 26B-A4B through the free Gemini API (the Smart mode judge), on a random sample of 456 windows. It cost $0.
- **Result.** Gemma 4's AUC against replay intensity was 0.56 (95% CI 0.49 to 0.62), where 0.5 is chance. None of the four pre-registered hypotheses is supported at this n: Gemma 4 above chance, Gemma 4 above the stage 1 rules, Gemma 4 above a loudness-and-pace baseline, and the stage 1 rules above chance.
- **Exploratory (not pre-registered).** The blend the app ranks by (0.7 Gemma score plus 0.3 pre-score) scored 0.57 (0.51 to 0.64). At the effect seen, about 52 videos would be needed for 80% power against chance.
- **Faithful cuts.** With Gemma 4, the check flagged 10 of 95 top picks. Its precision is not measured yet.
- **Not done yet.** The blind preference test (`node eval/prefer.mjs`) has no ratings.
- **Selection parity.** The v2 run predates a fix: the eval did not keep stretches where whisper looped out of the shortlist, as the app does. Rechecking the cached transcripts found no such loops in any of the 19 videos, so the numbers are unchanged; the run was not repeated. See [`eval/results/RESULTS.md`](eval/results/RESULTS.md).

v1 (6 videos, hit@k only) is kept in [`eval/results/RESULTS-v1.md`](eval/results/RESULTS-v1.md).

### Reproduce the eval

You need yt-dlp (the fetcher reads YouTube cookies from Chrome to get the heatmap; set `SELECTS_YTDLP_COOKIES_BROWSER` to use another browser) and a free Gemini API key in `GEMINI_API_KEY` or `.env`.

```sh
node eval/fetch-datasets.mjs fetch <the ids in eval/datasets/manifest.json>
node eval/fetch-datasets.mjs build              # write the manifest with heatmap labels
node eval/run-eval-v2.mjs                       # transcripts, Gemma 4 judging, then the report; resumable
node eval/run-eval-v2.mjs --report              # rebuild RESULTS.md from the cached answers only
```

Transcripts and model answers are cached in `eval/cache/`, so a second run only does new work. The method is described in [`eval/README.md`](eval/README.md).

## Tests

```sh
npm test
```

The tests use `node:test` and cover the core modules, the server and the eval code.

## Licence

MIT. The bundled Atkinson Hyperlegible Next and Noto Sans fonts are under the SIL Open Font License; see `src/core/assets/OFL.txt` and `src/core/assets/OFL-NotoSans.txt`. Atkinson Hyperlegible Next has no dot-below vowels (the Yoruba letters ẹ, ọ and ṣ), so captions fall back to Noto Sans for those letters.
