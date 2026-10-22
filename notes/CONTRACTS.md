# Selects: shared contracts (read before writing code)

Three builders work in parallel: **core** (`src/core`, `bin`, `src/server`), **web** (`web/`), **eval** (`eval/`). This file is the interface between them. If you must change a contract, change it here first and say so in your final report.

Product and design source of truth: the private `DESIGN.md` and `STRATEGY.md` (kept outside this repo).

## Rules for everyone

- **New project.** Hacktoberfest rules require a project built during Oct 12 to 18. Do not copy code from older private pipelines. You may read them to learn flags, and you may call installed binaries and models (whisper-cli, ggml models) through the config (`~/.selects/config.json` or env).
- Node 23 on this Mac (target Node 20+), ESM `.mjs`, no TypeScript build step for core and eval. Keep dependencies few; prefer the standard library. Tests use `node:test`.
- Machine: Intel i5-7360U dual-core, 16 GB, no GPU, about 35 GB free. Be kind to disk: no large intermediates, delete temp WAVs, and never write video files into the repo (use `.selects/` or `jobs/`, which are gitignored).
- ffmpeg 7 at /usr/local/bin has **no libass, no subtitles filter, no drawtext**. Captions must be rendered as images (for example with `@napi-rs/canvas`, which ships prebuilt binaries) and composited with `overlay`. Do not install another ffmpeg.
- Everything runs locally. No network calls at runtime except to Ollama on localhost (and yt-dlp in eval only).
- Commit your own directory only, with clear messages ending in:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
  Do not push. Do not touch other builders' directories.
- No em dashes in user-facing copy, README, or docs.

## Binaries and models (config defaults; env overrides)

| Thing | Default | Env |
|---|---|---|
| whisper-cli | `whisperBin` in `~/.selects/config.json`, else `whisper-cli` on PATH | `SELECTS_WHISPER_BIN` |
| whisper model | `~/.selects/models/ggml-base.en.bin` (or `whisperModel` / `modelsDir` in the config file) | `SELECTS_WHISPER_MODEL` |
| Ollama | `http://127.0.0.1:11434` | `SELECTS_OLLAMA_URL` |
| Judge model | `gemma3:4b` if pulled, else the first `gemma3*` tag present (`gemma3-4b-hf:latest` is installed) | `SELECTS_MODEL` |
| Jobs dir | `~/.selects/jobs` (an existing `<repo>/.selects` is still used) | `SELECTS_HOME` |

whisper flags known to give word-level timestamps on this build: `-ml 1 -sow -ojf -np`.

## Data model (JSON on disk, one folder per job)

`<SELECTS_HOME>/jobs/<jobId>/`
- `job.json`: the Job object below (the single source of truth; written atomically: write temp, then rename)
- `audio.wav` (deleted after transcription), `whisper.json` (raw), `words.json`, `thumbs/strip-%04d.jpg`, `clips/<candidateId>.mp4`, `clips/<candidateId>.srt`, `clips/<candidateId>.kit.json`

```js
// Job
{
  id: "j_20261016_ab12",          // stable, sortable
  source: { path: "/abs/video.mp4", name: "talk.mp4", duration: 1864.2, width: 1920, height: 1080, fps: 25 },
  settings: { model: "gemma3:4b", k: 5, minLen: 20, maxLen: 60, preset: "shorts" },
  stage: "queued" | "probing" | "transcribing" | "candidates" | "judging" | "ready" | "rendering" | "done" | "error",
  stages: { probe: StageState, transcribe: StageState, candidates: StageState, judge: StageState, render: StageState },
  error: null | { stage, message, hint },     // message says what happened; hint says what to do
  words: null,                                 // not inlined; see words.json
  candidates: Candidate[],                     // filled after judging (ranked) or after candidates (unranked)
  curve: [{ t: 0, v: 0.12 }, ...],             // interest curve: 1 point per ~5 s, v in 0..1, from judge scores (smoothed)
  thumbs: { count: 60, interval: 31.07, pattern: "thumbs/strip-%04d.jpg" },
  createdAt, updatedAt                          // ISO strings
}

// StageState
{ status: "pending" | "running" | "done" | "error" | "skipped", startedAt, endedAt, progress: 0..1, etaSec: null | number, note: "transcribing at 0.4x real time" }

// Word (words.json is Word[])
{ w: "Nobody", s: 761.42, e: 761.80, p: 0.93 }   // text, start sec, end sec, probability

// Candidate
{
  id: "c_0007",
  rank: 2 | null,                    // 1 = best, null if not ranked yet
  start: 761.42, end: 807.10,        // seconds, snapped to word boundaries (sentence start / sentence end)
  text: "Nobody tells you ...",      // transcript of the window
  hook: "Nobody tells you the validator said yes before the bug.",  // first sentence
  scores: { hook: 5, standalone: 4, payoff: 4, clarity: 5 },       // 1..5 each, from the judge
  total: 0.87,                       // 0..1 combined
  reason: "Opens on a claim and resolves it inside 46 seconds.",   // one plain sentence from the judge
  title: null | "suggested post title",                             // filled by kit step after approval
  status: "proposed" | "approved" | "skipped",
  trimmed: false,                     // true once a person has moved start or end
  render: null | { status: "pending" | "running" | "done" | "error", path: "clips/c_0007.mp4", srt: "clips/c_0007.srt", kit: "clips/c_0007.kit.json", progress: 0..1 }
}
```

## Core module API (what eval and server import)

All in `src/core/`, each function async unless stated, each module unit-tested.

```js
import { probe } from "./probe.mjs";                 // probe(path) -> source object
import { transcribe } from "./transcribe.mjs";       // transcribe(videoPath, { onProgress, cacheDir }) -> Word[]
import { toSentences } from "./sentences.mjs";       // toSentences(words) -> [{ s, e, text, wordIdx: [i0, i1] }]  (sync)
import { makeCandidates } from "./candidates.mjs";   // makeCandidates(sentences, { minLen, maxLen, stride }) -> Candidate[] (unranked, sync)
import { judge } from "./judge.mjs";                 // judge(candidates, { model, onProgress, cacheDir }) -> Candidate[] with scores, total, reason
import { rank } from "./rank.mjs";                   // rank(candidates, { k, iou: 0.3 }) -> top-k Candidate[] with rank (sync; NMS on time overlap)
import { curve } from "./rank.mjs";                  // curve(candidates, duration, { step: 5 }) -> [{t, v}] (sync)
import { snapTrim } from "./sentences.mjs";          // snapTrim(words, start, end) -> { start, end } snapped to nearest sentence boundaries (sync)
import { render } from "./render.mjs";               // render(job, candidate, { preset, onProgress }) -> { path, srt }
import { postingKit } from "./kit.mjs";              // postingKit(candidate, { model }) -> { title, caption, hashtags[] }
import { runJob, resumeJob, createJob, loadJob, saveJob, listJobs } from "./job.mjs";  // job lifecycle with per-stage checkpoints; events via an EventEmitter `jobEvents`
```

