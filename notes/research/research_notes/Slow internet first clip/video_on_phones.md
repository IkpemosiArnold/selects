# Video on phones: decoding iPhone and Android files and rendering captioned 9:16 H.264 clips in the browser (as of 22 Oct 2026)

Scope: the video side of Selects Web on Nigerian Android phones (Tecno, Infinix, itel, Samsung A-series; 3 to 8 GB RAM; MediaTek Helio G / Dimensity, Unisoc) in Chrome, Opera and Phoenix, and on iPhones XR to 15 in Safari. Research date: 22 Oct 2026. Every number is labelled desktop or phone. Where the source gives no date, that is said. Local repo files are cited by path; they were read, not changed.

## What the repo uses today (read before the matrix)

### Takeaway
Selects Web uses mediabunny 1.61.5 on top of WebCodecs for everything: probe, audio-only decode for whisper, thumbnails and the render. There is no ffmpeg.wasm and no custom decoder or encoder fallback, so every codec gap in the browser is a hard stop for the user.

### Cited Findings
- Dependency: `"mediabunny": "1.61.5"` (plus transformers.js 4.3.1, MediaPipe GenAI 0.10.29, wllama 3.8.1); no ffmpeg.wasm. [src/browser/package.json](/Users/mac/Documents/DevProjects/selects/src/browser/package.json)
- Input is `new Input({ source: new BlobSource(file), formats: ALL_FORMATS })`; the probe reads codec, coded and display size, rotation, `computePacketStats(120)` and `canDecode()` for the video and audio tracks. [src/browser/media.js](/Users/mac/Documents/DevProjects/selects/src/browser/media.js)
- Audio for whisper: `AudioSampleSink` over the primary audio track only (no video decode), mixed to mono, resampled to 16 kHz with `OfflineAudioContext`. If `track.canDecode()` is false it throws "This browser cannot decode the video's audio." There is no non-WebCodecs fallback. [src/browser/media.js](/Users/mac/Documents/DevProjects/selects/src/browser/media.js); long files use the same path in 10-minute segments written to OPFS. [src/browser/pcm.js](/Users/mac/Documents/DevProjects/selects/src/browser/pcm.js)
- Render: in a module worker, `CanvasSink(vtrack, { width: workW, height: workH, fit: "fill", poolSize: 3 })` decodes source frames; each is drawn on an `OffscreenCanvas` (1080x1920 "shorts" or 720x1280 "preview"), captions are drawn from a cached caption layer, and `CanvasSource(canvas, { codec: "avc", bitrate: 6e6 or 2.5e6, keyFrameInterval: 2, latencyMode: "quality" })` encodes H.264; audio goes through `AudioSampleSink` to `AudioSampleSource` (AAC, or Opus if `canEncodeAudio("aac")` is false); the MP4 is muxed into a `BufferTarget` in memory. Sources above 30 fps are thinned to 30 fps. [src/browser/render-clip.js](/Users/mac/Documents/DevProjects/selects/src/browser/render-clip.js), [src/browser/render.worker.js](/Users/mac/Documents/DevProjects/selects/src/browser/render.worker.js), [src/core/layout.mjs](/Users/mac/Documents/DevProjects/selects/src/core/layout.mjs)
- The "fit" reframe draws a blurred background with `bgCtx.filter = "blur(9px) brightness(0.86)"` on an OffscreenCanvas 2D context. [src/browser/render-clip.js](/Users/mac/Documents/DevProjects/selects/src/browser/render-clip.js)
- The only encode capability check is `VideoEncoder.isConfigSupported({ codec: "avc1.640028", width: 1080, height: 1920, bitrate: 6e6, framerate: 30 })`; render itself checks `canEncodeVideo("avc", { width: W, height: H })`. [src/browser/api.js](/Users/mac/Documents/DevProjects/selects/src/browser/api.js)
- Screen Wake Lock is already taken and re-taken on `visibilitychange`; the code comment says phones freeze background tabs and the engine resumes per stage. [src/browser/device.js](/Users/mac/Documents/DevProjects/selects/src/browser/device.js)
- Measured in the repo (DESKTOP, headless Chrome 155 on a 2017 MacBook Pro i5-7360U, heavy machine load): audio to 16 kHz for a 2-minute file 2.8 s; one 41 s clip at 1080x1920 rendered in 57.2 s (fit with blurred background); a 23.9 s 720x1280 preview in 7.8 to 9.6 s; audio decode of a 1-hour file 48 s (whole PCM, renderer RSS peak 954 MB) or 93 s (10-minute segments to OPFS, renderer RSS peak 465 MB). [notes/timings.md](/Users/mac/Documents/DevProjects/selects/notes/timings.md)
- A real phone recording in the repo's tests is HEVC 3840x2160 at 59.94 fps with rotation -90 and mono AAC 44.1 kHz, which is the kind of file iPhone users will bring. [notes/timings.md](/Users/mac/Documents/DevProjects/selects/notes/timings.md)

### Inferences
- Because the pipeline is WebCodecs only, the support matrix below is the product's support matrix. Anything that `canDecode()` rejects ends the job.
- The render already follows good memory habits: a small decode pool (3), one caption layer redrawn only when the caption changes, samples closed after use, one clip at a time in one worker.

### Gaps
- The repo has no phone timings yet (all browser numbers are from a desktop).

