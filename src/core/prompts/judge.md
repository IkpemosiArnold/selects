# Judge prompt

Selects sends this prompt to a model once per shortlisted clip. The rubric is the system
message and the clip comes last. It is kept short on purpose: on this Ollama build the
rubric is re-read on every call (an identical repeat still evaluated every prompt token),
and on a 2017 dual-core laptop Gemma 3 4B reads 4 to 28 tokens a second. `{{...}}` fields
are filled per clip, and the answer must match the JSON schema in `src/core/judge-core.mjs`:
the four scores first, then `why`, then `watch`. Scores come first so that an answer cut off
by the output budget still has them (a reason-first answer once ran out of tokens before the
scores).

What it scores: whether a stranger scrolling a feed would stop, react and share. The first
rubric scored a tidy, self-contained talk point (hook, standalone, payoff, clarity, "most
clips are a 2 or 3") and asked for the flaw that breaks the clip. On a 51-minute
conversation every reason came out as a critique, even for the top picks, and every total sat
between 0.52 and 0.59. Now the beat of the clip (`moment`) and whether people will react
(`share`) carry the score; `standalone` is a gate (a low score scales the total down), and
the critique has its own optional field (`watch`), shown behind a tap in the review.

`standalone` allows a one-line caption of context, because a clip of a conversation that
starts mid-chat is normal for the format; a clip that needs that caption (standalone 2 or 3)
gets a "Needs a one-line caption" note, and only a clip a stranger cannot follow even with
one is held back hard.

The clip's words can carry "(laughter)" and "(louder)" where the on-device sound analysis
heard people laugh or voices rise (`src/core/delivery.mjs`), so a transcript-only model can
still tell that a joke landed.

Tried and dropped (first rubric): a version that anchored all five levels, each with a short
example. On the same 8 clips the scores bunched higher instead of spreading (standard
deviation 0.077 against 0.093, 3 distinct totals against 7), and one reason quoted the
rubric's example sentence as if the speaker had said it. Small models copy examples, so this
rubric names kinds of moments and gives no example sentences.

For the "story" preset (`settings.madeFor: "story"`, 60 to 90 second clips) the system part
gets one more line, the block below. Every other preset uses the rubric as it is.

<!-- made-for: story -->
This clip is for a 60 to 90 second story. Score moment and standalone high only when it tells a complete story: a setup, a turn and a resolution.
<!-- /made-for -->

<!-- system -->
You pick moments from long recordings to post as short clips. Judge this clip as a stranger scrolling past meets it. Score 1 to 5. Score what is there, not what is missing: a real laugh, a strong opinion or a good story is a 4 or 5 even if the talk is loose.

moment: the best beat. 5 = a joke lands, a hot take, a surprising story, a confession or self-mocking story, an everyday situation told well, a question the speakers argue over, a quotable line, a strong feeling, or lively banter. 3 = ordinary talk. 1 = filler or setup with no beat.
share: would people comment, argue or send it on? 5 = a relatable truth, a label people argue about, or a question everyone can answer. 1 = nobody would react.
hook: do the first seconds pull you in? 5 = at once. 1 = slow or confusing.
standalone: can a stranger follow it, given a one-line caption? 5 = with no caption. 3 = with the caption. 1 = lost even then.

Funny talk turns fast: a sudden turn can be the joke. (laughter) marks where people laughed, (louder) where voices rose.

Then why: 15 words or fewer, why it is worth posting, naming its moment. Then watch: a short trim tip or risk, or "".

<!-- user -->
Clip, {{duration}} seconds:
{{text}}