Judge contract: Ollama `/api/chat` with `format` set to a JSON schema, `stream: false`, temperature 0.2, one request per candidate (or small batches if measurably faster), cached by hash(model + candidate text). The rubric prompt lives in `src/core/prompts/judge.md` so the post can quote it.

## HTTP API (src/server, default http://127.0.0.1:4317)

| Method | Path | Body or result |
|---|---|---|
| GET | `/api/health` | `{ ok, whisper: bool, ollama: bool, models: string[], diskFreeGb }` |
| GET | `/api/models` | `[{ name, sizeGb, measuredSecPerCandidate: number or null }]` for the Faster-to-Smarter control |
| GET | `/api/jobs` | `Job[]` (summaries) |
| POST | `/api/jobs` | `{ path, settings? }` (a local file path; the UI uses a path field and drag-and-drop of a path) -> `Job` |
| GET | `/api/jobs/:id` | `Job` |
| GET | `/api/jobs/:id/events` | Server-Sent Events: `stage`, `progress`, `words` (newly transcribed Word[] chunk, for the streaming reveal), `candidates`, `render`, `error` |
| GET | `/api/jobs/:id/words` | `Word[]` |
| PATCH | `/api/jobs/:id/candidates/:cid` | `{ status?, start?, end? }` -> server snaps start/end with `snapTrim`, sets `trimmed: true`, returns `Candidate` |
| POST | `/api/jobs/:id/render` | `{ ids?: string[] }` (default: all approved) -> 202; progress via events |
| POST | `/api/jobs/:id/resume` | resumes from the last finished stage |
| GET | `/media/:id/source` | the source video with HTTP Range support |
| GET | `/media/:id/thumbs/:n` | thumbnail JPEG |
| GET | `/media/:id/clips/:cid` | rendered clip with Range support |
| GET | `/*` | serves `web/dist` |

## Render preset `shorts`

1080x1920, H.264 (libx264, CRF 20, preset veryfast), AAC 160k, loudnorm to -14 LUFS (single pass is fine). Reframe: centre-crop 9:16 from 16:9 by default; if the speaker is not centred, fall back to blurred-background fit (scaled source over a boxblur of itself). Captions: 2 to 4 words at a time, Atkinson Hyperlegible Next Bold or a bundled open font, white with a dark outline, lower third inside the safe zone (keep clear of the bottom 18% for platform UI), current word highlighted in the marker yellow #F2BE22.

## Eval contract (eval/)

- `eval/datasets/manifest.json`: `[{ id, title, url, license, licenseUrl, localPath, duration, labels: [{ start, end, source: "human" | "heatmap" | "official-clip", weight }] }]`
- Methods to compare: `random`, `energy` (loudness and speech-rate heuristic, no LLM), `judge:<model>` for each local model, optionally `judge:backboard:<model>`.
- Metric: hit@k (k = 3 and 5): a prediction hits if its temporal IoU with any label is 0.5 or more; also precision@k and mean best IoU. Report wall time per video and per stage.
- Output: `eval/results/results.json` and `eval/results/RESULTS.md` (a table the post can paste), plus a per-video plot data file for the interest curve against the labels.

## Changes from core (16 Oct, after the measured speeds in review-tech-feasibility.md)

All additive: nothing above was removed or renamed.

- **Settings:** `settings.judgeN` (default 8) is how many pre-scored windows the LLM judge reads. `settings.kit` is `"model"` (default) or `"plain"` (no LLM for post titles). `settings.preset` stays `"shorts"`.
- **Two-stage selection:** `makeCandidates` now gives each candidate `pre` (0..1, no LLM: hook phrases, questions, numbers, contrast words, pace, pauses, loudness) and `preParts` (the parts of that score). `shortlist(cands, { n: 8, duration })` from `candidates.mjs` picks the windows the judge reads. Candidates from the candidates stage are the shortlist, not every window. Pass `{ loudness }` (from `loudness.json`) to `makeCandidates` to use the loudness signal.
- **judge()** still returns `Candidate[]`; the array also carries a non-enumerable `stats` property `{ wallSec, judged, cached, secPerCandidate }`. Each real Ollama call is appended to `<job>/judge-calls.jsonl` with `promptTokens`, `promptSec`, `outTokens`, `outSec`, token rates and `loadSec`. Ollama options: temperature 0.2, num_ctx 2048, num_predict 80, keep_alive 30m. Requests use node:http, not fetch (fetch drops a request after 300 s without headers).
- **Job folder extras:** `loudness.json` (`{ step: 0.5, db: number[] }`), `candidates.json` (`{ sentences, windows, shortlist }`), `judged.json` (all judged candidates, for the curve and eval), `judge-cache.json`, `judge-calls.jsonl`. `job.timings` holds wall seconds per stage (`probe`, `transcribe`, `candidates`, `judge`) and per rendered clip (`render: [{ id, sec, clipSec, kitSec }]`).
- **Source:** `source` also has `sar`, `displayWidth`, `hasVideo`, `videoStream` (non-square pixels are common in conference recordings).
- **Render presets:** `shorts` as above, plus `preview` (720x1280, x264 ultrafast, CRF 26) for quick drafts. A preview fills `candidate.preview` (same shape as `render`, file `clips/<cid>.preview.mp4`, no posting kit) and leaves the job in `ready`. Reframe is automatic: centre crop when the motion sits in the centre band, otherwise blurred-background fit; `render.reframe` says which.
- **Overnight queue (`src/core/queue.mjs`):** `enqueue({ jobId, kind: "analyze" | "render", ids?, preset? })`, `drainQueue()`, `queueState()`. Persisted in `<SELECTS_HOME>/queue.json`; one job at a time. The server queues new jobs, renders and resumes through it.
- **HTTP additions:** `GET /api/locate?name=&size=` returns `{ path }` for a dropped file found by exact name and size in the usual folders (404 if not found). `POST /api/jobs` accepts paths starting with `~/`. `GET /api/queue` returns `{ running, items }`. `POST /api/jobs/:id/render` also takes `preset: "shorts" | "preview"` and returns 202 `{ queued, clips, queue }`. `GET /media/:id/clips/:cid?preset=preview` serves the preview. The SSE stream sends a `job` event (the full Job) first, then the named events; `render` events carry `preset`. Errors are JSON `{ error, hint }`. Only `http://localhost:*` and `http://127.0.0.1:*` origins may call the API from a browser.
- **CLI:** `selects <video>`, `selects review <job-id>`, `selects queue add|run`, `selects jobs`, `selects serve`, `selects doctor`. Flags: `--model --k --min --max --judge-n --preview --plain-kit --out --yes`.
- **Attribution (16 Oct):** `settings.credit` (for example "Jenni, EMF 2026"), `settings.license` (a canonical id such as `CC-BY-SA-4.0`; spellings like "cc by-sa 4.0" are normalised) and `settings.sourceUrl` can be set when creating a job, or later with `PATCH /api/jobs/:id` and body `{ settings: { credit?, license?, sourceUrl? } }`, which returns the Job (other keys give a 400). Each `clips/<cid>.kit.json` now has `caption` (with the credit line appended), `captionText` (without it), `attribution` (the line, or null) and `reminder` ("Check slides and on-screen media: a talk's licence may not cover every figure."). Changing the credit rewrites existing kits; nothing re-renders. `src/core/attribution.mjs` exports `LICENSES`, `normaliseLicense`, `licenseCheck` (ND: adaptations not allowed; NC: no paid campaigns), `attributionLine` and `MEDIA_REMINDER`. CLI: `--credit`, `--license`, `--source-url` on `selects <video>` and `selects review <job-id>`.
- **Scoring (16 Oct, after the spread test in notes/timings.md):** each judged candidate has `judgeTotal` (the rubric alone, 0..1, weights hook 0.35, standalone 0.3, payoff 0.2, clarity 0.15) and `total`, the number it is ranked by: `0.7 * judgeTotal + 0.3 * pre`, then the listwise round. **Eval: use `judgeTotal` for a pure judge method, and `total` for the shipped pipeline.** The listwise round (`listwise(candidates, { model, n: 4 })` in `judge.mjs`, prompt in `prompts/listwise.md`) sends the top 4 distinct windows (NMS, IoU 0.3) as first and last sentences only, in one call, and the model orders them. Each total becomes `0.85 * total + 0.15 * listScore`, where listScore is 1, 2/3, 1/3, 0 by position, and 0 for windows outside the round. Candidates in the round get `listRank` (1 = best) and `listReason`. The job records `job.listwise = { order: ids[], reasons: {id: text}, complete, sec }`. `settings.listwise` (default true) turns the round off; `settings.listN` (default 4) sets its size. The judge schema puts the four scores before `reason`.
- **Posting kit over HTTP (16 Oct, web):** `GET /api/jobs/:id/candidates/:cid/kit` returns that clip's `kit.json` (`title`, `caption`, `captionText`, `hashtags`, `attribution`, `reminder`, ...) plus `file` and `srtFile`, the absolute paths of the rendered MP4 and SRT. 404 with a hint if the clip has no kit yet. The review app reads it for the render results.

