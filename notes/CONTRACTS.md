# Selects: shared contracts (read before writing code)

Three builders work in parallel: **core** (`src/core`, `bin`, `src/server`), **web** (`web/`), **eval** (`eval/`). This file is the interface between them. If you must change a contract, change it here first and say so in your final report.

Product and design source of truth: `/Users/mac/Documents/DevProjects/road-to-50k/crew/hacktoberfest/DESIGN.md` and `STRATEGY.md`.

## Rules for everyone

- **New project.** Hacktoberfest rules require a project built during Oct 12 to 18. Do not copy code from `road-to-50k/crew/video-weekend/pipeline/`. You may read it to learn flags, and you may call installed binaries and models it built (whisper-cli, ggml model).
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
| whisper-cli | `/Users/mac/Documents/DevProjects/road-to-50k/crew/video-weekend/pipeline/vendor/whisper.cpp/build/bin/whisper-cli`, else `whisper-cli` on PATH | `SELECTS_WHISPER_BIN` |
| whisper model | `.../pipeline/models/ggml-base.en.bin` | `SELECTS_WHISPER_MODEL` |
| Ollama | `http://127.0.0.1:11434` | `SELECTS_OLLAMA_URL` |
| Judge model | `gemma3:4b` if pulled, else the first `gemma3*` tag present (`gemma3-4b-hf:latest` is installed) | `SELECTS_MODEL` |
| Jobs dir | `<repo>/.selects/jobs` | `SELECTS_HOME` |

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
