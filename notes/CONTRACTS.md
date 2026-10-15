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
