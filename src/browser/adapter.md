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
| `createJob(file, settings)` | **takes a File, not a path**. Settings as on the desktop (`k`, `minLen`, `maxLen`, `judgeN`, `listwise`, `credit`, `license`, `sourceUrl`, `captions`, `kit: "model" \| "plain"`), plus `asrDevice: "auto" \| "webgpu" \| "wasm"` |
| `patchCandidate(id, cid, { status?, start?, end? })` | trims snap with the core's `snapTrim`, as the server does |
| `patchJob(id, { credit?, license?, sourceUrl?, captions?, k?, kit? })` | rewrites existing posting kits, as the server does |
| `getCaptions`, `putCaptions`, `resetCaptions` | the core's cue logic (`src/core/cues.mjs`) |
| `captionsFileUrl(id, "srt" \| "vtt")` | returns a `blob:` URL |
| `render(id, ids?, preset?)` | `preset` is `"shorts"` (1080x1920) or `"preview"` (720x1280); progress through `render` events |
| `getKit(id, cid)` | the posting kit; `file` and `srtFile` are `blob:` URLs (use them as download links with a `download` attribute) |
| `events(id, onEvent)` | sends `job` first, then `stage`, `progress`, `words`, `candidates`, `render`, `captions`, `error` with the server's payloads |
| `thumbUrl(id, n)`, `sourceUrl(id)`, `clipUrl(id, cid, preset?)` | `blob:` URLs (`n` from 1) |

Browser-only additions: `setMode`, `getMode`, `preferBackend`, `capabilities()` (WebGPU, cross-origin isolation, threads, WebCodecs, H.264 encoding), `downloads()` (what Private mode will download on this browser, with sizes, licences and where each is cached), `copy`, and `engine` (the engine itself, for tests).

## Differences from the server

- `progress` events can carry `download: { loaded, total }` (bytes) while a model downloads. Show it: the first run downloads 140 to 210 MB for whisper and 0.7 or 2.0 GB for the judge.
- The judge's `progress` note says "waking the Smart mode server (N s ...)" while a sleeping proxy starts. Keep the spinner up; it can take about a minute.
- `job.judge = { backend, model, where, loadSec, calls, secPerCandidate }`, `job.asr = { provider: "transformers.js", model, device, decodeSec, loadSec, sec, speed }`, `job.runtime = { where: "browser" }`.
- `job.language` is a light check: lid-lite-5 reads the English transcript. When it finds Nigerian-language or Pidgin text, `job.language.warning` is set (show `api.copy.accentNote`). There is no language question and no re-transcription.
- No transcript quality gate yet: words have no probability (`p`), so low-confidence underlines and the gate are desktop features.
- One judge answer that cannot be read does not stop the run: that candidate keeps its first-stage score and says so in `reason`.
- Not in the browser build (they reject with status 501 and a plain message): `setLanguage`, `detectFaces`, `getFaces`, `resume`, caption mode (whole-video captions), blur, the overnight queue. `queue()` returns an empty queue.
- Nothing survives a reload. A reload needs the file again; the models stay cached.

## Headers the host must send

Multithreaded WebAssembly needs cross-origin isolation:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

`credentialless` (not `require-corp`) lets the page fetch models from Hugging Face's CDN, which does not send `Cross-Origin-Resource-Policy`. If the React app is served from `web/`, its Vite config needs the same two headers for dev and preview, and `fs.allow` must include `src/browser`.

## Integrating with the React app

1. In `web/src/lib/api.js`, choose the client: `export const api = isBrowser ? createBrowserApi() : createHttpApi();` where `isBrowser` comes from a build flag (`VITE_SELECTS_BROWSER=1`) or a query parameter.
2. The new-job screen must take a File (file input or drop) instead of a path when `api.browser` is true.
3. Before the first run, show `await api.downloads()` (sizes, licences) and `api.copy.limits`.
4. Add the Private and Smart switch with `api.copy.privateMode.line` and `api.copy.smartMode.line`. In Smart mode, offer a key field (`api.copy.smartMode.keyLine`) and say when the proxy is used (`api.copy.smartMode.proxyLine`).
5. Render results are `blob:` URLs: download links need `download="01 - <title>.mp4"`.
6. The engine's dependencies live in `src/browser/node_modules`; run `npm --prefix src/browser ci` before building the web app with the browser client.
