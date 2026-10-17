# UX review, Fri 16 Oct

This review covers every screen of the Selects web app at 1440 x 900 (laptop), 390 x 844 (a recent phone) and 360 x 780 (a small Android phone). The screenshots were taken with headless Chrome against the real server (`node bin/selects.mjs serve`), with touch emulation on for the phone sizes. The reader we are designing for is a clipper or a small creator who has a long video and wants a few short, captioned clips they can post. They may be on an old laptop, or on a phone between other jobs.

The short verdict is that the desktop review screen is strong and specific, and the phone version is a squeezed copy of it. Home asks for eleven decisions before the first useful action. Several labels are the builder's vocabulary ("judge model", "rubric", "real time", "whisper"), so a first-time user cannot say what the app does in five seconds.

## What already works

- The identity is specific to the subject. The film leader on home, the clapperboard slate, the 9:16 card with the burned-in caption and the light table / editing bay themes all come from editing, and none of it reads as a template.
- The reel shows the clip the way it will be posted, with the same captions the render burns in. That answers the main question ("is this clip worth posting?") without the user imagining anything.
- The clap and throw is one memorable motion, and it is tied to the one action that matters (approve).
- The data is honest. Times are measured on the laptop or marked as not measured, and the credit line and licence reminder are on the render screen.

## Problems, worst first

| # | Screen | Problem | Why it hurts | Fix |
|---|---|---|---|---|
| 1 | Home, phone | The page is 1196 px wide on a 390 px screen. "Find clips" is cut off at the right edge and the language picker is off screen. | The one action on the page cannot be pressed without scrolling sideways. | Give the page grid a `minmax(0, 1fr)` column, and rebuild home around one action. |
| 2 | Home, all sizes | The first screen shows a drop zone, a path field, two submit buttons, a mode switch, a language picker, four number inputs inside a sentence, three credit fields and a model slider with three measurements. | A first-time user has to read everything to find out which part is required. Only the video is required. | One action, "Choose a video". Clip settings and the credit fold away behind one-line summaries, on desktop too. |
| 3 | Reel, top bar | The pile says "0 approved" while the button already says "Render 1 clip", for the half second the approved card is in the air. | Two numbers on the same bar disagree, which makes the count look broken. | One count, used by both. The pile thumbnail can still land late, but the number changes once. |
| 4 | Reel, phone | The card is pushed left with 40 px of dead space on the right for the peeking card, and it ends above the fold. The slate, the reason and the scores are below the decision buttons and the trim tools, about 900 px down. | On a phone the person sees the video and two buttons, and never sees why Gemma picked the clip. Swiping works, but nothing on screen says you can swipe. | Full-height card, a bottom sheet that holds the slate and the reason (its top edge is the clap stick), Skip and Approve in thumb reach, and visible swipe hints. |
| 5 | Language question, phone | The order is wrong. "No" comes first, then "Decide later", then "Yes", then the question itself at the bottom of the page. | The person answers a question they have not read yet, and the likely answer (Yes) is the third control. | Question, then the ten-second card, then Yes and No side by side, then the evidence folded under "Why Selects is asking". |
| 6 | Render, phone | The first clip starts about 560 px down, under a long credit paragraph. Each clip shows a 160-character file path. There is no way to share or save a clip from the phone. | The finished clips are the reason the person came, and they are the hardest thing to reach. On a phone a file path is useless. | Clips first. "Share" (system share sheet with the video file and the caption) and "Save video" on every clip. The credit and the licence reminder follow the clips. |
| 7 | All screens | Builder words: "judge model", "rubric", "transcript quality", "2.78x real time", "whisper heard", "cues", "WebVTT", "re-render", "burn captions", "fine trim". | Each one costs a first-time user a guess. A clipper knows "hook" and "captions"; they do not know "judge" or "real time factor". | Say what the person gets: "Gemma's pick", "why Gemma picked it", "how sure", "about 4 minutes for a 10-minute video". Keep "whisper" and the model names only where someone is choosing a model. |
| 8 | Reel, touch | Hover-only keyboard hints ("A", "S", ",", ".", "[", "]") are hidden on touch, but the "Trim by a sentence" grid still uses 36 px buttons and the tools are 32 px tall. | Under the 44 px minimum for a thumb. Two of them sit next to each other with a 6 px gap. | 44 px minimum on touch, 8 px gaps, and plain labels ("Start one sentence earlier"). |
| 9 | Processing | "Transcribing at 2.78x real time." is the headline. The steps say "Judge with the model". | The person wants to know how long, and whether they can walk away. They get a speed ratio. | Headline says what is happening in plain words. The sub line says how long and that they can close the tab. |
| 10 | Captions, phone | The keyboard shortcut bar is hidden on phone, but the editor still relies on Enter, Shift+Enter and Alt+Down to split and move. The video preview takes 38% of the height and the caption list scrolls under it. | Editing a caption on a phone works, but splitting and moving to the next unsure word has no visible control. | Not fixed in this pass (see "Not done"). The shortcut bar now hides, and the render button stays reachable. |

## Screen by screen

### Home

