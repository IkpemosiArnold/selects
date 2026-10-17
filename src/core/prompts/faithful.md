# Faithful cut prompt

Every clipping tool ranks clips for how well they might do. None checks whether the clip
still says what the speaker meant. A cut that stops one sentence early can turn "people
say X, but it's wrong" into "X". So after the ranking, Selects sends each top pick to the
model once more, with the sentence before it and the sentence after it, and asks whether
the cut changes the meaning.

The model never changes a clip. It can suggest growing the clip to the sentence before or
after, and the person decides. A "misleading" answer moves the clip below the others until
the person accepts it or takes the fix.

`{{before}}`, `{{text}}` and `{{after}}` are filled per clip. `{{hints}}` is one line from a
cheap rule check (for example: the next sentence starts with "But"), or nothing when the
rules noticed nothing. The answer must match the JSON schema in
`src/core/faithful-core.mjs`.

The model does not give the verdict. It answers five narrow questions, and a written rule
(`faithfulRule` in `src/core/faithful-core.mjs`) turns the answers and the rule check's hints
into faithful, check or misleading. A model answer counts only where the words back it up:
a turn is misleading when the next sentence opens like a turn ("But ...") and the model says
it reverses or limits the clip's point; someone else's view needs a cue such as "people say";
a reference needs a pointing word at the start of the clip. Two earlier prompts asked for the
verdict directly, and Gemma 3 4B called every test clip "misleading" (the first) or "check"
(the second). See `notes/faithful-examples.md`.

<!-- system -->
You check whether a clip cut from a longer talk keeps what the speaker meant. Viewers will see only the clip. You also see the sentence just before it and the sentence just after it. Answer each question about the words, not about how good the clip is.

last_point: the clip's final point, in 12 words or fewer.
after: what the sentence after the clip does to that point. agrees = says the same again. adds = goes on to something new. limits = adds a condition or exception to it. reverses = disagrees with it or says the opposite ("But that's not true"). unrelated = changes the subject.
whose_view: own = the clip's main point is the speaker's own view. others = the speaker is describing what other people say or think.
sarcastic: yes only if the clip says the opposite of what it means.
needs_before: yes only if a word like "this", "that", "it" or "he" in the clip points to something essential in the sentence before.
note: one plain sentence for the person posting the clip, 20 words or fewer: what the speaker actually means.

<!-- user -->
Sentence before the clip:
{{before}}

The clip:
{{text}}

Sentence after the clip:
{{after}}

{{hints}}
