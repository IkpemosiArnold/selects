# Non-speech and low-quality-audio clipping: signals by content type, and multimodal clipper architectures

Research date: 22 Oct 2026. Every finding carries a source and the date of that source (or "undated, accessed Oct 2026"). VENDOR = the company's own marketing or docs. INDEPENDENT = paper, press, or third-party evidence. UNVERIFIED = I could not confirm against a primary source. Selects context: an open-source, zero-cost, transcript-first clipper (whisper + Gemma). "Free?" notes say whether each approach can be copied without paid infrastructure or proprietary training data.

## 1. Gaming: game-event detection, kill-feed OCR, audio spikes, chat velocity, clip counts

### Takeaway
Gaming clippers fall into two camps. The first reads structured events from the game itself (replay systems, game event APIs, developer SDKs): Medal, Overwolf/Outplayed, NVIDIA Highlights. The second runs computer vision trained per game on the rendered screen (kill feed, HUD), plus audio and chat spikes: Athenascope, Powder, Eklipse. Both depend on per-game work: integrations or labelled training data. Neither carries over free to arbitrary content. Only the generic parts (audio loudness and shout spikes, chat velocity, laughter) are cheap to reproduce.

### Cited Findings
**Medal (game-API / replay route)**
- Medal's Auto Clipping ("Automatic Event Detection") detects in-game triggers such as a victory, goal or ace and saves the clip without a hotkey. Windows only. VENDOR. [Medal support, updated Nov 2025](https://support.medal.tv/support/solutions/articles/48001167701-what-is-automatic-event-detection-auto-clipping-)
- "Most of the Auto Clipping games on Medal use the game's Replay system as a base." Streamer Mode can break detection because it "obfuscates some information that Medal uses to detect the in-game events." Medal therefore reads game state, not pixels. VENDOR. [Medal support, updated Nov 2025](https://support.medal.tv/support/solutions/articles/48001167701)
- The official list has 15 games (Rocket League, League of Legends, GTA V, Dota 2, Roblox, PUBG, CS2, Fortnite, War Thunder, EA Sports FC Online, Rematch, REPO, RuneScape: Dragonwilds, YAPYAP, Valorant). A Medal marketing page claims "100+ supported titles (all Riot-connected games and a growing list of Roblox titles)" plus rare Steam achievements. VENDOR, and the two claims conflict. [Medal support, Nov 2025](https://support.medal.tv/support/solutions/articles/48001167701); [Medal developer email page, undated, accessed Oct 2026](https://medal.tv/developer/all-features-email)
- Game developers can push custom events to Medal through an HTTP request, and Medal saves the clip locally. VENDOR. [Medal Developer API, undated, accessed Oct 2026](https://medal.tv/developer/auto-clipping)
- For unsupported games Medal falls back to "Voice Clips", which it says work in every game. VENDOR. [Medal support, undated, accessed Oct 2026](https://support.medal.tv/en/support/solutions/articles/48001159663)
- A third-party blog says Medal integrates with game APIs across 1,000+ titles. This contradicts Medal's own list of about 15 games. Treat it as UNVERIFIED and likely wrong. [Medal auto-clipping page and secondary blogs, accessed Oct 2026](https://medal.tv/ar/auto-clipping)

**Overwolf / Outplayed (Game Events Provider)**
- An Overwolf staff member described Outplayed as a recording app that detects "events like kills, deaths, etc. in certain games and record[s] them automatically." VENDOR. [Overwolf forum, undated, accessed Oct 2026](https://discuss.overwolf.com/t/more-details-in-dota-2-and-league-of-legends-for-kill-events/306)
- Overwolf's Game Events Provider (GEP) exposes a per-game kill event for each title. PUBG's docs note a known issue: if a teammate knocks an enemy and the local player finishes him, the kill event does not fire. Per-game integrations are brittle in this way. VENDOR. [Overwolf GEP docs: PUBG, undated, accessed Oct 2026](https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/playerunknowns-battlegrounds); [Fortnite](https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/fortnite); [CS2](https://dev.overwolf.com/ow-native/live-game-data-gep/supported-games/counter-strike-2)
- I found no source confirming that Outplayed uses GEP internally. UNVERIFIED (very likely, but not documented).

**NVIDIA Highlights (developer SDK route)**
- Developers define key moments (boss fights, killing sprees) through an SDK, with Unreal Engine 4 and Unity plugins. ShadowPlay then captures video and screenshots, and players review them in a summary. VENDOR. [NVIDIA developer blog, UE4 plugin, undated (2017-2018 era)](https://developer.nvidia.com/blog/implementing-nvidia-highlights-plugin-unreal-engine-4); [NVIDIA Highlights tutorial](https://www.nvidia.com/en-us/geforce/news/shadowplay-highlights-tutorial)
- Announced with the SDK at GDC 2018. Formerly "ShadowPlay Highlights". PUBG was an early adopter. Requires a Maxwell or newer NVIDIA GPU. INDEPENDENT press. [PC Perspective, Mar 2018](https://pcper.com/2018/03/gdc-2018-nvidia-adds-new-ansel-and-highlights-features-to-geforce-experience/); [80.lv, Mar 2018](https://80.lv/articles/nvidia-news-at-gdc-2018/?amp=1)
- I found no 2025-2026 source on whether the SDK is still maintained. Gap.

**Athenascope (per-game screen CV route)**
- Uses computer vision and deep learning on "exactly what you're seeing when you play". No account access or plug-in needed. Tailored to individual games. The article names 2D interface (HUD) cues as useful signals. Launched with Fortnite, Rocket League and PUBG. Founder Chris Kirmse (Xfire). $2.5M seed led by First Round Capital. INDEPENDENT press. [TechCrunch, 8 Feb 2019](https://techcrunch.com/2019/02/08/athenascope-nabs-2-5m-seed-led-by-first-round-to-bring-gamers-ai-edited-highlight-reels)
- A search snippet said Athenascope runs in the cloud because the AI is compute-heavy, but the fetched article text did not confirm this. UNVERIFIED.
- Acquisition: I found no source for an Athenascope acquisition, shutdown, or later status. UNVERIFIED. The "acquired by?" question remains open.
- Kirmse also holds a related patent, "Methods and systems for computer video game streaming, highlight, and replay" (US 9782678). Undated in my results. [USPTO PDF](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9782678)

**Powder (per-game CV + audio + chat)**
- Scans Twitch, YouTube or MP4 recordings for gameplay spikes (victories, assists, kills). Has "over 40 proprietary game-specific models". Also has audio analysis and laughter detection, with a shouting / voice-fluctuation detector planned for mid-December 2023. Its "Community Hype" model (launched Sept 2023) detects chat spikes. Speech-to-text and mood prompts were planned. $22M raised. INDEPENDENT press quoting the company. [TechCrunch, 20 Nov 2023](https://techcrunch.com/2023/11/20/powder-an-ai-clipping-tool-for-gaming-can-detect-when-a-creator-yells-during-a-stream)

**Eklipse (per-game CV, vendor-described)**
- Eklipse says its AI first identifies the game. It then detects kills, clutches, multi-kills and eliminations, plus chat reaction spikes, and it reads "kill feed activity, audio spikes, chat velocity, and engagement cues." It says the model is "trained on kill feed events and discrete action moments" and is weakest on strategy, Just Chatting and IRL streams. VENDOR. [Eklipse blog, undated, accessed Oct 2026](https://blog.eklipse.gg/tools/ai-clip-maker-gaming.html); [Eklipse blog post 42318](https://blog.eklipse.gg/?p=42318)
- Eklipse cites "80-90% usable clip rates" for Valorant, CoD, Apex and Fortnite "based on user feedback". VENDOR, not independently tested. [Eklipse blog, accessed Oct 2026](https://blog.eklipse.gg/featured/eklipse-gg-review.html)
- Eklipse does not say whether it reads the kill feed with OCR or with an icon/object detector. UNVERIFIED.

**Spikes Studio, StreamLadder, Sizzle, Clipbot**
- StreamLadder's "ClipGPT" scans full VODs and auto-detects highlights, about 10 vertical clips per stream. The source is a competitor (Eklipse) comparison page updated July 2026. An older page called StreamLadder "a converter, not an AI clip detector". [Eklipse vs StreamLadder, updated Jul 2026](https://eklipse.gg/compare/eklipse-vs-streamladder/); [StreamLadder alternatives page](https://eklipse.gg/compare/streamladder-alternatives/)
- A competitor page says Spikes Studio targets generic "notable moments" and may miss fast gaming highlights. Competitor claim, UNVERIFIED. [Eklipse vs Spikes Studio, accessed Oct 2026](https://eklipse.gg/compare/eklipse-vs-spikes-studio/)
- Sizzle and Clipbot: no technical sources found. Gap.

**Twitch's own Auto Clips**
- Twitch announced AI Auto Clips (clips auto-made from a previous stream so viewers can catch up) at TwitchCon San Diego, Oct 2025. INDEPENDENT press. [AOL / news syndication, Oct 2025](https://www.aol.com/news/twitch-unveils-next-era-dual-221316637.html); [LOS40, 17 Oct 2025](https://los40.com.mx/2025/10/17/el-futuro-de-twitch-se-transmite-en-formato-dual-e-integra-inteligencia-artificial/)
- A third-party blog dated 2 Jun 2026 says Stream Summaries and Auto Clips went live after "TwitchCon Rotterdam on May 30th". It also says Auto Clips look for "a spike in chat activity or emotional response". Single secondary source. Selection criteria UNVERIFIED (no official Twitch doc found). [StreamChat AI blog, 2 Jun 2026](https://streamchatai.com/blog/twitchs-new-ai-stream-summaries-and-auto-clips-what-they-actually-mean-for-your-channel)
- A vendor post says "Clip That" voice triggers need Auto Clips enabled, English channel language, and Affiliate or Partner status, and that Auto Clips ran as a waitlist/closed beta. VENDOR (competitor), possibly outdated. [Eklipse blog, accessed Oct 2026](https://blog.eklipse.gg/eklipse-news-and-guide/eklipse-tips-tricks/twitch-clip-that-voice-command.html)

### Inferences
- Gaming clippers use three detection routes, ordered by the per-game work each needs. (a) Structured game events (Medal replay files, Overwolf GEP, NVIDIA SDK): accurate, but each game needs an integration, and the user must be running the client while playing. Useless for uploaded VODs. (b) Per-game screen CV (Athenascope, Powder's 40+ models, Eklipse kill-feed models): works on VODs, but needs labelled data for every game and every HUD update. (c) Generic signals (audio and shout spikes, laughter, chat velocity, clip counts): game-agnostic, weakest alone.
- Free?: For Selects, only route (c) can be reproduced at zero cost on any game. A middle option is OCR or template matching on the kill-feed region. Open tools exist for this (Tesseract, PaddleOCR), but the region and keywords must be configured per game, and it breaks with HUD updates. Route (a) is free only for games with public event APIs, and only during live play.
- Medal's fallback from game events to voice clips is itself a small router: use structured events where they exist, and generic signals otherwise.

### Gaps
- Athenascope's fate after 2019 (acquired, pivoted, or shut down): no source found.
- Whether Eklipse or Powder use OCR text reading or icon detectors on the kill feed: not published.
- No independent accuracy benchmark of any gaming clipper.
- Twitch Auto Clips' actual selection signals: no official Twitch documentation found.
- Medal's own "AI clipping" beyond replay-based event detection: no technical source found.

## 2. Sports: crowd noise, commentator excitement, scoreboard OCR, replay/graphics detection, event data feeds

### Takeaway
The published sports systems fuse crowd audio, commentator tone and words, on-screen graphics and OCR, player action recognition, and official data feeds. The best-documented example is IBM's Masters/Wimbledon system (Merler et al.). Crowd cheer was by far the strongest single signal: weight 0.61 in IBM's fusion, and the alignment anchor in Warner Bros. Discovery's AWS pipeline. Crowd energy, whistle bands and loudness are cheap audio features and can be reproduced free. Commercial vendors (WSC, Magnifi, Pixellot) add proprietary per-sport models and paid data feeds.

### Cited Findings
**IBM Research: Merler et al. (Masters golf, then Wimbledon and US Open)**
- arXiv v1 submitted 22 Jul 2017 by Merler, Joshi, Nguyen, Hammer, Kent, Smith and Feris. It fuses player reactions (action recognition: high-fives, fist pumps), crowd cheering, and commentator tone plus word analysis. It outputs start and end frames with player name and hole metadata. It cuts annotation needs by exploiting correlations between modalities. [arXiv 1707.07075, 22 Jul 2017](https://arxiv.org/abs/1707.07075v1); journal version listed on [IBM Research publication page (IEEE TMM; year listed variously, 2019 per brief)](https://researcher.watson.ibm.com/publications/automatic-curation-of-sports-highlights-using-multimodal-excitement-features)
- Crowd cheer: SoundNet conv-5 features on 6-second windows feeding a linear SVM. Trained on 156 positive and 193 negative samples, with 99.4% leave-one-out accuracy, refined by bootstrapping. [arXiv HTML 1707.07075](https://arxiv.org/html/1707.07075)
- Commentator excitement: tone uses a SoundNet + SVM (131/217 samples, 81.3% LOO accuracy). Words: IBM Watson speech-to-text, then a dictionary of 60 excitement words and phrases, each scored 0 to 1. The two are averaged. [arXiv HTML 1707.07075](https://arxiv.org/html/1707.07075)
- Player reaction: a VGG-16 fine-tuned on frames sampled at 1 fps. Hard-negative mining over 3 rounds (2,906 positive / 6,744 negative). 88% test accuracy. Low-threshold audio detectors chose which segments to annotate (cross-modal bootstrapping). [arXiv HTML 1707.07075](https://arxiv.org/html/1707.07075)
- TV graphics: detected by distinctive colours at fixed screen locations. Tesseract OCR reads player name and hole number. Shot boundaries come from colour-histogram differences. [arXiv HTML 1707.07075](https://arxiv.org/html/1707.07075)
- Segmenting: cheer detections seed candidates, and adjacent positive 6 s windows are merged. A candidate is kept only if a player-name graphic appears within 80 s. Start = 5 s before the graphic. End = the first shot boundary within 5 s after the cheer ends. [arXiv HTML 1707.07075](https://arxiv.org/html/1707.07075)
- Fusion: linear, with weights cheer 0.61, commentator audio 0.13, commentator text 0.13, player reaction 0.13. Scores are normalized in 15 s (player) and 20 s (commentator) windows. Weights were tuned on 2016 Masters data. [arXiv HTML 1707.07075](https://arxiv.org/html/1707.07075)
- Results: 92.68% of the top 120 clips were rated legitimate highlights. Against the official 2017 Masters reels: P=0.54 / R=0.40 at k=120, and P=0.35 / R=0.90 at k=500. In later versions, automatic selections agreed with human preference 80% (Wimbledon 2017) and 84.2% (US Open 2017). [arXiv HTML 1707.07075](https://arxiv.org/html/1707.07075); [IBM Research page](https://researcher.watson.ibm.com/publications/automatic-curation-of-sports-highlights-using-multimodal-excitement-features); [CVPR 2017 workshop paper](https://openaccess.thecvf.com/content_cvpr_2017_workshops/w2/papers/Merler_Auto-Curation_and_Personalization_CVPR_2017_paper.pdf)

**Warner Bros. Discovery on AWS (audio-first event alignment)**
- Audio is converted to mel spectrograms. Whistle detection isolates the 3.6-4.1 kHz band, subtracts the average across frequencies, and applies a threshold. Crowd excitement = average intensity of prominent crowd mel bands plus the sample-to-sample change in intensity. No custom ML models; computer vision (Amazon Rekognition) is used only for second-level validation: the wide "Camera 01" angle, player count, and match-clock OCR as a kickoff fallback. Each data-feed marker is snapped to the crowd-excitement peak within a window. Runs about 25x real time (10 s of audio in 0.4 s). 24 of 25 events fell within 1000 ms of the human-logged time. The one miss was a weak shot whose crowd cheer came about 2.6 s later. INDEPENDENT-ish (AWS + customer engineering blog). [AWS M&E Blog, 28 May 2024](https://aws.amazon.com/blogs/media/how-warner-bros-discovery-uses-audio-analysis-to-improve-data-accuracy-and-enrich-the-fan-experience)
- AWS also open-sourced the Media Replay Engine (MRE, Apache-2.0), a plugin framework for live and VOD clipping and replays that exports MP4/HLS and EDL/JSON. Sample plugins are Lambda functions plus ML notebooks. FOX used MRE for 2022 FIFA World Cup recaps. [awslabs/aws-media-replay-engine wiki, accessed Oct 2026](https://github.com/awslabs/aws-media-replay-engine/wiki); [AWS blog: FOX AI highlights, accessed Oct 2026](https://aws.amazon.com/blogs/media/how-fox-teamed-up-with-aws-for-ai-powered-highlights)
- An AWS tennis replay sample uses silence detection to find low-volume gaps, so cuts avoid interrupting announcers, plus Rekognition text detection on the scoreboard. [AWS M&E Blog, tennis replays, accessed Oct 2026](https://aws.amazon.com/blogs/media/stream-tennis-matches-through-aws-elemental-medialive-and-generate-real-time-replays-with-amazon-rekognition/)
- AWS Elemental Inference (newer managed service) identifies "shots, goals, and saves" and emits timing data. FOX prototyped live 9:16 vertical highlights with it. Paid AWS service. [AWS blog: Elemental Inference sample clipping portal, accessed Oct 2026](https://aws.amazon.com/blogs/media/evaluate-your-content-with-aws-elemental-inference-using-the-sample-clipping-portal/); [AWS blog: FOX vertical video, accessed Oct 2026](https://aws.amazon.com/blogs/media/how-aws-built-a-live-ai-powered-vertical-video-capability-for-fox-sports-with-aws-elemental-inference)

**WSC Sports**
- Co-founder Daniel Shichman describes three layers. (1) Computer vision tags on-screen activity. (2) Audio analysis picks up whistles, crowd reaction and commentator tone. (3) Live data and stats feeds. These are fused to decide that an event happened and how much lead-up to include ("if there are three passes leading to a goal, we make sure that is included"). WSC ingests the same broadcast stream fans see, with no special hardware. VENDOR interview. [Sportcal feature, undated, accessed Oct 2026](https://www.sportcal.com/features/wsc-sports-how-ai-has-led-the-highlights-revolution/); [WSC blog: Amos Bercovich, accessed Oct 2026](https://wsc-sports.com/blog/industry-insights/wsc-sports-amos-bercovich-explains-how-ai-keeps-the-highlights-coming/)
- A USPTO patent on automatic sports highlight generation (US 10,417,500) describes NLP comparing play-by-play data with commentator phrases. I could not confirm the assignee as WSC. UNVERIFIED. [USPTO 10417500](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10417500)
- One blog says WSC ingests Genius Sports / Sportradar feeds and made 16M highlights in 2025. Another source says 6M clips. The two conflict, and both are UNVERIFIED. [Kunal Ganglani blog, 2026](https://www.kunalganglani.com/blog/ai-world-cup-2026-highlights-pipeline.md)

**Magnifi (VideoVerse, now part of Minute Media)**
- Magnifi says it meta-tags streams by "taking cues from sports mechanics, observing crowd responses, and using activity recognition". It claims models for 70+ sports. No public detail on commentator audio or scoreboard OCR. VENDOR. [Magnifi Digital Highlight Pro page, undated, accessed Oct 2026](https://magnifi.ai/products/digital-highlight-pro); [SVG sponsor spotlight, 24 Feb 2023](https://www.sportsvideo.org/2023/02/24/svg-new-sponsor-spotlight-magnifis-meghna-krishna-on-powering-automated-sports-highlights-through-ai/)
- The site banner says Magnifi is "now part of the Minute Media family". Acquisition date not confirmed. [magnifi.ai, accessed Oct 2026](https://magnifi.ai/products/digital-highlight-pro)

**Pixellot**
- Highlights are generated "in real-time and on the original video, without any need for supporting metadata, such as play-by-play commentary or scoring statistics". CNNs track the ball and players. Highlights are rated for importance (for example, shots on goal count about as much as goals). VENDOR via trade press. [Broadcast Now, 2018](https://www.broadcastnow.co.uk/tech/ai-made-auto-highlights-added-to-pixellots-products/5129751.article); [NVIDIA blog on Pixellot, accessed Oct 2026](https://blogs.nvidia.com/?p=41045)
- Air NXT models are said to be trained on "over 5 million games" from eight years of streams. VENDOR. [SVG, 27 Sep 2024](https://www.sportsvideo.org/2024/09/27/introducing-pixellot-air-nxt-the-next-generation-of-the-multi-sports-portable-ai-camera/)
- No source says Pixellot uses audio. Gap.
- Hudl: not researched within the tool budget. Gap.

### Inferences
- In both published systems, crowd/audience audio is the main detector (IBM weight 0.61; WBD snaps every event to the crowd peak), and vision is used to gate, bound, and label the clip. That suits a free pipeline: an AudioSet tagger (PANNs, YAMNet) or plain band-energy features can find "cheer" and "whistle" on CPU.
- Free?: The cheap parts are reproducible: band energy, cheer classifiers, Tesseract OCR of score bugs, histogram shot boundaries, and silence detection for cut points. Not reproducible at zero cost: official data feeds (Sportradar/Genius are paid), Pixellot-style per-sport ball tracking trained on millions of games, Rekognition / Elemental Inference (paid AWS), and Watson STT (paid, and replaceable by whisper).
- IBM's rule "start a few seconds before the name graphic, end at the next shot boundary after the cheer" is a reusable boundary heuristic. Use the audio peak to find the moment, and visual structure to find clean cut points.

### Gaps
- Exact year and venue of the expanded Merler journal version: the brief says IEEE TMM 2019, but search listings vary (CVPRW 2017/2018). I did not confirm the TMM DOI.
- WSC data-feed partners and current volume: conflicting secondary figures only.
- Magnifi's and Pixellot's use of audio, commentator speech, or scoreboard OCR: not published.
- Hudl: not covered.

## 3. Music, dance and performance: beat tracking, energy, motion

### Takeaway
Consumer tools (CapCut Auto Cut, GoPro Quik, Apple Memories) use beat detection to place cuts on the music. They do not publish how they decide which part of a performance is the highlight. Open, free beat trackers (Beat This!, madmom) and AudioSet taggers make beat-aligned cutting and energy-based ranking reproducible.

### Cited Findings
- CapCut Auto Cut trims, segments and syncs footage to "a selected track, script, or beat pattern", and looks at speech, music beats, or on-screen text to find cut points. Mobile and desktop, not web. VENDOR. [CapCut help: Auto Cut, undated, accessed Oct 2026](https://www.capcut.com/help/auto-cut-in-capcut)
- Reviewers say auto beat tools are most reliable on grid-locked tracks, miss syncopated or human-played hits, and produce "an aesthetic first pass" that needs manual nudging. Secondary (a competitor's blog). [Splice blog, 10 Feb 2026](https://spliceapp.com/blog/best-tool-for-rhythm-based-editing); [Splice blog, 14 Mar 2026](https://spliceapp.com/blog/what-editors-provide-timing-markers-for-beats)
- Beat This! (Foscarin, Schlüter, Widmer, JKU, ISMIR 2024) beats the prior state of the art in F1 without DBN post-processing. Model, code and data released. Still weak on underrepresented genres. One third-party page says code and weights are MIT (UNVERIFIED against the official repo). INDEPENDENT. [arXiv 2407.21658, Jul 2024](https://arxiv.org/pdf/2407.21658); [JKU research page](https://research.jku.at/en/publications/beat-this-accurate-beat-tracking-without-dbn-postprocessing/); [GGUF port page noting licenses](https://huggingface.co/cstr/beat-this-GGUF)
- PANNs: pretrained on AudioSet (1.9M clips, 527 classes), mAP 0.439. Code and models are open. This allows music / singing / cheering / applause tagging on-device. INDEPENDENT. [arXiv 1912.10211, Dec 2019](https://arxiv.org/abs/1912.10211v5)

### Inferences
- For performance content, the likely free signal set is: music presence (AudioSet tagger), the energy envelope (RMS, spectral flux), beat and downbeat grid (Beat This!), audience cheer and applause (AudioSet), and optional motion energy (frame-difference or optical-flow magnitude). Clip boundaries snap to downbeats or phrase boundaries.
- "Cut to the beat" (an editing step) is a separate problem from "find the best 30 s" (selection). The vendor docs describe only the first.

### Gaps
- No published architecture for TikTok/CapCut highlight selection on dance content.
- No vendor documents using pose or motion estimation to rank dance moments. I found no source either way.

## 4. Vlogs and travel: scene detection, aesthetics, faces/emotion, telemetry

### Takeaway
Consumer memory products (Apple Memories, Google Photos, GoPro Quik, Magisto) select on-device or in the cloud using scene and object recognition, faces, and in GoPro's case sensor telemetry. None publishes a ranking architecture I could verify. All of these signals can be approximated free with open vision models and scene-cut detectors.

### Cited Findings
- Apple Memories (iOS 10, 2016) builds themed movies on-device using local face recognition and detection of what is in each image. Apple said it recognizes faces and "more than 4,000 different scenes or objects". VENDOR via press. [TechCrunch, 13 Jun 2016](https://techcrunch.com/2016/06/13/apple-memories); [Six Colors, Sep 2016](https://sixcolors.com/post/2016/09/whats-new-in-photos-for-ios-10/)
- Users complained that Memories could not tell pleasant memories from unpleasant ones. Anecdotal. [Best Practice AI case study, accessed Oct 2026](https://www.bestpractice.ai/ai-case-study-best-practice/apple_ios_10_creates_thematic_movies_from_user_photos_using_facial_recognition_while_remaining_low_latency)
- Apple's Photos tech brief says Memories is "enabled by powerful machine learning". No method detail. VENDOR. [Apple Photos Tech Brief, Sep 2019](https://apple.com/ph/ios/photos/pdf/Photos_Tech_Brief_Sept_2019.pdf)
- GoPro (HERO5 era) records GPS path, speed, altitude and g-force telemetry. Quik for Desktop added speed graphs that reviewers used to find action points manually. INDEPENDENT press. [PetaPixel, 17 Nov 2016](https://petapixel.com/2016/11/17/gopro-telemetry-feature-shows-speed-motion-data-videos/); [Engadget, 17 Nov 2016](https://www.engadget.com/2016-11-17-gopro-video-gps-data-overlays.html)
- The GoPro Quik mobile app "picks your best shots" and syncs to music. The listing does not name the selection signals. VENDOR. [GoPro Quik app listing, accessed Oct 2026](https://mwm.ai/apps/id/561350520)
- I found no primary source confirming that Quik's auto-highlight uses GPMF/IMU telemetry. UNVERIFIED (the brief's premise is plausible, but not sourced here).
- Google Photos and Magisto: not covered within budget. Gap.

### Inferences
- A reproducible free vlog signal set: shot/scene cuts (PySceneDetect, TransNetV2), face presence and expression (open face detectors), CLIP-style aesthetic or "interestingness" scores, motion energy, and, for GoPro or phone footage, embedded telemetry (GoPro's GPMF parser is open source per GoPro, UNVERIFIED here) where speed or g-force spikes mark action.
- The Apple complaint about unpleasant memories suggests that pure visual-salience ranking needs a semantic veto (a VLM or caption check) for sensitive content.

### Gaps
- Google Photos highlight video and Magisto selection methods: not researched.
- Whether GoPro uses telemetry in automatic selection: not confirmed.

## 5. Comedy skits and reactions: laughter and audience reaction

### Takeaway
Laughter is the main non-speech signal for comedy. Powder ships laughter detection for streams. Open laughter detectors and AudioSet "Laughter" classes exist and run free. A Sept 2026 study found open detectors reach reasonable event-level precision.

### Cited Findings
- Powder offers laughter detection as part of its audio analysis for gaming streams. [TechCrunch, 20 Nov 2023](https://techcrunch.com/2023/11/20/powder-an-ai-clipping-tool-for-gaming-can-detect-when-a-creator-yells-during-a-stream)
- An arXiv study comparing four open-source laughter detectors (Gillick, Omine, Ideo, and a Wav2Vec2-based one) against a commercial API concluded that "at event-level granularity, all four open-source methods achieve reasonable precision". The Ideo model is an LSTM on 3 s segments, about 1.5 MB. INDEPENDENT. [arXiv 2609.12642, Sep 2026](https://arxiv.org/pdf/2609.12642)
- ChuckleNet (Hugging Face) is a chunk-level laughter detector for comedy video on 5 s segments. It reports CV F1 0.879, and a later variant claims F1 0.975 "human-verified". Another variant's labels are weak labels from transcript markers. Self-reported and internally inconsistent: treat with caution. [ChuckleNet-Genki model card, accessed Oct 2026](https://huggingface.co/Hayasuki/ChuckleNet-Genki); [ChuckleNet-Kage](https://huggingface.co/Hayasuki/ChuckleNet-Kage)
- FunnyNet-W: an open multimodal (audio, vision, subtitles) model for funny moments, with code and weights. [GitHub FunnyNet-W, accessed Oct 2026](https://github.com/Holmes-Alan/FunnyNet-W)
- YAMNet's AudioSet class map includes Laughter, Giggle, Snicker, Belly laugh, Cheering and Clapping. [YAMNet class map on HF, accessed Oct 2026](https://huggingface.co/camstack/camstack-models/blob/main/audioClassification/yamnet/tf/assets/yamnet_class_map.csv)
- Whisper transcripts often mark audience reactions as "[laughter]" or "(applause)". ChuckleNet-Kage's use of "transcript markers" as weak labels relies on this. [ChuckleNet-Kage card](https://huggingface.co/Hayasuki/ChuckleNet-Kage)

### Inferences
- Selects already runs whisper, so a zero-cost first pass is to mine whisper's non-speech tokens ([laughter], [applause], [music]) plus an AudioSet tagger at 1 Hz. The laugh onset marks the end of the punchline; the setup starts at the prior sentence or scene boundary.
- On reaction videos the creator's laugh or shout plus face expression change is the signal. Powder's "yell" detector is the same idea (loudness and pitch excursion above the speaker's baseline).

### Gaps
- No vendor publishes how laughter is weighted against other signals.

## 6. Livestreams: chat activity, donations, subs; Twitch/Kick clipping

### Takeaway
Chat velocity is the oldest and best-studied livestream signal: in academic work (Fu et al. EMNLP 2017; Lightor ICDE 2020) and in products (Powder "Community Hype", Eklipse, reportedly Twitch Auto Clips). Chat reacts after the moment, so systems treat a chat burst as a rough pointer and then refine boundaries with video. Chat logs for Twitch VODs can be retrieved free. YouTube "Most Replayed" is a second free crowd signal for popular videos.

### Cited Findings
- Fu, Lee, Bansal, Berg (UNC), "Video Highlight Prediction Using Audience Chat Reactions", EMNLP 2017. Data: League of Legends championship streams from NA and Taiwanese Twitch channels, with English and Traditional Chinese chat. Model: character-level CNN-RNN on chat fused with visual features. Labels come from community-produced highlight videos. INDEPENDENT. [ACL Anthology D17-1102, Sep 2017](https://aclanthology.org/D17-1102/); [arXiv 1707.08559](https://ar5iv.arxiv.org/html/1707.08559)
- A third-party summary reports F-scores on NALCS of vision-only 72.2%, chat-only 43.2%, and combined 74.7% (LMS combined 70.0%). Not checked against the PDF. UNVERIFIED. [Liner review, accessed Oct 2026](https://liner.com/review/video-highlight-prediction-using-audience-chat-reactions)
- Lightor (ICDE 2020): a "Highlight Initializer" uses bursts of timestamped chat messages to flag approximate highlight positions. A "Highlight Extractor" then refines start and end points iteratively from viewer interaction data. The authors note that chat is noisy and lags the event. It was evaluated on two Twitch games with MTurk workers. INDEPENDENT. [Lightor ICDE 2020 PDF (Microsoft Research)](https://www.microsoft.com/en-us/research/uploads/prod/2020/02/icde20lightor.pdf); [SFU thesis](https://summit.sfu.ca/item/19383)
- Powder's "Community Hype" model (launched Sept 2023) detects chat spikes. [TechCrunch, 20 Nov 2023](https://techcrunch.com/2023/11/20/powder-an-ai-clipping-tool-for-gaming-can-detect-when-a-creator-yells-during-a-stream)
- An open-source Auto-Clipper skill detects highlights from Twitch and Kick live streams "via audience-retention data, chat spikes and timestamped comments". [shyft.ai autoclipper, accessed Oct 2026](https://www.shyft.ai/skills/autoclipper)
- YouTube's "Most Replayed" heatmap rolled out to all users in May 2022. Headliner launched a "Most Replayed" clip tool in April 2025 that clips up to five peaks. OpusClip's MCP workflow reads the heatmap spikes (Pro plan). There is no documented public API, so tools read it from the watch page. [MobileSyrup, 18 May 2022](https://mobilesyrup.com/2022/05/18/youtubes-most-replayed-experimental-feature-is-now-rolling-out-for-all-users/); [Headliner press release via Sounds Profitable, Apr 2025](https://soundsprofitable.com/press-release/headliner-launches-most-replayed-providing-a-proven-path-to-clip-creation/); [OpusClip MCP inspiration page, accessed Oct 2026](https://www.opus.pro/mcp/inspiration/clip-the-exact-moments-your-viewers-rewatch-most)
- Donations, subs and bits as clip triggers: no technical source found within budget. Gap.

### Inferences
- In Fu et al. (as summarized), chat alone was weaker than vision alone, but adding chat helped. Chat works best as a recall booster and a pointer, not as the only ranker.
- Chat lags the event. Lightor's two-stage design (coarse pointer from chat, then refine) maps onto Selects: shift the window back by a lag estimate, then snap to transcript or shot boundaries.
- Free?: Twitch VOD chat replay and YouTube live-chat replay are publicly downloadable with open tools (for example, chat-downloader style utilities; tool names UNVERIFIED here). The Most Replayed heatmap needs no key but scrapes an undocumented page structure, so it should fail closed.

### Gaps
- Twitch's official Auto Clips signal set: unconfirmed.
- Kick-specific clipping tools: none researched.
- Event-alert (donation/sub/raid) triggers in commercial clippers: not documented.

## 7. B-roll-heavy and no-speech content: visual-only clipping (Opus ClipAnything, Vizard, Quso)

### Takeaway
OpusClip markets ClipAnything as multimodal "clip any video by prompt" (visuals, actions, emotions, audio, dialogue), separate from its transcript-only ClipBasic. Every claim is vendor-sourced, and no architecture is published. Open research on query-based highlight detection (QVHighlights, Moment-DETR, UniVTG, SG-DETR) provides free, published building blocks.

### Cited Findings
- ClipAnything was launched with OpusClip's $30M (cumulative) funding announcement, Series A led by Millennium New Horizons. The company describes it as "the world's first multimodal AI clipping that can clip any moment from any video with natural language prompts". It says it "understands and reasons across visuals, actions, emotions, audio, and dialogue", and was fine-tuned on signals from 6M users (likes, dislikes, exports, social performance). Post dated 31 Aug 2024 in header, with structured data saying 4 Sep 2024. VENDOR. [OpusClip blog, Aug/Sep 2024](https://www.opus.pro/blog/opusclip-celebrates-30m-in-funding-and-the-launch-of-clipanything)
- The product page says ClipAnything analyzes objects, colours, actions and on-screen text (scoreboards, name cards), plus sound effects and sentiment. It contrasts this with ClipBasic, which "relies solely on the transcript". It claims self-reported wins over Gemini-1.5, GPT-4V, InternVideo and VideoChat2 on video QA benchmarks. VENDOR, unverified. [opus.pro/clipanything, accessed Oct 2026](https://opus.pro/clipanything); [OpusClip help: ClipAnything](https://help.opus.pro/docs/article/how-to-use-clipanything.md)
- Vizard and Quso: no technical sources found within budget. Gap.
- QVHighlights (NeurIPS 2021): over 10k YouTube videos with free-form queries, relevant moments, and saliency scores. Moment-DETR's official repo supports inference on your own videos with SlowFast + CLIP features (about 8 GB of features), and trains in under 4 h on one RTX 2080Ti. INDEPENDENT. [arXiv 2107.09609, Jul 2021](https://arxiv.org/abs/2107.09609v2); [GitHub jayleicn/moment_detr](https://github.com/jayleicn/moment_detr)
- UniVTG (ICCV 2023) unifies moment retrieval, highlight detection and summarization, using CLIP as a teacher for pseudo labels. [CVF open access, ICCV 2023](https://openaccess.thecvf.com/content/ICCV2023/papers/Lin_UniVTG_Towards_Unified_Video-Language_Temporal_Grounding_ICCV_2023_paper.pdf)
- SG-DETR reports zero-shot 48.3 mAP / 68.0 HIT@1 on the QVHighlights test set after pretraining on InterVid-MR, using InternVideo2-1b features. Code release not confirmed. [arXiv 2410.01615, Oct 2024](https://arxiv.org/pdf/2410.01615)

### Inferences
- ClipAnything is in effect prompt-conditioned moment retrieval plus a learned engagement prior from user feedback. The open equivalent is CLIP/SigLIP frame embeddings plus a QVHighlights-trained grounding head, or a local VLM captioning sampled frames, with the LLM ranking the captions.
- OpusClip's ClipBasic / ClipAnything split is itself a router. It is user-selected, not detected automatically.
- Free?: The open models run on consumer GPUs. CPU-only runs are slow for long videos, so sampling at 0.5-1 fps with cheap pre-filters (shot cuts, motion energy) matters. OpusClip's preference fine-tuning on 6M users' data cannot be reproduced.

### Gaps
- No published architecture for ClipAnything, Vizard or Quso. No independent benchmark of visual-only clipping quality.

## 8. Published architectures of multimodal clippers

### Takeaway
The published systems share one pattern. Cheap high-recall detectors (audio peaks, chat bursts, game events) propose candidates. Structural signals (shot boundaries, graphics, silence) set clean boundaries. A weighted or learned fusion ranks the candidates. Vision is usually a validator or gate, not the first detector.

### Cited Findings
- IBM (Merler 2017): cheer-seeded candidates, graphic-gated, shot-boundary-bounded, then linear fusion (0.61 / 0.13 / 0.13 / 0.13). [arXiv HTML 1707.07075](https://arxiv.org/html/1707.07075)
- WBD/AWS (2024): audio-first detection (mel bands, thresholds), data-feed markers snapped to crowd peaks, CV only as second-level validation. Serverless and event-driven (S3, EventBridge, DynamoDB, Lambda/Step Functions, CloudWatch). [AWS M&E Blog, 28 May 2024](https://aws.amazon.com/blogs/media/how-warner-bros-discovery-uses-audio-analysis-to-improve-data-accuracy-and-enrich-the-fan-experience)
- AWS MRE: a plugin framework with clip/replay pipeline orchestration, where plugins are classifier, detector, or optimizer functions; outputs EDL/JSON. Apache-2.0. [awslabs MRE wiki, accessed Oct 2026](https://github.com/awslabs/aws-media-replay-engine/wiki); [MRE samples repo](https://github.com/brandoncroberts/aws-media-replay-engine-samples)
- WSC: CV, audio and data-feed layers fused, with lead-up logic for context. [Sportcal, undated](https://www.sportcal.com/features/wsc-sports-how-ai-has-led-the-highlights-revolution/)
- Fu et al. (EMNLP 2017): a chat-text model and a visual model fused for esports. [ACL Anthology D17-1102](https://aclanthology.org/D17-1102/)
- Lightor (ICDE 2020): two stages, a chat-burst initializer then an interaction-based boundary refiner. [Lightor PDF](https://www.microsoft.com/en-us/research/uploads/prod/2020/02/icde20lightor.pdf)
- Eklipse (vendor): identify the game, run game-specific detectors, add chat and audio spikes. [Eklipse blog](https://blog.eklipse.gg/tools/ai-clip-maker-gaming.html)
- Powder: 40+ per-game models plus generic audio, laughter and chat models. [TechCrunch, 20 Nov 2023](https://techcrunch.com/2023/11/20/powder-an-ai-clipping-tool-for-gaming-can-detect-when-a-creator-yells-during-a-stream)
- Medal: structured game events where integrated, voice clips as the universal fallback. [Medal support, Nov 2025](https://support.medal.tv/support/solutions/articles/48001167701); [Medal non-supported games](https://support.medal.tv/en/support/solutions/articles/48001159663)

### Inferences
- The "detect type, then choose a signal set" step appears in published form only in gaming (Eklipse identifies the game; Powder routes to a per-game model; Medal routes to replay integration or voice clips) and as OpusClip's manual ClipBasic/ClipAnything choice. I found no published automatic content-type router for general video. That design is open territory.

### Gaps
- No engineering blog from OpusClip, Vizard, Quso, Eklipse, or Medal describes model architecture or ranking in detail.

## 9. Noisy audio: do vendors enhance before ASR?

### Takeaway
Descript and Adobe market speech enhancement (Studio Sound, Enhance Speech v2) as output polish. Neither documents running it before transcription to improve ASR. Two recent independent studies found that common enhancement front-ends make Whisper's errors worse. For a whisper-based pipeline, the evidence favours transcribing raw audio and using enhancement only for the exported clip's sound.

### Cited Findings
- Descript's workflow is to upload and transcribe first, then toggle Studio Sound, which "uses AI to isolate speaker audio, then remove background noises". Enhancement is applied after transcription in the documented flow. VENDOR. [Descript voice enhancer page, undated, accessed Oct 2026](https://descript.com/tools/voice-enhancer)
- Adobe Podcast Enhance Speech v2 (Feb 2025 update) "delivers clearer, more natural-sounding dialogue, no matter the recording conditions". It is a separate tool from Adobe's transcription. VENDOR. [Adobe Podcast guides / latest updates, Feb 2025](https://podcast.adobe.com/en/guides/latest-updates)
- An informal reviewer test on a deliberately bad recording found Adobe's result strong and Descript's disappointing. Single, uncontrolled test. [Production Expert, accessed Oct 2026](https://www.pro-tools-expert.com/production-expert-1/adobe-podcast-enhance-is-it-any-good)
- "When De-noising Hurts": MetricGAN+ enhancement made results worse in all 40 configurations (4 ASR systems including Whisper, 10 noise conditions) on 500 medical recordings, by 1.1 to 46.6 points of absolute semantic WER. For Whisper at 10 dB SNR with short noise bursts, semWER rose from 8.0% to 17.68%. The authors conclude that modern ASR has enough internal noise robustness, and that enhancement removes features ASR needs. INDEPENDENT preprint. [arXiv 2512.17562, Dec 2025](https://arxiv.org/pdf/2512.17562)
- Meta SAM-Audio preprocessing before zero-shot Whisper raised both WER and CER on Bengali YouTube and English noisy data, even though signal-quality metrics improved. The damage grew with Whisper model size. INDEPENDENT preprint. [arXiv 2603.04710, Mar 2026](https://arxiv.org/abs/2603.04710)
- Riverside: not researched within budget. Gap.

### Inferences
- For Selects: do not put a denoiser in front of whisper by default. Use enhancement (an open model such as DeepFilterNet; not verified here) only on the rendered clip's audio track, as Descript and Adobe position it. If the transcript is unreliable (low avg log-prob, high no-speech probability, many hallucination markers), the right response is to route to non-speech signals, not to denoise and retry.
- Whisper's per-segment confidence fields can serve as a free "audio quality / speechiness" probe for the router below.

### Gaps
- No vendor documents whether its clipping ASR runs on enhanced or raw audio.
- No independent WER study of Adobe Enhance Speech v2 or Descript Studio Sound as ASR front-ends.

## 10. Sketch: a content-type router (detect type, choose signal set, rank) based on published systems

### Takeaway
The pieces exist in published work, but no one has published an automatic general-video router. The design below combines them. Gaming routing (Eklipse, Powder, Medal) shows "classify first, then use specialized detectors, with a generic fallback". IBM and WBD show "audio peak proposes, structure bounds, linear fusion ranks". Lightor shows "crowd signal points, content refines". Every stage below can run free on-device with open models, apart from the optional cloud VLM, which must fail closed.

### Cited Findings (design precedents)
- Classify then specialize, with a fallback: Eklipse identifies the game first [Eklipse blog](https://blog.eklipse.gg/tools/ai-clip-maker-gaming.html). Powder routes to 40+ game-specific models [TechCrunch, 20 Nov 2023](https://techcrunch.com/2023/11/20/powder-an-ai-clipping-tool-for-gaming-can-detect-when-a-creator-yells-during-a-stream). Medal falls back to voice clips for unsupported games [Medal support](https://support.medal.tv/en/support/solutions/articles/48001159663).
- Audio proposes, structure bounds, fusion ranks: [Merler et al. 2017](https://arxiv.org/html/1707.07075); [WBD/AWS, 28 May 2024](https://aws.amazon.com/blogs/media/how-warner-bros-discovery-uses-audio-analysis-to-improve-data-accuracy-and-enrich-the-fan-experience).
- Crowd pointer, then refine: [Lightor, ICDE 2020](https://www.microsoft.com/en-us/research/uploads/prod/2020/02/icde20lightor.pdf).
- Transcript vs multimodal mode split: [OpusClip ClipAnything vs ClipBasic](https://opus.pro/clipanything).
- Silence-aware cut points: [AWS tennis replay blog](https://aws.amazon.com/blogs/media/stream-tennis-matches-through-aws-elemental-medialive-and-generate-real-time-replays-with-amazon-rekognition/).
- Plugin architecture for detectors: [AWS MRE](https://github.com/awslabs/aws-media-replay-engine/wiki).

### Inferences (proposed design for Selects; my synthesis, not a published system)
**Stage 0: cheap probes over the whole file (CPU, about 1 Hz):**
- Speech ratio and transcript trust: whisper segment no-speech probability and avg log-prob (already computed).
- AudioSet tags per second (PANNs or YAMNet, open): speech, music, singing, laughter, cheering, clapping, crowd, gunshot/explosion, whistle.
- Loudness/RMS envelope and per-speaker baseline excursions (yell detector, as in Powder).
- Shot-cut rate (PySceneDetect / TransNetV2).
- Motion energy (frame differencing).
- OCR text density in fixed regions (score bug, kill feed, HUD) with Tesseract or PaddleOCR on sparse frames.
- Sidecar data if present: chat log, YouTube Most Replayed, game event log.

**Stage 1: type classification (rules first, optional zero-shot fallback):**
- Talking-head/podcast: speech ratio > ~0.6 and good transcript trust. Use the existing transcript-first path.
- Gaming: persistent HUD/OCR regions plus high motion, or a chat sidecar from Twitch/Kick. Optional CLIP zero-shot "video game screenshot" check.
- Sports broadcast: crowd/cheer tags plus a persistent score bug plus commentator speech.
- Music/performance: music or singing tags dominate, with beat-trackable audio.
- Comedy/reaction: speech plus frequent laughter tags or [laughter] transcript tokens.
- Vlog/travel/B-roll: low speech ratio, low HUD, moderate cut rate, possibly music bed.
- Allow mixtures. Output a soft distribution over types, not a single label, and blend signal weights.

**Stage 2: per-type signal set (candidate proposal):**
- Talking-head: current LLM-on-transcript scoring.
- Gaming: loudness/yell spikes, laughter, chat velocity (lag-shifted back ~5-15 s; lag value UNVERIFIED and should be tuned), and optional user-configured kill-feed OCR keywords. Generic, no per-game training.
- Sports: cheer/crowd energy (IBM-style dominant weight), whistle band energy, commentator excitement (pitch/energy above baseline plus an excitement word list on the whisper transcript, as in IBM's 60-term dictionary), and a score-bug OCR change as a strong event marker.
- Music/performance: energy envelope peaks, chorus/drop detection via energy plus repetition, applause/cheer, and downbeat grid for boundaries.
- Comedy/reaction: laughter onsets (punchline end), with the setup start found from transcript sentence boundaries.
- Vlog/B-roll: shot-level aesthetic/salience scores (CLIP/SigLIP embeddings), face presence and expression, motion peaks, telemetry spikes if present, and diversity (avoid near-duplicate shots).

**Stage 3: boundaries.** Snap to shot boundaries, silence gaps, sentence ends, or downbeats, depending on type (IBM, AWS tennis, CapCut precedent).

**Stage 4: ranking.** Per-type linear fusion of z-normalized signals in sliding windows. IBM's 0.61 crowd weight is a sensible starting prior for sports. Then an optional rerank by the local LLM (Gemma) over a text dossier per candidate: transcript excerpt, audio tags, OCR text, and VLM captions of 3-5 frames if a local VLM is available. A free cloud VLM tier may be used only with bring-your-own keys, and must fail closed.

**Free reproducibility map:**
- Free, on-device: PANNs/YAMNet tags, RMS/band energy, whistle-band detection (WBD recipe needs no ML), Beat This!, laughter detectors, PySceneDetect/TransNetV2, Tesseract OCR, CLIP/SigLIP, Moment-DETR/UniVTG (GPU preferred), whisper confidence, chat-replay downloads.
- Needs paid infra or proprietary data (do not copy): official sports data feeds (Sportradar/Genius), Pixellot/Magnifi/WSC per-sport models, per-game kill models (Powder 40+, Eklipse), NVIDIA/Overwolf/Medal live game hooks (free but live-only and per-game), AWS Rekognition / Elemental Inference, OpusClip's 6M-user preference tuning, Watson STT.

### Gaps
- No published evaluation of an automatic multi-type router. Thresholds above (speech ratio 0.6, chat lag 5-15 s) are my placeholders, not sourced values, and need tuning on Selects' own test set.