- Five-second test: "Drop a long video here, or choose a file" says how to start, not what the app does. A creator does not learn that it finds clips until the third line of settings.
- Hierarchy: the brightest thing on the page is the white "Find clips" button next to an empty path field. The drop zone button "Choose a file" is a quiet outline. Two primary-looking buttons compete ("Find clips", "Queue for overnight").
- Copy: "The brief", "Judge model", "Faster / Smarter", "Transcription runs at 2.78x real time here", "2.49 GB". Only the last one is a fact a user can act on, and it has no label.
- Phone: horizontal overflow (problem 1). The number inputs inside a sentence wrap badly at 360 px.
- Touch: the number inputs are 36 px tall. The spin buttons are tiny.
- Shelf: good idea (each job as a frame with its approved clips fanned on top). The status lines are useful.

### Reel (review)

- Five-second test on desktop: pass. The video, "Approve" and "Skip" are obvious. On phone: partial. The buttons are clear, the swipe is not, and the reason is out of sight.
- Hierarchy on desktop: good. The slate is the boldest object, the card is the content, the keys are quiet. The rubric pips are small and hard to read in light mode.
- Copy: "Render it later" under Approve is close; "Leave it out" under Skip is good. "Trim by a sentence, Start earlier later" reads as a word list. "Fine trim in the script" uses two editing terms. "3 clips to decide" is fine.
- The count bug (problem 3).
- Thumb reach on phone: the decision buttons sit at about 760 px on a 844 px screen after a scroll, so they move as the page scrolls. They should be pinned.
- The card's "Sound is off. Turn it on" pill is good and honest.

### Trim (lined script)

- Desktop: strong. The line in the margin with handles is a real editing convention, and the yellow marks what the person changed.
- Phone: the script page is 70vh tall under a full card, so the person scrolls the page and the script at once. The help text is three clauses long.
- Copy: "Fine trim, clip 2" and "Drag the ends of the line in the margin, or select words, to move the in and out points. Clips start and end on whole sentences. Double-click a word to fix it." Double-click does not exist on a phone.

### Language question

- Desktop: good. The big question, the card and the Yes key read in the right order.
- Phone: wrong order (problem 5). The masthead note "One question before you review" wraps onto its own line at 360 px.
- Copy: "English won 86% of the vote between the language checks, and they did not all agree" is accurate but abstract. "Watch ten seconds with whisper's captions" names a model the reader does not know.

### Processing

- The slate with Step, Heard, Length, Left is a good use of the identity.
- Copy is model-centred (problem 9). "What whisper has heard so far" could be "What Selects has heard so far".

### Render

- Desktop: the takes layout is good. The file path row is useful on a laptop.
- Phone: problem 6. "Burn captions into the clips" is jargon for most people; "Show captions in the video" says the same thing.

### Captions and blur (caption mode)

- Desktop: dense but clear for a focused task. The keyboard bar is useful.
- Phone: the tabs and the render button work. Problem 10 stands.
- Copy: "Whisper's words, unedited", "cues", "WebVTT". The download buttons are fine for people who know the formats; the labels now say what each file is for.

## Jargon list and replacements

| Was | Now |
|---|---|
| Judge model | Gemma's model |
| the model reads the best 8 moments | Gemma reads the best 8 moments |
| Rubric (Hook, Stands alone, Payoff, Clarity) | How Gemma scored it, out of 5 |
| Transcribing at 2.78x real time | Transcribing, about 5 minutes left |
| What whisper has heard so far | What Selects has heard so far |
| Burn captions into the clips | Show captions in the video |
| Fine trim in the script | Trim by words |
| Trim by a sentence, Start earlier | Start one sentence earlier |
| Re-render 2 clips to apply changes | Render 2 clips again with your changes |
| Whisper's words, unedited | Not edited yet |

## What changed, Sat 17 Oct

- Home has one action, "Choose a video". "Made for" (Shorts, Reels or TikTok, LinkedIn, X, a story) sets the clip lengths, and clip settings and the credit fold behind one-line summaries on every screen size. Started videos that have not finished are listed above the picker.
- On a phone the review clip fills the screen. The slate is a bottom sheet whose top edge is the clap stick, and pulling it up shows why Gemma picked the clip, its scores and the trims. Skip and Approve sit in a bar at the bottom, and they fill as the card is swiped toward them. The first clip leans once toward Approve to show the swipe, and a toast offers Undo after each decision.
- The pile and the Render button use one count, so they agree while a card is in the air.
- A faithful-cut note sits on the card when a cut may change what the speaker meant, with the fix as one button. A video with no strong clips says so once, above the review.
- The render screen puts the clips first, with Share (the phone's share sheet, with the video file and the caption) and Save video on each one.
- The language question reads in order on a phone, and processing says how long is left in words, with "Notify me when it's done".
- Inputs are 16 px on touch, taps do not flash, pull-to-refresh is off, the layout uses dvh and safe-area insets, and keyboard hints are hidden on touch screens.

## Still open

- The caption editor on a phone still needs on-screen controls to split and join lines and to jump to the next unsure word.
- The tablet layout (681 to 1100 px) was checked but not redesigned.
- Sticky hover, safe areas, the software keyboard and the share sheet need a real phone. Headless Chrome with touch emulation cannot show them.
