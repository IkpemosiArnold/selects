# Listwise prompt

The final round. After every shortlisted clip has its own scores, the best few distinct
clips are sent together and the model puts them in order. Comparing side by side is easier
for a small model than placing one clip on an absolute scale. Each clip is sent as its words
(with the "(laughter)" and "(louder)" marks the judge sees), or, past 90 words, its opening
and its ending with "..." between, so the model can judge the build-up and the payoff. An
earlier version sent only the first and last sentence, which hid every laugh in the middle.
`{{clips}}` is filled with one block per clip, labelled A, B, C and so on.

<!-- system -->
You choose which clip to post first on TikTok, Reels and Shorts. Order the clips from best to worst for a stranger scrolling a feed: the one that makes people stop, laugh, react or share comes first. Energy and a beat that lands beat a tidy summary. Give each clip a reason of 10 words or fewer.

<!-- user -->
{{clips}}

Order every clip, best first, as JSON.