## Languages, captions, transcript quality and blur (16 Oct, feature engineer)

All additive. Defaults keep every earlier job working.

### Settings (job.settings)

| Key | Default | Meaning |
|---|---|---|
| `mode` | `"clips"` | `"clips"` (find and render short clips) or `"caption"` (caption the whole video, keep its aspect, no clipping) |
| `language` | `"en"` | the spoken language: an ISO 639-1 code, or `"auto"` (decode-and-compare picks it). Never trust whisper's own auto-detect for accented English: it labelled Nigerian-accented English as Yoruba with p = 0.88. |
| `asrModel` | `"auto"` | `"auto"`, a model name in the models folder (`base.en`, `small.en`, `medium.en-q5_0`, `base`, `small`, ...) or an absolute path to a ggml file. Auto: `base.en` for English, the best installed multilingual model otherwise. |
| `asrPrompt` | `null` | a short neutral context passed to whisper as `--prompt` |
| `captions` | `true` | burn captions into rendered clips (`--no-captions` turns it off) |
| `captionLang` | `"source"` | `"source"`, `"en"` (whisper translate) or `"both"` (two lines: source over English). Only `"source"` is built; the others are stretch goals. |
| `captionStyle` | `"auto"` | `"bold"` (2 to 4 words, current word in marker yellow; the clip default) or `"subtitle"` (up to 2 lines of about 42 characters, no highlight; the caption-mode default for landscape) |
| `blur` | `null` | the blur spec below, for caption-mode jobs (clips use `candidate.blur`, falling back to this) |

### Blur spec

```js
blur: {
  faces: { mode: "off" | "all" | "others" | "chosen", tracks: ["f_02"] },  // "others" keeps the main speaker; "chosen" blurs only the listed tracks
  regions: [{ x: 0.62, y: 0.08, w: 0.3, h: 0.12, start: null, end: null }] // normalised to the upright source frame (after rotation); start/end in source seconds, null = the whole clip
}
```

`candidate.blur` has the same shape (PATCH it like status). Face tracks come from `<job>/faces.json` (macOS only, Apple Vision): `{ fps, width, height, tracks: [{ id: "f_01", start, end, boxes: [{ t, x, y, w, h }], area, share, main: bool }] }`, boxes normalised to the upright frame. `tools/faces/faces` writes the raw detections (`faces-raw.json`: `{ fps, width, height, frames: [{ t, faces: [{ x, y, w, h, c }] }] }`), and `src/core/faces.mjs` tracks them.

### Job fields

- `job.language`: `{ setting, used, detected: { code, p } | null, compared: [{ code, meanP, words }], margin, decided: "setting" | "compare", warning: null | string, sec }`. `detected` is whisper's own first-30-seconds guess, shown only as a warning. `compared` is decode-and-compare: 3 samples of about 20 s spread over the video, decoded with each candidate language (the setting, the detected language and "en") using multilingual base, ranked by mean word probability. Cached in `<job>/language.json`.
- `job.transcriptQuality`: `{ score, meanP, lowShare, repeatShare, compression, words, verdict: "good" | "shaky" | "unreliable", hint, suggest: null | { asrModel, language, force } }`. `suggest` is what to try, as data (the hint names CLI flags); `job.error.suggest` carries the same when the gate stops a run. Clip mode stops before candidates when the verdict is `"unreliable"` (stage `transcribe` ends `done`, `job.stage` becomes `"error"` with that hint); `"shaky"` continues with a warning.
- `job.asr`: `{ provider: "whisper.cpp", model, language, prompt, preprocess, sec, speed }`.
- `job.output` (caption mode): `{ status, path: "output/captioned.mp4", srt, vtt, file, srtFile, vttFile, progress, wallSec, stale? }` (path, srt, vtt relative to the job folder; file, srtFile, vttFile absolute).
- Stage `language` sits between `probe` and `transcribe` in `job.stages` (`job.stage` reads "transcribing" while it runs).
- Renders and `job.output` carry `inputs` (a fingerprint of the captions shown and the blur applied) and `stale` (true when captions or blur changed since; recomputed on every caption edit, reset and blur change, so undoing an edit clears it). Caption mode skips `candidates` and `judge` (status `"skipped"`) and waits in `"ready"` for the caption review.
- `source` also has `rotation` (degrees, from the display matrix), `uprightWidth`, `uprightHeight` (display size after rotation and SAR), `vcodec`, `audioStreams: [{ index, channels, sampleRate, codec }]`.
- Candidates have `meanP` (mean word probability in the window). The pre-score has a `confidence` part that penalises low-confidence windows, and `shortlist` drops windows with `meanP < 0.45` when enough others exist.

