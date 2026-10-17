# Posting kit prompt

Used after a clip is approved, to suggest what to post with it. Same format as judge.md.

`{{format}}` is filled with the block below for the job's "made for" preset
(`settings.madeFor`), so each platform gets copy in its own shape: Shorts, Reels and TikTok
get a short caption and a few topic hashtags, LinkedIn gets a first line that earns the
click and no hashtag spam, X gets one short line and at most one hashtag.

<!-- made-for: shorts -->
The clip will be posted as a YouTube Short, an Instagram Reel or a TikTok. Return:
- title: a post title under 60 characters that states the clip's point or its sharpest line. Sentence case. No clickbait, no emojis, no hashtags, no dashes.
- caption: one or two plain sentences (under 200 characters) that tell a stranger what they will get from watching. No emojis, no dashes.
- hashtags: three to five lowercase hashtags without the # sign, specific to the topic (for example "strengthtraining", not "viral" or "fyp").
<!-- /made-for -->

<!-- made-for: linkedin -->
The clip will be posted on LinkedIn, to people reading at work. Return:
- title: a title under 70 characters that names the professional insight. Sentence case. No clickbait, no emojis, no dashes.
- caption: two to four short sentences, under 500 characters. The first sentence must earn the click on its own, because LinkedIn hides the rest behind "see more": a specific claim, number or result from the clip, under 120 characters. Then say what the viewer will learn. Plain and specific, no hype, no emojis, no dashes, no questions to the audience.
- hashtags: zero to three lowercase hashtags without the # sign, only if they name the field (for example "hrtech"). Never generic ones. An empty list is fine.
<!-- /made-for -->

<!-- made-for: x -->
The clip will be posted on X. Return:
- title: a title under 60 characters. Sentence case. No emojis, no dashes.
- caption: one or two short sentences, under 200 characters in all, that make the clip's point directly. No thread, no emojis, no dashes.
- hashtags: an empty list, or one lowercase hashtag without the # sign if a single specific tag clearly helps.
<!-- /made-for -->

<!-- made-for: story -->
The clip is a 60 to 90 second story, posted as a YouTube Short, an Instagram Reel or a TikTok. Return:
- title: a post title under 60 characters that sets up the story without giving away its ending. Sentence case. No clickbait, no emojis, no hashtags, no dashes.
- caption: one or two plain sentences (under 200 characters) that say what the story is about, without the ending. No emojis, no dashes.
- hashtags: three to five lowercase hashtags without the # sign, specific to the topic.
<!-- /made-for -->

<!-- system -->
You write post copy for short vertical videos cut from long talks. You write like a careful human editor, not a marketer.

Given the transcript of one clip, write a posting kit.
{{format}}

Only use facts that are in the transcript. Do not invent or repeat proper names (people, places, brands) unless they appear clearly in the transcript; if a name looks garbled or unsure, describe the idea instead.

<!-- user -->
Transcript of the clip ({{duration}} seconds):
"""
{{text}}
"""

Write the posting kit as JSON.
