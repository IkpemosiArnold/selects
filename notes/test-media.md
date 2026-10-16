# Test media

Used for the core end-to-end run. The file lives in `.selects/media/` (gitignored), never in the repo.

| Field | Value |
|---|---|
| Talk | How I became (nearly) as strong as the average untrained man |
| Speaker | Jenni |
| Event | Electromagnetic Field 2026 (EMF 2026), 19 Jul 2026 |
| Page | https://media.ccc.de/v/emf2026-160-1-how-i-became-nearly-as-strong-as-the-average-untrained-man |
| File | https://cdn.media.ccc.de/events/emf/2026/h264-sd/emf2026-16001-eng-How_I_became_nearly_as_strong_as_the_average_untrained_man_sd.mp4 |
| Local path | `.selects/media/strength-talk.mp4` (55 MB) |
| Format | H.264 720x576, sample aspect 64:45 (displays as 16:9), 25 fps, AAC; the file carries two video streams; 1677.7 s (27:58) |
| Licence | CC BY-SA 4.0. The talk page says "Licensed to the public under https://creativecommons.org/licenses/by-sa/4.0/" (checked 16 Oct 2026). |

**Excerpt used for the end-to-end run:** `.selects/media/strength-talk-6min.mp4`, cut with `ffmpeg -ss 180 -t 360 -i strength-talk.mp4 -map 0:v:0 -map 0:a:0 -c copy` (03:00 to 09:00 of the talk, 360.2 s), because the full 28 minutes would take hours on this machine under load. Timecodes in `selects-out/strength-talk-6min/clips.md` are relative to the excerpt: add 3:00 for the talk's own time.

Clips made from it are derivative works, so they must credit the speaker and EMF 2026 and be shared under CC BY-SA 4.0.

## Rights caveat found in the rendered clips

The talk is CC BY-SA 4.0, but some slides show third-party figures with their own licences. One frame in clip 1 (source 02:33 to 03:14) shows a figure from Blocquiaux et al., Experimental Gerontology 2020, which the slide marks as CC BY-NC-ND 4.0. A clip that shows that slide is a derivative of an ND work, so it should not be posted as is. Clip 2 shows a figure from Tøien et al. 2025 marked CC BY 4.0, which is fine with attribution. Check slide content, not only the talk's licence, before posting.