### Captions file

`<job>/captions.json`: `{ edited: bool, updatedAt, cues: [{ s, e, text, words: [{ w, s, e, p }] }] }`. Built from `words.json` the first time it is asked for. Clip renders and caption mode both read it, so edits apply everywhere. SRT and VTT are written from it.

### HTTP additions

| Method | Path | Body or result |
|---|---|---|
| GET | `/api/jobs/:id/captions` | `{ edited, cues, lowP: 0.5 }` |
| PUT | `/api/jobs/:id/captions` | `{ cues: [{ s, e, text }] }`: the whole list, in order. Splits and merges change the cue list; text edits change words. Timings are kept: a cue whose word count did not change keeps every word's time, otherwise its words are spread over the cue by length. Returns the new captions. |
| POST | `/api/jobs/:id/captions/reset` | rebuild from `words.json` |
| GET | `/api/jobs/:id/captions.srt`, `.vtt` | the files |
| POST | `/api/jobs/:id/language` | `{ language, asrModel? }`: re-transcribe with that language (the one-click override). 202. |
| POST | `/api/jobs/:id/faces` | run face detection (macOS). 202; a `faces` event carries the tracks when done. |
| GET | `/api/jobs/:id/faces` | `faces.json`, or 404 with a hint |
| PATCH | `/api/jobs/:id` | `settings` may now also carry `blur`, `captions`, `captionStyle`, `captionLang` |
| PATCH | `/api/jobs/:id/candidates/:cid` | may carry `blur` |
| POST | `/api/jobs/:id/render` | caption mode renders the whole video into `job.output` |
| GET | `/media/:id/output` | the captioned video (Range support) |
| GET | `/media/:id/frame?t=12.5` | one upright JPEG frame (for drawing blur regions) |
| GET | `/api/asr-models` | installed whisper models `[{ name, sizeMb, english }]` (for the model choice) |
| GET | `/api/profiles` | saved speaker profiles `{ name: { language, asrModel, asrPrompt, ... } }`; pass `settings.profile: name` when creating a job |

New SSE events: `faces`, `output` (caption-mode render progress, same shape as `render`), `captions`.

### CLI additions

`selects caption <video> [--language en|auto|<code>] [--asr-model small.en] [--prompt "..."] [--captions source|en|both] [--style bold|subtitle] [--edit] [--srt fixed.srt] [--blur-faces all|others] [--blur-region x,y,w,h[@start-end]] [--out dir]`, and on clip runs `--language`, `--asr-model`, `--prompt`, `--no-captions`, `--blur-faces`, `--blur-region`.

### ASR providers

`src/core/asr/` holds providers behind one interface: `{ id, local: bool, available(): Promise<bool>, transcribe(wav, { language, model, prompt, translate, signal, onProgress, onSegments }) -> { words, raw } }`. Only `whisper.cpp` is built. `elevenlabs-scribe` is listed as a future opt-in cloud provider and throws "not built" if chosen.

## Fixes (16 Oct, after the first real runs)

All additive.

- Every log or cache write in `src/core` creates its folder first (`appendJsonLine` in `util.mjs`). `judge-calls.jsonl` also gets one line per posting-kit call (`kind: "kit"`) when `postingKit` is given `cacheDir`.
- Whisper's non-speech notes (`[Music]`, `[BLANK_AUDIO]`, `(laughs)`, a split-up `(speaking in foreign language)`, any fully bracketed or parenthesised token or run) are dropped before sentences, candidates and captions are built (`src/core/nonspeech.mjs`: `splitNonSpeech(words) -> { words, events }`, `speechOnly(words)`). Their spans stay as gaps between words. The notes are saved as `<job>/events.json`: `[{ type: "laughter" | "applause" | "music" | "silence" | "inaudible" | "foreign" | "other", s, e }]`. `makeCandidates` takes `{ events }`; a laugh inside a window or up to 1.5 s after it adds a `laughter` pre-score part (0.04 each, at most 0.08). `loadWords` and `GET /api/jobs/:id/words` return speech words only, also for older `words.json` files.
- Sentences when punctuation is sparse (fewer than 1 sentence end per 25 words, `isSparsePunctuation` in `sentences.mjs`): a pause of 0.6 s or more (after at least 3 words) also ends a sentence, and no sentence runs past 12 s (split at its largest internal gap). Such sentences carry `soft: true`; `makeCandidates` then skips the lowercase-start and missing-full-stop rules for them (`isDanglingOpener(text, { soft })`, `isDanglingEnding(text, { soft })`) and keeps the rest. Punctuated transcripts are unchanged.
- The posting kit reads the edited transcript: when `captions.json` has `edited: true`, `kitSource(dir, candidate)` (in `job.mjs`) gives the kit the caption words inside the clip (and their first sentence as the hook) instead of the raw whisper text. The candidate itself is not rewritten. `prompts/kit.md` now says not to invent or repeat proper names unless they appear clearly in the transcript.
- The slide reminder only shows when it applies: `kit.json` `reminder` is the text when the job has a credit, a licence or a `sourceUrl`, and `null` when nothing is set or `settings.license` is `"own"` (own footage). `mediaReminder(settings)` in `attribution.mjs` and `needsMediaReminder(settings)` in `web/src/lib/licences.js` hold the rule. `PATCH /api/jobs/:id` and `--license` accept `"own"`.

## Language ID ensemble, accent routing and punctuation (16 Oct, speech-ML)

All additive. Models, licences and sizes are in `notes/MODELS.md`; measurements in `notes/timings.md`.

### `job.language` additions

