# Faithful cuts: real examples

Every clipping tool ranks clips for how well they might do. Selects also checks whether each top pick still says what the speaker meant. This note shows what the check said on real windows, with the words quoted from Creative Commons sources, and what it took to get there.

Sources (quotes are verbatim from whisper's transcript, so small transcription slips are kept):

- "How I became nearly as strong as the average untrained man", Jenni, EMF 2026, CC BY-SA 4.0 (the 6-minute excerpt in `notes/test-media.md`).
- "Lecture 1, How to Start a Startup", Sam Altman, CC BY 3.0 (eval video `CBYhVcO4WgI`).
- "I'm a Machine: An interview with Fabiano Caruana", GibChess, CC BY 3.0 (eval video `G9NabGlnDCs`).

Model: Gemma 3 4B (Q4_K_M) through Ollama on the 2017 dual-core laptop. Prompt: `src/core/prompts/faithful.md`. Rule: `faithfulRule` in `src/core/faithful-core.mjs`.

## How the check decides

For each top pick, Selects finds the sentence before and the sentence after the clip. A rule check looks at the words: does the next sentence open like a turn ("But ...", "That's not true"), does the clip report others ("people say", "they think"), does it open on a pointing word ("This", "He") with something before it. The model then answers five narrow questions: the clip's last point, what the next sentence does to it (agrees, adds, limits, reverses, unrelated), whose view it is, whether it is sarcastic, and whether it needs the sentence before. A written rule combines the two, and a model answer only counts where the words back it up.

The note shown to the person quotes the words outside the clip, so they can judge for themselves. Nothing changes on its own: the person can keep the cut or take the suggested fix, which grows the clip to the nearby sentence boundary. A misleading cut moves below the others until they decide.

## Examples

### Misleading: the clip stops just before the turn

Sam Altman, How to Start a Startup, 3:59 to 4:26. The clip:

> You're just supposed to start, throw stuff at the wall, see what sticks, and not even spend any time thinking about if it'll be valuable if it works. And pivots are supposed to be great, the more pivots the better. So this isn't totally wrong. Things do evolve in ways that are difficult to predict, and there's a limit to how much you can figure out without actually getting a product in a hands of users. And great execution is at least 10 times more important and 100 times harder than a good idea.

The next sentence:

> But the pendulum has swung way out of whack here.

On its own, the clip sounds like advice to skip thinking about the idea. The lecture says the opposite: the idea matters more than founders now think. The rule check saw "But the pendulum"; the model said the next sentence limits the clip's point. Verdict: **misleading** (turn). Note: Right after the clip, the speaker says "But the pendulum has swung way out of whack here." Suggested fix: end at 4:28 instead of 4:26.

### Misleading: the clip ends on what other people think

Jenni, EMF 2026, 0:23 to 1:21. The clip ends:

> Another thing that sometimes people say when I kind of try to advocate for weight training is that they think they're too old to start.

The next sentence:

> And that's definitely not true. There is actually quite good data to support this.

A viewer hears "you can be too old to start" as the last word of the clip. The rule check saw both "people say" and a turn ("And that's definitely"). Verdict: **misleading** (quote). Note: The clip ends on what others think ("people say"), and the speaker answers it next: "And that's definitely not true. There is actually quite good data to support this." Suggested fix: end at 1:24 instead of 1:21. The model's own summary of the last point was off ("Weightlifting is a relatively low risk activity", from the middle of the clip), which is why the rule leans on the words and not on the summary.

### Check: a claim the next sentence softens

Jenni, EMF 2026, 0:23 to 0:46 (one of the three clips the shipped pipeline picked from this talk). The clip ends:

> And I don't think that's actually that well supported by the data. So obviously all sport has some risk of injury and weightlifting is no exception.

The next sentence:

> But when you kind of look at sort of the data that is available and admittedly the quality of the data is not brilliant, it doesn't look as if weight training comes out as being particularly dangerous.

The clip already says the fear is not well supported, so it does not reverse her point, but it ends on "weightlifting is no exception". Verdict: **check** (turn). Note: Right after the clip, the speaker says "But when you kind of look at sort of the data that is available and admittedly the quality ..." Suggested fix: end at 0:56 instead of 0:46.

### Check: someone else's view, no turn right after

Sam Altman, How to Start a Startup, 7:37 to 8:33. The clip ends:

> The 13th search engine, and without all the features of a web portal, most people thought that was pointless. Search was done, and anyway, it didn't matter that much. Portals were where the value was at.

Verdict: **check** (quote). Note: The speaker may be describing what others think ("people thought"), not their own view. Suggested fix: end at 8:42, after the next example. A person would probably call this one misleading, since "Portals were where the value was at" is said with irony; the next sentence moves on to another example instead of answering it, so the rule does not go further than "check".

### Faithful

Jenni, EMF 2026, 2:33 to 3:14 (the top pick of the shipped run), which ends:

> And unsurprisingly, over that time, when they then started their retraining at week 24, they had lost a lot of strength, but they weren't going back to where they'd started.

The next sentence ("They'd actually still maintained some of the strength gain ...") says the same thing again. Verdict: **faithful**. The model's note: "Strength training provides sustained results, unlike cardio which quickly reverses gains."

Jenni, EMF 2026, 3:44 to 4:25 (the third pick), about the idea that women's bodies should be small and weak being one to challenge, is also **faithful**.

## What it took: three prompts

The same EMF picks, three prompts:

| Prompt | What it asked | 2:33 pick | 0:23 pick | 3:44 pick |
|---|---|---|---|---|
| 1 | issue, then verdict, directly | misleading (quote) | misleading (turn) | misleading (turn) |
| 2 | two summaries (what the clip says, what the speaker means), then the verdict | timed out | check (turn) | check (reference) |
| 3 (shipped) | five narrow questions; a written rule decides | faithful | check (turn) | faithful |

Prompt 1 called all three picks misleading, with notes that did not hold up ("The speaker was discussing the importance of independence, specifically using the toilet"). Prompt 2 called every window it answered "check" (6 of 6; the seventh timed out). Asked for a verdict, a 4B model hedges or alarms; asked narrow questions, its answers still lean one way ("others" for whose view in 6 of 6 windows, "needs the sentence before" in 4 of 6), so the rule only counts those answers when the words carry a matching cue. On the 6 windows above, the shipped rule gives 2 faithful, 2 check and 2 misleading, which matches a careful reading of them, except the portal clip, which a reader would probably call misleading.

This is 6 windows from 3 videos, not a benchmark. The point for the post is the design: the model answers narrow questions, a short written rule decides, the note quotes the evidence, and the person makes the call.

## Cost

One model call per top pick (about 470 to 620 prompt tokens and 75 output tokens). On the 2017 laptop: the EMF talk's 3 picks took 629 s (210 s a call) while other builders' jobs kept the load average between 200 and 500; calls made at quieter moments took 86 to 126 s. With the default 5 picks, expect 5 to 10 extra minutes per video on this machine, or `--faithful rules` for the rule check alone (no model, under a millisecond). Answers are cached, so a resumed job does not pay twice.
