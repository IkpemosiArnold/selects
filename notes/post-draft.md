---
title: Can Gemma on a 2017 laptop pick clips as well as people do? I measured it on 6 videos
published: false
tags: devchallenge, hf26challenge, ai, opensource
---

*This is a submission for the [Hacktoberfest 2026 Open Source AI Challenge: Side Hustle](https://dev.to/challenges/hf26).*

On the night of 15 October, my 2017 MacBook Pro sat on its 67 W charger and still lost battery, from 18% down to 8%, while Gemma 3 4B read a passage of about 330 words at 0.87 tokens a second. It took 1,437 seconds, nearly 24 minutes, to choose one clip from that passage. It returned valid JSON with real timestamps, and it chose the speaker's introduction, which the prompt had told it to skip.

The test was the first step of an experiment, and the reason for the experiment was a number. In the week of 9 September, one of the top posts on r/naijaremote was a video clipping gig that paid $0.40 for every 1,000 views. At that rate a clip needs 100,000 views to earn $40. Opus Clip's Starter plan costs $15 a month on its [pricing page](https://www.opus.pro/pricing), so a clipper on that gig would need 37,500 views before the tool paid for itself.

So I built a clipper with no monthly bill that runs on the laptop I already have, and then I asked it a harder question. Can a free open model on a 2017 laptop pick clips as well as people do? I measured it.

## What I Built

Selects takes a long video, finds the moments that would work as short clips, and renders the ones you approve as captioned 9:16 videos with a title, a caption and a credit line ready to post. Everything runs on your own computer: whisper.cpp writes the transcript, Gemma 3 4B judges the candidate clips through Ollama, and ffmpeg cuts them. Nothing is uploaded, and nothing is rendered until you approve it.

The name comes from film editing, where "selects" are the best moments an editor pulls from raw footage.

[SCREENSHOT: notes/screens/real-review-07m4-ranking.png. Caption: "The review screen. The blue curve is the model's interest across the talk, and each numbered bracket is a proposed clip. The panel shows why clip 2 earned its place."]

Each proposed clip shows its four rubric scores and a one-line reason from the model. On the clip above, Gemma wrote: "The initial 'dangerous' claim is intriguing, but the vague 'data' needs more grounding." Opus Clip gives each clip a single virality score. I wanted a clipper to be able to read why a clip was picked and disagree with it.

### Who would pay, and the problem

Selects is free and MIT licensed, so the useful version of "who would pay" is who pays for this work today, and what Selects saves them.

| Who | How they are paid | What they pay for tools today |
|---|---|---|
| Per-view clippers on brand campaigns (for example Whop Content Rewards) | per 1,000 views; guides quote $0.20 to $6, and the r/naijaremote gig paid $0.40 | Opus Clip $15 or $29 a month; Klap $14 to $94 a month billed yearly (pricing pages, checked 15 Oct) |
| Me | I cut 9:16 shorts of my own video series | [ARNOLD: how long one short takes you to cut by hand, start to finish] |

Editors who cut shorts for podcasters and event media teams use the same subscriptions, and they upload every long file first. The rates for clipping campaigns come from third-party guides, several of them written by clipper vendors, and they disagree with each other, so I treat them as a range and not a fact.

A per-minute or per-month bill comes out of every clip before it earns anything, and at $0.40 per 1,000 views that bill is large compared with the pay. Hosted tools also need the long video uploaded first. [ARNOLD: one or two sentences from your own experience of mobile data costs or power cuts in Lagos, and what uploading a long video costs you. Only what you have lived.]

## Demo

[PENDING: demo GIF, a long video going in and three captioned clips coming out]

[PENDING: 60 to 90 second demo video link]

Selects runs on your own machine, so there is no hosted demo link.

[SCREENSHOT: notes/screens/real-render-credit.png. Caption: "After rendering. The credit line is added to every caption, and the rights reminder sits above the clips."]

## Code

[PENDING: repo embed, {% github <repo URL> %}]

```sh
git clone [PENDING: repo URL] selects
cd selects && npm install
node bin/selects.mjs doctor
node bin/selects.mjs ~/Movies/talk.mp4 --k 3
```

The README covers the prerequisites (Node 20+, ffmpeg, whisper.cpp and Ollama), including a workaround for Ollama versions that refuse to pull `gemma3`. The licence is MIT.

## How I Built It

The build machine is a 2017 13-inch MacBook Pro with an Intel i5-7360U (2 cores, 4 threads), 16 GB of RAM and no GPU. Selects is Node with one dependency in the core, `@napi-rs/canvas`, which draws the captions. The ffmpeg on this Mac has no libass and no drawtext filter, so Selects draws each caption as an image and lays it over the video. The review page is React and Vite, served from a small local server.

The model is Gemma 3 4B (Q4_K_M). Ollama 0.12.5 refused `ollama pull gemma3:4b` with "requires a newer version of Ollama", so I downloaded the GGUF file from Hugging Face (2.49 GB at 1.95 MB/s, 1,277 seconds) and imported it with `ollama create`. I chose Gemma 3 over Gemma 4 because no Gemma 4 tag in Ollama was under 3.5 GB, and the Gemma 3 4B file is 2.49 GB.

### The model judges short passages instead of reading the whole transcript

My first plan was to hand Gemma the transcript and ask for the best three clips. On a 2,957-word transcript, that call did not finish in 30 minutes. A small model on a CPU is too slow to read a whole talk, but it can score one 100-word passage in about a minute, so Selects splits the work into two stages.

```
video --> whisper.cpp (greedy, a time for every word)
      --> sentences --> windows of whole sentences, 20 to 60 s
      --> STAGE 1, no model: drop windows that open on "as I said" or end mid-thought,
          pre-score the rest from text, pace and loudness, keep the best 8
      --> STAGE 2, Gemma: score each of the 8 on a rubric, as JSON
      --> listwise round: Gemma orders the top 4 side by side
      --> you approve --> ffmpeg renders 9:16 with captions
```

Every window starts and ends on a sentence boundary from whisper's word times, so a clip never cuts a word in half. Gemma never writes timestamps, because the code decides where each clip starts and ends, and the model only scores the windows it is given.

### The rubric

The rubric is the system message, about 140 words. The full text is in `src/core/prompts/judge.md`. It begins:

> You are a senior short-form video editor. Judge one clip cut from a long talk the way a stranger scrolling a feed meets it: no context, two seconds of patience. Score each from 1 to 5. Most clips are a 2 or 3; a 5 is rare.

The four scores are hook (the first sentence), stands alone, payoff (the last sentence) and clarity, weighted 0.35, 0.30, 0.20 and 0.15. Ollama's `format` option forces the answer into a JSON schema. The final score is 70% Gemma's rubric and 30% the stage 1 pre-score, and then a listwise round sends the top 4 windows to Gemma together, as their first and last sentences only, and asks for an order. First place in that round adds 0.15 to a clip's score.

### Measured on the 2017 laptop

The final end-to-end run with the shipped pipeline used a 6-minute excerpt of a CC BY-SA 4.0 talk from Electromagnetic Field 2026. Other work was running on the machine, and the load average was about 35.

| Stage | Wall time | Notes |
|---|---|---|
| Probe and thumbnails | 0.8 s | |
| Transcribe | 129.7 s | 1,232 words |
| Candidates and pre-score | under 0.1 s | 37 windows passed, 8 went to Gemma |
| Gemma: 8 rubric calls and 1 listwise call | 724.4 s | 72.9 s per rubric call on average |
| Render 3 clips at 1080x1920 | 65.1 s, 23.4 s, 37.7 s | |
| Posting kits, one Gemma call each | 169.8 s, 43.3 s, 98.9 s | title, caption, hashtags |
| Whole run | 21.6 min | from the video file to 3 captioned, credited clips |

Load moves these numbers a lot. On an earlier run, at a load average of about 250, the same 6 minutes of audio took 7.0 minutes to transcribe, and Gemma's first call read its prompt at 0.76 tokens a second. On a quieter machine, the same kind of prompt read at up to 28 tokens a second.

An identical prompt sent twice in a row took as long the second time, so on this Ollama build the rubric is read again on every call. A short rubric saves time on every clip.

### Failure: Gemma's JSON was cut off, and then it looped on a curly quote

The first full run stopped on the third clip with invalid JSON. My prompt asked for the reason first and the scores after it. Gemma wrote a long reason, ignored the schema's length limit, hit the 80-token output cap, and was cut off in the middle of a string, twice, because the retry did the same thing.

The fix was to put the four scores before the reason in the schema, so a cut-off answer still has its scores, and to trim a cut-off reason back to whole words. A later call was cut off the same way, and Selects kept its scores.

A test run later in the night broke in a new way. Gemma closed the reason with a curly quote (`”`) instead of a straight one, and then repeated "11 words. 11 words." until it ran out of tokens. The salvage code now cuts the reason at that quote.

### Failure: a CC BY-NC-ND chart inside a CC BY-SA talk

I only used Creative Commons talks that allow adaptations, because a clip is an adaptation. The test talk is CC BY-SA 4.0, so I added `--credit`, `--license` and `--source-url` flags, and Selects writes a full attribution line into every caption.

Then I checked frames from the rendered clips. The first clip shows a slide with a figure from a 2020 paper in Experimental Gerontology, and the slide itself marks that figure as CC BY-NC-ND 4.0. The talk's licence does not cover that figure, and a clip that shows it is an adaptation of a no-derivatives work, so it should not be posted as it is. Another clip shows a figure marked CC BY 4.0, which is fine with credit.

A licence flag can't catch a figure on a slide, so Selects now prints a reminder after every render and puts it in every posting kit: "Check slides and on-screen media: a talk's licence may not cover every figure." The clip with the NC-ND figure stays out of my demo.

### Failure: every hook scored 3

In the first full run, all three picks scored 3 for hook and 3 for stands alone, and two of them tied at 0.675, so the ranking came down to tie-breaks. In the final run, all 8 shortlisted windows scored 3 for hook. The hook has the highest weight in the rubric, and on this talk it separated nothing.

Blending in the stage 1 pre-score (70% Gemma, 30% pre-score) gave 8 different totals out of 8. The listwise round then spread them a little further, from a standard deviation of 0.079 to 0.104. Side by side, Gemma put a clip it had ranked fourth on its own scores into first place, with the reason "Direct, relatable motivation; clear risk statement, immediate scroll stop." It also moved a clip it had scored high down to last: "Generic statement, lacks a strong hook or payoff."

The listwise order depends on which clips share the round. With a different set of four, the same clip that came last above came first. Comparing clips side by side spreads the scores, but whether it agrees with people more is a question for the eval.

### Failure: adding examples to the rubric made the scores bunch up

The obvious fix for flat scores was a richer rubric, so one variant described all five levels of each score, each with a short example. On the same 8 windows, the scores bunched higher instead of spreading out. The standard deviation of the totals fell from 0.093 to 0.077, only 3 of the 8 totals were different, most windows moved to 4 for stands alone and 5 for payoff and clarity, and the hook stayed at 3 for all 8.

Worse, one of the rubric's examples, "I slept four hours a night for a year", turned up in a reason as if the speaker had said it. The longer rubric also cost 220 words instead of 140 on every call. I dropped it. Small models copy examples, so the shipped rubric anchors only levels 1, 3 and 5, in words, with no example sentences.

### The eval: 6 videos, measured against Most Replayed

To answer the headline question, I needed moments that people chose. The eval uses 6 videos marked Creative Commons Attribution on YouTube: three interviews, a lecture, a conference talk and a commencement speech. The labels come from YouTube's Most Replayed heatmap, turned into up to 5 peaks per video. Most Replayed shows where viewers rewatch, which is not the same as where a good short is, so I treat it as a proxy. [ARNOLD: label the 6 videos blind with `node eval/label.mjs` so the eval also has human picks.] Every method picks its top 5 from the same windows, and a pick is a hit when it overlaps a peak by 50% or more (intersection over union).

| Method | Videos | hit@3 (95% CI) | Mean best overlap (95% CI) |
|---|---|---|---|
| Random over all windows (mean of 200 seeds) | 6 | 26% (22% to 31%) | 0.13 (0.12 to 0.15) |
| Loudness and speech rate, no model | 6 | 17% (0% to 50%) | 0.11 (0.03 to 0.21) |
| Stage 1 alone, no model | 6 | 33% (0% to 67%) | 0.09 (0.02 to 0.19) |
| Stage 1 + qwen2.5:0.5b | 5 | 40% (0% to 80%) | 0.12 (0.03 to 0.22) |
| Stage 1 + Gemma 3 4B | [PENDING] | [PENDING] | [PENDING] |
| Best possible from the 8-window shortlist | 6 | 67% (33% to 100%) | 0.17 (0.08 to 0.27) |
| Best possible from all windows | 6 | 100% | 0.76 (0.71 to 0.81) |

[PENDING: final eval numbers, the Gemma row, and the human-label results.]

With 6 videos, every interval overlaps, so no method is clearly better than random yet. [PENDING: one paragraph that answers the headline question from the final numbers, including where Gemma missed.]

### Failure: the shortlist is the bottleneck

The last two rows of the table were the most useful result so far. If you could pick perfectly from every window, you would hit a Most Replayed peak in every video, with an average overlap of 0.76. If you pick perfectly from the 8 windows that stage 1 hands to the model, you hit in only 67% of videos, with an average overlap of 0.17.

So in 2 of the 6 videos, stage 1, the part with no model at all, throws away every window that matches a rewatched moment before Gemma sees anything. Gemma can't pick a window it never reads, so the next version has to fix the shortlist before it tunes the judge, either with a better pre-score or by letting the model read more windows overnight, at about a minute per extra window.

### What it can't do yet

- English only. Selects uses whisper's `base.en` model, so Nigerian Pidgin and Yoruba transcribe badly or not at all. A multilingual whisper model would fix it, at a cost in speed I have not measured.
- Slide talks fall back to "fit". Selects centre-crops only when the motion stays in the middle of the frame. On the test talk, all 3 clips came out as the full frame over a blurred background, with small slide text. There is no face tracking.
- Audio and text only. The model never sees the video, so it can't tell when a moment depends on a slide or a demo.

## Why Does Open Innovation Matter?

With open weights, a clipper paid $0.40 per 1,000 views pays nothing per clip to Selects, because Gemma runs on the laptop. The footage never leaves the machine, which matters for unreleased episodes and for anyone paying for every gigabyte they upload. [ARNOLD: your own data or power experience, if you want it here instead of in What I Built.]

Open weights also make the claims checkable. Every number in this post comes from a model anyone can download, running on a 2017 laptop, and the eval harness, the rubric and the timing notes are in the repo. If you think the rubric is wrong, you can change `src/core/prompts/judge.md` and rerun the eval against the same 6 videos.

The model is also a setting. `--model` or `SELECTS_MODEL` swaps Gemma 3 4B for any model in Ollama, and the eval already compares two. When a better small model comes out, a clipper can test it on their own videos without asking a vendor to change a plan.

## My Agent Session

[PENDING: agent session link]

I built Selects with Claude Code agents, and I directed the work and checked the results. Three agents worked in parallel on the core pipeline, the review page and the eval, and they shared one file, `notes/CONTRACTS.md`, that defined the data model and the API between them. The first commit landed on 15 October at 23:56 Lagos time.

Parallel agents slowed the dual-core laptop down. Their whisper and Ollama jobs ran at the same time, the load average reached about 250, and one timing test was ruined because the load fell from 250 to 28 while it ran. The fix was a shared lock file for heavy jobs, with a 90-second gap between turns so each agent got the CPU in order. The anchored rubric above is the clearest case of a change that looked right, measured worse, and was dropped because of the numbers.

## My First User

[PENDING: first user quote]

[ARNOLD: who the first user is, what they clipped, their words quoted exactly, and their permission to quote them. The ask: "Send me one long video you'd normally clip. I'll run it on my laptop and send back 5 captioned shorts. Which would you post, what was wrong, would you pay, and how much?"]

## Prize Categories

- Gemma: Gemma 3 4B runs locally through Ollama and judges every clip. Selects can't pick clips without it.
- [PENDING: other categories, only if actually used by submission time. Candidates: the agent session category, the .tech domain (selects.tech, not yet checked or claimed), Backboard.]

[PENDING: .tech domain link, if claimed]

I'm a product engineer in Lagos. Selects is open source, and if you clip for a living, I'd like to hear what it gets wrong on your videos.
