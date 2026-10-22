# Hosted open-weights speech-to-text for Selects Web "Light mode" (as of 22 Oct 2026)

Scope: Light mode uploads only compressed speech audio (Opus at about 16 to 24 kbps, or AAC) to a hosted Whisper-family service, possibly through the existing Render proxy (selects-smart-proxy) or a Cloudflare Worker, and needs word-level timestamps. Users are in Lagos on slow mobile data; the operator has a tiny budget.

Context read from the repo (22 Oct 2026, no code changed): `render.yaml` defines `selects-web` (static, built with the in-browser engine) and `selects-smart-proxy` (Node, `plan: free`, holds `GEMINI_API_KEY`, judge tasks only). The live proxy's `/healthz` (fetched 22 Oct 2026 14:19 UTC) reports `"bodyBytes":16384`, so today it accepts only 16 KB request bodies; an audio route would be a new endpoint with its own size limit. `render.yaml` sets no `region`, so the proxy's Render region is whatever the dashboard chose (not visible from outside). `notes/timings.md` holds local whisper.cpp speeds used below for self-hosting estimates.

## Q1. Comparison table (one row per provider)

### Takeaway
For a free, low-ops start, two options stand out: Groq's whisper-large-v3-turbo ($0.04 per audio hour, word timestamps, accepts ogg and webm, up to 8 audio hours per day in the published base limits) and Cloudflare Workers AI's `@cf/openai/whisper-large-v3-turbo` (about 214 free audio minutes per day from 10,000 free neurons, then about $0.03 per hour, word timestamps inside segments). Both are served from a Cloudflare edge in Lagos (colo LOS). DeepInfra is the cheapest paid option ($0.012 per hour) but has the slowest network path from Lagos. Fireworks deprecated audio inference on 10 Jun 2026.

### Cited Findings

All prices are USD and were read from the linked pages on 22 Oct 2026 unless another date is given. "Per hour" figures marked (derived) are my arithmetic from the per-minute or per-token price.

