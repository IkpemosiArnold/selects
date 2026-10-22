# Local facts: what works for Nigerian users today

Every external service Selects depends on, checked from Lagos with a dated source or a live test from this machine (Airtel, AS36873, IP located in NG). A fact without a date is not a fact here. Re-check before relying on one that is more than a month old.

| Dependency | What was checked | Result | Date | How |
|---|---|---|---|---|
| Groq API (`api.groq.com`) | Reachable from Nigeria, no geo-block | 401 "Invalid API Key" without a key; served through Cloudflare's Lagos edge (`cf-ray ...-LOS`), 0.44 s to first byte | 22 Oct 2026 | curl from this machine |
| Groq API from a web page | Browser calls allowed (for the own-key option) | Preflight 204, `access-control-allow-origin: *`, `authorization` header allowed | 22 Oct 2026 | curl preflight with `Origin: https://selects.ikpemosi.work` |
| Groq free tier | Needs no card; refuses at its limit | No card for the free tier (Groq community answer); 429 at the limit; terms list US export and OFAC restrictions only, Nigeria not restricted. Whether signup asks for a phone number is not documented | 22 Oct 2026 | [rate limits](https://console.groq.com/docs/rate-limits), [services agreement](https://console.groq.com/docs/legal/services-agreement), [community](https://community.groq.com/t/is-there-a-free-tier-and-what-are-its-limits/790) |
| Cloudflare Workers AI | Reachable, free plan fails closed | 401 through the Lagos edge; free plan 10,000 neurons a day, errors beyond it | 22 Oct 2026 | curl; [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Hugging Face CDN (model downloads) | Reachable; Range requests work (the Safari speed probe) | 1 MB range request answered from `us.aws.cdn.hf.co` | 22 Oct 2026 | WebKit timing run through a 1 Mbps throttle |
| Hugging Face Inference Providers | Free use | No monthly credits for free accounts | 22 Oct 2026 | [pricing](https://huggingface.co/docs/inference-providers/pricing) |
| DeepInfra, fal | Anonymous use | 401 without a key | 22 Oct 2026 | curl |
| Fireworks audio | Endpoint up | 503 "no healthy upstream" | 22 Oct 2026 | curl |
| Render free web service | Resources | 0.1 CPU, 512 MB, sleeps after 15 minutes idle, about a minute to wake, 750 hours a month | 22 Oct 2026 | [compute plans](https://render.com/docs/compute-plans), [free](https://render.com/docs/free) |
| Google Gemini API (Smart and Light judging) | Free Gemma answering from the proxy | Answered, but slowly on 22 Oct: 64 to 220 s for a full judging round of 8 clips, with some 500s and timeouts | 22 Oct 2026 | local proxy with the project key, timing runs in `notes/timings.md` |
| WebKit (Safari 26 engine) | WebCodecs Opus encoding; COEP `credentialless` | `AudioEncoder` encodes Opus at 16 kHz; `credentialless` is not supported, so the page is not cross-origin isolated in Safari (WebKit bug 230550) | 22 Oct 2026 | Playwright WebKit build for macOS 13 on this machine; [bug 230550](https://bugs.webkit.org/show_bug.cgi?id=230550) |
| Chrome (desktop 155) | WebCodecs Opus encoding; AAC encoding | Opus at 16 kHz works; AAC encoding failed ("Encoding error") in this build | 22 Oct 2026 | Playwright with the installed Chrome |