```js
job.language = {
  ...,                       // setting, used, detected, compared, margin, best, decided, warning, sec (as before)
  rule: "ensemble-1",        // a cached language.json from another rule is recomputed
  decided: "setting" | "compare" | "ensemble" | "detector" | "default",
  compared: [{ code, meanP, words, englishShare,
               text: { lid608: { label: "eng_Latn", code: "en", p, pcm } | null,       // olaverse lid-lite-608 on that decode's text
                       ng5: { eng, hau, ibo, pcm, yor, matched } | null } }],          // olaverse lid-lite-5
  textLid: { models: ["lid-lite-608", "lid-lite-5"], sec, error: null | string } | null,
  ensemble: {
    language: "en",          // what the evidence says
    used: "en",              // what Selects transcribes with (the setting when the user chose one)
    confidence: 0.85,        // the winner's share of the weighted vote, or null with no signals
    scores: { en: 2.45, yo: 0.45 },
    signals: [{ id: "whisper-detect" | "whisper-decode" | "text-608" | "text-ng5", kind: "audio" | "decode" | "text",
                model, verdict: "en" | null, p, weight, refuted: bool, margin?, detail? }],
    disagreement: false,
    reasons: [],             // plain phrases, e.g. "whisper-detect says Welsh", "only 52% of the vote"
    question: null,
  },
  question: null | { text: "Is the speaker using English?", language: "en", choices: ["yo", ...] },  // null once answered
  confirmed: { by: "user", language, at } | undefined,
}
```

The rule (`src/core/langid/rule.mjs`, tested in `src/core/langid.test.mjs`): each signal votes for its verdict with `weight * p`. Weights: whisper-detect 0.5 (the signal known to fail on accents), whisper-decode 1.0 (0.5 when the decode margin is under 0.05), text-608 1.0, text-ng5 0.5. The text signals only vote when whisper wrote another language than the one it was asked for (asked for Yoruba, wrote English: a vote for English that refutes Yoruba); otherwise they have no opinion. A decode with mean word probability under 0.3 (or under 5 words) failed: its text is ignored and its language is refuted. `disagreement` is true when a signal that was not refuted votes for another language, the winner has under 60% of the vote, the user's setting differs from the evidence, or the top language cannot be transcribed by whisper (Igbo).

**UI:** when `job.language.question` is not null, show `question.text` with two answers: **Yes** sends `POST /api/jobs/:id/language { language: question.language, confirm: true }` (200, returns the Job; nothing is transcribed again; `question` becomes null and `confirmed` is set). **Choose another language** offers `question.choices` first, then any code, and sends `POST /api/jobs/:id/language { language }` as before (202, transcribes again). The run is not paused while the question is open: Selects transcribes with `used` and the answer can redo it.

### Accent routing

- `settings.accent`: `"auto"` (default), `"ng"` (Nigerian English, always use the fine-tune for English), `"none"`. Saved in profiles. CLI `--accent auto|ng|none`. `POST /api/jobs/:id/language` also takes `accent`.
- In `"auto"`, English is routed when the language check found a cue: whisper's detector heard Yoruba, Hausa or Igbo (p >= 0.5) in speech that turned out to be English, or the English decode's text has a Nigerian-language share of 0.25 or more (lid-lite-5) or reads as Pidgin (lid-lite-608, 0.3 or more).
- `settings.asrModel` other than `"auto"` always wins. A missing model file is never fatal.
- `job.accent = { accent: "ng" | null, routed: bool, model: "ggml-small-nigerian-accent.bin" | null, cues: [{ kind: "audio" | "text", note }], reason }`, and `job.asr.accent` is `"ng"` when the fine-tune transcribed.

### Punctuation

- `settings.punctuate` (default `true`). When the transcript is English and sparse (`isSparsePunctuation`), the Edge-Punct-Casing model (sherpa-onnx) restores full stops, commas, question marks and casing in `words.json` before sentences, candidates and captions are built. Spelling and timings are whisper's; whisper's own punctuation and capitals are kept.
- `job.punctuation = null | { restored: bool, model, changed, sec, reason }` (`reason` says why not, for example a missing model; the pause-based fallback then applies as before).
- `sherpa-onnx-node` is an optional dependency (prebuilt for macOS x64 and arm64, Linux, Windows).

### Config (env)

| Thing | Default | Env |
|---|---|---|
| text LID models | `<models>/langid` | `SELECTS_LANGID_DIR` |
| Nigerian-accent whisper | `<models>/ggml-small-nigerian-accent.bin` | `SELECTS_ACCENT_MODEL_NG` |
| punctuation model | `<models>/punct/sherpa-onnx-online-punct-en-2024-08-06` | `SELECTS_PUNCT_DIR` |

