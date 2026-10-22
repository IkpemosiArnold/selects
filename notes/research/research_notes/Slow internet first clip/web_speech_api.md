# Web Speech API (SpeechRecognition) as a file-transcription option for Selects Web (as of 22 Oct 2026)

Scope: can the browser's built-in SpeechRecognition give Selects Web a transcript, with word-level timestamps, of a user-chosen video file, without uploading the video and without a 140 MB model download, for users on Android Chrome, Opera, Phoenix and iPhone Safari in Nigeria.

Status labels used below: SHIPPED (on by default in stable), FLAG (behind a flag or dev trial), PROPOSED (spec or intent only, not in stable), PLANNED (a ship milestone is set but not reached).

Live checks done on 22 Oct 2026: chromestatus.com JSON API (feature entries listed below), chromiumdash milestone schedule, MDN browser-compat-data (raw GitHub, last commit to the SpeechRecognition file 7 Oct 2026), the spec repo commit log, and the Google Chrome speech demo page. Note on chromestatus: the summary "status" text in its v0 API still says "In developer trial (Behind a flag)" for features whose shipping stage (stage type 160) has a desktop milestone set. MDN BCD and Chrome's own blog confirm those features shipped, so the shipping-stage milestone is the reliable field.

Chrome release dates used (chromiumdash, fetched 22 Oct 2026): Chrome 135 stable 1 Apr 2025; 139 stable 5 Aug 2025; 142 stable 28 Oct 2025; 150 stable 30 Jun 2026; 153 stable 8 Sep 2026; 156 stable 20 Oct 2026 (current stable on Android and desktop is 156.0.8078.x); 159 stable 8 Dec 2026. Chrome is now on a two-week stable cadence in this range. [chromiumdash 139](https://chromiumdash.appspot.com/fetch_milestone_schedule?mstone=139); [chromiumdash 159](https://chromiumdash.appspot.com/fetch_milestone_schedule?mstone=159); [Android stable releases](https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Android&num=1)

## 1. Chrome on-device speech recognition (processLocally, available(), install())

### Takeaway
On-device Web Speech recognition is SHIPPED in Chrome desktop only (Windows, Mac, Linux) since Chrome 139 (Aug 2025), with about 60 MB per language pack, and English on-device is en-US only. It is NOT available on Chrome for Android (available() returns "unavailable" there; MDN marks chrome_android as unsupported), so for Selects' Android users every recognition goes to Google's cloud.

### Cited Findings
- Spec (Draft Community Group Report dated 21 Oct 2026, editor Evan Liu, Google) defines `attribute boolean processLocally` (default false; when true, recognition "must" run on device; when false the UA may choose local or remote), `static Promise<SpeechRecognitionAvailabilityStatus> available(SpeechRecognitionOptions)`, `static Promise<boolean> install(SpeechRecognitionOptions)`, availability values "unavailable", "downloadable", "downloading", "available", gated by the "on-device-speech-recognition" permissions policy (default allowlist 'self'). [Web Speech API spec, 21 Oct 2026](https://webaudio.github.io/web-speech-api/)
- `SpeechRecognitionOptions` now has `required sequence<DOMString> langs; boolean processLocally = false; SpeechRecognitionQuality quality = "command"` with quality values "command", "dictation", "conversation". [Web Speech API spec, 21 Oct 2026](https://webaudio.github.io/web-speech-api/)
- chromestatus "On-device Web Speech API" (feature 6090916291674112, owner evliu@google.com): shipping stage set to desktop milestone 139, Android milestone empty, Finch names `InstallOnDeviceSpeechRecognition, OnDeviceWebSpeechAvailable, OnDeviceWebSpeech`; Mozilla and WebKit positions "Positive". [chromestatus 6090916291674112](https://chromestatus.com/feature/6090916291674112) (fetched via API 22 Oct 2026; entry last updated 22 Aug 2025)
- Chrome's "New in Chrome 139" post (5 Aug 2025) lists on-device speech recognition for the Web Speech API: sites can check availability for a language, prompt install, and choose on-device or cloud. [New in Chrome 139, 5 Aug 2025](https://developer.chrome.com/blog/new-in-chrome-139)
- Intent to Ship (posted 7 Jan 2025): "Initially supported on Windows, Mac, and Linux with ChromeOS support to follow"; Android not listed; Evan Liu states about 60 MB per language pack on Chrome for Windows, Mac and Linux; reviewers raised fingerprinting concerns and Google said it would reuse the Translator API download and masking pattern. [blink-dev Intent to Ship: On-device Web Speech API, Jan 2025](https://groups.google.com/a/chromium.org/d/msgid/blink-dev/677c7f0e.2b0a0220.2e82a8.01f6.GAE%40google.com)
- MDN browser-compat-data (file last changed 7 Oct 2026): `processLocally`, `available()`, `install()` all Chrome desktop 139; `chrome_android: false`; Safari false; Firefox "preview" (Nightly). Opera, Samsung Internet and WebView "mirror" Chrome Android, so also false. [MDN BCD SpeechRecognition.json](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json); [MDN processLocally](https://developer.mozilla.org/docs/Web/API/SpeechRecognition/processLocally)
- Languages Google Chrome supports on-device, per the spec repo explainer (updated 14 Oct 2026): de-DE, en-US, es-ES, fr-FR, hi-IN, id-ID, it-IT, ja-JP, ko-KR, pl-PL, pt-BR, ru-RU, th-TH, tr-TR, vi-VN, zh-CN, zh-TW. No en-GB, no en-NG, no Nigerian languages. [On-device explainer, WebAudio/web-speech-api](https://github.com/WebAudio/web-speech-api/blob/main/explainers/on-device-speech-recognition.md)
- Android field test (11 May 2026): on Chrome and Brave for Android, `SpeechRecognition.available({langs:['en-US'], processLocally:true})` resolved to "unavailable"; the author attributes it to Chromium on Android not shipping on-device speech models. Samsung Internet exposed only `webkitSpeechRecognition` (no available()/install()) and recognition worked via cloud. [bagrounds.org Word Meter Android RCA, 11 May 2026](https://bagrounds.org/ai-blog/2026-05-11-1-word-meter-android-rca)
- Field test in Chromium builds (12 to 16 Oct 2026): in Brave 155, Playwright Chromium 156 and Chrome for Testing 155, `available()` said "downloadable" but `install()` never resolved and "0 bytes" arrived after 4 to 10 minutes; the author concluded the packs need real Google Chrome. Pack size noted as about 60 MB per language. [amngy/glossa PR #50, Oct 2026](https://github.com/amngy/glossa/pull/50); same hang reported in [brave-browser issue #55414](https://github.com/brave/brave-browser/issues/55414)
- A Chrome AI dev-preview thread (about 14 months old per search snippet) reported install() returning true on a Chromebook while no model appeared, and "language-not-supported" for en-US on ChromeOS, with the Chrome team having disabled on-device Web Speech on ChromeOS at that time. [chrome-ai-dev-preview-discuss thread](https://groups.google.com/a/chromium.org/g/chrome-ai-dev-preview-discuss/c/Rlyc2uAsFCY/m/i7QOnrClAgAJ) (seen only as a search snippet; the page timed out on fetch)
- MDN: "By default, using speech recognition on a web page involves a server-based recognition engine. Your audio is sent to a web service for recognition processing, so it won't work offline." On-device "requires a one-time language pack download for each language"; starting with processLocally=true without the pack fails with `language-not-supported`. [MDN Using the Web Speech API, last modified 31 Aug 2026](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API)
- Related Chrome features, all PROPOSED or PLANNED on desktop only (no Android milestone): contextual biasing `phrases` (shipping stage desktop 142; MDN BCD Chrome 142, chrome_android false) [chromestatus 5225615177023488](https://chromestatus.com/feature/5225615177023488); on-device `quality` levels (shipping stage desktop 150) [chromestatus 5136859632107520](https://chromestatus.com/feature/5136859632107520); `unspokenPunctuation` auto punctuation (shipping stage desktop 151; MDN BCD Chrome 151) [chromestatus 4785284026859520](https://chromestatus.com/feature/4785284026859520)
- Microsoft Edge separately documents local speech recognition from Edge 150.0.4076 for English, German, Italian, Portuguese (PT), Spanish and Korean. [Microsoft Learn: Edge speech recognition API](https://learn.microsoft.com/fi-fi/microsoft-edge/web-platform/speech-recognition-api) (seen via search snippet)

### Inferences
- For the Android-heavy Nigerian audience, processLocally is effectively unavailable in Oct 2026. Any Web Speech path on Android is cloud recognition that streams audio to Google, which costs mobile data (audio, not video, but still continuous upload) and is not "no upload".
- On desktop Chrome, the 60 MB pack is smaller than the 140 MB model Selects wants to avoid, but it is still a download, it is en-US only for English, and it only works in genuine Google Chrome (not Brave or other Chromium forks).
- Without processLocally, the spec lets the UA choose; in Chrome the default has historically been Google's cloud. Treat "no processLocally" as "audio goes to Google".

### Gaps
- The older "mode: ondevice-only / ondevice-preferred" proposal: I did not find a fetched primary source confirming its exact shape or when it was replaced by the `processLocally` boolean. The original explainer PR was [WebAudio/web-speech-api PR #122](https://github.com/WebAudio/web-speech-api/pull/122) (linked from chromestatus), not read.
- No official Google statement or chromestatus milestone for on-device Web Speech on Chrome for Android was found.
- No published pack size for each language beyond "about 60 MB" (stated for desktop).
- Whether Edge's local recognition differs from Chrome's in API behaviour was not checked.

## 2. Non-microphone input: recognition.start(MediaStreamTrack), and speed

### Takeaway
`recognition.start(audioTrack)` is SHIPPED in Chrome desktop 135+ only (not Chrome Android, Safari, Opera Android, Samsung Internet; Firefox plans it for desktop 161). It consumes a live track, so it runs at playback speed: a 30 minute video needs about 30 minutes of playback.

### Cited Findings
- Spec: `undefined start(MediaStreamTrack audioTrack)` uses the given track instead of the microphone; throws `InvalidStateError` if the track kind is not "audio" or its readyState is not "live". [Web Speech API spec, 21 Oct 2026](https://webaudio.github.io/web-speech-api/)
- chromestatus "Add MediaStreamTrack support to the Web Speech API" (feature 5178378197139456): shipping stage desktop 135, Android empty, flag/Finch `MediaStreamTrackWebSpeech`; motivation "caption other sources of audio including remote audio tracks". [chromestatus 5178378197139456](https://chromestatus.com/feature/5178378197139456) (fetched 22 Oct 2026); Intent to Ship thread linked there: [blink-dev, Dec 2024](https://groups.google.com/a/chromium.org/d/msgid/blink-dev/6762170b.2b0a0220.38516f.0183.GAE%40google.com)
- MDN BCD `SpeechRecognition.start.audioTrack`: Chrome 135; chrome_android false; Safari false; Firefox false; Opera, Samsung Internet, WebView mirror (false on Android). [MDN BCD SpeechRecognition.json, Oct 2026](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json); [MDN start()](https://developer.mozilla.org/docs/web/API/SpeechRecognition/start)
- The Google timestamps explainer's own example feeds a video element: `const audioStream = mediaElement.captureStream(); recognition.start(audioStream.getAudioTracks()[0]);`, so feeding `HTMLMediaElement.captureStream()` audio is the intended pattern. [Timestamps explainer, WebAudio/web-speech-api, Jul to Sep 2026](https://github.com/WebAudio/web-speech-api/blob/main/explainers/speech-recognition-result-timestamps.md)
- Real-world use (Oct 2026): a browser extension passes a tab-capture track via `start(track)`; it notes Chrome speech "starts only with a tab stream" and routes decoded file audio to Whisper instead, so file input via Web Speech was not covered. [amngy/glossa PR #50, Oct 2026](https://github.com/amngy/glossa/pull/50)
- Mozilla intent (16 Sep 2026, ship note 12 Oct 2026): Firefox's strictly on-device SpeechRecognition processes audio "directly from the microphone or a same-origin MediaStreamTrack", "in real-time, with low-latency"; intends to ship in Firefox 161 on all desktop platforms; Android tracked separately (bug 1244242) over mobile performance. [Mozilla dev-platform intent, Sep to Oct 2026](https://groups.google.com/a/mozilla.org/g/dev-platform/c/6f4l8P9hO6o)
- A Jan 2026 developer article still states "The SpeechRecognition API only recognizes audio from the local microphone" (it targets the older behaviour and Safari/iOS). [lilting.ch, 23 Jan 2026](https://lilting.ch/en/articles/webrtc-webspeech-realtime-translation)

### Inferences
- `video.captureStream()` (or `HTMLMediaElement.captureStream`) and a Web Audio `MediaStreamAudioDestinationNode` both yield live audio MediaStreamTracks, so both should satisfy the "live audio track" check in desktop Chrome 135+. I found no independent test report confirming either for a local file.
- Speed is bound to playback: the recognizer only receives audio as the media element plays. Playing at 1.5x or 2x would shorten wall time but feeds pitch-corrected, time-compressed speech to a recognizer tuned for natural speech; accuracy impact is untested. The video element also has to keep playing (background tab throttling and mobile power saving can pause it).
- On Android (the main Selects audience) there is no way to route the file's audio into the recognizer. The only hack is playing the video through the speaker into the microphone, which is slow (1x), noisy, and captures room sound.

### Gaps
- No benchmark of start(track) throughput or accuracy on file audio was found.
- Whether Chrome caps session length or stops after silence when fed a track (versus the mic) was not documented.
- Whether captureStream on a video with `muted` or zero volume still delivers audio to the recognizer was not verified.

## 3. Word timing in results

### Takeaway
There are no word-level timestamps anywhere in the API. The only timing addition is segment-level `speechStartTime` / `speechEndTime` on each SpeechRecognitionResult, merged into the spec on 21 Oct 2026, behind a flag in Chrome since 153, and PLANNED to ship in desktop Chrome 159 (8 Dec 2026). Not on Android.

### Cited Findings
- `SpeechRecognitionAlternative` has only `transcript` and `confidence`. [Web Speech API spec, 21 Oct 2026](https://webaudio.github.io/web-speech-api/)
- Spec now adds `readonly attribute double speechStartTime; readonly attribute double speechEndTime;` on SpeechRecognitionResult, in seconds on the "session audio timeline", precision implementation-defined. [Web Speech API spec, 21 Oct 2026](https://webaudio.github.io/web-speech-api/); commit "Update SpeechRecognitionResult with speech timing attributes (#192)" dated 21 Oct 2026 in [WebAudio/web-speech-api commits](https://github.com/WebAudio/web-speech-api/commits/main)
- chromestatus "SpeechRecognitionResult Timestamps (WebSpeech API)" (feature 5811907077472256, owner alanding@chromium.org, created 13 Jul 2026, updated 22 Oct 2026): dev trial stage desktop 153, shipping stage desktop 159, Android empty, flag `WebSpeechTimestamps`, bug crbug.com/528037568; Safari "No signal", Mozilla unofficially positive. Motivation: the API "currently does not expose the acoustic timing bounds of recognized speech segments, making it difficult to ... generate synchronized subtitle cues". [chromestatus 5811907077472256](https://chromestatus.com/feature/5811907077472256); Intent to Prototype: [blink-dev r78IyGSnclg](https://groups.google.com/a/chromium.org/g/blink-dev/c/r78IyGSnclg)
- The explainer defines the times as "the exact acoustic bounds (in seconds) of the recognized speech, measured from the start of the audio stream consumed by the recognizer (t = 0.0s, marked by audiostart)", for building `VTTCue(start, end, text)`. Per-result granularity, not per-word. [Timestamps explainer](https://github.com/WebAudio/web-speech-api/blob/main/explainers/speech-recognition-result-timestamps.md)
- Today developers approximate: "Line times are wall-clock approximations (Chrome gives no audio times)". [amngy/glossa PR #50, Oct 2026](https://github.com/amngy/glossa/pull/50)

### Inferences
- Workarounds for word timing: (a) record `video.currentTime` at `audiostart`, `speechstart`/`speechend` and at each result event, then spread words across the segment proportionally by character or syllable count; error is likely hundreds of milliseconds to seconds, since result events lag the audio. (b) Once speechStartTime/EndTime ship (desktop Chrome 159+), use them as segment bounds and run forced alignment (for example a small wav2vec2/CTC aligner) in the browser to get word times; that reintroduces a model download, which defeats the zero-download goal. (c) Use the Web Speech text only as a draft and get word timing from the main transcription engine.
- For karaoke-style captioned 9:16 clips, segment timing with proportional word spreading would produce visibly drifting word highlights.

### Gaps
- No public measurement of how accurate Chrome's speechStartTime/speechEndTime are, or how long a "result" segment typically is with continuous=true.

## 4. Safari and iOS

### Takeaway
Safari (macOS 14.1+, iOS 14.5+) exposes only prefixed `webkitSpeechRecognition`, built on Apple's Speech framework with on-device or Apple-server processing depending on language and device. It has no MediaStreamTrack input, no processLocally/available()/install(), no timestamps, and has a history of unreliable continuous mode on iOS. Apple has no one actively working on Web Speech per a 2026 chromestatus note. Not usable for file transcription.

### Cited Findings
- MDN BCD: Safari `SpeechRecognition` 14.1 with `webkit` prefix (iOS mirrors); `continuous` fully from Safari 17 (14.1 was partial: "Returns multiple results when set to false"); `start(audioTrack)`, `processLocally`, `available()`, `install()`, `phrases`, `unspokenPunctuation` all false. [MDN BCD SpeechRecognition.json, Oct 2026](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json)
- chromestatus note on Safari's position for the quality-levels proposal (Jan to Jun 2026): "Apple doesn't have anyone actively working on the Web Speech API on the moment." [chromestatus 5136859632107520](https://chromestatus.com/feature/5136859632107520); [WebKit standards-positions #634](https://github.com/WebKit/standards-positions/issues/634)
- WebKit's implementation uses Apple's Speech framework; an embedding app needs the speech usage description in Info.plist or the prompt may not appear. [WebKit Bugzilla 239816](https://bugs.webkit.org/show_bug.cgi?id=239816)
- Apple WWDC 2019: server recognition has request and audio-duration limits that on-device recognition avoids; server supports more languages. [WWDC19 session 256 notes](https://nonstrict.eu/wwdcindex/wwdc2019/256/); [Apple WWDC19 256](https://developer.apple.com/videos/play/wwdc2019/256/)
- Developer reports: with `interimResults = true`, recognition sometimes switches to cloud processing and can fail offline; continuous and interim results "do not always work as expected" in WebKit. [Apple Developer Forums 775699](https://developer.apple.com/forums/thread/775699); [WebKit Documentation issue #120](https://github.com/WebKit/Documentation/issues/120)
- iOS developer tips (2026): issues include "stopping on its own", "buffer clogging", "no recognition on the first attempt"; `getUserMedia()` and SpeechRecognition conflict as separate mic sessions; push-to-talk is more stable than auto-restart with continuous. [lilting.ch iOS Web Speech tips](https://lilting.ch/en/articles/ios-webspeech-api-tips); [lilting.ch, 23 Jan 2026](https://lilting.ch/en/articles/webrtc-webspeech-realtime-translation)
- A 2026 support summary: Safari uses "Apple's dictation engine", all iOS browsers use WebKit and behave like Safari, Dictation/Siri settings affect availability, and Apple "may process audio on-device or on its servers, depending on language and device". [textintoaudio.com, last reviewed 4 Oct 2026](https://textintoaudio.com/speech-recognition-browser-support)

### Inferences
- Because iOS Safari has no track input, the only way to get the file's audio in is speaker-to-mic playback, which is not workable.
- The often-quoted "1 minute" cap applies to Apple's native server-based SFSpeechRecognizer; it is plausible but unconfirmed for Safari's webkitSpeechRecognition.

### Gaps
- No Safari 18 or Safari 26 release-note entry about Web Speech changes was found; I could not confirm whether Safari 26 changed engines (for example to SpeechAnalyzer) for the web API.
- No confirmed Safari session-length limit for webkitSpeechRecognition.

## 5. Opera, Samsung Internet, Phoenix, Firefox on Android

### Takeaway
On Android only Chrome-family browsers that have Google's speech service wired in work, and only with the microphone and cloud recognition. Samsung Internet works via prefixed `webkitSpeechRecognition` (cloud). Opera and other Chromium forks may expose the constructor but can fail with `network` or `not-allowed`. Firefox for Android has no support. Phoenix: no data found.

### Cited Findings
- MDN BCD: unprefixed `SpeechRecognition()` constructor lists `opera: false`, `opera_android: false`; prefixed support mirrors Chrome; `webview_android` 37 prefixed; Firefox "preview" only (Nightly); `continuous` on chrome_android: "The property can be set, but has no effect" (crbug 41297427). [MDN BCD SpeechRecognition.json, Oct 2026](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json)
- Samsung Internet: only legacy `webkitSpeechRecognition`, no on-device API; `start()` worked via cloud. Chrome/Brave Android: on-device returned "unavailable". [bagrounds.org, 11 May 2026](https://bagrounds.org/ai-blog/2026-05-11-1-word-meter-android-rca)
- Support summary: Opera, Brave, Vivaldi and other Chromium forks "Varies ... The constructor may exist, then fail with network or not-allowed"; Electron and embedded Chromium "Effectively no", since "Google's service is unavailable to third-party builds"; Firefox desktop and Android "Not supported" (hidden pref only). [textintoaudio.com, last reviewed 4 Oct 2026](https://textintoaudio.com/speech-recognition-browser-support)
- Firefox: on-device SpeechRecognition intends to ship in Firefox 161 desktop; Android not yet (performance). [Mozilla dev-platform intent, Sep to Oct 2026](https://groups.google.com/a/mozilla.org/g/dev-platform/c/6f4l8P9hO6o); MDN BCD shows Firefox Nightly gained `available()/install()` options on 7 Oct 2026 ([BCD commit #30780](https://github.com/mdn/browser-compat-data/commits/main/api/SpeechRecognition.json))
- Spec `start(audioTrack)` and on-device methods are false for all Android browsers per BCD (mirroring chrome_android). [MDN BCD](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json)

### Inferences
- Phoenix (Transsion's browser, common on Tecno/Infinix/itel phones) is Chromium-based; like other forks it most likely either lacks a working Google speech backend or works only with the mic. Unverified.
- Chrome Android ignoring `continuous` means each session ends after one utterance and must be restarted, which makes long transcription brittle even with the mic.

### Gaps
- No direct test results found for Opera for Android or Opera Mini, or for Phoenix.
- Whether Chrome Android requires a fresh user gesture for each restart of `start()` was not confirmed.

## 6. Accuracy on Nigerian-accented English, and en-NG

### Takeaway
Chrome's cloud recognizer accepts `en-NG` as a language tag (it is on Google's own Web Speech demo list), but on-device has only en-US. I found no published word error rate for Chrome's Web Speech backend on Nigerian English. Benchmarks of other systems show West African accents roughly double to triple error rates versus East African English.

### Cited Findings
- Google's Chrome Web Speech demo page lists `['en-NG', 'Nigeria']` (also en-GH, en-KE) among its English dialects (checked 22 Oct 2026). [Google Web Speech API demo](https://www.google.com/intl/en/chrome/demos/speech.html)
- On-device Chrome English is en-US only. [On-device explainer](https://github.com/WebAudio/web-speech-api/blob/main/explainers/on-device-speech-recognition.md)
- Google Cloud Speech-to-Text's language table (separate product) lists yo-NG, ha-NG and ig-NG on chirp_2/chirp_3, but en-NG did not appear in the portions I could read (en-AU, en-HK, en-IN, en-IE, en-NZ, en-PK, en-PH, en-SG, en-GB, en-US were present; page truncated). [Google Cloud STT supported languages](https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages)
- AfriSpeech-MultiBench (Nov 2025, IJCNLP-AACL 2025): West African accents saw error rates roughly double or triple Kenyan and Ugandan English, often over 25%; Nigeria WER about 16.7% to 32.8% across models, Whisper-large-v3 26.53%, AWS Transcribe 28.16%; most models above 40% WER on named entities. Google's row was not visible in what I retrieved. [AfriSpeech-MultiBench, arXiv 2511.14255](https://arxiv.org/pdf/2511.14255)
- AfriSpeech-200: 200 hours, 120 accents; minority accents lag significantly. [TACL 2023](https://aclanthology.org/2023.tacl-1.93.pdf)
- Off-the-shelf English models transfer poorly to Nigerian Pidgin: zero-shot English baselines at 73.7% WER versus 29.6% for a fine-tuned model. [arXiv 2010.11123](https://arxiv.org/abs/2010.11123v2)

### Inferences
- Expect noticeably higher error rates on Nigerian speakers than on US speakers, worse for names, places, Pidgin and code-switching. Contextual biasing (`phrases`) could help with names but is desktop-only.
- Setting `lang = 'en-NG'` on the cloud path may help with accent; on-device would force en-US.

### Gaps
- No public WER figures for Chrome's Web Speech backend (cloud or on-device) on Nigerian English.
- Whether en-NG is a distinct model on the Web Speech backend or maps to a general English model is undocumented.

## 7. Licence, terms and privacy

### Takeaway
SpeechRecognition is a browser-provided API backed by proprietary engines (Google in Chrome, Apple in Safari, Microsoft in Edge). There is no open-source model, no SLA, and no published developer terms for the Chrome backend. Without processLocally, audio goes to the vendor's servers, which Selects would need to disclose.

### Cited Findings
- Default recognition is server-based and audio "is sent to a web service". [MDN Using the Web Speech API, 31 Aug 2026](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API)
- On-device mode "ensures that neither the audio nor the transcribed speech are sent to a third-party service". [MDN, 31 Aug 2026](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API/Using_the_Web_Speech_API); [chromestatus 6090916291674112](https://chromestatus.com/feature/6090916291674112)
- Server-based recognition sends audio to Google or Microsoft, "so products using it should say so in their privacy policy"; third-party Chromium builds cannot reach Google's service. [textintoaudio.com, 4 Oct 2026](https://textintoaudio.com/speech-recognition-browser-support)
- Fingerprinting mitigation for available()/install(): the same masking as the Translator API. [On-device explainer](https://github.com/WebAudio/web-speech-api/blob/main/explainers/on-device-speech-recognition.md); [blink-dev Intent to Ship](https://groups.google.com/a/chromium.org/d/msgid/blink-dev/677c7f0e.2b0a0220.2e82a8.01f6.GAE%40google.com)

### Inferences
- The site does not sign any terms with Google to use the backend; the user's browser terms apply. That also means no quota guarantees, and Google can change behaviour without notice.

### Gaps
- I could not find a Google document stating retention or use of audio sent by Chrome's Web Speech backend (the Chrome privacy whitepaper fetch had no speech section). No Chromium API-key page text on the "Speech API" restriction was retrieved.

## 8. Bottom line for Selects Web

### Takeaway
(c) Not viable as the main path, and only a narrow (b) at best: a desktop-Chrome-only quick draft. For the Android and iOS majority there is no way to feed a file's audio, no on-device mode, no word timestamps, and audio would go to Google in real time anyway.

### Cited Findings
- File input via track: desktop Chrome 135+ only; false on all Android browsers and Safari. [MDN BCD](https://github.com/mdn/browser-compat-data/blob/main/api/SpeechRecognition.json)
- On-device: desktop Chrome 139+ only, about 60 MB per language, English en-US only; "unavailable" on Chrome Android. [blink-dev intent](https://groups.google.com/a/chromium.org/d/msgid/blink-dev/677c7f0e.2b0a0220.2e82a8.01f6.GAE%40google.com); [explainer](https://github.com/WebAudio/web-speech-api/blob/main/explainers/on-device-speech-recognition.md); [bagrounds.org, May 2026](https://bagrounds.org/ai-blog/2026-05-11-1-word-meter-android-rca)
- Timing: segment-level only, shipping desktop Chrome 159 (8 Dec 2026), no word timing. [chromestatus 5811907077472256](https://chromestatus.com/feature/5811907077472256)

### Inferences
- (a) Main transcription path: not viable. Fails on Android and iOS, gives no word timestamps, runs at 1x real time, and its accuracy on Nigerian English is unmeasured.
- (b) Zero-download quick first draft: viable only on desktop Chrome 135+ and only in cloud mode (which uploads audio to Google in real time) or with a 60 MB en-US pack. It could give a rough transcript with approximate segment times (wall-clock now, real speechStartTime from Chrome 159) while a proper engine runs. For a "slow internet first clip" goal on Android phones, it does not help.
- (c) Practical recommendation: treat Web Speech as an optional desktop-Chrome extra at most, feature-detected via `'start' accepts a track` behaviour and `SpeechRecognition.available()`, never as the Android path. Revisit if Chrome ships on-device recognition and track input on Android, or if Firefox 161 desktop on-device results prove good.

### Gaps
- No hands-on test was run (no browser automation was used, per instructions). A quick manual test on a real Android phone (Chrome, Opera, Phoenix) and desktop Chrome 156 with `video.captureStream()` would confirm the track path, session length and accuracy on a Nigerian-accented sample.