| Provider | Open-weights model(s) | Price per audio hour | Free tier and limits | Max size, formats | Word timestamps | Speed | Data retention / training | Account, card, Nigeria |
|---|---|---|---|---|---|---|---|---|
| Cloudflare Workers AI | `@cf/openai/whisper-large-v3-turbo`, `@cf/openai/whisper`, `@cf/openai/whisper-tiny-en` (beta) | turbo $0.0005/min on pricing page, $0.000513/min on model page, so about $0.03/h (derived); whisper $0.0005/min (pricing) or $0.000453/min (model page); tiny-en not priced | 10,000 neurons/day free on Free and Paid plans; turbo 46.63 neurons/min, so about 214 audio min/day free (derived); whisper 41.14 neurons/min, about 243 min/day (derived); ASR rate limit 720 requests/min | turbo takes `audio` as a base64 string (or `{body, contentType}`); whisper and tiny-en take raw binary or an array of uint8; request body cap 100 MB on Free/Pro zones; no documented audio duration cap; formats not documented | turbo: `segments[].words[]` with `word`, `start`, `end`; whisper and tiny-en: top-level `words[]` with `start`, `end`; both also return `vtt` | Not published | Does not use customer content to train models or improve services without consent | Free plan exists; Nigeria availability and card acceptance not documented (gap) |
| Groq | `whisper-large-v3`, `whisper-large-v3-turbo` | v3 $0.111/h; turbo $0.04/h; minimum 10 s billed per request | Rate-limit table (labelled as Developer plan base limits): 20 RPM, 2,000 RPD, 7,200 audio s/hour, 28,800 audio s/day for both models | 25 MB upload on free tier, 100 MB on dev tier; larger files via `url`; flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm (Opus not listed as a bare type) | Yes: `timestamp_granularities` `word` and/or `segment`, requires `response_format=verbose_json` (the page's code comment contradicts this) | Speed factor 189 (v3) and 216 (turbo); WER 10.3% and 12% on Groq's own table | No retention of inference data by default; reliability/abuse logs up to 30 days, ZDR available to all customers; not used for training without permission; data stored in US GCP | Nigerian IP got a normal 401 (no geo-block) in live test; no published country list found |
| Hugging Face Inference Providers | `openai/whisper-large-v3` via deepinfra, fal-ai, hf-inference, replicate, together | Pass-through of provider price, no HF markup | Free users: no monthly credits (must buy credits); PRO $2.00/month credits | `inputs` as base64 string, or raw bytes if no parameters | Task spec only has `return_timestamps` returning `chunks[]` with `[start, end]` per chunk, not per word | Depends on provider | Depends on provider | HF account; free users must purchase credits |
| Fireworks AI | whisper-v3-large, whisper-v3-large-turbo (historic) | Beta launch post: serverless $0.0015/min (v3) and $0.0009/min (turbo) | n/a | n/a | Launch post offered word-level alignment | Launch post: 7 to 11 s per hour of audio | n/a | Changelog 10 Jun 2026: "Audio inference and image generation are deprecated." The `audio-prod` host still answered 401 on 22 Oct 2026 |
| Replicate | `vaibhavs10/incredibly-fast-whisper` (large-v3), `openai/whisper` | about $0.0031 per run (322 runs per $1), varies by input; L40S GPU | None found | Not stated on page | Not stated on page (gap) | "typically complete within 4 seconds"; Artificial Analysis speed factor 53.1 | Not checked | Not checked |
| DeepInfra | `openai/whisper-large-v3-turbo` (plus Voxtral, Nemotron ASR) | turbo $0.00020/min = $0.012/h (derived) | None found | Not checked | Not checked (gap) | Not published | Model page shows "Zero retention" | Nigerian IP got normal 401 / "missing API key" |
| fal.ai | Wizper (large-v3), Whisper large-v3 | Artificial Analysis: Wizper $0.50 per 1,000 min ($0.03/h, derived), Whisper large-v3 $1.15 per 1,000 min | Not checked | Not checked | Not checked | Speed factor 144.1 (Wizper), 97.3 | Not checked | Not checked |
| Mistral (Voxtral) | Voxtral Mini Transcribe 3 (released 20 Oct 2026), Voxtral Mini Transcribe 2 (4 Feb 2026); Voxtral Realtime is Apache 2.0 | Transcribe 3 $0.0035/min ($0.21/h, derived); Transcribe 2 $0.003/min ($0.18/h) | Not checked | Up to 3 hours per request | "Provides precise timestamps for each word" | Not checked | Not checked | Nigerian IP got normal 401 |
| Google Gemini (not open weights; Selects already has a key) | Gemini 2.5 Flash, 2.5 Flash-Lite, 3.x Flash | Audio input per 1M tokens: 2.5 Flash $1.00, 2.5 Flash-Lite $0.30, 3.1 Flash-Lite $0.50, 3.5 Flash-Lite $0.30; 32 tokens per audio second, so 2.5 Flash about $0.115/h and Flash-Lite about $0.035/h of input (derived), plus output tokens | Free tier input "Free of charge" for these models (rate limits not checked here) | Inline request up to 20 MB, Files API above; ogg, opus and webm MIME types accepted; up to 9.5 h per prompt | Only MM:SS timestamps on request, no word-level timestamps in docs | Not published | Not checked | Already used by Selects from Nigeria |
| OpenAI (not open weights) | gpt-4o-mini-transcribe, gpt-transcribe, gpt-4o-transcribe | mini $0.003/min ($0.18/h); gpt-transcribe $0.0045/min; gpt-4o-transcribe $0.006/min | Not checked | Not checked | Not checked for these models (gap) | Not checked | Not checked | Nigeria is on OpenAI's supported-countries list |
| Deepgram (not open weights) | Nova-3 (also hosts "Deepgram Whisper Cloud") | Nova-3 monolingual current $0.0048/min ($0.29/h), regular $0.0077/min | Free $200 credit, "No credit card required"; up to 5 concurrent for Whisper Cloud | Not checked | Not checked | Not checked | Not checked | Nigerian IP got normal 401 |
| AssemblyAI (not open weights) | Universal-2, Universal-3.5 Pro | $0.15/h (Universal-2), $0.21/h (Universal-3.5 Pro) | "Start free" (amount not captured) | Not checked | Not checked | Not checked | Not checked | Not checked |
| ElevenLabs Scribe (not open weights) | Scribe v2, Scribe v2 Realtime | $0.22/h (v2), $0.39/h (Realtime) | Not checked | Not checked | Realtime page lists "Precise word-level timestamps" | Not checked | Zero Retention Mode mentioned for Medical | Not checked |

Sources for the table:
- Cloudflare pricing, free neurons, $0.011 per 1,000 neurons and neurons per audio minute (page "Last updated Oct 20, 2026"): [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- Cloudflare model pages and raw schemas (fetched 22 Oct 2026): [whisper-large-v3-turbo](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/), [turbo input schema](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/schema-input.json), [turbo output schema](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/schema-output.json), [whisper](https://developers.cloudflare.com/workers-ai/models/whisper/), [whisper output schema](https://developers.cloudflare.com/workers-ai/models/whisper/schema-output.json), [whisper-tiny-en](https://developers.cloudflare.com/workers-ai/models/whisper-tiny-en/)
- Cloudflare ASR rate limit 720 requests/min: [Workers AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/)
- Cloudflare 100 MB request body on Free and Pro: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- Cloudflare no-training statement: [Workers changelog / llms-full](https://developers.cloudflare.com:8443/workers/llms-full.txt) (via search snippet, 22 Oct 2026)
- Groq models, prices, speed factors, WER, size limits, formats, timestamp rules, 10 s minimum billing: [Groq speech-to-text docs](https://console.groq.com/docs/speech-to-text)
- Groq audio rate limits: [Groq rate limits](https://console.groq.com/docs/rate-limits)
- Groq data handling: [Your Data in GroqCloud](https://console.groq.com/docs/your-data); training clause: [Groq Services Agreement](https://console.groq.com/docs/legal/services-agreement)
- HF ASR task spec and provider mapping: [HF ASR task](https://huggingface.co/docs/inference-providers/tasks/automatic-speech-recognition); credits: [HF pricing](https://huggingface.co/docs/inference-providers/pricing)
- Fireworks deprecation (2026-06-10): [Fireworks changelog](https://docs.fireworks.ai/updates/changelog.md); launch prices and speeds (beta era, undated in fetch): [Fireworks audio launch blog](https://fireworks.ai/blog/audio-transcription-launch)
- Replicate: [incredibly-fast-whisper](https://replicate.com/vaibhavs10/incredibly-fast-whisper)
- DeepInfra: [whisper-large-v3-turbo](https://deepinfra.com/openai/whisper-large-v3-turbo), [DeepInfra pricing](https://deepinfra.com/pricing)
- Cross-provider WER, speed factor and price per 1,000 min (page undated beyond "© 2026"): [Artificial Analysis Whisper](https://artificialanalysis.ai/speech-to-text/models/whisper)
- Mistral: [Voxtral Mini Transcribe 3](https://docs.mistral.ai/models/voxtral-mini-transcribe-3-0.md), [Voxtral Mini Transcribe 2](https://docs.mistral.ai/models/voxtral-mini-transcribe-26-02.md), [Mistral audio transcription](https://docs.mistral.ai/capabilities/audio_transcription)
- Gemini prices ("Last updated 2026-10-19 UTC"): [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing); formats, 32 tokens/s, 20 MB inline, MM:SS timestamps: [Gemini audio docs](https://ai.google.dev/gemini-api/docs/audio)
- OpenAI: [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [supported countries](https://developers.openai.com/api/docs/supported-countries)
- Deepgram: [Deepgram pricing](https://deepgram.com/pricing); AssemblyAI: [AssemblyAI pricing](https://www.assemblyai.com/pricing); ElevenLabs: [ElevenLabs API pricing](https://elevenlabs.io/pricing/api)

### Inferences
- Upload size per hour of speech: Opus at 16 kbps is about 7.2 MB per hour and at 24 kbps about 10.8 MB per hour (arithmetic), so a 10-minute clip is about 1.2 to 1.8 MB. That is far under Groq's 25 MB and Cloudflare's 100 MB caps; a one-hour talk fits in one Groq request at 24 kbps.
- Groq's 10-second minimum billing does not matter for whole-file requests but makes many tiny chunks more expensive.
- Cloudflare's turbo model takes base64 inside JSON, which adds about 33% to the bytes if the browser does the encoding. A Worker or the Render proxy can accept raw binary from the browser and base64 it server side, so the phone uploads only the compressed bytes.
- Cloudflare's turbo parameter names (`vad_filter`, `hallucination_silence_threshold`, `condition_on_previous_text`) match faster-whisper's options, which suggests a faster-whisper backend that decodes common containers including ogg and webm. This is not documented and should be tested with a real Opus file before relying on it.
- Gemini is not a good primary choice for Light mode because it gives no word-level timestamps; LLM-produced MM:SS times would also need checking against the audio.
- With the free daily caps: Cloudflare gives about 3.6 audio hours per day; Groq's published base limits give 2 audio hours per hour and 8 per day per organisation. For a small user base both cover early traffic; a shared free key will run out quickly if Light mode becomes popular.

### Gaps
- Groq's free-plan limits: the rate-limit page says the visible table is the Developer plan's base limits, so the free-plan audio-seconds figures may be lower. Confirm on the console's limits page after signing in.
- Whether Groq or Cloudflare signup needs a card, and whether Nigerian-issued cards work on either, is not documented in anything I found. No Nigerian community reports on Groq signup were found.
- Cloudflare does not document a maximum audio duration or the accepted containers for Workers AI Whisper; its own tutorial chunks audio into 1 MB pieces "to work within memory and execution time constraints" ([Cloudflare chunking tutorial](https://developers.cloudflare.com/workers-ai/guides/tutorials/build-a-workers-ai-whisper-with-chunking)).
- DeepInfra's and Replicate's word-timestamp support, file limits and accepted formats were not confirmed from primary pages.
- OpenAI's gpt-4o-mini-transcribe word-timestamp support was not checked on a primary page.
- Retention terms for Mistral, fal, Replicate, Deepgram, AssemblyAI and ElevenLabs were not checked.

## Q2. Cloudflare Workers AI: free minutes, input/output, and Lagos presence

### Takeaway
Cloudflare serves both cloudflare.com and selects.ikpemosi.work from its Lagos PoP (colo LOS) for this Mac, and the Workers AI REST endpoint answered in 0.12 to 0.36 s. The free 10,000 neurons per day cover about 214 minutes of turbo audio. Where the GPU inference itself runs is not published per city, so I cannot confirm Lagos GPUs.

### Cited Findings
- Live test, 22 Oct 2026 14:17 UTC, from this Mac in Lagos (Airtel Networks, AS36873, IP geolocated Lagos NG): `https://www.cloudflare.com/cdn-cgi/trace` returned `colo=LOS`, `loc=NG`, `http=http/2`, `tls=TLSv1.3`. `https://selects.ikpemosi.work/cdn-cgi/trace` also returned `colo=LOS`. The selects.ikpemosi.work response carried `rndr-id` and `cf-ray ...-LOS`, so the site is a Render service behind Cloudflare's edge. (live measurement)
- The `cf-ray` suffix was `LOS` for api.groq.com, api.cloudflare.com, selects-smart-proxy.onrender.com, api.mistral.ai, api.openai.com and api.replicate.com; the Fireworks audio host came through `CDG` (Paris). (live measurement, 14:19 UTC)
- Free allocation: "10,000 Neurons per day at no charge" on Free and Paid; overage "$0.011 per 1,000 Neurons" on Workers Paid; whisper-large-v3-turbo 46.63 neurons per audio minute ($0.0005); whisper 41.14 neurons per minute ($0.0005). [Workers AI pricing, updated 20 Oct 2026](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- Non-open-weights ASR on Workers AI: `@cf/deepgram/nova-3` $0.0052/min (472.73 neurons), Nova-3 over WebSocket $0.0092/min (836.36 neurons), `@cf/deepgram/flux` WebSocket $0.0077/min (700 neurons); `@cf/pipecat-ai/smart-turn-v2` is a turn-detection model. [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- whisper-large-v3-turbo input: `audio` is either "Base64 encoded value of the audio data" or an object with `body` and `contentType`; options include `language`, `vad_filter`, `initial_prompt`, `prefix`, `beam_size` (default 5), `condition_on_previous_text`, `no_speech_threshold`, `hallucination_silence_threshold`. Output includes `transcription_info` (language, duration, duration_after_vad), `segments[]` each with `words[]` of `{word, start, end}` in seconds, and `vtt`. Batch: yes. [turbo input schema](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/schema-input.json); [turbo output schema](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/schema-output.json)
- `@cf/openai/whisper` input: binary, or `audio` as "An array of integers ... 8-bit unsigned integer values"; output `words[]` with `start` ("The second this word begins in the recording") and `end`. [whisper input schema](https://developers.cloudflare.com/workers-ai/models/whisper/schema-input.json); [whisper output schema](https://developers.cloudflare.com/workers-ai/models/whisper/schema-output.json)
- `@cf/openai/whisper-tiny-en` is marked Beta, English-only, same `words[]` output, and is not listed on the pricing page. [whisper-tiny-en](https://developers.cloudflare.com/workers-ai/models/whisper-tiny-en/)
- ASR rate limit: 720 requests per minute. [Workers AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/)
- Cloudflare's product page says its catalog runs models "close to users in 200+ cities"; a 2023 analysis said Cloudflare planned GPUs in more than 100 cities by end of 2023. No current per-city GPU list was found. [Cloudflare Workers AI product page](https://www.cloudflare.com/product/workers-ai); [DCD analysis, 2023](https://www.datacenterdynamics.com/en/analysis/how-cloudflare-plans-to-dominate-generative-ai-at-the-edge/)

### Inferences
- A Worker bound to Workers AI (`env.AI.run`) would take the upload at the Lagos edge over a 10 to 30 ms connection, which is the shortest first hop of any option measured. Where the model then runs is Cloudflare's choice.
- 214 free turbo minutes per day is about 21 ten-minute clips per day before charges (and charges need Workers Paid, which is $5/month on Cloudflare's usual pricing; that figure was not re-checked here).
- Turbo returns word timings nested in segments, so the client has to flatten `segments[].words[]`; the older `whisper` model returns a flat `words[]` but is the original large-v2-era model (Cloudflare's page links OpenAI's 2022 Whisper research page), likely less accurate.

### Gaps
- No public statement on whether Workers AI has GPUs in Lagos or which colo serves inference for Nigerian traffic.
- Maximum audio length per request for turbo is undocumented.

## Q3. Groq specifics, availability in Nigeria, and data handling

### Takeaway
Groq's turbo model is cheap ($0.04/h), fast (speed factor 216), takes ogg and webm directly, and returns word timestamps with `verbose_json`. From a Nigerian IP it answers normally (401 for a bad key), but I found no official country list to confirm account availability.

### Cited Findings
- `whisper-large-v3` $0.111/h, speed factor 189, WER 10.3%; `whisper-large-v3-turbo` $0.04/h, speed factor 216, WER 12%, no translation. Files are downsampled to 16 kHz mono. [Groq speech-to-text](https://console.groq.com/docs/speech-to-text)
- 25 MB max on free tier, 100 MB on dev tier, use `url` for larger files; minimum billed length 10 s. [Groq speech-to-text](https://console.groq.com/docs/speech-to-text)
- `timestamp_granularities` supports `word` and `segment`; the parameter table says `response_format` must be `verbose_json`, while a code comment on the same page says `json`. [Groq speech-to-text](https://console.groq.com/docs/speech-to-text)
- Rate limits for both Whisper models: 20 RPM, 2K RPD, 7.2K audio seconds per hour, 28.8K audio seconds per day, with the note "the limits shown below are the base limits for the Developer plan." [Groq rate limits](https://console.groq.com/docs/rate-limits)
- "By default, Groq does not retain customer data for inference requests"; `/openai/v1/audio/transcriptions` falls under "System reliability and abuse monitoring, Up to 30 days", ZDR can be enabled by all customers; data stored in GCP buckets in the United States. [Your Data in GroqCloud](https://console.groq.com/docs/your-data)
- "Groq is not permitted to use Inputs or Outputs for training or fine-tuning any AI Model Services or other models, unless explicitly granted permission." The agreement also binds customers to US export control and OFAC rules. [Groq Services Agreement](https://console.groq.com/docs/legal/services-agreement)
- Live test 22 Oct 2026 14:33 UTC from Lagos: POST to `api.groq.com/openai/v1/audio/transcriptions` without a key returned `{"error":{"message":"Invalid API Key",...}}`, not a region block; response header `x-groq-region: dls` (Dallas) with `cf-ray` ending `LOS`. (live measurement)
- Groq's web-search tool docs list Nigeria as a supported country for result boosting; this is a search-feature setting, not a statement of account availability. [Groq web search docs](https://console.groq.com/docs/tool-use/built-in-tools/web-search) (via search, 22 Oct 2026)

### Inferences
- The request from Lagos enters Cloudflare in Lagos and is processed in Dallas, so the upload body travels the long haul once; with 1 to 2 MB clips that is a few seconds at most beyond the user's own uplink time.
- Because the 100 MB `url` path exists on the dev tier, very long files could be uploaded to object storage first; Light mode's small Opus files do not need it.

### Gaps
- No official Groq list of supported or blocked countries was found; Nigeria is not mentioned in the services agreement page text that was downloaded.
- Free-plan audio limits and whether signup needs a card are not confirmed.

## Q4. Other hosted routes (HF Inference Providers, Fireworks, Replicate, DeepInfra, and non-open-weights)

### Takeaway
Hugging Face no longer gives free users monthly credits and its ASR spec returns chunk timestamps, not word timestamps; Fireworks has deprecated audio; Replicate is per-run with GPU cold starts; DeepInfra is the cheapest per minute but slowest to reach from Lagos. Among closed models, Deepgram's $200 no-card credit is the largest free allowance, and AssemblyAI, ElevenLabs, Mistral and OpenAI's mini model cost $0.15 to $0.22 per hour.

### Cited Findings
- HF: free users have "None" monthly credits ("credits purchase required"); PRO users get $2.00; hf-inference "focuses mostly on CPU inference" since July 2025. [HF pricing](https://huggingface.co/docs/inference-providers/pricing)
- HF ASR providers mapped for `openai/whisper-large-v3`: deepinfra, fal-ai (`fal-ai/whisper`), hf-inference, replicate, together; request is base64 `inputs` or raw bytes; `return_timestamps` yields `chunks[]` with `timestamp: [start, end]`. [HF ASR task](https://huggingface.co/docs/inference-providers/tasks/automatic-speech-recognition)
- Fireworks changelog: "Audio inference and image generation are deprecated." dated 2026-06-10; an earlier entry added diarization and batch to audio inference. [Fireworks changelog](https://docs.fireworks.ai/updates/changelog.md)
- Replicate incredibly-fast-whisper: "approximately $0.0031 to run ... 322 runs per $1", Nvidia L40S, "Predictions typically complete within 4 seconds." [Replicate model page](https://replicate.com/vaibhavs10/incredibly-fast-whisper)
- Artificial Analysis Whisper providers (per 1,000 min / speed factor / WER): Groq turbo $0.67 / 200.8 / 4.6%; fal Wizper $0.50 / 144.1 / 4.7%; fal large-v3 $1.15 / 97.3 / 4.1%; Replicate incredibly-fast $1.49 / 53.1 / 5.7%; Replicate large-v3 $4.23 / 2.9 / 10.1%; Together large-v3 $1.50 / 285.4 / 4.5%; Telnyx turbo $15.00 / 37.3 / 5.5%. [Artificial Analysis](https://artificialanalysis.ai/speech-to-text/models/whisper) (no data date on page)
- DeepInfra `openai/whisper-large-v3-turbo` "$0.00020 / minute", page marks "Zero retention"; pricing page also lists Voxtral-Small-24B-2507 $0.003/min, Voxtral-Mini-3B-2507 $0.001/min, Nemotron-3.5-ASR-Streaming-Multilingual-0.6b $0.0002/min. [DeepInfra model page](https://deepinfra.com/openai/whisper-large-v3-turbo); [DeepInfra pricing](https://deepinfra.com/pricing)
- OpenAI: gpt-4o-mini-transcribe $0.003/min, gpt-transcribe $0.0045/min, gpt-4o-transcribe $0.006/min, gpt-realtime-whisper $0.017/min; Nigeria is on the supported-countries list. [OpenAI pricing](https://developers.openai.com/api/docs/pricing); [OpenAI supported countries](https://developers.openai.com/api/docs/supported-countries)
- Deepgram: "Free $200 Credit then pay-as-you-go", "No credit card required"; Nova-3 monolingual current $0.0048/min (regular $0.0077), up to 5 concurrent requests for "Deepgram Whisper Cloud". [Deepgram pricing](https://deepgram.com/pricing)
- AssemblyAI: Universal-2 $0.15/hr, Universal-3.5 Pro $0.21/hr, "Start free". [AssemblyAI pricing](https://www.assemblyai.com/pricing)
- ElevenLabs: Scribe v2 $0.22/hr, Scribe v2 Realtime $0.39/hr with "Precise word-level timestamps". [ElevenLabs API pricing](https://elevenlabs.io/pricing/api)
- Mistral: Voxtral Mini Transcribe 3 released 2026-10-20, $0.0035/min, features "timestamps, transcriptions"; Voxtral Mini Transcribe 2 $0.003/min; Voxtral Realtime (Voxtral-Mini-4B-Realtime-2602) is Apache 2.0. [Mistral models](https://docs.mistral.ai/models/voxtral-mini-transcribe-3-0.md); [Mistral audio](https://docs.mistral.ai/capabilities/audio_transcription)
- Gemini: 2.5 Flash audio input $1.00 per 1M tokens, 2.5 Flash-Lite $0.30, free tier "Free of charge"; 32 tokens per second of audio; accepts `audio/ogg`, `audio/opus`, `audio/webm`; timestamps only as MM:SS. [Gemini pricing, 19 Oct 2026](https://ai.google.dev/gemini-api/docs/pricing); [Gemini audio](https://ai.google.dev/gemini-api/docs/audio)

### Inferences
- Deepgram's $200 credit at $0.0048/min is about 694 audio hours (arithmetic), but Nova-3 is closed and its own hosted "Whisper Cloud" is capped at 5 concurrent requests.
- DeepInfra at $0.012/h is about a third of Groq's turbo price, but has no free tier found and the worst network path measured (see Q6).

### Gaps
- Replicate cold-start time was not documented on the page; fal.ai and Together free tiers were not checked.
- Whether DeepInfra's OpenAI-compatible endpoint returns word timestamps was not confirmed.

## Q5. Accuracy on African-accented English

### Takeaway
Zero-shot Whisper is clearly worse on African-accented English than on standard benchmarks: Intron's AfriSpeech-MultiBench puts Whisper-large-v3 at about 27% average WER against about 15% for Intron's Sahara V2, and community fine-tunes show Whisper-medium at 43% WER zero-shot on AfriSpeech-200. Selects' own tests found base.en unsure of 20% of words on an elderly Nigerian speaker.

### Cited Findings
- AfriSpeech-MultiBench (authors from Intron Health): Whisper-large-v3 overall average about 27.19 vs 15.25 for Intron Sahara V2; in call-center audio about 24.7% vs 13.45%; Whisper degrades more on silence and noise. [AfriSpeech-MultiBench, arXiv 2511.14255](https://arxiv.org/pdf/2511.14255)
- Zero-shot Whisper-medium on an AfriSpeech-200 test split: 43.22% WER (clinical 50.55%, general 36.09%); Whisper-small 49.15%; fine-tuning brought them to 20.13% and 22.94%; hardest accents were mostly smaller Nigerian accents. [whisper-medium-afrispeech card](https://huggingface.co/Professor/whisper-medium-afrispeech); [whisper-small-afrispeech card](https://huggingface.co/Professor/whisper-small-afrispeech)
- AfriSpeech-200: about 200 hours, 120 accents, 13 countries. [TACL 2023](https://transacl.org/index.php/tacl/article/view/5211)
- Intron expanded Sahara to 57 languages (Mar 2026) and released Sahara v2.5 for code-switched speech (Aug 2026); the headline comparisons are Intron's own. [TechCabal, 5 Mar 2026](https://techcabal.com/2026/03/05/intron-expands-sahara-to-57-languages/); [Techeconomy, Aug 2026](https://techeconomy.ng/intron-unveils-sahara-v25-bringing-natural-african-language-mixing-to-voice-ai)
- Selects README: a Nigerian-accent fine-tune was unsure of 2% of words vs 20% for the default model on the elderly speaker, but ran about 3.5 times slower. (repo `README.md`, "Accents")
- Groq's own WER figures: v3 10.3%, turbo 12% (benchmark not named). [Groq speech-to-text](https://console.groq.com/docs/speech-to-text)

### Inferences
- Any hosted large-v3 or large-v3-turbo will be far better than the in-browser base.en Selects runs today, but still error-prone on strong Nigerian accents; `initial_prompt` (Cloudflare) or `prompt` (Groq) with names and Pidgin terms is a cheap mitigation.
- The AfriSpeech-MultiBench numbers come from the vendor whose model wins, so they favour Sahara; the Whisper figures themselves are consistent with the independent-looking community model cards.

### Gaps
- No independent WER for whisper-large-v3-turbo specifically on Nigerian English was found.
- No hosted, priced API for Intron Sahara was checked.

## Q6. Latency from Lagos (live) and self-hosting options

### Takeaway
Measured from Lagos on 22 Oct 2026, providers fronted by Cloudflare's Lagos edge (Groq, Cloudflare API, Mistral, Render) connect in 15 to 30 ms; DeepInfra, Deepgram and fal have 195 to 275 ms ping and the slowest handshakes. Self-hosting Whisper on Render free (0.1 CPU) would run slower than real time; even the $25 Standard instance would manage only about base.en at a few times real time, so a hosted GPU API is the better fit.

### Cited Findings
Live tests: run from this Mac in Lagos (Airtel Networks AS36873, public IP geolocated Lagos NG) on 22 Oct 2026 between 14:17 and 14:34 UTC with `curl -w` (three requests each, unauthenticated, so 401/403/404 are expected). Values in seconds; "connect" is TCP connect done, "tls" is TLS handshake done, "ttfb" is time to first byte, all measured from request start.

| Endpoint | Status | connect | tls | ttfb | Edge / note |
|---|---|---|---|---|---|
| api.groq.com/openai/v1/models | 401 | 0.021 to 0.146 | 0.095 to 0.176 | 0.376 to 0.841 | CF LOS; `x-groq-region: dls`; ping 10 to 15 ms |
| api.cloudflare.com (Workers AI run URL) | 404 | 0.016 to 0.125 | 0.046 to 0.317 | 0.120 to 0.362 | CF LOS |
| api.fireworks.ai | 401 | 0.135 to 0.270 | 0.320 to 0.630 | 0.460 to 0.760 | 35.207.x (GCP) |
| audio-prod.us-virginia-1.direct.fireworks.ai | 401 | 0.117 to 0.230 | 0.278 to 0.547 | 0.529 to 0.950 | CF CDG |
| api.deepinfra.com/v1/openai/models | 200 | 0.347 to 1.100 | 0.685 to 1.725 | 1.163 to 2.782 | ping 229 to 275 ms |
| router.huggingface.co (hf-inference whisper) | 401 | 0.145 to 0.282 | 0.221 to 0.407 | 0.528 to 0.671 | CloudFront |
| api.replicate.com | 401 | 0.215 to 0.690 | 0.712 to 1.318 | 0.941 to 2.120 | CF LOS |
| selects-smart-proxy.onrender.com/healthz | 200 | 0.016 to 0.292 | 0.244 to 0.973 | 14.445 (first), then 0.439 and 1.528 | CF LOS; first call looked like a free-instance wake; ping 9 to 14 ms |
| render.com | 200 | 0.024 to 0.256 | 0.752 to 1.135 | 1.073 to 1.611 | |
| api.openai.com | 401 | 0.026 to 0.450 | 0.640 to 2.740 | 1.101 to 3.036 | CF LOS |
| api.deepgram.com | 401 | 0.212 to 0.367 | 0.803 to 1.088 | 1.067 to 2.228 | ping 207 to 217 ms |
| api.assemblyai.com | 401 | 0.262 to 0.662 | 0.536 to 0.939 | 0.814 to 1.215 | AWS |
| generativelanguage.googleapis.com | 403 | 0.113 to 0.189 | 0.334 to 0.431 | 0.468 to 0.751 | 403 is "unregistered callers", not a region block |
| api.mistral.ai | 401 | 0.015 to 0.317 | 0.285 to 0.369 | 0.474 to 0.642 | CF LOS |
| api.elevenlabs.io | 404 | 0.133 to 0.165 | 0.298 to 0.554 | 0.515 to 0.778 | |
| fal.run/fal-ai/whisper | 401 | 0.207 to 0.459 | 0.413 to 0.693 | 0.695 to 0.892 | ping 194 to 201 ms |

No endpoint returned a geographic block to the Nigerian IP; error bodies were "Invalid API Key" (Groq, Mistral), "Missing bearer authentication" (OpenAI), "missing API key" (DeepInfra) and "unregistered callers" (Google). (live measurement)

Self-hosting sources:
- Render compute: Free $0 "512 MB RAM", "Less than 1 CPU"; Starter $7/month 512 MB RAM, 0.5 CPU; Standard $25/month 2 GB RAM, 1 CPU; Pro $85/month 4 GB, 2 CPU. [Render pricing](https://render.com/pricing) (22 Oct 2026)
- Render regions: Oregon, Ohio, Virginia, Frankfurt, Singapore; Frankfurt is the only European one and the nearest to Lagos. [Render regions](https://render.com/docs/regions)
- Measured on the Selects dev Mac (Intel i5-7360U, 2 cores/4 threads, no GPU), whisper.cpp greedy: base.en 5.95x real time, small.en 1.86x real time on a test clip; whole talks at 1.57x to 2.78x under heavy load. (repo `notes/timings.md`, lines 15, 31, 136, 148 to 152)
- faster-whisper small int8 on an unspecified CPU: 13 min of audio in 1 min 42 s (about 7.6x real time); older official figure 8 threads on Xeon Gold 6226R, int8 2m04s for 13 min, 995 MB RAM. [ki-syndikat faster-whisper](https://www.ki-syndikat.de/tools/faster-whisper/); [faster-whisper on PyPI](https://pypi.org/project/faster-whisper/1.0.0)
- Modal Starter: "$0 + compute / month", "$30 / month free credits", 10 GPU concurrency. [Modal pricing](https://modal.com/pricing)
- HF ZeroGPU: free to use for all users; free personal accounts (verified email, account older than 30 days) can host up to 2 ZeroGPU Spaces; PRO gets 8x daily quota; hardware is half an RTX Pro 6000 Blackwell (48 GB) by default. [HF ZeroGPU docs](https://huggingface.co/docs/hub/spaces-zerogpu.md)

### Inferences
- First-hop latency favours Groq and Cloudflare: both terminate TLS in Lagos. TTFB on a 401 includes the long-haul hop to the origin (Dallas for Groq), so real transcription replies will be roughly those TTFBs plus upload time plus inference (a 10-minute clip at Groq's speed factor of about 200 is about 3 s of compute).
- On slow mobile data the user's uplink dominates: a 1.8 MB clip (10 min at 24 kbps) takes about 14 s at 1 Mbps uplink (arithmetic). Routing through the Render proxy adds a second upload leg (Render to provider) and the 15 to 60 s free-instance wake (14.4 s seen here); a Cloudflare Worker has no wake delay.
- Render free (0.1 CPU) scaled from the dev Mac's 2-core numbers would run base.en at well under 1x real time (roughly 0.3x, a rough linear estimate), and 512 MB RAM cannot hold small.en (488 MB model) plus Node. Render Standard (1 CPU, 2 GB) might reach roughly 3x for base.en and about 1x for small.en; large-v3-turbo int8 on one CPU would be slower than real time. These are scaled estimates, not measurements.
- Modal's $30 monthly credit or a ZeroGPU Space can run large-v3-turbo on a GPU for free, but both add cold starts and queueing and a ZeroGPU Space's daily quota is per caller and undocumented in minutes here; they suit a backup path more than the main one.

### Gaps
- No real transcription was timed end to end, because no API keys were used; numbers are handshake and first-byte only.
- Exact ZeroGPU daily quota in seconds for free users and Modal cold-start times for a Whisper container were not found.
- Which Render region the existing proxy runs in is not visible from outside or in `render.yaml`.
