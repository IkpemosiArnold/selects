# Selects Web: the browser adapter

`src/browser/api.js` exports `createBrowserApi()`. It returns an object with the same methods as the HTTP client in `web/src/lib/api.js`, but it is served by an engine that runs in the visitor's tab (`src/browser/engine.js`) instead of the local server. The Job, Candidate, Word and event shapes are the ones in `notes/CONTRACTS.md`, so the review UI can run against either.

```js
import { createBrowserApi, capabilities } from "../../src/browser/api.js";

const api = createBrowserApi();                    // Private mode (the default)
const job = await api.createJob(file, { k: 5 });   // a File from <input type=file> or a drop
const stop = api.events(job.id, (type, data) => { /* same events as the SSE stream */ });
```

## Modes

| Mode | What runs where | What leaves the device |
|---|---|---|
| Private (default) | whisper and Gemma run in the tab; the clip is rendered in the tab | nothing (models are downloaded once) |
| Smart, own key | whisper and the render in the tab; the judge is Gemma on Google's Gemini API | the transcript text of the shortlisted passages, sent to Google |
| Smart, proxy | as above, through `server-proxy` with the project's key | the same text, through the proxy to Google; the proxy does not log it |

```js
api.setMode("private");
api.setMode("smart", { key });              // kept in sessionStorage for this tab only
api.setMode("smart", { proxyUrl });         // defaults to VITE_SELECTS_PROXY_URL from the build
api.setMode("smart", { key: null });        // forget the key
api.getMode();                              // { mode, hasKey, proxyUrl, model, prefer }
api.preferBackend("gemma3-wasm");           // force the CPU judge (or "gemma4-webgpu", or "auto")
```

Plain copy for each mode, the limits, and the download sizes is in `src/browser/copy.js` (`api.copy`). Use `api.copy.smartMode.line` next to the Smart mode switch: it is the one sentence on what leaves the device.

## Methods

Same as the HTTP client:

| Method | Notes |
|---|---|
| `health()`, `models()` | `models()` returns the judge that will run here, with `where: "device" \| "google"` |
| `listJobs()`, `getJob(id)`, `getWords(id)` | jobs live in memory for the page's life |
| `createJob(file, settings)` | **takes a File, not a path**. Settings as on the desktop (`k`, `minLen`, `maxLen`, `judgeN`, `listwise`, `credit`, `license`, `sourceUrl`, `captions`, `kit: "model" \| "plain"`), plus `asrDevice: "auto" \| "webgpu" \| "wasm"` (auto: WebGPU unless the adapter is Intel, where the CPU measured faster) |
| `patchCandidate(id, cid, { status?, start?, end? })` | trims snap with the core's `snapTrim`, as the server does |
| `patchJob(id, { credit?, license?, sourceUrl?, captions?, k?, kit? })` | rewrites existing posting kits, as the server does |
| `getCaptions`, `putCaptions`, `resetCaptions` | the core's cue logic (`src/core/cues.mjs`) |
| `captionsFileUrl(id, "srt" \| "vtt")` | returns a `blob:` URL |
| `render(id, ids?, preset?)` | `preset` is `"shorts"` (1080x1920) or `"preview"` (720x1280); progress through `render` events |
| `getKit(id, cid)` | the posting kit; `file` and `srtFile` are `blob:` URLs (use them as download links with a `download` attribute) |
| `retryKit(id, cid)` | write a rendered clip's title and caption again; progress comes as `render` events with `kitStatus` |
| `events(id, onEvent)` | sends `job` first, then `stage`, `progress`, `words`, `candidates`, `render`, `captions`, `error` with the server's payloads |
| `thumbUrl(id, n)`, `sourceUrl(id)`, `clipUrl(id, cid, preset?)` | `blob:` URLs (`n` from 1) |

Browser-only additions: `setMode`, `getMode`, `preferBackend`, `capabilities()` (WebGPU, cross-origin isolation, threads, WebCodecs, H.264 encoding), `downloads()` (what Private mode will download on this browser, with sizes, licences and where each is cached; the runtimes come from `chooseRuntimes` in `devices.js`, the same function the engine runs with, so the sizes shown are the sizes fetched), `copy`, and `engine` (the engine itself, for tests).

## Resume, phones and installing

Phones freeze background tabs and stop service workers after seconds, so Selects Web never promises background work. It saves after every stage instead (see `store.js`), keyed by a content hash of the file:

| Saved | When | Resumes without the file? |
|---|---|---|
| source, thumbnails count | after probe | yes (thumbnails need the file or the kept copy) |
| words, events, loudness, 16 kHz audio | after transcribe | yes |
| shortlist | after candidates (reused only with the same length and judgeN settings) | yes |
| judged clips, ranking, curve, faithful checks, quality verdict | after judge | yes |
| approvals, trims, faithful accept or fix, credit | on each change | yes |
| caption edits, posting kits | on each change | yes |
| rendered clips (MP4 and SRT) | after each render | yes, they play from storage |
| the video itself | after probe, in OPFS, when it fits in half the free quota | (it is the file) |