## 1. Decode support matrix: HEVC, H.264, AAC, Opus on Safari iOS 17/18/26, Chrome Android, Opera, Samsung Internet; mediabunny limits; HDR

### Takeaway
H.264 decode and encode is close to universal on both phone platforms, and Safari iOS decodes HEVC including 10-bit Main 10 almost everywhere. The two big holes are: (1) Safari before 26 (iOS 17 and 18, which includes every iPhone XR and XS, stuck on iOS 18) has no WebCodecs AudioDecoder, so Selects cannot extract audio at all there today; (2) Chrome Android decodes HEVC only with a hardware decoder, and iPhone-style 10-bit 4K HEVC decodes on only about half of Chrome Android sessions, with mid-range MediaTek chips capped at 2K30.

### Cited Findings
WebCodecs availability
- caniuse (data current to at least Sept 2026, no per-row date): Safari iOS 16.4 to 18.7 "partial", 26.0 to 26.6 and 27.x supported; Chrome for Android 156 supported; Opera Mobile 80 supported; Samsung Internet 17.0 to 30 supported; Firefox for Android not supported. [caniuse WebCodecs](https://caniuse.com/webcodecs) (fetched 22 Oct 2026)
- WebKit's Safari 26.0 release post: Safari 26.0 adds `AudioEncoder` and `AudioDecoder` to WebCodecs (Sept 2025). [WebKit Features in Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/); also announced at WWDC25 (June 2025) [News from WWDC25](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/)
- Safari 16.4 to 18.7 WebCodecs was video only (VideoDecoder, VideoEncoder, EncodedVideoChunk, VideoFrame); audio had to go through `<video>` or Web Audio. [AmitxParmar/ai-video-editor issue #49, 17 Oct 2026](https://github.com/AmitxParmar/ai-video-editor/issues/49) (secondary summary; consistent with the WebKit post above)
- iOS 27 supports the same iPhones as iOS 26 (iPhone 11 and later, SE 2nd gen and later); anything older than iPhone 11 does not get iOS 26 or 27. [AppleInsider, 8 Jun 2026](https://appleinsider.com/articles/26/06/08/ios-27-keeps-iphone-11-and-newer-compatibility); [Tom's Guide (2026)](https://tomsguide.com/phones/iphones/ios-27-supported-devices-see-which-iphones-did-and-didnt-make-the-cut)
- A Safari AudioDecoder report: Safari rejected a 16-channel Opus config that Chrome and Firefox decoded (single developer report, seen only as a search summary; ordinary stereo or mono AAC not implicated). [ambisonic-box docs/IOS-SAFARI.md (GitLab)](https://git.pg.edu.pl/p829296/ambisonic-box/-/blob/b4854b20df788198e29a3a039d76146d71d8bc81/docs/IOS-SAFARI.md)

Per-codec support measured on real sessions (webcodecsfundamentals.org Codec Support Dataset; "decoder data collection started Jan 2026"; encoder date range not given; UA-based browser detection; fetched 22 Oct 2026)
- H.264 High L4.0 `avc1.640028` (the exact string the repo checks): PHONE Chrome Android encode 96.49% (626,338 / 649,149), decode 99.65%; Safari iOS encode 99.98%, decode 99.98%; Edge Android encode 98.79%, decode 100%. [avc1.640028](https://webcodecsfundamentals.org/codecs/avc1.640028.html)
- HEVC Main 10, level 5.1 `hev1.2.4.L153.B0` (the class of an iPhone 4K HDR recording): PHONE Safari iOS decode 97.72% (207,577 / 212,414); Chrome Android decode 52.36% (334,811 / 639,476), encode 0.0%; Edge Android decode 79.86%. DESKTOP Chrome Windows decode 82.31%, Edge Windows 56.77%, Chrome macOS 96.58%, Chrome Linux 49.16%, Firefox near 0. [hev1.2.4.L153.B0](https://webcodecsfundamentals.org/codecs/hev1.2.4.L153.B0.html)
- HEVC Main, level 1 `hev1.1.6.L30.B0` (8-bit, tiny level): PHONE Chrome Android decode 99.24%, encode 89.98%; Safari iOS decode 97.87%. DESKTOP Chrome Windows decode 85.17%. [hev1.1.6.L30.B0](https://webcodecsfundamentals.org/codecs/hev1.1.6.L30.B0.html)
- AAC `mp4a.40.2` page (tables are labelled VideoEncoder/VideoDecoder, which looks like a template label; read as audio support): PHONE Chrome Android decode 100.0% (2,279,295 / 2,279,340); Safari iOS decode 78.56% (595,597 / 758,104), encode 78.06%; Edge Android 100%. DESKTOP Chrome Windows 99.98%. [mp4a.40.2](https://webcodecsfundamentals.org/codecs/mp4a.40.2.html)
- Samsung Internet is not broken out in this dataset. [avc1.640028](https://webcodecsfundamentals.org/codecs/avc1.640028.html)

Chrome HEVC
- Chrome 107 enabled HEVC hardware decoding by default on ChromeOS, Mac, Windows and Android; WebCodecs 8-bit HEVC decode needs Chrome 107+, 10-bit needs 108+ (community guide, not official docs). [StaZhu/enable-chromium-hevc-hardware-decoding](https://fr.github.com/StaZhu/enable-chromium-hevc-hardware-decoding); [Streaming Learning Center](https://streaminglearningcenter.com/?p=17448)
- "HEVC is only supported if the underlying device has an HEVC hardware decoder." [Bitmovin](https://bitmovin.com/google-adds-hevc-support-chrome)
- Chromium's Dale Curtis on blink-dev: HEVC codec changes were handled outside chromestatus "especially so in the case of HEVC where it requires hardware support"; WebCodecs HEVC encode shipped in M130 without a chromestatus entry. [blink-dev Intent to Ship: H26x for MediaRecorder](https://groups.google.com/a/chromium.org/g/blink-dev/c/YJ1QijNiHeM/m/3EhMjMVwAgAJ)
- Hardware probing via WebCodecs is unreliable (w3c/webcodecs#896), so `isConfigSupported()` is the test to use. [AmitxParmar issue #49, 17 Oct 2026](https://github.com/AmitxParmar/ai-video-editor/issues/49)
- MediaTek's official Helio G99 sheet: H.264/H.265/VP9 playback and encode at 2K 30 fps, FHD 60 fps, HD 120 fps (no 4K). [MediaTek Helio G99](https://www.mediatek.com/products/smartphones/mediatek-helio-g99) (undated product page); third-party listings say 2K30. [91mobiles](https://www.91mobiles.com/processor/mediatek-helio-g99-pdp)

Mediabunny
- Reads and writes MP4/M4V and QuickTime .mov (plus MKV/WebM, Ogg, MP3, WAV, ADTS, FLAC, TS/HLS); video codecs AVC, HEVC, VP8, VP9, AV1 (ProRes only via an extension); audio AAC, Opus, MP3, Vorbis, FLAC, AC-3/E-AC-3, DTS, PCM. "The availability of the codecs provided by the WebCodecs API depends on the browser and thus cannot be guaranteed by this library." PCM is decoded in JS and always works; AAC encoding has an extension `@mediabunny/aac-encoder` "because in some browsers AAC encoding is not supported by WebCodecs". Custom decoders can be registered for existing codecs (`CustomAudioDecoder`, `CustomVideoDecoder`, `registerDecoder`) and `canDecode` accounts for them. The docs do not describe any built-in AAC decode fallback for browsers without AudioDecoder. [mediabunny: Supported formats & codecs](https://mediabunny.dev/guide/supported-formats-and-codecs) (fetched 22 Oct 2026)

Old Safari HEVC bugs (historical)
- 2023: WebCodecs HEVC `isConfigSupported` returned true but decoding failed in Safari Technology Preview. [WebKit bug 262950](https://bugs.webkit.org/show_bug.cgi?id=262950); a 2023 Apple forum thread reported an HEVC config rejected in Safari 16.4. [Apple Developer Forums 729464](https://developer.apple.com/forums/thread/729464)
- A third-party project reports Safari 18.6 accepts hvc1/hev1 in WebCodecs. [supervision-js browser support doc](https://supervision-js-demo-pr-93.onrender.com/documents/Core_Concepts.Browser_Support.html) (undated)
- A video-editor research summary puts Safari HEVC WebCodecs at "17.4 and later" for its video-only tier. [AmitxParmar issue #49, 17 Oct 2026](https://github.com/AmitxParmar/ai-video-editor/issues/49)

HDR / Dolby Vision
- Apple: iPhone Dolby Vision video is HEVC 10-bit and is designed to be backward compatible with HLG, so a decoder without Dolby Vision support decodes the HLG base layer. [Apple, Incorporating HDR video with Dolby Vision into your apps (PDF)](https://developer.Apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf) (undated)
- Washed-out, low-contrast, greyish highlights are the usual symptom of 10-bit HDR treated as SDR without tone mapping. [Gumlet HDR & Color Space docs](https://docs.gumlet.com/docs/video-hdr-color-space) (vendor docs, undated)
- Web Platform Tests include a case for `drawImage` of high-bit-depth (10-bit) VideoFrames. [WPT videoFrame-drawImage-hbd.any.js](https://searchfox.org/firefox-main/source/testing/web-platform/tests/webcodecs/videoFrame-drawImage-hbd.any.js)
- A 2026 Apple forum thread reports HEVC playback that works on iPhone 13 and 15 failing on iPhone X and iPhone 17 Pro Max (native playback, not WebCodecs). [Apple Developer Forums 845845](https://developer.apple.com/forums/thread/845845)

### Inferences
- iPhone XR and XS cannot go past iOS 18, so on those phones (and on any iPhone not yet updated to iOS 26) Safari has VideoDecoder but no AudioDecoder; mediabunny's `AudioSampleSink.canDecode()` will be false for AAC and Selects Web stops at "This browser cannot decode the video's audio." The AAC row above (Safari iOS about 78.6%) is consistent with roughly a fifth of iOS sessions lacking it. A fallback is needed for this tier: for example, copy the AAC packets without decoding (mediabunny can read encoded packets and write an ADTS or M4A output) in 5 to 10 minute pieces and hand each piece to Web Audio `decodeAudioData`, which Safari has had for years. This is a design suggestion, not something a source tested.
- On Chrome Android, a 4K 10-bit iPhone HEVC file is roughly a coin flip, and on Helio G99-class phones (2K30 hardware ceiling) a 4K or 4K60 source should be expected to fail `isConfigSupported` or to be very slow; most Android owners record H.264 at 1080p, which should decode everywhere. Files sent from iPhones over WhatsApp are usually re-encoded, but that was not researched here.
- HDR: on Safari, the decoder and 2D canvas will most likely convert to SDR without careful tone mapping, so HDR iPhone clips may look flat or washed out after rendering. No source tested this in WebCodecs specifically; treat as a risk to test on a real iPhone 12+ HDR file.
- Opera Android and Phoenix are Chromium-based, so they should match Chrome Android's WebCodecs behaviour for their Chromium version, but no dataset breaks them out (Opera Mobile is "supported" on caniuse; Phoenix has no data at all).

### Gaps
- No official Apple or Google per-codec WebCodecs table; the percentages come from one third-party crowd dataset with UA detection.
- No data on Phoenix browser (Transsion's default browser on Tecno/Infinix/itel) or on Samsung Internet per codec.
- No source on whether iPhone "High Efficiency" 10-bit HDR HEVC decodes and tone-maps correctly through mediabunny's CanvasSink on Safari or Chrome Android. No public test found.
- Could not confirm from a primary source the iPhone default capture settings (HEVC "High Efficiency" plus HDR on by default from iPhone 12); this is common knowledge but not sourced here.

## 2. Audio extraction fast path, and reading large picked files on iOS

### Takeaway
The repo already uses the fast path: mediabunny reads only the audio packets lazily from the Blob (8 MiB cache by default) and decodes them with AudioDecoder; no video is decoded. No public phone benchmark exists for this. On iOS, picking a video from Photos through `<input type=file>` makes WebKit copy and transcode it to H.264 ("Preparing..."), which costs time proportional to the video and is the main delay on iPhones for long files.

### Cited Findings
- mediabunny: "Files are always read partially ('lazily'), meaning only the bytes required to extract the requested information" are read; creating an `Input` reads nothing until data is requested; `BlobSource` has a cache whose maximum "Defaults to 8 MiB"; by contrast `BufferSource` "requires the entire input file to be held in memory". [mediabunny: Reading media files](https://mediabunny.dev/guide/reading-media-files) (fetched 22 Oct 2026)
- DESKTOP measurement in the repo: 1-hour MP4 (114 MB) audio-only decode to 16 kHz: 48 s whole-PCM, 93 s segmented to OPFS; 2-minute file 2.8 s (headless Chrome, 2017 MacBook Pro under heavy load). [notes/timings.md](/Users/mac/Documents/DevProjects/selects/notes/timings.md)
- WebKit commit r283592 (5 Oct 2021): most iOS devices default to HEVC; some sites only accept H.264; WebKit added `WKFileUploadMediaTranscoder`, which transcodes picked videos one at a time with `AVAssetExportSession`, shows a "Preparing..." progress UI that the user can cancel, and falls back to the original if transcoding fails. It notes PHPickerViewController also transcodes. [webkit-changes r283592](https://www.mail-archive.com/webkit-changes@lists.webkit.org/msg177757.html)
- WebKit commit 0f7604 (5 Mar 2024, bug 267277): on iOS, file inputs that accept images or videos let users pick from Photos and "WebKit has always converted selected images to JPEG and videos to H.264"; image conversion now happens only if `accept` restricts image types, but "Videos remain exempted from this behavior change due to known compatibility issues", that is, videos are still transcoded. [webkit-changes 0f7604](https://www.mail-archive.com/webkit-changes@lists.webkit.org/msg211341.html)
- Conflicting developer claim (18 Oct 2026, untested on a device): an `accept` list that includes `video/quicktime` makes iOS Safari hand over the original HEVC .mov, while `accept="video/mp4"` should force H.264 transcoding. [docsfitnessnj PR #120](https://github.com/docsfitnessnj/docs-fitness-app/pull/120)
- An older Apple forum thread says that from iOS 13.6.1 sites started receiving the original (often HEVC) file instead of a converted one. [Apple Developer Forums 658708](https://developer.apple.com/forums/thread/658708)
- User report: a 5 GB video on iOS 15 spent about a minute "preparing" before upload. [Power Users Codidact](https://powerusers.codidact.com/posts/290276); a vendor help page says conversion takes up to about 4 s per (short) video and some iOS versions show no progress. [GuestCam help](https://help.guestcam.co/article/49-delay-on-iphone-after-tapping-the-add-button)
- iOS Safari treats `accept="audio/*"` like `video/*`. [WebKit bug 242110](https://bugs.webkit.org/show_bug.cgi?id=242110)

### Inferences
- For a 30 to 60 minute file, audio is a small share of the bytes (AAC at 128 kbps is about 58 MB per hour), so the fast path's cost on a phone should be dominated by the AAC decode plus resampling and the scattered reads, not by video size. Expect it to be a small fraction of whisper's time. No phone number exists, so measure: log `performance.now()` around `decodeAudioSegments` on one Tecno/Infinix and one iPhone.
- On iOS the transcode happens before the page even gets a File, so the page cannot show its own progress for it. The transcode also means the page usually receives H.264 rather than HEVC, which helps decoding but costs minutes for long videos and may downgrade HDR. Whether current iOS (26/27) transcodes depends on the `accept` value and possibly the iOS version; sources conflict, so test `accept="video/*"` versus `accept="video/mp4"` versus no accept on a real iPhone with a 30-minute HEVC video and time the "Preparing..." step.
- Picking from the Files app (not Photos) should avoid the transcode, since the WebKit transcoder is attached to the photo picker path. This is an inference from the commits, not tested.
- The picked File on iOS is a copy in the app's temp storage, so memory is not the issue (BlobSource reads slices), but storage is: a 4 GB video plus the transcoded copy plus Selects' OPFS copy (`keepVideo` in store.js) can triple disk use. [src/browser/store.js](/Users/mac/Documents/DevProjects/selects/src/browser/store.js)

### Gaps
- No public benchmark of WebCodecs AudioDecoder (or mediabunny AudioSampleSink) speed on any phone.
- No current (iOS 26/27) Apple documentation on when Safari transcodes a picked video, or on the size and time of the "Preparing..." step for long videos.
- No data on `File.slice` read throughput from a picked file on iOS or Android.

## 3. Encode and render: H.264 VideoEncoder on iOS Safari and mid-range Android, speed, caption drawing, 720p vs 1080p

### Takeaway
H.264 encode is available on nearly all Chrome Android and Safari iOS sessions, but speed varies a lot: one undated benchmark shows 1080p30 encode at 200 fps on a Galaxy S25 (Chrome) and only 12 fps on an iPhone 16 Pro in Safari (120 fps in Chrome on the same phone). Separately, Safari 27.0/27.0.1 has a WebKit bug where H.264 High/Main in the default "quality" latency mode never outputs, which is exactly the repo's configuration. No public benchmark exists for Helio/Unisoc phones. 720x1280 is the right default for phones.

### Cited Findings
Benchmarks (webcodecsfundamentals.org, 1080p 30 fps H.264, undated, device type labels are mine)
- PHONE iPhone 16 Pro: Chrome encode 120 fps, decode 600 fps; Safari encode 12 fps, decode 600 fps. PHONE Samsung Galaxy S25 Chrome: encode 200 fps, decode 600 fps. DESKTOP/LAPTOP: Windows netbook Chrome encode 11 fps, decode 540; Samsung Chromebook Chrome 60 / 600; MacBook Pro M4 Chrome 200 / 1200, Safari 200 / 600. The page says encode "is in general much slower than decoding", recommends `latencyMode: "realtime"` for faster encoding and "quality" (default) for files, and recommends capping `encodeQueueSize` (example limit 20) and calling `frame.close()` right after `encode()`. [webcodecsfundamentals VideoEncoder](https://webcodecsfundamentals.org/basics/encoder/) (fetched 22 Oct 2026)

Safari 27 encoder stall
- mediabunny issue #541 (opened 29 Sep 2026, closed 5 Oct 2026): on Safari 27.0 and 27.0.1 (macOS 27), H.264 High and Main in default "quality" mode hang (encoder accepts about 4 frames, never calls `output`, `flush()` never resolves) at 360p, 720p and 1080p, even with `prefer-software`; Baseline `avc1.42001f` works; `latencyMode: "realtime"` works for all. Cause identified as WebKit PR 74602 (already fixed upstream). iOS not confirmed; an earlier iOS Safari hang (#333) was never isolated. [mediabunny #541](https://github.com/Vanilagy/mediabunny/issues/541)
- hyperaudio-lite-editor issue #721 (10 Oct 2026): root cause WebKit bug 324827: on macOS 27.0 the GPU-process sandbox blocks a VideoToolbox property, so a software H.264 encoder is used that buffers up to 16 frames while WebCodecs caps the queue at 4. Fix landed in WebKit 321700@main on 23 Sep 2026 and on the Safari 27 branch but was not in a public release as of 10 Oct. On a healthy macOS 26.6.2 machine, `realtime` dropped 20 of 300 frames (bursts after keyframes). Their fix: a one-time probe per page load (High profile, default latency, 640x360, 8 frames, wait about 1.5 s for a packet; about 75 ms when healthy), falling back to Baseline via mediabunny's `onEncoderConfig`; Baseline output was about 14% larger (1.35 MB vs 1.18 MB). [hyperaudio-lite-editor #721](https://github.com/hyperaudio/hyperaudio-lite-editor/issues/721)
- Remotion switched H.264 on Safari 27+ to realtime; a reviewer noted the UA check cannot tell macOS from iOS, so iOS 27 gets the workaround too. [remotion PR #11997](https://github.com/remotion-dev/remotion/pull/11997); [remotion issue #11964](https://github.com/remotion-dev/remotion/issues/11964) (Oct 2026)

ffmpeg.wasm comparison (DESKTOP only)
- Apple M3, Chromium 145: WebCodecs 1.3 s vs ffmpeg.wasm 9.8 s (5 s 1080p clip, 7.5x), 2.8 s vs 28.4 s (15 s 1080p, 10.1x), 2.8 s vs 27.4 s (30 s 720p, 9.8x). Throughput: WebCodecs hardware AVC 305 Mpx/s, WebCodecs software fallback 60 Mpx/s, ffmpeg.wasm single-thread libx264 15 Mpx/s (about 20x slower than hardware). ffmpeg.wasm made a smaller file on the 720p clip (CRF vs WebCodecs average bitrate). [dev.to, "WebCodecs is 10x faster than ffmpeg.wasm", posted 15 Sep (year not shown)](https://dev.to/mengyuxuan/webcodecs-is-10x-faster-than-ffmpegwasm-and-sometimes-worse-37jk)
- Remotion's client-side renderer (`@remotion/web-renderer`, experimental) uses WebCodecs via mediabunny, needs Safari 26+ (Chrome 94+, Firefox 130+), is single-concurrency, and renders slower in a background tab. "Filters are not supported in Safari/WebKit." [Remotion client-side rendering](https://convert.remotion.dev/docs/client-side-rendering); [Remotion limitations](https://www.remotion.dev/docs/client-side-rendering/limitations) (fetched 22 Oct 2026, undated)

Canvas
- caniuse: `CanvasRenderingContext2D.filter` is "Not supported" in Safari 3.1 to 17.6 and "Disabled by default" in Safari and Safari iOS 18.0 to 26.3. [caniuse canvas filter](https://caniuse.com/mdn-api_canvasrenderingcontext2d_filter); `OffscreenCanvasRenderingContext2D.filter` is WebKit bug 275436, status NEW. [WebKit bug 275436](https://bugs.webkit.org/show_bug.cgi?id=275436)
- `WorkerGlobalScope.fonts` (used by `loadFonts` in the render worker) is Baseline widely available since Sept 2022. [MDN WorkerGlobalScope.fonts](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/fonts)
- Repeated `drawImage` and `getImageData` calls have caused jetsam on iPad (WebKit report). [WebKit bug 227636](https://bugs.webkit.org/show_bug.cgi?id=227636)

### Inferences
- The repo's `CanvasSource(..., { codec: "avc", latencyMode: "quality" })` matches the configuration that hangs on Safari 27.0/27.0.1, and the render has no timeout, so on affected Safari a render would spin forever at the first frames. A probe like hyperaudio's, plus a watchdog (no packet in N seconds, then retry with Baseline or realtime), is the fix pattern documented by others. Whether iOS 27 is affected is not confirmed.
- On Safari (iOS 17 to 26.3 at least), the "fit" mode's blurred background will not blur: `bgCtx.filter` is ignored, so the background is a sharp, undarkened, upscaled copy. A manual blur (draw the frame at about 1/16 size and scale up, which the repo's quarter-size `bg` canvas half does already) avoids depending on `filter`.
- Time per clip is roughly frames divided by the slowest of decode, draw and encode. A 45 s clip at 30 fps is 1,350 frames. Using the one public phone figure: at 12 fps (iPhone 16 Pro Safari 1080p encode) that is about 112 s of encode for one clip; at 120 to 200 fps (Chrome on high-end phones) under 12 s. These are high-end phones; a Helio G85/G99 or Unisoc T606 will be slower, and 720x1280 has 44% of 1080x1920's pixels, which is why 720p is the safer phone default. The desktop repo figure (720x1280, 23.9 s clip, 7.8 to 9.6 s on a 2017 laptop) is a floor, not a phone number.
- Source decode work is set by the source, not the output: a 4K60 HEVC source is decoded at 4K for every kept frame (the 60 fps source is thinned to 30 by skipping after decode, so both frames are still decoded). On a 2K30-capped chip that source may not decode at all. Downscaling at decode is not possible in WebCodecs; CanvasSink scales after decode.
- Captions drawn from a cached layer (redrawn only when the caption changes) are cheap compared with the full-frame `drawImage`; no source measured canvas caption cost on phones.

### Gaps
- No public WebCodecs encode or decode benchmark for any MediaTek Helio G-series, Dimensity, Unisoc or Samsung A-series phone. No public benchmark found.
- No Diffusion Studio phone benchmark found (not searched in depth).
- The 12 fps Safari figure is undated and from one device; it may predate or reflect a Safari bug; it needs a re-test on Safari 26 and 27 on iPhones.
- No source measured `drawImage` or OffscreenCanvas 2D cost per frame on phones.

## 4. Memory limits and background behaviour

### Takeaway
iPhone Safari tabs live in a WebContent process with a soft memory limit of about 1.5 GB (lower on low-RAM iPhones; about 2 to 3 GB seen on Pro models), above which the tab is killed and reloads. Selects' render is light (a 3-frame decode pool, one output canvas, an in-memory MP4 of tens of MB), so the risk is in long-file audio and models, not the render. Phones stop work when the tab is hidden; Screen Wake Lock is supported on iOS 16.4+ (home screen apps fixed in 18.4) and Chrome Android 84+, and is released when the tab is hidden.

### Cited Findings
- Simon Fraser (WebKit), WebKit bug 277848 (filed 8 Aug 2024, iPhone 12 Pro, iOS 17.5.1): WebContent processes on iPhone have a soft limit of roughly 1.5 GB, can be killed by jetsam above it, may exceed it when overall memory pressure is low, and the limit is lower on iPhones with less RAM; developers should stay under 1.5 GB. The reporter saw about 1.5 GB normally and about 3 GB after a reboot on iPhone 12 Pro, and about 3 GB on iPhone 15 Pro/Pro Max. [WebKit bug 277848](https://bugs.webkit.org/show_bug.cgi?id=277848)
- 2026 Apple forum report: a WebContent process on iPhone 17 Pro (12 GB) killed at an ActiveHard limit of 2048 MB; it crashed on iPhones, not iPads. [Apple Developer Forums 823061](https://developer.apple.com/forums/thread/823061)
- A three.js forum thread reports memory-limit crashes on iOS 26. [three.js forum](https://discourse.threejs.org/t/memory-limit-crash-on-ios-26/86978)
- iPhone RAM (teardown-based, Apple does not publish): XR 3 GB; 11 4 GB; 12 and 12 mini 4 GB, 12 Pro 6 GB; 13 and 13 mini 4 GB, 13 Pro 6 GB; 14 6 GB; 15 6 GB, 15 Pro 8 GB. [9to5Mac iPhone RAM list (Nov 2023)](https://9to5mac.com/2023/11/18/iphone-ram-list/)
- Open VideoFrames, `decodeQueueSize` and `encodeQueueSize` are the memory bottlenecks; without a cap the encode queue can grow until video memory runs out and the process crashes; close frames right after `encode()`. [webcodecsfundamentals VideoEncoder](https://webcodecsfundamentals.org/basics/encoder/)
- DESKTOP repo measurement: segmented audio decode of a 1-hour file peaked at 146 MB JS and 465 MB renderer RSS, versus 495 MB JS and 954 MB RSS for the whole-PCM path; whole PCM for 2 hours would be about 1 GB of JS memory, "which a phone tab will not get". [notes/timings.md](/Users/mac/Documents/DevProjects/selects/notes/timings.md)
- Chrome Page Lifecycle (updated 16 Oct 2026): browsers freeze hidden pages to save CPU and battery; in the frozen state timers and fetch callbacks do not run; discards fire no event, check `document.wasDiscarded`; on mobile, "hidden" is often the last reliable signal; no time thresholds given. [Chrome Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
- Chrome intensive throttling: timers at once per minute after 5 minutes hidden; rAF and requestVideoFrameCallback pause when hidden. [AmitxParmar issue #49, 17 Oct 2026](https://github.com/AmitxParmar/ai-video-editor/issues/49) (secondary)
- Remotion: background tabs get throttled rAF, and "rendering in a background tab will be slower than in a foreground tab". [Remotion limitations](https://www.remotion.dev/docs/client-side-rendering/limitations)
- Screen Wake Lock: Safari iOS 16.4+, with home screen web apps broken until fixed in iOS 18.4 (WebKit bug 254545); Chrome Android 84+ (caniuse lists a different version; sources conflict); the lock can be refused (low battery, settings) and is released when the tab is hidden. [WebKit bug 254545](https://bugs.webkit.org/show_bug.cgi?id=254545); [Chrome: Screen Wake Lock API](https://developer.chrome.com/docs/capabilities/web-apis/wake-lock); [caniuse wake-lock](https://caniuse.com/wake-lock)

### Inferences
- Practical iPhone budgets: plan for about 1 GB per tab on 3 to 4 GB iPhones (XR, 11, 12, 13), about 1.5 GB on 6 GB models. Holding a 2 GB judge model plus whisper plus a render in one tab on a 4 GB iPhone is the likely crash, not the render alone. Unload models before rendering.
- The render's own peak should be small: 3 decoded frames at the working size, a 1080x1920 RGBA canvas (8 MB), a caption layer, and the output MP4 in a BufferTarget (6 Mb/s x 60 s is about 45 MB at 1080p; about 19 MB at 720p). One clip at a time is right; batching several clips in parallel would multiply this.
- A 4K HEVC decode holds large hardware surfaces; the pool size of 3 is already low. Do not raise it on phones.
- When the screen locks or the user switches apps, assume the render stops. The engine's per-clip resume is the correct design; the wake lock only prevents auto-lock while the tab is visible.

### Gaps
- No source on Android Chrome per-tab memory limits or low-memory-killer behaviour on 3 to 4 GB Tecno/Infinix/itel phones (Android Go-style devices). Not found.
- No source confirming whether dedicated workers (the render worker) keep running in a hidden but not frozen tab on Chrome Android or iOS Safari.
- No report tying WebCodecs specifically to the iOS "A problem repeatedly occurred" reload. Not found.

## 5. Battery and thermal

### Takeaway
No public measurement of WebCodecs encode/decode energy or of sustained WASM inference thermals on phones was found. The only evidence is indirect: native phones throttle within minutes of sustained load, and WASM uses less energy than JS for the same work.

### Cited Findings
- Native measurement: on a Nexus 5, thermal throttling started after about 3 minutes of video playback, driven by skin temperature. [Sahin and Coskun, ESWEEK 2016 (PDF)](https://www.bu.edu/peaclab/files/2016/10/ESWEEK16_sahin.pdf)
- ACM study on Android: WebAssembly can use less energy than JavaScript; it cites an earlier result that WASM cut battery use by 39%; Firefox used less energy than Chrome. Short workloads, not sustained video. [ACM, Comparing the Energy Efficiency of WebAssembly and JavaScript on Android (2022)](https://dl.acm.org/doi/fullHtml/10.1145/3530019.3530034)
- The FibRace client-side proving benchmark on phones did not measure power or throttling and calls for energy metrics, which confirms the gap. [FibRace, arXiv 2510.14693 (Oct 2025)](https://arxiv.org/pdf/2510.14693)
- W3C Compute Pressure proposal: high CPU/GPU load on mobile can make devices hot and drain the battery. [w3c/compute-pressure](https://github.com/w3c/compute-pressure)

### Inferences
- Hardware encode and decode (the WebCodecs path) should be far cheaper in energy than CPU work, so the render is unlikely to be the thermal problem; whisper and the judge running on WASM or WebGPU for many minutes are. Expect throttling during long transcriptions on Helio G-series phones, which will stretch timings past any short benchmark.

### Gaps
- No public benchmark found for WebCodecs or WASM inference energy or thermal throttling in a phone browser. Measure on target phones (battery percent before and after, and per-minute throughput drift over a 20-minute run).

## 6. Practical recommendation and feature-detection checklist

### Takeaway
Default phones to 720x1280, 30 fps, one clip at a time, clips under about 60 s, and a handful of clips per session; offer 1080x1920 only after a quick on-device speed probe. Feature-detect each path with `isConfigSupported` on the real file's codec string (not a generic one), add a Safari 27 encoder probe and a watchdog, and add an audio fallback for Safari before 26.

### Cited Findings
- 720x1280 has 921,600 pixels against 2,073,600 for 1080x1920 (44%); the repo already defines a "preview" preset at 720x1280 with 2.5 Mb/s video and 128 kb/s audio. [src/browser/render-clip.js](/Users/mac/Documents/DevProjects/selects/src/browser/render-clip.js), [src/core/layout.mjs](/Users/mac/Documents/DevProjects/selects/src/core/layout.mjs)
- Helio G99 hardware video ceiling: 2K30, FHD60, HD120 for both encode and playback. [MediaTek Helio G99](https://www.mediatek.com/products/smartphones/mediatek-helio-g99)
- The only public phone encode figures: iPhone 16 Pro Safari 12 fps and Chrome 120 fps; Galaxy S25 Chrome 200 fps (1080p30, undated). [webcodecsfundamentals VideoEncoder](https://webcodecsfundamentals.org/basics/encoder/)
- Probe-and-fallback pattern for the Safari 27 stall (High profile probe at 640x360, 8 frames, 1.5 s wait, about 75 ms when healthy; Baseline fallback via `onEncoderConfig`). [hyperaudio-lite-editor #721](https://github.com/hyperaudio/hyperaudio-lite-editor/issues/721)
- Use `isConfigSupported()`; hardware probing is unreliable (w3c/webcodecs#896). [AmitxParmar issue #49](https://github.com/AmitxParmar/ai-video-editor/issues/49)
- The repo already limits phones: over 30 minutes it tells phone users to use a laptop. [notes/timings.md](/Users/mac/Documents/DevProjects/selects/notes/timings.md)

### Inferences
What a "modest phone" can do (estimates, not measured; no public mid-range benchmark exists):
- Resolution: 720x1280 at 30 fps by default. 1080x1920 only when a 2-second probe (encode 60 synthetic 1080x1920 frames) shows at least about 30 fps.
- Clip length and count: clips of 15 to 60 s; render the top 3 first, then more on request. One at a time. At 720p, a source that hardware-decodes at its native size should render a 45 s clip in roughly 1 to 3 times real time on a mid-range Chromium phone; on Safari, if the 12 fps encode figure holds, closer to 2 to 4 times real time at 1080p and less at 720p. These need measuring.
- Source: 1080p H.264 Android recordings are the easy case. 4K60 HEVC from iPhones is the hard case on Android; on Chrome Android, check decode support before transcription so the user is told early, not after 30 minutes of whisper.

Feature-detection checklist (in order, cache the answers per page load):
1. `typeof VideoDecoder`, `VideoEncoder`, `AudioDecoder`, `AudioEncoder`, `OffscreenCanvas`, `navigator.wakeLock`, `navigator.deviceMemory` exist. `AudioDecoder` missing means Safari before 26: use the `decodeAudioData` fallback for transcription and keep video-only rendering with audio via a fallback, or say plainly the browser is too old.
2. Source video: `VideoDecoder.isConfigSupported(await videoTrack.getDecoderConfig())` with the file's real codec string, coded size and description (mediabunny's `canDecode()` does this). Also try `hardwareAcceleration: "prefer-hardware"` to know whether a hardware path exists (result is a hint, not a guarantee).
3. Source audio: `AudioDecoder.isConfigSupported(await audioTrack.getDecoderConfig())` (mediabunny `canDecode()`).
4. Output video: `VideoEncoder.isConfigSupported({ codec: "avc1.640028" (High) or "avc1.4d0028" (Main) or "avc1.42001f"/"avc1.42e01f" (Baseline), width: 720, height: 1280, bitrate: 2.5e6, framerate: 30, latencyMode: "quality" })`, then the same at 1080x1920. Level note: 720x1280 fits level 3.1 (`avc1.64001f`); 1080x1920 needs level 4.0 (`avc1.640028`).
5. Safari 27 stall probe: actually encode 8 small frames with the chosen High/Main config and default latency, wait about 1.5 s for one output chunk; if none, use Baseline (or realtime) and keep a render watchdog that aborts if no packet arrives for about 10 s.
6. Output audio: `AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: 48000 or the source rate, numberOfChannels: 1 or 2, bitrate: 128000 })`, else Opus (`"opus"`), else mediabunny's `@mediabunny/aac-encoder`.
7. Canvas: `"filter" in offscreenCtx` before relying on `filter` for the blurred background; else downscale-and-upscale blur.
8. Speed probe: encode about 60 frames at 1080x1920 and time it; pick 1080p only above about 30 fps.
9. Memory: `navigator.deviceMemory` (Chromium only) under 4 means one model loaded at a time and 720p only; on iOS, treat XR/11/12/13 (3 to 4 GB) as about 1 GB budget.
10. Wake lock: request on start, re-request on `visibilitychange`; tell the user the screen must stay on.

### Gaps
- No public render time for any phone, any resolution, with WebCodecs. The first measured numbers should come from running the existing render on one Tecno or Infinix (Helio G85/G99), one Samsung A-series, and one iPhone 11 or 12 on iOS 26 and 27.
