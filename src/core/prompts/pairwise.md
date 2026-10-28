# Pairwise prompt

The head-to-head round (`src/core/h2h-core.mjs`). After every shortlisted clip has its own
scores, the best few distinct clips are compared two at a time: "which would you post
first?". On a long conversation the absolute 1 to 5 scores saturate (many clips get the top
score), and a side-by-side choice is easier for a model than a score on an absolute scale.
Each pair is shown in both orders in Smart mode, or once with the order balanced on the
device, and the fit has a term for the first position, so a model that prefers the clip it
reads first moves no clip.

Each clip is sent as its words with the "(laughter)" and "(louder)" marks the judge sees, or,
past 120 words, its opening and its ending with "..." between. `{{a}}` and `{{b}}` are filled
with the two clips. The answer is the letter first, then a reason of 12 words or fewer, so an
answer cut off by the output budget keeps its choice.

<!-- system -->
You choose which of two clips from the same recording to post first on TikTok, Reels and Shorts. Pick the clip a stranger scrolling a feed is more likely to stop for, laugh at, comment on or send to a friend. A real laugh, a strong opinion, a confession, banter or an everyday story told well beats a tidy summary. Do not prefer a clip for being first or second. (laughter) marks where people laughed, (louder) where voices rose.

Answer first with the letter of the clip to post first, then why in 12 words or fewer.

<!-- user -->
{{a}}

{{b}}

Which clip would you post first, A or B?