Measured in headless Chrome: closing the browser after transcription and reopening picked the job up at the judge without choosing the file again; approvals survived another close; the rendered clip played after a third reopen; a different file was refused with "This is not the same video file."

| Method | What it does |
|---|---|
| `createJob(file, settings)` | if this device has the same file's job saved, it resumes that job (`job.resumed = { from, savedAt }`) |
| `listSaved()` | `[{ key, id, name, size, savedAt, from, finished }]`, newest first. Show unfinished ones as "Not finished yet" |
| `openSaved(key, file?)` | reopen a saved job; uses the kept copy of the video when there is no file |
| `attachFile(id, file)` | give a resumed job its video again (checked by content key; 409 if it is another file) |
| `forgetSaved(key)` | delete everything saved for that video |
| `enableNotifications()` | ask once, from a button; resolves true when allowed (on iOS only for an installed app) |
| `registerApp()` | registers `sw.js` (the app shell only; it never runs models) |
| `keepOpenLine` | "Keep this tab open to finish faster. If you leave, it continues when you come back." |

While a job runs or renders, the engine holds a screen wake lock (taken again when the tab comes back), shows progress in the title ("42%: Selects"), and notifies when the clips are ready if notifications are allowed and the tab is in the background. When a step needs the video and it is gone, `job.error.needsFile` is true: ask for the same file and call `attachFile`.

The PWA files are `public/manifest.webmanifest` (name Selects, standalone, theme `#1d2126` from the design tokens), `public/icons/` and `public/sw.js`. If the React app becomes the site, copy them into `web/public` and register `sw.js` the same way.

## Faithful cuts, Made for and the quality bar

The browser judge follows the core: `settings.madeFor` (`shorts`, `linkedin`, `x`, `story`) sets the length range through `applyMadeFor`, adds the story line to the judge prompt, shapes the posting kit, and picks the caption look (`clipCaptionStyle`: LinkedIn renders two-line subtitles). After ranking, each top pick gets a faithful check (one model call with the sentences around it, the rule check when the call fails) and `orderByFaithful`; then `applyQualityBar` sets `candidate.weak` and `job.verdict`. `patchCandidate(id, cid, { faithful: "accept" | "fix" | "reset" })` works as on the server. Smart mode sends the faithful task through the same proxy (it accepts `kind: "faithful"` with the sentence before and after).

## Differences from the server

- `progress` events can carry `download: { loaded, total }` (bytes) while a model downloads. Show it: the first run downloads 140 to 210 MB for whisper and 0.7 or 2.0 GB for the judge.
- The judge's `progress` note says "waking the Smart mode server (N s ...)" while a sleeping proxy starts. Keep the spinner up; it can take about a minute.
- `job.judge = { backend, model, where, loadSec, calls, secPerCandidate }`, `job.asr = { provider: "transformers.js", model, device, decodeSec, loadSec, sec, speed }`, `job.runtime = { where: "browser" }`.
- `job.language` is a light check: lid-lite-5 reads the English transcript. When it finds Nigerian-language or Pidgin text, `job.language.warning` is set (show `api.copy.accentNote`). There is no language question and no re-transcription.
- No transcript quality gate yet: words have no probability (`p`), so low-confidence underlines and the gate are desktop features.
- One judge answer that cannot be read does not stop the run: that candidate keeps its first-stage score and says so in `reason`.
- Not in the browser build (they reject with status 501 and a plain message): `setLanguage`, `detectFaces`, `getFaces`, `resume`, caption mode (whole-video captions), blur, the overnight queue. `queue()` returns an empty queue.
- A reload keeps the job (see "Resume, phones and installing"); the models stay cached.

## Headers the host must send

Multithreaded WebAssembly needs cross-origin isolation:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`require-corp`, not `credentialless`: Safari does not support `credentialless` and ignores it, so the page was never isolated on an iPhone. Hugging Face's CDN sends no `Cross-Origin-Resource-Policy`, but that only matters for files loaded without CORS; every model download is a CORS `fetch`, which `require-corp` allows. Keep all scripts and WebAssembly on this origin (ONNX Runtime and MediaPipe are imported with `?url`, not loaded from a CDN). If the React app is served from `web/`, its Vite config needs the same two headers for dev and preview, and `fs.allow` must include `src/browser`.

## Integrating with the React app

1. In `web/src/lib/api.js`, choose the client: `export const api = isBrowser ? createBrowserApi() : createHttpApi();` where `isBrowser` comes from a build flag (`VITE_SELECTS_BROWSER=1`) or a query parameter.
2. The new-job screen must take a File (file input or drop) instead of a path when `api.browser` is true.
3. Before the first run, show `await api.downloads()` (sizes, licences) and `api.copy.limits`.
4. Add the Private and Smart switch with `api.copy.privateMode.line` and `api.copy.smartMode.line`. In Smart mode, offer a key field (`api.copy.smartMode.keyLine`) and say when the proxy is used (`api.copy.smartMode.proxyLine`).
5. Render results are `blob:` URLs: download links need `download="01 - <title>.mp4"`.
6. The engine's dependencies live in `src/browser/node_modules`; run `npm --prefix src/browser ci` before building the web app with the browser client.