VAD was measured and not adopted (whisper.cpp's built-in Silero VAD moved word times by up to 4 s and squashed pauses; see `notes/timings.md`).

## Faithful cuts (16 Oct, evening, core)

All additive. After ranking, each top pick (about k clips) is checked once more: does cutting here change what the speaker meant? The pure parts are in `src/core/faithful-core.mjs` (browser-safe), the Ollama call in `src/core/faithful.mjs`, the prompt in `src/core/prompts/faithful.md`.

### Candidate field

```js
candidate.faithful = {
  verdict: "faithful" | "check" | "misleading",
  issue: "turn" | "quote" | "sarcasm" | "qualifier" | "reference" | null,
  note: "One plain sentence for the user.",   // for check/misleading it quotes the words outside the clip
  fix: { start?: 21.4, end?: 51.2 } | null,   // grow to the nearby sentence boundary (snapTrim); only the edges that move
  by: "model" | "rules",                       // rules only when settings.faithful is "rules" or the model call failed
  hints: ["turn"],                             // what the cheap rule check noticed (the model saw these as a hint)
  answers?: { lastPoint, after: "agrees" | "adds" | "limits" | "reverses" | "unrelated", whose_view: "own" | "others", sarcastic: "yes" | "no", needs_before: "yes" | "no" },
  meaning?: "the model's sentence on what the speaker means",   // when the note quotes evidence instead
  context: { before: "sentence before the clip" | null, after: "sentence after" | null },
  error?: "why the model could not check it",
  accepted?: true,                             // the person kept the cut as it is
  applied?: true,                              // the person took the fix (or trimmed to cover it)
}
candidate.demoted = true                       // only while a misleading cut is neither accepted nor fixed
```

- Nothing is applied on its own. A `"misleading"` clip is moved below the others (ranks renumbered, `demoted: true`) until the person accepts it or applies the fix. Rules alone never say `"misleading"`: a rule hint gives `"check"`, no hint gives `"faithful"`.
- `PATCH /api/jobs/:id/candidates/:cid` takes `{ faithful: "accept" | "fix" | "reset" }`. `"fix"` moves start and end to `faithful.fix` (like a trim: `trimmed: true`, the old render is dropped) and sets `applied`. A trim that covers the fix also sets `applied`. Returns the Candidate; the `candidates` event carries the reordered list.
- `job.faithful = { mode, checked, faithful, check, misleading, asked, cached, failed, sec, secPerCall }`; `job.timings.faithful` is its wall seconds (inside the judge stage, which now reports 0 to 0.8 for the pointwise calls, 0.8 for the listwise round and 0.9 to 1 for this check).
- `settings.faithful`: `"model"` (default, one call per top pick, cached in `judge-cache.json`, logged in `judge-calls.jsonl` as `kind: "faithful"`), `"rules"` (no model) or `"off"`. CLI `--faithful model|rules|off`. With `--yes`, misleading cuts are left unapproved.
- The model does not give the verdict: it answers five narrow questions (`answers`), and `faithfulRule(answers, hints)` decides. A model answer counts only where the rule check's hints back it up (see `notes/faithful-examples.md`).
- Browser: `tasks.mjs` has a `faithful` task: `{ kind: "faithful", candidate, before, after, hints }`, with `prompts.faithful` the text of `prompts/faithful.md`; `readTask` returns `{ verdict, issue, extend, note, answers }` (verdict from the rule) or null. Build the field with `contextFor`, `faithfulHints` and `faithfulResult` from `faithful-core.mjs`, then order with `orderByFaithful`.

## Selects Web: the engine in the browser (16 Oct, browser builder)

All additive. The browser build (`src/browser/`) runs the pipeline in the visitor's tab and serves the same Job, Candidate, Word and event shapes as the server. Full interface: `src/browser/adapter.md`.

### Browser-safe core modules

These have no Node imports anywhere in their import graph (checked by `src/core/browser-safe.test.mjs`), and the browser build imports them directly. The original modules import and re-export them, so every existing caller is unchanged.

| Module | Holds | Re-exported by |
|---|---|---|
| `format.mjs` | `tc`, `srtTime`, `slugify` | `util.mjs` |
| `cues.mjs` | `STYLES`, `chunkWords`, `cuesFromWords`, `applyCueEdits`, `toSrt`, `toVtt`, `parseSubtitles`, `clipCues`, `textInRange` | `captions.mjs` |
| `layout.mjs` | `PRESETS`, `captionOptions`, `layoutCaption`, `paintCaption(ctx, words, highlightIdx, { width, caption, families })`, `captionTimeline(cues, clipDur, { perWord })`, `captionTop`, `workingSize`, `reframeByShape`, `motionSize`, `reframeFromMotion(raw, W, H, dispW, dispH)`, `clipWords`, `captionChunks` | `render.mjs` (which now draws with `paintCaption` and times captions with `captionTimeline`; its ffconcat output is unchanged) |
| `judge-core.mjs` | `WEIGHTS`, `BLEND`, `LIST_WEIGHT`, `blend`, `combine`, `clamp`, `JUDGE_SCHEMA`, `salvageJudge`, `splitPrompt`, `judgeMessages`, `listMessages`, `listSchema`, `parseListAnswer`, `applyListOrder`, `tidyReason`, `lastSentence` | `judge.mjs` |
| `kit-core.mjs` | `KIT_SCHEMA`, `plainKit`, `kitMessages(md, candidate)`, `cleanKit` | `kit.mjs` |
| `tasks.mjs` | model tasks for runtimes other than Ollama: `buildTask(task, prompts) -> { messages, schema, maxTokens }`, `readTask(task, { data, text })`, `extractJson`, `schemaHint`, `withSchemaHint`, `checkTaskShape`, `slimTask`, `batchMessages`, `batchSchema` | (new) |
| `gemini.mjs` | Gemma through the Gemini API: `geminiGenerate({ key, model, messages, schema, maxTokens, timeoutMs = 25000, retries = 1 })`, `geminiBody`, `toGeminiSchema`, `readGemini`, `refusedFeature` | (new) |
| `langid/cues.mjs` | `nigerianCues`, `NG_TEXT_SHARE`, `NG_AUDIO_P` | `langid/accent.mjs` |

A task is `{ kind: "judge", candidate }`, `{ kind: "judgeBatch", candidates }` (Smart mode option: the shortlist in one call, each clip scored on its own), `{ kind: "listwise", top }` or `{ kind: "kit", candidate }`. Prompts are always the files in `src/core/prompts/`, so a prompt change reaches the desktop, the browser and the proxy at once.

### Browser job fields

- `job.key`: the content key of the video (`v_` + 32 hex: SHA-256 over size, name, lastModified and the first and last 1 MB).
- `job.source.path` is `null`; `source.size`, `source.canDecodeVideo` and `audioStreams[].canDecode` are added.
- `job.asr = { provider: "transformers.js", model, device: "webgpu" | "wasm", decodeSec, loadSec, sec, speed, chunks }`.
- `job.judge = { backend: "gemma4-webgpu" | "gemma3-wasm" | "gemini-key" | "gemini-proxy", model, where: "device" | "google", loadSec, calls, secPerCandidate, fallbacks, note?, smartError? }`. A judged candidate has `judgedOn: "device" | "google"` and, when Smart mode fell back, `fallbackNote`.
- `job.language` is the light check (lid-lite-5 on the English text): `{ setting: "en", used: "en", decided: "setting", textLid, accentCues, warning }`.
- `job.resumed = { from, savedAt, withFile? }` when a saved job was picked up; `job.error.needsFile: true` when a step needs the video again.
- `settings.asrDevice`: `"auto"` (WebGPU when there is an adapter) or `"webgpu"` or `"wasm"`. `settings.smartBatch`: judge the shortlist in one Smart mode call.
- Every URL (thumbnails, source, clips, SRT, kit files) is a `blob:` URL.
- Faithful cuts (`candidate.faithful`, `demoted`, `job.faithful`), `settings.madeFor` (through `applyMadeFor` and `clipCaptionStyle`) and the quality bar (`candidate.weak`, `job.verdict`) work as in `job.mjs`, from the same pure modules; `PATCH { faithful }` is `patchCandidate(id, cid, { faithful })`.

### Saved on the device

IndexedDB database `selects-web`, store `kv`: `job:<key>` (the Job, which stages are done, the candidates settings fingerprint), `part:<key>:<words|events|loudness|shortlist|judged|captions|kits>`, `pcm:<key>` (16 kHz mono Float32Array), `clip:<key>:<cid>:<preset>` (`{ mp4: Blob, srt }`). The video goes to OPFS `videos/<key>` when it is under half of the free quota. Choosing the same file again (same key) resumes that job.

### Smart mode proxy (`server-proxy/`)

`POST /v1/task` with a slim task (only `text`, `hook`, `start`, `end` per clip) returns `{ text, model, promptTokens, outTokens, finish }`; `GET /healthz` returns `{ ok, model, limits, counts }`. 400 for any other body shape, 403 for an origin not in `ALLOWED_ORIGINS`, 429 with `retry-after` (and `scope: "ingress" | "ip" | "global"`) over the limits, 504 when Gemma did not answer within the timeout (the page then judges that clip on the device). The proxy builds prompts from `src/core/prompts` itself and never logs clip text. Order of checks (22 Oct): a cheap per-IP ingress limit before the body is read, then the body cap and the strict task check (413, 400), and only then the model quota (per IP and global, charged together), so invalid bodies never use up the shared quota. `/healthz` returns all `limits`. `TRUST_PROXY_HOPS` defaults to 3 on Render.

## Made for presets (17 Oct, core)

All additive. `src/core/madefor.mjs` (browser-safe) holds the presets.

- `settings.madeFor`: `"shorts"` (default; Shorts, Reels or TikTok), `"linkedin"`, `"x"` or `"story"`. Set when the job is created (`POST /api/jobs` settings, CLI `--made-for`); an unknown name is a 400. It changes only:
  - the length range, unless `minLen` or `maxLen` were given: shorts 20 to 60 s, linkedin 30 to 90, x 15 to 45, story 60 to 90;
  - the caption style for clips, unless `captionStyle` was given: `settings.captionStyle` is filled in at creation (linkedin `"subtitle"`, the rest `"bold"`), and clip renders now honour `"subtitle"` (`render.captionStyle` says which was used);
  - the posting kit: `kit.json` has `madeFor`; the prompt gets that platform's block from `prompts/kit.md`; hashtags are 3 to 5 (shorts, story), 0 to 3 (linkedin) or 0 to 1 (x).
- `story` adds one line (the `<!-- made-for: story -->` block in `prompts/judge.md`) to the judge's system prompt. Other presets send the rubric unchanged, so their judge cache is shared.
- Exports: `MADE_FOR`, `madeForPreset(name)`, `applyMadeFor(settings)`, `clipCaptionStyle(settings)`, `madeForBlock(md, key)`; `kitSchema(madeFor)`, `kitMessages(md, c, { madeFor })`, `cleanKit(d, { madeFor })` in `kit-core.mjs`; `judgeMessages(prompt, c, { extra })` in `judge-core.mjs`.
- Browser tasks: `judge`, `judgeBatch` and `kit` tasks take an optional `madeFor`, kept by `slimTask`.

## Quality bar (17 Oct, core)

All additive. `STRONG_TOTAL = 0.55` in `src/core/rank.mjs`, calibrated on this machine's jobs (scores only): a private phone video the judge called weak topped out at 0.52 (0.40 to 0.52), the EMF talk scored 0.56 to 0.68, and the best clip of each of the 6 eval videos 0.60 to 0.68.

- `job.verdict = { strong: n, threshold: 0.55, best: 0.52, note }`, set when judging finishes (after the faithful check) and recomputed when a faithful accept or fix changes the order. `note` is plain text for the UI, for example "No strong clips in this video. These are the closest 2, with why." or "2 strong clips. The other 1 is weaker." A demoted (misleading, not accepted) clip never counts as strong.
- Each ranked candidate has `weak: true | false` (below the bar, or demoted).
- When `strong` is 0, `job.candidates` holds only the closest 2 (ranks 1 and 2); each keeps its `reason` as the "why".
- `GET /api/jobs` summaries carry `verdict`. The CLI prints "No strong clips in <video>." instead of "N proposed clips" and marks weak clips; with `--yes` it still renders the closest ones and says so.
- `qualityVerdict(cands, { threshold })` and `applyQualityBar(cands, { threshold, closest: 2 })` are exported from `rank.mjs` (browser-safe).

## Transcript reuse (17 Oct, core)

All additive. `src/core/reuse.mjs`.

- The language check and the transcript are saved in `<SELECTS_HOME>/cache/` (`language/<key>.json`; `transcripts/<key>/` with `words.json`, `events.json`, `loudness.json`, `meta.json`). The source is identified by `sourceFingerprint(path)`: sha1 of size, mtime and the first and last 4 MB (8 MB read at most). The transcript key adds the whisper model's file name, the language, the prompt, the audio clean-up and the audio stream; the language key adds the setting, the remembered language, the rule version and the check model. Caption mode and clip mode share both.
- Whisper's words are saved before punctuation restoration and the non-speech split, so a reused job runs those steps (seconds) the same way as a fresh one.
- `job.reuse = { language: { key, sec } | null, transcript: { key, from: jobId, sec } | null }`: `sec` is what the original run took, so the UI can say "reused the transcript from an earlier run (saved 2 min)". The stages still run and end `done`, with a progress note saying what was reused.
- `settings.reuse: false` (CLI `--fresh`) turns it off for one job; `SELECTS_REUSE=0` everywhere.

## Long videos and many clips (17 Oct, performance)

All additive except the `judgeN` default. Measured numbers are in `notes/timings.md`, "Long videos".

- **Chunked transcription.** `transcribe()` cuts recordings over 1.5 parts (15 minutes) into parts of about `SELECTS_CHUNK_SEC` (600 s), each ending at the quietest 0.2 s within 15 s of the cut, and keeps each finished part as `<job>/whisper-chunks/NNN.json` with `plan.json` (the cuts and the whisper settings). A resumed job transcribes only the parts without a JSON; changing the model, language, prompt or clean-up starts over. `audio.wav` is written as `audio.part.wav` and renamed when complete, and stays until the transcript is merged into `whisper.json`. Exported helpers: `planChunks`, `wavInfo`, `quietestIn`, `writeWavSlice`, `mergeWhisperJson`.
- **Judge count.** `settings.judgeN` now defaults to `null` (auto): `judgeCount({ k, duration, judgeN, secPerCall, budgetSec })` in `select.mjs` gives max(16, 2k, one per 5 minutes), capped by a time budget (`judgeBudgetSec(duration)`: half the video's length, at least 10 minutes) at the judge's seconds per call (`settings.judgeSecPerCall`, else the model's measured speed in `models.json`, else 70 s), never below k + k/5. An explicit `judgeN` is kept, raised only to k + k/5. `selectCandidates` returns `judgeN: { n, auto, capped, floor }`; the job keeps it as `job.judgeN` and, when auto, writes the count it used into `settings.judgeN`.
- **Shortlist spread.** On inputs over 30 minutes `shortlist()` uses at least one segment per 10 minutes (never more than n) and caps each segment at max(3, 2n / segments) picks. Up to 30 minutes it picks exactly as before.
- **Estimate.** After the probe each job gets `job.estimate = { stages: { probe, language, transcribe, judge, render }, analysisSec, renderSec, totalSec, overnight, judgeN, measured: { judgeSec, asrSpeed }, at }` (seconds; `estimate.mjs`, browser-safe), and an `estimate` event. `overnight` is true when finding the clips will take over 30 minutes. `progress` events carry `jobEtaSec`: this stage's ETA plus the estimate for the analysis stages still to run.
- **Disk.** Before transcribing and before rendering the job checks free space (`diskNeed`); a full disk anywhere (ENOSPC, or "No space left on device" from ffmpeg or whisper) fails the job with `error.code = "disk_full"`, a message that says how much is needed and free, and a hint to free space or move `SELECTS_HOME`. HTTP status for the error object, where one is sent: 507.
- **Render queue.** `renderJob` renders one clip at a time and saves each as soon as it is done. A clip that fails gets `render` (or `preview`) `{ status: "error", message, hint }` and the rest carry on; the stage note says "rendered 5 of 6 clips ... 1 failed" and `stages.render.failed` lists the ids. A stop or a full disk ends the queue. Clips approved while it runs (no `ids` given) join the end. The renderer merges the person's fields (`status`, `blur`, `start`, `end`, `text`, `hook`, `trimmed`, `faithful`, and `settings`) from disk before every save, so approvals and credit edits made during a render are kept. `render` events carry `queue: { done, total, etaSec }`.
- **Approve top N.** `approveTop(id, n, { includeWeak = true })` approves the first n candidates in review order that are not skipped. `POST /api/jobs/:id/approve { top: n, render?: boolean, preset?: "shorts" | "preview", includeWeak?: boolean }` returns `{ approved, candidates }` (200), or 202 with `queue` when `render` is true.
- **Queue.** Items have a `key`; finished items are removed by key. A render request for a job whose render is already running queues behind it; two waiting render requests for the same job and preset merge their `ids` (no ids means every approved clip).
- **Thumbnails.** One every 30 s, 60 to 240 (`thumbCount`).
- **Browser.** Videos over 20 minutes decode and transcribe in segments of about 10 minutes (`src/browser/pcm.js`): each segment's 16 kHz PCM goes to OPFS as `pcm/<key>/<index>.f32` (memory where OPFS is missing), the words so far are saved as the part `asrPartial` after every segment, and the finished job keeps `pcmSegs` instead of `pcm`. `job.warning` says plainly when a video is too long for this device: on a phone or tablet over 30 minutes, "For videos over about 30 minutes, use Selects on a laptop."

## Signatures, decisions and kits (22 Oct, after an external review)

All additive.

- **Signatures** (`src/core/signatures.mjs`, browser-safe). Each computed result carries a versioned signature of its inputs: `transcriptSignature` (source, speech model, precision, device setting, language, prompt, clean-up, audio stream), `selectionSignature` (`transcriptHash` of the words, events and loudness, the length range, the stride, the effective window count, the loop stretches kept out), `judgmentSignature` (the selection, the judge backend and its configured model, hashes of the judge, listwise and faithful prompts, the story preset, listwise, listN, faithful mode, maxLen, k, smartBatch) and `kitSignature` (the kit's source text and hook, the kit prompt, the platform, the kit mode; which model wrote it is recorded as `madeBy`, not signed). `SIG_VERSIONS` is bumped when a stage's code changes what it produces. A stage is reused only when its saved signature equals the one the current inputs give; re-ranking never repeats transcription.
- **Desktop** (`job.mjs`): `job.signatures = { transcript, selection, judgment }`. On every run, a finished candidates or judge stage whose signature no longer matches is run again (a finished stage from before signatures is adopted as is).
- **Browser** (`engine.js`): the saved record has `sigs: { transcribe, candidates, judge }`; the judge stage is saved as the part `judgment` (`{ judged, candidates, curve, verdict, listwise, faithful, judge }`, replacing `judged` and the old `candKey`). The in-page answer cache (`judge.js`) is keyed by `taskKey`: the backend, the model and the exact built messages, schema and output budget.
- **Decisions** (`src/core/decisions.mjs`, browser-safe). Approvals, trims and faithful accepts are kept apart from the judgment, keyed by the window (`windowKey`: the selection's start and end; a trim keeps them as `origStart`, `origEnd` on the candidate). `captureDecisions` and `applyDecisions` put them back on a new judgment only where the same window is a candidate again. Desktop: `job.decisions`; browser: the part `decisions`.
- **Rendered clips and kits** are linked to a candidate only when their saved `start` and `end` match it (browser `clip:` records and kits now store them).
- **Kits follow the clip, on their own** (both engines). A rendered clip is `render.status: "done"` (saved, announced, playable) the moment its MP4 is stored; its posting kit is written afterwards with its own `render.kitStatus` (`"pending" | "running" | "done" | "error"`), `render.kitError` and `render.kitSec`. A failed kit leaves a plain kit (the clip's opening line) to copy meanwhile. `POST /api/jobs/:id/candidates/:cid/kit` (202) and `retryKit(id, cid)` in `job.mjs` and the browser adapter write it again; `GET .../kit` answers 404 "still being written" while it is pending. The kit reads the edited captions through `kitSourceFromCaptions(caps, candidate)` (`kit-core.mjs`, browser-safe; `job.mjs kitSource` wraps it). In the browser a caption edit, a caption reset or a kit-mode change rewrites only the kits whose `kitSignature` changed; on the desktop such an edit already marks the clip's render stale, and rendering again rewrites its kit. The browser writes a model kit only with Smart mode or a private model that is loaded or already saved; otherwise it writes the plain kit and says why (`kit.note`).
- **No surprise downloads** (browser). When Smart mode does not load and the private model is neither loaded nor saved in the browser (`backend.isCached()`), the judge stage stops with `job.error = { code: "smart_unavailable", message, hint, choices: [{ id: "retry" }, { id: "preliminary" }, { id: "download", bytes, estSec, mbps, metered, warning }] }` (the estimate and warning from the Network Information API, `downloadAdvice` in `devices.js`). `chooseJudge(id, choice)` runs the job again with the choice, reusing the transcript and shortlist. "preliminary" ranks the shortlist by `pre` with the rule-only faithful check (`job.judge.backend: "prescore"`, candidates `judgedOn: "prescore"`). With the private model saved, Smart mode falls back to it and `job.judge.note` says so. A single slow Smart mode clip uses the private model only when it is saved; otherwise the clip keeps its pre-score with the reason "Smart mode could not judge this clip". Backends now carry `sigModel`, `loaded` and `isCached()`.
- **One device choice** (browser). `chooseRuntimes({ webgpu, vendor, deviceMemoryGb, prefer, asrDevice })` in `src/browser/devices.js` picks the judge (Gemma 4 on WebGPU with at least 4 GB, else Gemma 3 on the CPU) and whisper's device (WebGPU unless the adapter is Intel). `privateBackend`, `downloads()` and `loadAsr` all use it, so the sizes shown are the sizes fetched.

