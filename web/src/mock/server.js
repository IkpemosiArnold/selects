// In-browser stand-in for the core server: same interface as the HTTP client
// in lib/api.js, with a fake SSE stream that replays a believable pipeline.
//
// URL params (all optional):
//   mock=1                 turn the mock on
//   scenario=fresh|midreview|rendered|error
//   health=bad             show health warnings on the new job screen
//   speed=0.3              slow the simulated pipeline (for screen recording)
//   at=0.4                 start the live job part way through transcription
//   faces=unsupported      the faces endpoint answers as it does on a non-Mac server
//   lang=yo                a new job's language check disagrees with the setting
//   clips=50&dur=7316      the demo job has 50 clips over a 2 hour video (either alone works too)
//   audio=1                the demo job is an audio-only recording (its clips become audiograms)
import { buildTalk, makeJob, MEASURED, attributionFor, spreadCandidates } from "./fixture.js";
import { frameSvg } from "./frames.js";
import { cuesFromWords, applyCueEdits, toSrt, toVtt, accentedWords } from "./captions.js";
import { needsMediaReminder } from "../lib/licences.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));

export function createMockApi(params) {
  const scenario = params.get("scenario") || "fresh";
  const speed = Math.max(0.05, Number(params.get("speed")) || 1);
  const startAt = Math.min(0.98, Math.max(0, Number(params.get("at")) || 0));
  const healthBad = params.get("health") === "bad";
  const facesUnsupported = params.get("faces") === "unsupported";
  const langParam = params.get("lang");
  const talk = buildTalk();
  let words = talk.words;
  let duration = talk.duration;
  if (scenario === "worst") {
    // A 3 hour recording: the talk six times over, back to back.
    const out = [];
    for (let k = 0; k < 6; k++) for (const w of talk.words) out.push({ ...w, s: +(w.s + k * talk.duration).toFixed(2), e: +(w.e + k * talk.duration).toFixed(2) });
    words = out;
    duration = +(talk.duration * 6).toFixed(2);
  }
  // Many clips over a long video: the talk again and again, cut at the asked length.
  const manyN = Math.min(200, Math.max(0, Math.floor(Number(params.get("clips")) || 0)));
  const manyDur = Number(params.get("dur")) || 0;
  if (scenario !== "worst" && (manyN || manyDur)) {
    const want = Math.max(manyDur || talk.duration, 60);
    const out = [];
    for (let k = 0; k * talk.duration < want; k++) for (const w of talk.words) out.push({ ...w, s: +(w.s + k * talk.duration).toFixed(2), e: +(w.e + k * talk.duration).toFixed(2) });
    words = out.filter((w) => w.e < want - 1);
    duration = want;
  }
  const jobs = new Map();
  const listeners = new Map();
  const sims = new Map();

  const emit = (id, type, data) => {
    for (const fn of listeners.get(id) || []) fn(type, clone(data));
  };

  // Seed jobs.
  const demo = makeJob({ id: "j_20261015_demo", stage: "ready" });
  if (scenario === "midreview" || scenario === "rendered") {
    const byRank = (r) => demo.candidates.find((c) => c.rank === r);
    Object.assign(byRank(1), { status: "approved" });
    Object.assign(byRank(2), { status: "approved", trimmed: true, end: byRank(2).end - 6.2 });
    fixEnd(byRank(2));
    Object.assign(byRank(4), { trimmed: true });
    Object.assign(byRank(3), { status: "approved" });
    Object.assign(byRank(12), { status: "skipped" });
    Object.assign(byRank(11), { status: "skipped" });
  }
  // Faithful cuts (notes/CONTRACTS.md, "Faithful cuts"): a check on whether the
  // cut changes what the speaker meant, with a fix when one exists.
  {
    const byRank = (r) => demo.candidates.find((c) => c.rank === r);
    const nextEnd = (t) => words.find((w) => w.e > t + 1 && /[.?!]$/.test(w.w))?.e ?? null;
    const c2 = byRank(2);
    const e2 = c2 && nextEnd(c2.end);
    if (c2 && e2) c2.faithful = { verdict: "check", issue: "turn", note: "This stops just before the speaker's \"but\". Ending here, it says the opposite of what they meant.", fix: { end: e2 }, by: "model", hints: ["turn"], context: { before: null, after: null } };
    const c5 = byRank(5);
    if (c5) c5.faithful = { verdict: "misleading", issue: "quote", note: "The speaker is quoting someone they disagree with here. On its own, it sounds like their view.", fix: null, by: "model", hints: ["quote"], context: { before: null, after: null } };
    for (const c of demo.candidates) if (!c.faithful) c.faithful = { verdict: "faithful", issue: null, note: "", fix: null, by: "model", hints: [], context: { before: null, after: null } };
  }
  if (scenario === "weak") {
    demo.candidates = demo.candidates.filter((c) => c.rank <= 2);
    demo.verdict = { strong: 0, threshold: 0.55, best: 0.52, note: "No strong clips in this video. These are the closest 2, with why." };
    for (const c of demo.candidates) c.weak = true;
  }
  if (scenario === "worst") applyWorst(demo);
  else if (manyN || manyDur) applyMany(demo, manyN || 12);
  if (scenario === "empty") demo.candidates = [];
  if (scenario === "one") demo.candidates = demo.candidates.filter((c) => c.rank === 1);
  if (scenario === "rendered") {
    demo.stage = "done";
    for (const c of demo.candidates.filter((c) => c.status === "approved")) finishRender(demo, c);
  }
  // a recording with no picture: no filmstrip, and the review shows the audiogram
  const audioDemo = params.get("audio") === "1";
  if (audioDemo) {
    demo.source = { ...demo.source, name: "voice-memo.m4a", hasVideo: false, width: 0, height: 0, uprightWidth: 0, uprightHeight: 0, fps: null };
    demo.thumbs = null;
    if (params.get("bg")) demo.settings = { ...demo.settings, audiogram: { bg: params.get("bg") } };
  }
  let mockCover = null;
  jobs.set(demo.id, demo);
  const older = makeJob({ id: "j_20261012_k7q2", name: "sunday-service-oct-12.mp4", stage: "done", createdAt: "2026-10-12T19:02:11.000Z", duration: 5412.6, judgeN: 8 });
  older.settings = { ...older.settings, credit: null, license: "own", sourceUrl: null };
  {
    // Three clips rendered after judging finished, at the measured render and kit speeds.
    const end = Date.parse(older.stages.judge.endedAt);
    const sec = older.candidates.slice(0, 3).reduce((a, c) => a + (c.end - c.start) * MEASURED.renderFactor + MEASURED.kitSec, 0);
    older.stages.render = { status: "done", startedAt: new Date(end).toISOString(), endedAt: new Date(end + sec * 1000).toISOString(), progress: 1, etaSec: 0, note: "rendered 3 clips (shorts)" };
  }
  for (const c of older.candidates.slice(0, 3)) {
    c.status = "approved";
    finishRender(older, c);
  }
  jobs.set(older.id, older);

  // Every job the core finishes now says which language it used and how sure whisper was.
  for (const j of [demo, older]) {
    j.language = langInfo("en", "en", null);
    j.transcriptQuality = quality(words, "good");
    j.stages = withLanguageStage(j.stages);
  }

  // Caption mode: a 6 minute community recording in accented English, transcribed and
  // waiting for its caption review. Whisper's quick guess called it Yoruba.
  {
    const cap = makeJob({ id: "j_20261016_cap6", name: "community-meeting-oct-11.mov", stage: "ready", createdAt: "2026-10-16T08:12:40.000Z", duration: 362.4 });
    cap._words = accentedWords(words.filter((w) => w.e < 360));
    cap.settings = { ...cap.settings, mode: "caption", language: "en", asrModel: "auto", captions: true, captionStyle: "subtitle", credit: null, license: "own", sourceUrl: null };
    cap.candidates = [];
    cap.curve = [];
    cap.thumbs = { count: 60, interval: 362.4 / 60, pattern: "thumbs/strip-%04d.jpg" };
    cap.stages = withLanguageStage(cap.stages);
    cap.stages.candidates = { status: "skipped", startedAt: null, endedAt: null, progress: 0, etaSec: null, note: null };
    cap.stages.judge = { status: "skipped", startedAt: null, endedAt: null, progress: 0, etaSec: null, note: null };
    cap.language = langInfo("en", "en", { code: "yo", p: 0.88 });
    cap.transcriptQuality = quality(cap._words, "shaky");
    cap.asr = { provider: "whisper.cpp", model: "base.en", language: "en", prompt: null, preprocess: null, sec: 131.2, speed: 2.76 };
    cap.output = null;
    jobs.set(cap.id, cap);
  }

  // Clip mode, stopped: the transcript was too unsure to pick clips from.
  {
    const bad = makeJob({ id: "j_20261016_unr2", name: "toast-speech.mov", stage: "error", createdAt: "2026-10-16T07:40:02.000Z", duration: 248.9 });
    bad._words = accentedWords(words.filter((w) => w.e < 246), 0.42);
    bad.settings = { ...bad.settings, mode: "clips", language: "auto", asrModel: "auto", credit: null, license: "own", sourceUrl: null };
    bad.candidates = [];
    bad.curve = [];
    bad.stages = withLanguageStage(bad.stages);
    for (const k of ["candidates", "judge"]) bad.stages[k] = { status: "pending", startedAt: null, endedAt: null, progress: 0, etaSec: null, note: null };
    bad.language = langInfo("auto", "yo", { code: "yo", p: 0.88 }, true);
    bad.transcriptQuality = quality(bad._words, "unreliable");
    bad.error = { stage: "transcribe", message: "The transcript is too unsure to pick clips from.", hint: bad.transcriptQuality.hint, suggest: bad.transcriptQuality.suggest };
    bad._emitted = null;
    jobs.set(bad.id, bad);
  }

  // The overnight queue. Empty unless the scenario asks for one.
  const queue = { running: null, items: [] };
  if (scenario === "queue") {
    const busy = makeJob({ id: "j_20261016_q1a9", name: "panel-ai-in-hr-oct-14.mp4", stage: "transcribing", createdAt: new Date(Date.now() - 600e3).toISOString(), duration: 3121.4, judgeN: 8 });
    busy.candidates = [];
    Object.assign(busy.stages.transcribe, { status: "running", endedAt: null, startedAt: new Date(Date.now() - 520e3).toISOString(), progress: 0.4, etaSec: (3121.4 * 0.6) / MEASURED.rtf, note: `transcribing at ${MEASURED.rtf}x real time` });
    for (const k of ["candidates", "judge", "render"]) busy.stages[k] = { status: "pending", startedAt: null, endedAt: null, progress: 0, etaSec: null, note: null };
    jobs.set(busy.id, busy);
    const next = makeJob({ id: "j_20261016_q2c4", name: "church-service-oct-12-full.mp4", stage: "queued", createdAt: new Date(Date.now() - 300e3).toISOString(), judgeN: 8 });
    next.source.duration = null;
    next.candidates = [];
    for (const k of Object.keys(next.stages)) next.stages[k] = { status: "pending", startedAt: null, endedAt: null, progress: 0, etaSec: null, note: null };
    jobs.set(next.id, next);
    queue.running = { jobId: busy.id, kind: "analyze", ids: null, preset: null, addedAt: busy.createdAt };
    queue.items = [
      queue.running,
      { jobId: next.id, kind: "analyze", ids: null, preset: null, addedAt: next.createdAt },
      { jobId: demo.id, kind: "render", ids: demo.candidates.filter((c) => c.rank <= 3).map((c) => c.id), preset: "shorts", addedAt: new Date().toISOString() },
    ];
  }

  function withLanguageStage(stages) {
    const { probe, ...rest } = stages;
    const t = probe?.endedAt || null;
    return { probe, language: { status: "done", startedAt: t, endedAt: t, progress: 1, etaSec: 0, note: "decoded 3 samples" }, ...rest };
  }

  function langInfo(setting, used, detected, unsure = false) {
    const compared = unsure
      ? [{ code: "yo", meanP: 0.46, words: 38 }, { code: "en", meanP: 0.44, words: 51 }]
      : detected && detected.code !== used
      ? [{ code: used, meanP: 0.74, words: 61 }, { code: detected.code, meanP: 0.41, words: 29 }]
      : [{ code: used, meanP: 0.86, words: 64 }];
    const name = { en: "English", yo: "Yoruba" };
    let warning = null;
    if (unsure) warning = `Whisper's quick guess was Yoruba (p = 0.88), and neither language decoded with confidence (Yoruba 0.46 against English 0.44). Using Yoruba. Accented English is often misread as another language; change it if this is wrong.`;
    else if (detected && detected.code !== used)
      warning = `Whisper's quick guess was ${name[detected.code]} (p = ${detected.p.toFixed(2)}), but ${name[used]} decoded with more confidence (0.74 against 0.41). Using ${name[used]}. Accented English is often misread as another language; change it if this is wrong.`;
    return { setting, used, detected, compared, margin: compared[1] ? +(compared[0].meanP - compared[1].meanP).toFixed(3) : null, decided: setting === "auto" ? "compare" : "setting", warning, sec: 41.6 };
  }

  function quality(ws, verdict) {
    const meanP = ws.reduce((a, w) => a + w.p, 0) / Math.max(1, ws.length);
    const lowShare = ws.filter((w) => w.p < 0.5).length / Math.max(1, ws.length);
    const pc = (x) => `${Math.round(x * 100)}%`;
    const hint =
      verdict === "good"
        ? null
        : verdict === "shaky"
        ? `Whisper was unsure of ${pc(lowShare)} of the words (mean confidence ${meanP.toFixed(2)}). Check the captions before posting; a bigger model (--asr-model small.en) usually helps with accents.`
        : `Whisper was unsure of ${pc(lowShare)} of the words (mean confidence ${meanP.toFixed(2)}), so clips picked from this transcript would be guesses. Try --asr-model small.en, or set --language to the language spoken.`;
    const score = verdict === "good" ? 0.84 : verdict === "shaky" ? 0.66 : 0.41;
    const suggest = verdict === "good" ? null : { asrModel: "small.en", language: "en", force: verdict === "unreliable" };
    return { score, meanP: +meanP.toFixed(3), lowShare: +lowShare.toFixed(3), repeatShare: 0.01, compression: 1.6, words: ws.length, verdict, hint, suggest };
  }

  function wordsOf(job) {
    return job._words || words;
  }

  function captionsOf(job) {
    if (!job._captions) {
      const style = job.settings?.mode === "caption" ? "subtitle" : "bold";
      job._captions = { edited: false, updatedAt: new Date().toISOString(), cues: cuesFromWords(wordsOf(job), style) };
    }
    return job._captions;
  }

  function facesFor(job) {
    // The mock frames show one speaker at stage centre, plus a second face for
    // part of the video, so "everyone except the main speaker" has someone to blur.
    const dur = job.source.duration;
    const boxes = (x0, y0, w, h, from, to, drift) => {
      const out = [];
      for (let t = from; t <= to; t += 2) out.push({ t: +t.toFixed(2), x: +(x0 + Math.sin(t / 9) * drift).toFixed(4), y: y0, w, h });
      return out;
    };
    return {
      fps: 2,
      width: 1920,
      height: 1080,
      tracks: [
        { id: "f_01", start: 0, end: dur, boxes: boxes(0.43, 0.34, 0.09, 0.19, 0, dur, 0.012), area: 0.017, share: 0.94, main: true },
        { id: "f_02", start: dur * 0.18, end: dur * 0.31, boxes: boxes(0.12, 0.46, 0.06, 0.12, dur * 0.18, dur * 0.31, 0.004), area: 0.007, share: 0.13, main: false },
        { id: "f_03", start: dur * 0.52, end: dur * 0.58, boxes: boxes(0.78, 0.5, 0.05, 0.1, dur * 0.52, dur * 0.58, 0.003), area: 0.005, share: 0.06, main: false },
      ],
    };
  }

  function applyWorst(job) {
    job.source.name = "GMT20261014-150312_Recording_gallery_1920x1080_all-hands-q4-FINAL-v3-export.mp4";
    job.source.path = "/Users/aleksandra.wisniewska-kowalczyk/Library/CloudStorage/OneDrive-NorthwindIndustries/Recordings/2026/" + job.source.name;
    job.source.duration = duration;
    job.thumbs = { count: 360, interval: duration / 360, pattern: job.thumbs.pattern };
    const base = job.candidates;
    const list = [];
    for (let k = 0; k < 30; k++) {
      const b = base[k % base.length];
      const off = Math.floor(k / base.length) * talk.duration * 2 + (k % 3) * talk.duration;
      list.push({ ...b, id: "c_w" + String(k).padStart(3, "0"), rank: k + 1, start: b.start + off, end: b.end + off, scores: { ...b.scores } });
    }
    list[0].hook = "So when people ask me what the single most important lesson from the whole migration was, after eighteen months, four rewrites, two reorganisations and a very long weekend, I tell them this.";
    list[1].reason = null;
    list[2].scores = { hook: 5, standalone: null, payoff: 4 };
    list[3].start = 0.4; list[3].end = 6.9; list[3].hook = "Okay.";
    list[4].start = duration - 41; list[4].end = duration - 0.3;
    list[5].start = list[0].start + 8; list[5].end = list[0].end + 12;
    list[6].rank = null;
    list[7].status = "approved"; list[7].trimmed = true;
    list[8].status = "skipped";
    list[7].render = { status: "error", progress: 0.4, message: "ffmpeg stopped because the disk is full. Free 1 GB, then render again." };
    list[9].reason = "Strong opening question that pulls the viewer in, followed by a concrete story about the outage, a clear explanation of the root cause, and a memorable closing line that works without any of the context from the rest of the talk.";
    job.candidates = list;
    job.curve = [];
    for (let x = 0; x <= duration; x += 5) {
      let v = 0.1 + Math.abs(Math.sin(x / 61)) * 0.08;
      for (const c of list) v = Math.max(v, (c.total || 0.5) * Math.exp(-(((x - (c.start + c.end) / 2) / ((c.end - c.start) / 2.2)) ** 2) / 2));
      job.curve.push({ t: x, v: Math.min(1, v) });
    }
  }

  function applyMany(job, n) {
    job.source.duration = duration;
    job.thumbs = { count: Math.min(360, Math.ceil(duration / 20)), interval: duration / Math.min(360, Math.ceil(duration / 20)), pattern: job.thumbs.pattern };
    job.candidates = spreadCandidates({ n, duration, words, base: job.candidates });
    job.listwise = { ...job.listwise, order: job.candidates.slice(0, 4).map((c) => c.id) };
    job.curve = [];
    for (let x = 0; x <= duration; x += 5) {
      let v = 0.1 + Math.abs(Math.sin(x / 61)) * 0.08;
      for (const c of job.candidates) v = Math.max(v, c.total * Math.exp(-(((x - (c.start + c.end) / 2) / ((c.end - c.start) / 2.2)) ** 2) / 2));
      job.curve.push({ t: x, v: Math.min(1, v) });
    }
  }

  function fixEnd(c) {
    // Snap a fixture trim to a real sentence end.
    const sentEnds = words.filter((w) => /[.?!]$/.test(w.w)).map((w) => w.e);
    c.end = sentEnds.reduce((a, b) => (Math.abs(b - c.end) < Math.abs(a - c.end) ? b : a));
  }

  function finishRender(job, c) {
    // Shapes as the core writes them: relative paths on the candidate, the kit in kit.json.
    c.render = { status: "done", progress: 1, path: `clips/${c.id}.mp4`, srt: `clips/${c.id}.srt`, kit: `clips/${c.id}.kit.json` };
    c.title = c._kit.title;
  }

  function kitFor(job, c) {
    const attribution = attributionFor(job.settings);
    const dir = `/Users/demo/selects/.selects/jobs/${job.id}`;
    return {
      ...c._kit,
      caption: [c._kit.captionText, attribution].filter(Boolean).join("\n\n"),
      attribution,
      reminder: needsMediaReminder(job.settings) ? "Check slides and on-screen media: a talk's licence may not cover every figure." : null,
      file: `${dir}/clips/${c.id}.mp4`,
      srtFile: `${dir}/clips/${c.id}.srt`,
    };
  }

  function newJob(id, path, settings = {}) {
    const name = path.split("/").pop() || "video.mp4";
    const job = makeJob({ id, name, stage: "queued", createdAt: new Date().toISOString() });
    job.source.path = path;
    job.settings = { ...job.settings, ...settings };
    job.candidates = [];
    job.curve = [];
    job._candidates = makeJob({ id }).candidates;
    for (const k of Object.keys(job.stages)) {
      job.stages[k] = { status: "pending", startedAt: null, endedAt: null, progress: 0, etaSec: null, note: null };
    }
    job.stages = withLanguageStage(job.stages);
    job.stages.language = { status: "pending", startedAt: null, endedAt: null, progress: 0, etaSec: null, note: null };
    if (job.settings.mode === "caption") {
      job.stages.candidates.status = "skipped";
      job.stages.judge.status = "skipped";
    }
    job._emitted = startAt ? words.findIndex((w) => w.s >= duration * startAt) : 0;
    jobs.set(id, job);
    sims.set(id, runSim(job));
    return job;
  }

  function setStage(job, stage, key, patch) {
    job.stage = stage;
    if (key) Object.assign(job.stages[key], patch);
    job.updatedAt = new Date().toISOString();
    emit(job.id, "stage", { stage: job.stage, stages: job.stages, error: job.error });
  }

  async function runSim(job) {
    const tick = (ms) => wait(ms / speed);
    const now = () => new Date().toISOString();
    if (job.stage === "queued" || job.stage === "probing") {
      setStage(job, "probing", "probe", { status: "running", startedAt: now() });
      await tick(900);
      setStage(job, "probing", "probe", { status: "done", endedAt: now(), progress: 1 });
    }
    if (job.stages.language && job.stages.language.status !== "done") {
      setStage(job, "language", "language", { status: "running", startedAt: now(), note: "decoding 3 samples in each candidate language" });
      await tick(1200);
      const setting = job.settings.language || "en";
      const disagree = langParam && langParam !== (setting === "auto" ? "en" : setting);
      job.language = disagree ? langInfo(setting, setting === "auto" ? "en" : setting, { code: langParam, p: 0.88 }) : langInfo(setting, setting === "auto" ? "en" : setting, null);
      setStage(job, "transcribing", "language", { status: "done", endedAt: now(), progress: 1, note: `using ${job.language.used}` });
    }
    const words = wordsOf(job);
    if (job.stages.transcribe.status !== "done") {
      setStage(job, "transcribing", "transcribe", { status: "running", startedAt: job.stages.transcribe.startedAt || now() });
      const rtf = MEASURED.rtf;
      while (job._emitted < words.length) {
        if (scenario === "error" && !job._erroredOnce && words[job._emitted].s > duration * 0.45) {
          job._erroredOnce = true;
          job.error = {
            stage: "transcribe",
            message: `Whisper stopped at ${fmt(words[job._emitted].s)} because the disk is full.`,
            hint: "Free 2 GB, then resume. Your progress is saved.",
          };
          job.stages.transcribe.status = "error";
          job.stage = "error";
          emit(job.id, "error", job.error);
          emit(job.id, "stage", { stage: job.stage, stages: job.stages, error: job.error });
          return;
        }
        const chunk = words.slice(job._emitted, job._emitted + 22);
        job._emitted += chunk.length;
        const last = chunk[chunk.length - 1].e;
        const st = job.stages.transcribe;
        st.progress = Math.min(1, last / job.source.duration);
        st.etaSec = Math.max(0, job.source.duration - last) / rtf;
        st.note = `transcribing at ${rtf}x real time`;
        emit(job.id, "words", chunk);
        emit(job.id, "progress", { stage: "transcribe", ...st });
        await tick(260);
      }
      job.transcriptQuality = quality(words, job._verdict || (job._words ? "shaky" : "good"));
      if (job.settings.mode === "caption") {
        setStage(job, "ready", "transcribe", { status: "done", endedAt: now(), progress: 1, etaSec: 0, note: `${words.length} words, ${rtf}x real time` });
        return;
      }
      setStage(job, "candidates", "transcribe", { status: "done", endedAt: now(), progress: 1, etaSec: 0, note: `${words.length} words, ${rtf}x real time` });
    }
    if (job.settings.mode === "caption") {
      setStage(job, "ready", null);
      return;
    }
    setStage(job, "candidates", "candidates", { status: "running", startedAt: now() });
    await tick(900);
    const n = job.settings.judgeN || 8;
    const per = MEASURED.judgePerMoment;
    setStage(job, "judging", "candidates", { status: "done", endedAt: now(), progress: 1, note: `190 windows passed the filter, ${n} go to the judge` });
    setStage(job, "judging", "judge", { status: "running", startedAt: now() });
    for (let i = 0; i < n; i++) {
      const st = job.stages.judge;
      st.progress = i / (n + 1);
      st.etaSec = (n - i) * per + MEASURED.listwiseSec;
      st.note = `${i} of ${n} moments, ${per} s each`;
      emit(job.id, "progress", { stage: "judge", ...st });
      await tick(700);
    }
    Object.assign(job.stages.judge, { progress: n / (n + 1), etaSec: MEASURED.listwiseSec, note: "final round: the top 4 side by side" });
    emit(job.id, "progress", { stage: "judge", ...job.stages.judge });
    await tick(1400);
    job.candidates = job._candidates;
    job.curve = makeJob({ id: "x" }).curve;
    emit(job.id, "candidates", job.candidates);
    setStage(job, "ready", "judge", { status: "done", endedAt: now(), progress: 1, etaSec: 0, note: `${n} clips judged, ${per} s each` });
  }

  async function runRender(job, ids) {
    job.stage = "rendering";
    job.stages.render = { status: "running", startedAt: new Date().toISOString(), endedAt: null, progress: 0, etaSec: null, note: null };
    for (const c of job.candidates) if (ids.includes(c.id)) c.render = { status: "pending", progress: 0 };
    emit(job.id, "stage", { stage: job.stage, stages: job.stages });
    for (const id of ids) {
      const c = job.candidates.find((x) => x.id === id);
      c.render = { status: "running", progress: 0 };
      for (let p = 0; p <= 1.001; p += 0.05) {
        c.render.progress = Math.min(1, p);
        emit(job.id, "render", { id, ...c.render, etaSec: Math.round((1 - p) * (c.end - c.start) * MEASURED.renderFactor + MEASURED.kitSec) });
        await wait(110 / speed);
      }
      finishRender(job, c);
      emit(job.id, "render", { id, ...c.render, title: c.title });
    }
    job.stage = "done";
    job.stages.render = { ...job.stages.render, status: "done", progress: 1, endedAt: new Date().toISOString() };
    emit(job.id, "stage", { stage: job.stage, stages: job.stages });
  }

  async function runOutput(job) {
    job.stage = "rendering";
    job.stages.render = { status: "running", startedAt: new Date().toISOString(), endedAt: null, progress: 0, etaSec: null, note: null };
    job.output = { status: "pending", progress: 0, path: null, srt: null, vtt: null };
    emit(job.id, "stage", { stage: job.stage, stages: job.stages });
    const dur = job.source.duration;
    for (let p = 0; p <= 1.001; p += 0.04) {
      job.output = { ...job.output, status: "running", progress: Math.min(1, +p.toFixed(2)), etaSec: Math.round((1 - p) * dur * 0.9) };
      emit(job.id, "output", job.output);
      await wait(140 / speed);
    }
    const dir = `/Users/demo/selects/.selects/jobs/${job.id}`;
    job.output = {
      status: "done", progress: 1, path: "output/captioned.mp4", srt: "output/captioned.srt", vtt: "output/captioned.vtt", wallSec: Math.round(dur * 0.9),
      file: `${dir}/output/captioned.mp4`, srtFile: `${dir}/output/captioned.srt`, vttFile: `${dir}/output/captioned.vtt`,
    };
    emit(job.id, "output", job.output);
    job.stage = "done";
    job.stages.render = { ...job.stages.render, status: "done", progress: 1, endedAt: new Date().toISOString() };
    emit(job.id, "stage", { stage: job.stage, stages: job.stages });
  }

  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const summary = (j) => {
    const { _candidates, _emitted, _words, _captions, _faces, _verdict, ...rest } = j;
    return clone(rest);
  };

  return {
    mock: true,
    async health() {
      await wait(120);
      return healthBad
        ? { ok: false, whisper: false, ollama: false, models: [], diskFreeGb: 3.1 }
        : { ok: true, whisper: true, ollama: true, models: ["gemma3-4b-hf:latest", "qwen2.5:0.5b", "phi3:mini"], diskFreeGb: 34.6 };
    },
    async models() {
      await wait(100);
      return [
        // The figures measured on the build machine (.selects/models.json).
        { name: "qwen2.5:0.5b", sizeGb: 0.4, measuredSecPerCandidate: 14.89 },
        { name: "phi3:mini", sizeGb: 2.18, measuredSecPerCandidate: null },
        { name: "gemma3-4b-hf:latest", sizeGb: 2.49, measuredSecPerCandidate: 80.05 },
      ];
    },
    async listJobs() {
      await wait(80);
      return [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(summary);
    },
    async getJob(id) {
      await wait(60);
      if (!jobs.has(id) && id.startsWith("j_live")) newJob(id, "/Users/demo/Movies/retries-talk-2026.mp4");
      const job = jobs.get(id);
      if (!job) throw Object.assign(new Error("No job with that id."), { status: 404 });
      return summary(job);
    },
    async getWords(id) {
      await wait(80);
      const job = jobs.get(id);
      if (!job) return [];
      const ws = wordsOf(job);
      return job._emitted != null ? ws.slice(0, job._emitted) : ws;
    },
    async createJob(path, settings, { queueOnly = false } = {}) {
      await wait(300);
      if (!/\.(mp4|mov|mkv|webm|m4v)$/i.test(path)) {
        throw Object.assign(new Error(`Selects cannot open ${path.split("/").pop()}. Choose an MP4, MOV, MKV or WebM video.`), { status: 400 });
      }
      const id = "j_live_" + Math.random().toString(36).slice(2, 6);
      if (queueOnly || queue.running) {
        // Another job holds the machine: this one waits its turn, as in the core's queue.
        const job = makeJob({ id, name: path.split("/").pop(), stage: "queued", createdAt: new Date().toISOString() });
        job.source = { ...job.source, path, duration: null };
        job.settings = { ...job.settings, ...settings };
        for (const k of Object.keys(job.stages)) job.stages[k] = { status: "pending", startedAt: null, endedAt: null, progress: 0, etaSec: null, note: null };
        job.candidates = [];
        jobs.set(id, job);
        queue.items.push({ jobId: id, kind: "analyze", ids: null, preset: null, addedAt: job.createdAt });
        return summary(job);
      }
      return summary(newJob(id, path, settings));
    },
    async patchCandidate(id, cid, body) {
      await wait(140);
      const job = jobs.get(id);
      const c = job.candidates.find((x) => x.id === cid);
      if (body.status) c.status = body.status;
      if (body.faithful === "accept" && c.faithful) c.faithful = { ...c.faithful, accepted: true };
      if (body.faithful === "reset" && c.faithful) {
        const { accepted, applied, ...rest } = c.faithful;
        c.faithful = rest;
      }
      if (body.faithful === "fix" && c.faithful?.fix) {
        body = { ...body, start: c.faithful.fix.start ?? c.start, end: c.faithful.fix.end ?? c.end };
      }
      if ("blur" in body) {
        c.blur = body.blur;
        if (c.render?.status === "done") c.render.stale = true;
      }
      if (body.start != null || body.end != null) {
        const ends = [], starts = [];
        let next = true;
        for (const w of words) {
          if (next) starts.push(w.s);
          next = /[.?!]$/.test(w.w);
          if (next) ends.push(w.e);
        }
        const near = (list, t) => list.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
        let s = near(starts, body.start ?? c.start);
        let e = near(ends, body.end ?? c.end);
        if (e - s < 5) e = ends.find((x) => x > s + 5) ?? e;
        c.start = s;
        c.end = e;
        c.trimmed = true;
        const idx = words.findIndex((w) => w.s >= s);
        c.text = words.filter((w) => w.s >= s && w.e <= e + 0.01).map((w) => w.w).join(" ");
        c.hook = c.text.split(/(?<=[.?!])\s/)[0] || words[idx]?.w;
        // the core checks the new cut again; here, taking the fix settles it
        const fx = c.faithful?.fix;
        if (fx && c.start <= (fx.start ?? c.start) + 0.05 && c.end >= (fx.end ?? c.end) - 0.05) c.faithful = { ...c.faithful, applied: true };
      }
      return clone(c);
    },
    async render(id, ids) {
      await wait(150);
      const job = jobs.get(id);
      if (job.settings?.mode === "caption") {
        runOutput(job);
        return { queued: true };
      }
      const list = ids || job.candidates.filter((c) => c.status === "approved").map((c) => c.id);
      runRender(job, list);
      return null;
    },
    async approveTop(id, top, { render = false, preset } = {}) {
      await wait(160);
      const job = jobs.get(id);
      const n = Math.floor(Number(top));
      if (!(n >= 1)) throw Object.assign(new Error("top must be a whole number of clips, 1 or more."), { status: 400 });
      let approved = 0;
      for (const c of [...job.candidates].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))) {
        if (approved >= n) break;
        if (c.status === "skipped") continue;
        c.status = "approved";
        approved++;
      }
      const ids = job.candidates.filter((c) => c.status === "approved").map((c) => c.id);
      if (render && ids.length) runRender(job, ids);
      return { approved: ids.length, candidates: clone(job.candidates) };
    },
    async resume(id, body = {}) {
      await wait(150);
      const job = jobs.get(id);
      job.error = null;
      job.stage = "transcribing";
      if (body.force) {
        job.settings.qualityGate = false;
        job.stages.transcribe.status = "done";
        job._emitted = null;
        job._candidates = makeJob({ id }).candidates.filter((c) => c.end < job.source.duration);
      }
      sims.set(id, runSim(job));
      return summary(job);
    },
    async retryKit(id, cid) {
      await wait(80);
      return { queued: true, id: cid };
    },
    async getKit(id, cid) {
      await wait(90);
      const job = jobs.get(id);
      const c = job?.candidates.find((x) => x.id === cid);
      if (!c?.render?.kit) throw Object.assign(new Error("This clip has no posting kit yet. Render it first."), { status: 404 });
      return kitFor(job, c);
    },
    async patchJob(id, settings) {
      await wait(150);
      const job = jobs.get(id);
      job.settings = { ...job.settings, ...Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, v === "" ? null : v])) };
      if (settings.audiogram?.bg === "cover") job.settings.audiogram = { bg: "cover", cover: "cover", coverAt: job.settings.audiogram?.coverAt };
      emit(id, "job", job);
      return summary(job);
    },
    async setCover(id, file) {
      await wait(120);
      const job = jobs.get(id);
      if (mockCover) URL.revokeObjectURL(mockCover);
      mockCover = URL.createObjectURL(file);
      job.settings.audiogram = { bg: "cover", cover: "cover", coverAt: new Date().toISOString() };
      emit(id, "job", job);
      return summary(job);
    },
    coverUrl: () => mockCover,
    // the mock's meter follows its words (the real engines measure the recording)
    async levels(id, start, end) {
      const fps = 30;
      const n = Math.ceil((end - start) * fps);
      const v = new Float32Array(n);
      for (const w of words) {
        if (w.e < start || w.s > end) continue;
        for (let f = Math.max(0, Math.floor((w.s - start) * fps)); f < Math.min(n, Math.ceil((w.e - start) * fps)); f++) v[f] = 0.55 + 0.4 * Math.abs(Math.sin(f * 0.9 + w.s));
      }
      const mouth = new Float32Array(n);
      let m = 0;
      for (let i = 0; i < n; i++) mouth[i] = m = v[i] > m ? m + (v[i] - m) * 0.75 : m * 0.72 + v[i] * 0.28;
      return { fps, start, v, mouth };
    },
    async asrModels() {
      await wait(60);
      return [
        { name: "base.en", sizeMb: 141, english: true },
        { name: "small.en", sizeMb: 465, english: true },
        { name: "medium.en-q5_0", sizeMb: 514, english: true },
        { name: "small-nigerian-accent", sizeMb: 465, english: true },
        { name: "base", sizeMb: 141, english: false },
      ];
    },
    async getCaptions(id) {
      await wait(120);
      const job = jobs.get(id);
      if (!job) throw Object.assign(new Error("No job with that id."), { status: 404 });
      const c = captionsOf(job);
      return { edited: c.edited, cues: clone(c.cues), lowP: 0.5 };
    },
    async putCaptions(id, cues) {
      await wait(180);
      const job = jobs.get(id);
      const c = captionsOf(job);
      c.cues = applyCueEdits(c.cues, cues);
      c.edited = true;
      for (const x of job.candidates || []) if (x.render?.status === "done") x.render.stale = true;
      if (job.output?.status === "done") job.output.stale = true;
      emit(id, "captions", { cues: c.cues.length, edited: true });
      c.updatedAt = new Date().toISOString();
      return { edited: true, cues: clone(c.cues), lowP: 0.5 };
    },
    async resetCaptions(id) {
      await wait(160);
      const job = jobs.get(id);
      job._captions = null;
      const c = captionsOf(job);
      return { edited: false, cues: clone(c.cues), lowP: 0.5 };
    },
    async setLanguage(id, { language, asrModel } = {}) {
      await wait(200);
      const job = jobs.get(id);
      job.settings = { ...job.settings, language, ...(asrModel ? { asrModel } : {}) };
      // The person said what was spoken: re-transcribe with it. In the demo the
      // second pass hears the speech cleanly.
      if (job.settings.mode === "caption") job._words = accentedWords(words.filter((w) => w.e < job.source.duration - 2), 0.02);
      else {
        job._words = null;
        job.source.duration = duration;
        job.thumbs = { ...job.thumbs, interval: duration / (job.thumbs?.count || 60) };
      }
      job._verdict = "good";
      job._captions = null;
      job.error = null;
      job.candidates = [];
      job._candidates = makeJob({ id }).candidates;
      job.transcriptQuality = null;
      job._emitted = 0;
      for (const k of ["language", "transcribe", "candidates", "judge"]) {
        if (job.stages[k]) job.stages[k] = { status: job.stages[k].status === "skipped" ? "skipped" : "pending", startedAt: null, endedAt: null, progress: 0, etaSec: null, note: null };
      }
      job.stage = "language";
      emit(id, "job", summary(job));
      sims.set(id, runSim(job));
      return null;
    },
    async detectFaces(id) {
      await wait(160);
      if (facesUnsupported) {
        throw Object.assign(new Error("Face detection needs macOS (it uses Apple Vision). Draw boxes over faces by hand instead."), { status: 501 });
      }
      const job = jobs.get(id);
      setTimeout(() => {
        job._faces = facesFor(job);
        emit(id, "faces", job._faces);
      }, 2400 / speed);
      return null;
    },
    async getFaces(id) {
      await wait(90);
      const job = jobs.get(id);
      if (!job?._faces) throw Object.assign(new Error("No faces found yet. Run face detection first."), { status: 404 });
      return clone(job._faces);
    },
    captionsFileUrl(id, ext) {
      const job = jobs.get(id);
      const cues = job ? captionsOf(job).cues : [];
      const text = ext === "vtt" ? toVtt(cues) : toSrt(cues);
      return `data:text/${ext === "vtt" ? "vtt" : "plain"};charset=utf-8,${encodeURIComponent(text)}`;
    },
    outputUrl: () => null,
    frameUrl: (id, t) => {
      const job = jobs.get(id);
      const d = job?.source?.duration || 1;
      return frameSvg(Math.min(60, Math.floor((t / d) * 60) + 1), 60);
    },
    async queue() {
      await wait(60);
      return clone(queue);
    },
    async locate(name) {
      await wait(200);
      return "/Users/demo/Movies/" + name;
    },
    events(id, onEvent) {
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id).add(onEvent);
      return () => listeners.get(id)?.delete(onEvent);
    },
    thumbUrl: (id, n) => frameSvg(n, 60),
    sourceUrl: () => null,
    clipUrl: () => null,
  };
}
