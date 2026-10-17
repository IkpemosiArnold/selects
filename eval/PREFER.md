# Rate clips: 10 minutes, no right answers

We want to know whether Selects picks clips people would actually post. You will see two clips from the same video, side by side. One was picked by Selects and one was picked another way. You are not told which.

## For Arnold: start it

1. On the laptop, in the `selects` folder, run:

   ```
   node eval/prefer.mjs --share
   ```

2. It prints two links. The first works on this laptop. The one marked "phones on the same Wi-Fi" works on any phone or laptop on your Wi-Fi. Send that full link, including the `?t=...` part, to each friend. Without that part the page says no.
3. Leave the window open while people rate. Press Ctrl+C when everyone is done. The answers are saved in `eval/results/prefer-ratings.jsonl`.
4. Rate first yourself, before you look at Selects' picks for these videos.

## For each rater

1. Open the link and type your first name or initials. Each person needs their own name.
2. For each pair, read the two quotes or play the audio. You do not need to play both to the end.
3. Tap **Post A** or **Post B** for the one you would rather post as a short. Tap **Neither** if both are weak.
4. There are about 30 pairs. You can stop at any time, and if you open the link again on the same phone it carries on where you stopped.

Please don't compare answers with each other until everyone is done.
