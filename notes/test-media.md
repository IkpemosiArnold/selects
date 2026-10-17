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

## Long test videos (1 hour and 2 hours)

Built on 17 Oct 2026 for the long-video tests (`notes/timings.md`, "Long videos"). Each is several different EMF 2026 talks joined end to end, all CC BY-SA 4.0. Every talk page was checked on 17 Oct 2026 and says "Licensed to the public under https://creativecommons.org/licenses/by-sa/4.0/". Files live in `.selects/media/` (gitignored), never in the repo.

| Order | Talk | Speaker | Page | Length |
|---|---|---|---|---|
| 1 | How I became (nearly) as strong as the average untrained man | Jenni | https://media.ccc.de/v/emf2026-160-1-how-i-became-nearly-as-strong-as-the-average-untrained-man | 27:58 |
| 2 | Narrative Animals And How To Tell Better Stories | Lauren Beukes | https://media.ccc.de/v/emf2026-200-1-narrative-animals-and-how-to-tell-better-stories | 36:11 |
| 3 | How To Debug A Human: An Engineer's Guide To Emergency Medicine | Caitlin P-F | https://media.ccc.de/v/emf2026-77-1-how-to-debug-a-human | 28:03 |
| 4 | Mountains, Rescues, and Risks | Andrew Godwin | https://media.ccc.de/v/emf2026-211-1-mountains-rescues-and-risks | 29:44 |

- `.selects/media/long-1h.mp4`: talks 1 and 2, 3,848.7 s (1:04:09), 114 MB.
- `.selects/media/long-2h.mp4`: talks 1 to 4, 7,315.8 s (2:01:56), 234 MB.

All four SD files (`h264-sd` on cdn.media.ccc.de) have the same format: H.264 High 720x576, sample aspect 64:45 (16:9 on screen), 25 fps, AAC LC 48 kHz stereo. So they were joined without re-encoding: each talk's first video and audio stream was copied to MPEG-TS (`-map 0:v:0 -map 0:a:0 -c copy -bsf:v h264_mp4toannexb`, which puts the stream headers in band), the TS files were joined with ffmpeg's `concat:` protocol, and the result was written back to MP4 (`-c copy -bsf:a aac_adtstoasc -movflags +faststart`). Eight seconds around each join decode with no errors (`ffmpeg -xerror`). The intermediates were deleted; the media folder is 404 MB in all.

Clips cut from these files are derivative works of the talk they come from: credit that talk's speaker and EMF 2026, and share under CC BY-SA 4.0. Talk boundaries in the joined files: 1,677.7 s, 3,848.7 s and 5,531.9 s. The slide-content caveat above applies to every talk.
