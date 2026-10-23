// The in-browser engine: the same job lifecycle as src/core/job.mjs (probe, transcribe,
// candidates, judge, ready, render), with the same Job, Candidate and event shapes
// (notes/CONTRACTS.md), run entirely in this tab. Jobs live in memory for the page's life.
import { attributionLine, captionWithCredit, mediaReminder, normaliseLicense } from "../core/attribution.mjs";
import { selectCandidates } from "../core/select.mjs";
import { applyCueEdits, cuesFromWords, toSrt, toVtt } from "../core/cues.mjs";
import { nigerianCues } from "../core/langid/cues.mjs";
import { ng5Predict } from "../core/langid/ng5.mjs";
import { splitNonSpeech } from "../core/nonspeech.mjs";
import { orderByFaithful } from "../core/faithful-core.mjs";
import { applyMadeFor, clipCaptionStyle } from "../core/madefor.mjs";
import { applyQualityBar, qualityVerdict } from "../core/rank.mjs";
import { snapTrim, toSentences } from "../core/sentences.mjs";
import { judgeIdentity, judgmentSignature, kitSignature, selectionSignature, transcriptHash, transcriptSignature } from "../core/signatures.mjs";
import { kitSourceFromCaptions, plainKit } from "../core/kit-core.mjs";
import { applyDecisions, captureDecisions } from "../core/decisions.mjs";
import { loadAsr, resolveSpeech, transcribePcm } from "./asr.js";
import { canJudgeInTab } from "./devices.js";
import { publishPicks, transcribeLight } from "./light-run.js";
import { cachedFetch } from "./cache.js";
import { faithfulRound, judgeShortlist, listwiseRound, makeKit, rankAndCurve } from "./judge.js";
import { audioDecodeUnsupported, decodeAudio16k, loudnessFromPcm, makeThumbs, probeFile } from "./media.js";
import { decodeAudioSegments, longVideoNote, pcmStore } from "./pcm.js";
import { MODELS } from "./models.js";
import { PROMPTS } from "./prompts.js";
import { clipGainDb, renderInWorker } from "./render.js";
import { keepAwake, notifyDone, titleProgress } from "./device.js";
import { downloadAdvice } from "./devices.js";
import { contentKey, createJobStore, dropVideo, indexedDbBackend, keepVideo, keptVideo, memoryBackend, resumePoint } from "./store.js";

export const STAGES = ["probe", "language", "transcribe", "candidates", "judge", "render"];
/** What Private mode says on a phone, where the in-tab judge does not run (devices.js, inTabJudgeFits). */
export const PHONE_JUDGE_NOTE = "Ranked by the first-stage score and the cut checks, without Gemma: it is too big for a phone's browser. Smart mode adds Gemma's judgment.";
const STAGE_LABEL = { probe: "probing", language: "transcribing", transcribe: "transcribing", candidates: "candidates", judge: "judging", render: "rendering" };

/** Desktop defaults (src/core/config.mjs) with the browser's own: judge and kit run on whichever backend is chosen. */
export const DEFAULT_SETTINGS = {
  // minLen and maxLen come from the "made for" preset (src/core/madefor.mjs) unless set
  model: null, k: 5, madeFor: "shorts", faithful: "model", preset: "shorts", judgeN: 8, listwise: true,
  credit: null, license: null, sourceUrl: null, mode: "clips", language: "en", captions: true, kit: "model",
  asrDevice: "auto", // "auto" (WebGPU when there is an adapter), "webgpu" or "wasm"
  asrModel: "auto", // "auto" (tiny.en on phones and small-memory devices, base.en elsewhere), "base" or "tiny"
};

const now = () => new Date().toISOString();
const freshStage = () => ({ status: "pending", startedAt: null, endedAt: null, progress: 0, etaSec: null, note: "" });
const newId = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `j_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${Math.random().toString(36).slice(2, 6)}`;
};

// Above this, the audio is decoded and transcribed in 10-minute segments kept in OPFS
// (pcm.js), so the tab never holds the whole video's PCM. Below it, one piece in memory.
const LONG_SEC = 20 * 60;

export class Engine {
  constructor({ getJudge, getFallback, getTranscriber, getProfile, store, render = renderInWorker, inTabJudge = canJudgeInTab } = {}) {
    this.store = store || createJobStore(typeof indexedDB !== "undefined" ? indexedDbBackend() : memoryBackend());
    // getProfile(): the adapter's choices now (privacy mode, judge route, key fingerprints),
    // frozen onto each job when it starts (frozenProfile) and passed to every call below, so a
    // mode switch or a key change affects only jobs started after it.
    this.getProfile = getProfile;
    // getJudge(profile): Promise<backend> from llm.js, for that job's mode.
    // getFallback(profile): Promise<backend>, the on-device judge Smart mode falls back to.
    this.getJudge = getJudge;
    this.getFallback = getFallback;
    // inTabJudge(): Promise<boolean>, false on phones and small-memory devices (devices.js)
    this.inTabJudge = inTabJudge;
    // getTranscriber(profile): Promise<transcriber|null> (transcribers.js); a remote one is Light mode,
    // null keeps whisper on this device
    this.getTranscriber = getTranscriber;
    this.renderClip = render; // renderInWorker; tests pass a fake
    this.jobs = new Map(); // id -> { job, file, words, events, pcm, pcmSegs, captions, thumbs, clips, kits }
    // long videos keep their 16 kHz audio in 10-minute segments in OPFS, not in memory
    this.pcm = pcmStore();
    this.listeners = new Map(); // id -> Set(fn)
    this.timings = [];
  }

  on(id, fn) {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id).add(fn);
    return () => this.listeners.get(id)?.delete(fn);
  }

  emit(id, type, data) {
    for (const fn of this.listeners.get(id) || []) {
      try {
        fn(type, data);
      } catch (e) {
        console.error(e);
      }
    }
    for (const fn of this.listeners.get("*") || []) fn(type, data, id);
  }

  rec(id) {
    const r = this.jobs.get(id);
    if (!r) throw Object.assign(new Error(`No job called ${id}.`), { status: 404 });
    return r;
  }

  /**
   * Create a job from a File and start it. When this browser has already worked on the
   * same file (same content key), the saved job is picked up from its last finished stage
   * instead. Returns the Job.
   */
  async createJob(file, settings = {}) {
    if (!(file instanceof Blob)) throw Object.assign(new Error("Choose a video file."), { status: 400, hint: "Drop a video on the page or pick one. It stays on this device." });
    const key = await contentKey(file);
    const saved = await this.store.load(key).catch(() => null);
    const clean = Object.fromEntries(Object.entries(settings || {}).filter(([, v]) => v !== undefined && v !== null));
    const job = saved?.job ? structuredClone(saved.job) : this.newJob(file, clean);
    if (saved?.job) {
      job.settings = { ...job.settings, ...clean };
      job.resumed = { from: resumePoint(saved).from, savedAt: saved.savedAt };
    }
    // the choices it runs with, frozen now: choosing the video again starts it with the current ones
    job.profile = this.getProfile ? { ...this.getProfile() } : null;
    job.key = key;
    this.jobs.set(job.id, this.blankRec(job, file, key));
    this.start(job.id);
    return structuredClone(job);
  }

  start(id) {
    const r = this.rec(id);
    r.active = true;
    r.running = this.run(id).finally(() => (r.active = false));
    return r.running;
  }

  /**
   * The person's answer when Smart mode is not answering and the private model is not saved
   * (job.error.code "smart_unavailable"): "retry" Smart mode, use the "preliminary" ranking
   * (the first-stage score, no model), or "download" the private model. Runs the job again;
   * everything already done (the transcript, the shortlist) is reused.
   */
  async chooseJudge(id, choice) {
    const r = this.rec(id);
    if (!["retry", "preliminary", "download", "device"].includes(choice)) throw Object.assign(new Error("Choose retry, preliminary, download or device."), { status: 400 });
    if (r.active) throw Object.assign(new Error("This job is still running."), { status: 409, hint: "Wait for it to stop, then choose." });
    // Light mode's free transcriber was busy (job.error.code "light_busy"): "device" transcribes here
    if (choice === "device") r.asrChoice = "device";
    else r.judgeChoice = choice === "retry" ? null : choice;
    this.start(id);
    return structuredClone(r.job);
  }

  /** Resolves when the job's run, its saves and its posting kits have settled (tests, and callers that need to wait). */
  async idle(id) {
    const r = this.rec(id);
    for (;;) {
      const pending = [r.running, r.saving, r.kitQueue].filter(Boolean);
      await Promise.all(pending.map((p) => p.catch?.(() => {}) ?? p));
      if ([r.running, r.saving, r.kitQueue].filter(Boolean).every((p, i) => p === pending[i])) return;
    }
  }

  newJob(file, clean) {
    const job = {
      id: newId(),
      source: { path: null, name: file?.name || "video", duration: null, width: null, height: null, fps: null },
      settings: applyMadeFor({ ...DEFAULT_SETTINGS, ...clean, ...(clean.license ? { license: normaliseLicense(clean.license) ?? clean.license } : {}) }),
      stage: "queued",
      stages: Object.fromEntries(STAGES.map((s) => [s, freshStage()])),
      error: null,
      words: null,
      candidates: [],
      curve: [],
      thumbs: null,
      timings: {},
      runtime: { where: "browser" },
      createdAt: now(),
      updatedAt: now(),
    };
    job.stages.language.status = "skipped";
    return job;
  }

  blankRec(job, file, key) {
    return { job, key, file: file || null, words: [], events: [], pcm: null, captions: null, thumbs: [], clips: {}, kits: {}, decisions: {}, sourceUrl: file ? URL.createObjectURL(file) : null };
  }

  /** Jobs saved on this device, newest first: { key, id, name, size, savedAt, from, finished }. */
  listSaved() {
    return this.store.list();
  }

  /**
   * Open a saved job. Without a file, Selects uses its own kept copy of the video when it
   * has one; otherwise everything after transcription still works (review, approvals,
   * trims, judging), and rendering asks for the file again (attachFile).
   */
  async openSaved(key, file = null) {
    const saved = await this.store.load(key);
    if (!saved) throw Object.assign(new Error("That job is no longer saved on this device."), { status: 404 });
    if (file && (await contentKey(file)) !== key) throw Object.assign(new Error("This is not the same video file."), { status: 409, hint: `Choose "${saved.name}" again, the exact file you used before.` });
    const f = file || (await keptVideo(key, saved.name));
    const existing = [...this.jobs.values()].find((r) => r.key === key);
    if (existing) {
      if (f && !existing.file) this.attach(existing, f);
      return structuredClone(existing.job);
    }
    const job = structuredClone(saved.job);
    job.key = key;
    job.resumed = { from: resumePoint(saved).from, savedAt: saved.savedAt, withFile: !!f };
    // a saved job keeps the choices it started with (older saves had none: take today's)
    job.profile ??= this.getProfile ? { ...this.getProfile() } : null;
    this.jobs.set(job.id, this.blankRec(job, f, key));
    this.start(job.id);
    return structuredClone(job);
  }

  attach(r, file) {
    r.file = file;
    if (r.sourceUrl) URL.revokeObjectURL(r.sourceUrl);
    r.sourceUrl = URL.createObjectURL(file);
  }

  /** Give a resumed job its video again (verified by content key), for thumbnails and rendering. */
  async attachFile(id, file) {
    const r = this.rec(id);
    if ((await contentKey(file)) !== r.key) throw Object.assign(new Error("This is not the same video file."), { status: 409, hint: `Choose "${r.job.source.name}" again, the exact file you used before.` });
    this.attach(r, file);
    if (!r.thumbs.length && r.job.source.duration) {
      const t = await makeThumbs(file, r.job.source.duration).catch(() => null);
      if (t) {
        r.thumbs = t.urls;
        r.job.thumbs = { count: t.count, interval: t.interval, pattern: "blob" };
      }
    }
    this.emit(id, "job", structuredClone(r.job));
    return structuredClone(r.job);
  }

  async forgetSaved(key) {
    await this.store.remove(key);
    await dropVideo(key);
    await this.pcm.drop(key);
  }

  /** 16 kHz mono audio between two times: from memory for short videos, from the saved segments for long ones. */
  async pcmRange(r, start, end) {
    if (r.pcm) return r.pcm.subarray(Math.max(0, Math.floor(start * 16000)), Math.ceil(end * 16000));
    if (r.pcmSegs?.length) return this.pcm.range(r.key, r.pcmSegs, start, end);
    return null;
  }

  getJob(id) {
    return structuredClone(this.rec(id).job);
  }

  listJobs() {
    return [...this.jobs.values()].map((r) => structuredClone(r.job)).reverse();
  }

  getWords(id) {
    return this.rec(id).words.slice();
  }

  /** Save after a stage (or just the job, for a person's decisions), with the stage's signature. Never fatal. */
  async save(r, stage, parts, sigs) {
    try {
      await this.store.saveStage(r.key, r.job, stage, parts, sigs);
    } catch (e) {
      r.job.saveError = e.message; // full storage: the job still runs, it just will not resume
    }
  }

  /**
   * The job's frozen choices: its profile (from the adapter when it started) plus the device
   * rule's in-tab judge decision, made once. Every stage reads this, never the page's mode.
   */
  async frozenProfile(r) {
    if (!r.frozen) {
      const p = r.job.profile || {};
      // inTabJudge() answers true/false (tests) or { fits, why, note } (devices.js, canJudgeInTab)
      const fit = p.inTabJudge != null ? p.inTabJudge : await this.inTabJudge({ prefer: p.prefer }).catch(() => true);
      const inTabJudge = typeof fit === "object" ? fit.fits : fit;
      r.job.profile = { ...p, inTabJudge, ...(typeof fit === "object" && !fit.fits ? { inTabJudgeWhyNot: fit.why, judgeNote: fit.note, judgeBytes: fit.bytes } : {}) };
      r.frozen = Object.freeze({ ...r.job.profile });
    }
    return r.frozen;
  }

  async run(id) {
    const r = this.rec(id);
    const job = r.job;
    const saved = (await this.store.load(r.key).catch(() => null)) || { stages: {} };
    const has = (s) => saved.stages?.[s] === "done";
    const sigs = saved.sigs || {};
    job.error = null;
    if (saved.job) await this.restoreExtras(r);
    // a person's decisions, kept apart from the judgment (older saves kept them only on the candidates)
    r.decisions = (await this.store.part(r.key, "decisions").catch(() => null)) || captureDecisions(saved.job?.candidates || []);
    let current = null;
    const awake = typeof document !== "undefined" ? keepAwake() : null;
    const title = typeof document !== "undefined" ? titleProgress("Selects") : null;
    const WEIGHT = { probe: [0, 0.02], transcribe: [0.02, 0.6], candidates: [0.6, 0.61], judge: [0.61, 1] };
    const begin = (s) => {
      current = s;
      job.stage = STAGE_LABEL[s];
      job.stages[s] = { ...freshStage(), status: "running", startedAt: now() };
      job.updatedAt = now();
      this.emit(id, "stage", { stage: job.stage, name: s, state: { ...job.stages[s] } });
    };
    const progress = (s, p) => {
      Object.assign(job.stages[s], { progress: +(p.progress ?? 0).toFixed(3), etaSec: p.etaSec ?? null, ...(p.note ? { note: p.note } : {}) });
      const [a, b] = WEIGHT[s] || [0, 1];
      title?.set(a + (b - a) * (p.progress ?? 0));
      this.emit(id, "progress", { name: s, ...job.stages[s], ...(p.speed != null ? { speed: +p.speed.toFixed(2) } : {}), ...(p.download ? { download: p.download } : {}) });
    };
    const finish = (s, note) => {
      Object.assign(job.stages[s], { status: "done", endedAt: now(), progress: 1, etaSec: 0, ...(note ? { note } : {}) });
      job.timings[s] = +((Date.parse(job.stages[s].endedAt) - Date.parse(job.stages[s].startedAt)) / 1000).toFixed(1);
      this.emit(id, "stage", { stage: job.stage, name: s, state: { ...job.stages[s] } });
    };
    const reuse = (s, note) => {
      job.stages[s] = { ...freshStage(), ...(job.stages[s] || {}), status: "done", progress: 1, etaSec: 0, note: `${note} (saved on this device)` };
      this.emit(id, "stage", { stage: STAGE_LABEL[s], name: s, state: { ...job.stages[s] } });
    };
    const needFile = () => {
      if (!r.file) throw Object.assign(new Error("Selects needs the video again to finish this step."), { hint: `Choose "${job.source.name}" again. It is checked against the saved job, and nothing is uploaded.`, needsFile: true });
    };
    try {
      // 1. probe and filmstrip
      if (has("probe") && saved.job?.source?.duration) {
        job.source = saved.job.source;
        reuse("probe", `${Math.round(job.source.duration)} s`);
      } else {
        needFile();
        begin("probe");
        job.source = { ...job.source, ...(await probeFile(r.file)) };
        if (!job.source.audioStreams?.length) throw Object.assign(new Error("This video has no audio track."), { hint: "Selects finds clips from speech. Choose a video with someone talking." });
        // say so at the first step, before any download, when this browser cannot read sound at all
        const noDecoder = audioDecodeUnsupported();
        if (noDecoder) throw noDecoder;
        finish("probe", `${Math.round(job.source.duration)} s, ${job.source.uprightWidth || "?"}x${job.source.uprightHeight || "?"}`);
        await this.save(r, "probe");
      }
      // the honest limit: phones over about 30 minutes, any tab over an hour
      job.warning = longVideoNote(job.source.duration) ?? (job.source.duration > 20 * 60 ? "This video is longer than 20 minutes, so transcribing it in the tab takes a while. The desktop app is faster." : null);
      if (r.file) {
        try {
          const t = await makeThumbs(r.file, job.source.duration);
          r.thumbs = t.urls;
          job.thumbs = { count: t.count, interval: t.interval, pattern: "blob" };
        } catch {
          job.thumbs = { count: 0, interval: 0, pattern: "blob" };
        }
        // keep a copy for resuming without the file, when it fits (not awaited: it is only a copy)
        keepVideo(r.key, r.file).then((ok) => (job.videoKept = ok));
      }
      this.emit(id, "job", structuredClone(job));

      // 2. transcribe: decode audio, load whisper, run it window by window. Reused when it was
      // made from this file with this speech model, precision, device setting and language (a
      // transcript saved before signatures existed is reused: those never varied in the browser)
      const speech = await resolveSpeech({ device: job.settings.asrDevice || "auto", speech: job.settings.asrModel || "auto" });
      const deviceSig = transcriptSignature({ source: r.key, model: speech.model.id, language: "en", device: job.settings.asrDevice || "auto", dtype: speech.model.dtype });
      // Light mode: a remote transcriber (it also takes a transcript already made on this device)
      const P = await this.frozenProfile(r);
      const remote = this.getTranscriber ? await this.getTranscriber(P) : null;
      // one signature for Light mode's whisper, whichever route sent the audio (the shared proxy or the person's own key)
      const tSig = remote ? transcriptSignature({ source: r.key, model: `light:${remote.model}`, language: "en" }) : deviceSig;
      if (has("transcribe") && (sigs.transcribe == null || sigs.transcribe === tSig || (remote && sigs.transcribe === deviceSig))) {
        const [words, events, loudness, pcm, pcmSegs] = await Promise.all(["words", "events", "loudness", "pcm", "pcmSegs"].map((n) => this.store.part(r.key, n)));
        r.words = words || [];
        r.events = events || [];
        r.pcm = pcm || null;
        r.pcmSegs = pcmSegs || null;
        job.loudness = loudness || null;
        if (r.words.length) this.emit(id, "words", r.words);
        reuse("transcribe", `${r.words.length} words`);
      } else if (remote) {
        needFile();
        begin("transcribe");
        const choice = r.asrChoice ?? null;
        r.asrChoice = null;
        await transcribeLight(this, r, remote, { progress, finish, sig: tSig, choice, speech });
      } else if (job.source.duration > LONG_SEC) {
        needFile();
        begin("transcribe");
        await this.transcribeLong(r, { progress, finish, sig: tSig, model: speech.model });
      } else {
        needFile();
        begin("transcribe");
        r.words = [];
        r.events = [];
        r.picksAt = null;
        job.preliminary = null;
        const t0 = performance.now();
        progress("transcribe", { progress: 0, note: "reading the audio" });
        r.pcm = await decodeAudio16k(r.file, { duration: job.source.duration, onProgress: (p) => progress("transcribe", { progress: p * 0.05, note: "reading the audio" }) });
        const decodeSec = +((performance.now() - t0) / 1000).toFixed(1);
        const files = {};
        const asr = await loadAsr({
          device: job.settings.asrDevice || "auto",
          model: speech.model,
          onDownload: (m) => {
            if (m.total) files[m.file] = { loaded: m.loaded, total: m.total };
            const loaded = Object.values(files).reduce((a, f) => a + f.loaded, 0);
            const total = Object.values(files).reduce((a, f) => a + f.total, 0);
            progress("transcribe", { progress: 0.05, note: `getting the speech model: ${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB`, download: { loaded, total } });
          },
        });
        progress("transcribe", { progress: 0.06, note: `transcribing on ${asr.device === "webgpu" ? "the GPU" : "the CPU"}` });
        const t1 = performance.now();
        const res = await transcribePcm(r.pcm, {
          onChunk: (m) => {
            const split = splitNonSpeech(m.words);
            r.words.push(...split.words);
            r.events.push(...split.events);
            if (split.words.length) this.emit(id, "words", split.words);
            publishPicks(this, r, m.processed, r.pcm); // early picks after the first minutes
            const wall = (performance.now() - t1) / 1000;
            const speed = m.processed / Math.max(0.1, wall);
            const left = job.source.duration - m.processed;
            progress("transcribe", { progress: 0.06 + 0.94 * (m.processed / job.source.duration), speed, etaSec: Math.round(left / speed), note: `transcribing at ${speed.toFixed(1)}x real time` });
          },
        });
        job.loudness = loudnessFromPcm(r.pcm);
        job.asr = { provider: "transformers.js", model: speech.model.id, device: asr.device, language: "en", decodeSec, loadSec: asr.loadSec, sec: res.wallSec, speed: +(job.source.duration / Math.max(0.1, res.wallSec)).toFixed(2), chunks: res.chunks ?? null };
        // the language check the browser can afford: lid-lite-5 reads the English text for
        // signs of Nigerian languages or Pidgin, which the desktop app's accent model handles
        job.language = await this.languageNote(r.words);
        finish("transcribe", `${r.words.length} words, ${job.asr.speed}x real time on ${asr.device === "webgpu" ? "the GPU" : "the CPU"}`);
        await this.save(r, "transcribe", { words: r.words, events: r.events, loudness: job.loudness, pcm: r.pcm }, { transcribe: tSig });
      }

      // 3. candidates: reused only when the saved shortlist was selected from this transcript
      // with these settings (signatures.mjs). The browser has no transcript-quality check yet,
      // so there are no loop stretches to keep out (README, Limits).
      const selSettings = { ...job.settings, judgeN: job.settings.judgeN ?? 8 };
      const exclude = [];
      const selSig = selectionSignature({ transcript: transcriptHash({ words: r.words, events: r.events, loudness: job.loudness }), settings: selSettings, duration: job.source.duration, exclude });
      let short;
      const savedShort = has("candidates") && sigs.candidates === selSig ? await this.store.part(r.key, "shortlist") : null;
      if (savedShort) {
        short = savedShort;
        reuse("candidates", `${short.length} go to the judge`);
      } else {
        begin("candidates");
        // the same selection path as the desktop app and the eval (src/core/select.mjs);
        // never fewer windows than k clips need (30 clips cannot come out of 8 judged windows)
        const sel = selectCandidates({ words: r.words, events: r.events, loudness: job.loudness, settings: selSettings, duration: job.source.duration, exclude });
        const all = sel.windows;
        short = sel.shortlist;
        job.windows = all.length;
        finish("candidates", `${all.length} windows passed the filter, ${short.length} go to the judge`);
        await this.save(r, "candidates", { shortlist: short }, { candidates: selSig });
      }
      if (job.stages.judge.status !== "done") job.candidates = short;
      this.emit(id, "candidates", { ranked: false, candidates: structuredClone(short) });
      if (!short.length) throw Object.assign(new Error("No clip-sized passages were found."), { hint: "Selects needs at least 20 seconds of continuous speech. Try a longer video, or lower the minimum length." });

      // 4. judge, listwise round, rank, curve: reused only when made from this shortlist by
      // this judge (backend and model) with these prompts and settings. A person's decisions
      // are kept apart and put back on whatever the judge produced.
      current = "judge"; // a judge that cannot be set up (Smart mode without a key) stops this stage
      const asked = await this.getJudge(await this.frozenProfile(r));
      const want = judgmentSignature({ selection: selSig, judge: judgeIdentity(asked), prompts: PROMPTS, settings: job.settings });
      const savedJudgment = has("judge") && sigs.judge === want ? await this.store.part(r.key, "judgment") : null;
      let ranked;
      if (savedJudgment?.candidates) {
        ranked = savedJudgment.candidates;
        r.judged = savedJudgment.judged;
        Object.assign(job, { curve: savedJudgment.curve, verdict: savedJudgment.verdict, listwise: savedJudgment.listwise, faithful: savedJudgment.faithful, judge: savedJudgment.judge });
        reuse("judge", `${savedJudgment.judged.length} clips judged by ${job.judge?.model || "the judge"}`);
      } else {
        begin("judge");
        const { ranked: fresh, llm } = await this.judgeStage(r, short, progress, asked);
        ranked = fresh;
        finish("judge", job.judge.secPerCandidate ? `${r.judged.length} clips judged, ${job.judge.secPerCandidate} s each` : `${r.judged.length} clips judged`);
        // signed with the judge that actually did the work (Smart mode can fall back to the device)
        const made = judgmentSignature({ selection: selSig, judge: judgeIdentity(llm), prompts: PROMPTS, settings: job.settings });
        await this.save(r, "judge", { judgment: { judged: r.judged, candidates: ranked, curve: job.curve, verdict: job.verdict ?? null, listwise: job.listwise ?? null, faithful: job.faithful ?? null, judge: job.judge } }, { judge: made });
      }
      job.candidates = this.withDecisions(r, ranked);
      this.emit(id, "candidates", { ranked: true, candidates: structuredClone(job.candidates), curve: job.curve });
      job.stage = "ready";
      this.emit(id, "stage", { stage: "ready" });
      await this.save(r, null);
      if (!job.resumed || job.resumed.from !== "ready") notifyDone("Your clips are ready", `${job.candidates.length} clips from ${job.source.name}. Nothing was uploaded.`);
    } catch (e) {
      job.stage = "error";
      if (current && job.stages[current]) Object.assign(job.stages[current], { status: "error", endedAt: now() });
      job.error = { stage: current, message: e?.message || String(e), hint: e?.hint || "Reload the page and try again. Nothing was uploaded.", ...(e?.needsFile ? { needsFile: true } : {}), ...(e?.code ? { code: e.code } : {}), ...(e?.choices ? { choices: e.choices } : {}) };
      console.error(e);
      this.emit(id, "error", job.error);
    } finally {
      awake?.release();
      title?.reset();
    }
    job.updatedAt = now();
    return job;
  }

  /** Captions, posting kits and rendered clips saved earlier for this video. */
  /**
   * Transcribe a long video 10 minutes at a time: decode a segment, keep it in OPFS, send it
   * to whisper, save the words so far, let the segment go. Peak memory stays at about one
   * segment (38 MB of PCM) however long the video is, and a job that stops part way (a
   * closed tab, a frozen phone) resumes at the next segment.
   */
  async transcribeLong(r, { progress, finish, sig, model = MODELS.whisper }) {
    const job = r.job;
    const dur = job.source.duration;
    const partial = (await this.store.part(r.key, "asrPartial").catch(() => null)) || null;
    const segs = partial?.segs || [];
    r.words = partial?.words || [];
    r.events = partial?.events || [];
    const db = partial?.db || [];
    if (r.words.length) this.emit(job.id, "words", r.words);
    const startAt = segs.length ? segs[segs.length - 1].end : 0;
    progress("transcribe", { progress: startAt / dur, note: segs.length ? `carrying on from ${Math.round(startAt / 60)} min` : "reading the audio" });
    const files = {};
    const asr = await loadAsr({
      device: job.settings.asrDevice || "auto",
      model,
      onDownload: (m) => {
        if (m.total) files[m.file] = { loaded: m.loaded, total: m.total };
        const loaded = Object.values(files).reduce((a, f) => a + f.loaded, 0);
        const total = Object.values(files).reduce((a, f) => a + f.total, 0);
        progress("transcribe", { progress: startAt / dur, note: `getting the speech model: ${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB`, download: { loaded, total } });
      },
    });
    const where = asr.device === "webgpu" ? "the GPU" : "the CPU";
    const t0 = performance.now();
    let decodeSec = partial?.decodeSec || 0;
    let td = performance.now();
    for await (const seg of decodeAudioSegments(r.file, { duration: dur, startAt, firstIndex: segs.length })) {
      decodeSec += (performance.now() - td) / 1000;
      await this.pcm.put(r.key, seg.index, seg.pcm);
      await transcribePcm(seg.pcm, {
        onChunk: (m) => {
          const split = splitNonSpeech(m.words.map((w) => ({ ...w, s: +(w.s + seg.start).toFixed(3), e: +(w.e + seg.start).toFixed(3) })));
          r.words.push(...split.words);
          r.events.push(...split.events);
          if (split.words.length) this.emit(job.id, "words", split.words);
          const heard = seg.start + m.processed;
          const wall = (performance.now() - t0) / 1000;
          const speed = (heard - startAt) / Math.max(0.1, wall);
          progress("transcribe", { progress: Math.min(0.999, heard / dur), speed, etaSec: speed > 0 ? Math.round((dur - heard) / speed) : null, note: `transcribing on ${where} at ${speed.toFixed(1)}x real time, part ${seg.index + 1} of about ${Math.ceil(dur / 600)}` });
        },
      });
      db.push(...loudnessFromPcm(seg.pcm).db);
      segs.push({ index: seg.index, start: seg.start, end: seg.end });
      // a checkpoint after every segment: the words so far and where the audio is
      await this.store.savePart(r.key, "asrPartial", { segs, words: r.words, events: r.events, db, decodeSec }).catch(() => {});
      td = performance.now();
    }
    const wallSec = (performance.now() - t0) / 1000;
    r.pcm = null;
    r.pcmSegs = segs;
    job.loudness = { step: 0.5, db };
    job.asr = { provider: "transformers.js", model: model.id, device: asr.device, language: "en", decodeSec: +decodeSec.toFixed(1), loadSec: asr.loadSec, sec: +wallSec.toFixed(1), speed: +((dur - startAt) / Math.max(0.1, wallSec)).toFixed(2), segments: segs.length, pcmIn: this.pcm.kind };
    job.language = await this.languageNote(r.words);
    finish("transcribe", `${r.words.length} words, ${job.asr.speed}x real time on ${where}, in ${segs.length} parts`);
    await this.save(r, "transcribe", { words: r.words, events: r.events, loudness: job.loudness, pcmSegs: segs }, { transcribe: sig });
    await this.store.savePart(r.key, "asrPartial", null).catch(() => {});
  }

  async restoreExtras(r) {
    try {
      const [caps, kits] = await Promise.all([this.store.part(r.key, "captions"), this.store.part(r.key, "kits")]);
      if (caps?.cues) r.captions = caps;
      if (kits) r.kits = kits;
      for (const { cid, preset } of await this.store.clips(r.key)) {
        const c = await this.store.clip(r.key, cid, preset);
        if (!c?.mp4) continue;
        r.clips[`${cid}:${preset}`] = { url: URL.createObjectURL(c.mp4), srtUrl: URL.createObjectURL(new Blob([c.srt || ""], { type: "application/x-subrip" })), bytes: c.mp4.size, start: c.start ?? null, end: c.end ?? null };
      }
      this.attachRenders(r);
      // kits a closed tab left unwritten are written now
      for (const c of r.job.candidates || []) if (c.render?.status === "done" && ["pending", "running"].includes(c.render.kitStatus)) this.queueKit(r, c.id);
    } catch {}
  }

  /**
   * Link saved MP4s and kits to the candidates they were made from. A clip is saved with its
   * start and end, so after a new selection (where an id can name another window) or a trim
   * it is not shown as this candidate's render. Clips saved before that are linked by id, as
   * they always were, but only to a candidate that already had a render.
   */
  attachRenders(r) {
    const same = (x, c) => (x?.start == null ? null : Math.abs(x.start - c.start) < 0.01 && Math.abs(x.end - c.end) < 0.01);
    for (const c of r.job.candidates || []) {
      for (const preset of ["shorts", "preview"]) {
        const field = preset === "preview" ? "preview" : "render";
        const clip = r.clips[`${c.id}:${preset}`];
        const match = clip ? same(clip, c) : false;
        if (match === false || (match === null && !c[field])) {
          if (c[field]?.status === "done" && c[field].path?.startsWith?.("blob:") && !clip) c[field] = null;
          continue;
        }
        c[field] = { ...(c[field]?.status === "done" ? c[field] : { status: "done", progress: 1 }), path: clip.url, srt: clip.srtUrl, bytes: clip.bytes };
        if (field === "render") {
          const k = r.kits[c.id];
          if (k && same(k, c) !== false) {
            c.render.kit ??= `kit:${c.id}`;
            c.title ??= k.title;
          }
        }
      }
    }
  }

  /** Judge the shortlist. Returns { ranked, llm }: the candidates as the judge ranked them (no human decisions) and the backend that judged. */
  async judgeStage(r, short, progress, asked) {
    const job = r.job;
    const P = await this.frozenProfile(r);
    let llm = asked || (await this.getJudge(P));
    const loadOpts = {
      onProgress: (p) =>
        p.secPerCall // measured on this device right after loading (llm.js); about two calls per clip plus one
          ? progress("judge", { progress: 0, etaSec: Math.round(p.secPerCall * (short.length * 2 + 1)), note: `measured on this device: about ${Math.max(1, Math.round((p.secPerCall * (short.length * 2 + 1)) / 60))} minutes to judge ${short.length} clips` })
          : progress("judge", { progress: 0, note: p.cached ? "loading the judge model from this browser's cache" : `getting the judge model: ${Math.round(p.loaded / 1e6)} of ${Math.round(p.total / 1e6)} MB`, download: { loaded: p.loaded, total: p.total } }),
      onWaking: (s) => progress("judge", { progress: 0, note: `waking the Smart mode server (${s} s; a free server sleeps when idle and can take up to a minute)` }),
    };
    // the person's answer to "Smart mode is not answering" (chooseJudge), used once
    const choice = r.judgeChoice ?? null;
    r.judgeChoice = null;
    job.judge = {};
    if (choice === "preliminary") return this.prescoreStage(r, short, progress);
    // phones and small-memory devices never load (or download) the in-tab judge on their own
    const tabFits = P.inTabJudge !== false;
    if (llm.where !== "google" && !tabFits && choice !== "download") return this.prescoreStage(r, short, progress, P.judgeNote || PHONE_JUDGE_NOTE);
    // Smart mode can fall back to the private model, for the whole run if the proxy never
    // wakes or clip by clip when Google's free tier is slow, but only when that model is
    // already in this browser or the person chose to download it: never a surprise 2 GB
    let fb;
    const fallbackBackend = async () => (fb ??= this.getFallback ? await this.getFallback(P).catch(() => null) : null);
    const fallbackReady = async () => {
      if (!tabFits && choice !== "download") return false;
      const b = await fallbackBackend();
      return !!b && (choice === "download" || !!b.loaded || (await b.isCached?.().catch(() => false)) === true);
    };
    let device = null;
    const fallback = this.getFallback
      ? () => (device ??= (async () => {
          const b = await fallbackBackend();
          await b.load?.(loadOpts);
          return b;
        })())
      : null;
    try {
      await llm.load?.(loadOpts);
    } catch (e) {
      if (llm.where !== "google") throw e;
      job.judge.smartError = e.message;
      if (!fallback || !(await fallbackReady())) throw this.smartUnavailable(e, tabFits ? await fallbackBackend() : null);
      const saved = choice !== "download";
      progress("judge", { progress: 0, note: saved ? "Smart mode is not answering, so the clips are judged on this device with the model already saved in this browser" : "Smart mode is not answering, so the private model is downloading, as you chose" });
      llm = await fallback();
      job.judge.note = saved
        ? "Smart mode was not answering, so these clips were judged on this device with the private model already saved in this browser."
        : "Smart mode was not answering, so these clips were judged on this device with the private model you chose to download.";
    }
    const clipFallback = llm.where === "google" && fallback && (await fallbackReady()) ? fallback : null;
    job.settings.model = llm.model;
    Object.assign(job.judge, { backend: llm.id, model: llm.model, where: llm.where, loadSec: llm.loadSec ?? llm.wakeSec ?? null });
    const jr = await judgeShortlist(short, llm, {
      fallback: clipFallback,
      concurrency: llm.where === "google" ? 2 : 1,
      batch: llm.where === "google" && !!job.settings.smartBatch,
      madeFor: job.settings.madeFor,
      onFallback: () => progress("judge", { progress: job.stages.judge.progress, note: "Google's free Gemma was slow, so this clip is being judged on your device" }),
      onProgress: (p) => progress("judge", { ...p, progress: p.progress * 0.8 }),
    });
    let judged = jr.judged;
    Object.assign(job.judge, { fallbacks: jr.fallbacks, calls: jr.calls, secPerCandidate: jr.secPerCandidate });
    if (jr.fallbacks) job.judge.note = `Google's free Gemma was slow, so ${jr.fallbacks} of ${short.length} clips were judged on your device with the model already saved in this browser.`;
    const kept = judged.filter((c) => c && !c.scores).length;
    if (kept && llm.where === "google" && !clipFallback) job.judge.note = `Smart mode could not judge ${kept} of ${short.length} clips, so they keep their first-stage score. Nothing was downloaded.`;
    if (job.settings.listwise !== false && judged.filter((c) => c.scores).length >= 3) {
      progress("judge", { progress: 0.8, note: "comparing the best clips side by side" });
      try {
        const lw = await listwiseRound(judged.filter((c) => c.scores), llm, { n: job.settings.listN ?? 4 });
        const byId = new Map(lw.candidates.map((c) => [c.id, c]));
        judged = judged.map((c) => byId.get(c.id) || c);
        job.listwise = { order: lw.order, reasons: lw.reasons, complete: lw.complete, sec: lw.sec };
      } catch (e) {
        job.listwise = { order: [], reasons: {}, complete: false, error: e.message };
      }
    }
    r.judged = judged;
    let { ranked, curve } = rankAndCurve(judged, { k: job.settings.k, duration: job.source.duration });
    // Faithful cuts: does each top pick still say what the speaker meant? (one call per pick)
    const fmode = job.settings.faithful ?? "model";
    if (fmode !== "off" && ranked.length) {
      progress("judge", { progress: 0.9, note: "checking each pick still says what the speaker meant" });
      const maxLen = job.settings.maxLen ?? 60;
      const fr = await faithfulRound(ranked, llm, { words: r.words, maxLen: Math.max(maxLen * 1.5, maxLen + 15), rulesOnly: fmode === "rules", onProgress: (p) => progress("judge", { ...p, progress: 0.9 + 0.1 * p.progress }) });
      ranked = orderByFaithful(fr.candidates);
      const count = (v) => ranked.filter((c) => c.faithful?.verdict === v).length;
      job.faithful = { mode: fmode, checked: ranked.length, faithful: count("faithful"), check: count("check"), misleading: count("misleading"), ...fr.stats };
    }
    // the quality bar: say plainly when nothing is strong, and offer only the closest 2
    const bar = applyQualityBar(ranked);
    ranked = bar.candidates;
    job.verdict = bar.verdict;
    job.curve = curve;
    return { ranked, llm };
  }

  /**
   * The stop when Smart mode is not answering and the private model is not in this browser:
   * nothing is downloaded until the person chooses (chooseJudge). The download choice carries
   * its size, an estimate on this connection, and a warning on mobile data.
   */
  smartUnavailable(e, device) {
    const choices = [
      { id: "retry", label: "Try Smart mode again" },
      { id: "preliminary", label: "Use the preliminary ranking now", detail: "The clips ranked by the first-stage score (sentence shape, pauses, laughter, loudness), with no model. You can ask for a model's judgment later." },
    ];
    if (device) {
      const a = downloadAdvice(device.bytes || 0);
      choices.push({ id: "download", label: "Download the private model", detail: `${device.label || device.model}, downloaded once and kept in this browser. Nothing is uploaded.`, model: device.model, bytes: a.bytes, estSec: a.estSec, mbps: a.mbps, metered: a.metered, warning: a.warning });
    }
    return Object.assign(new Error("Smart mode is not answering."), {
      code: "smart_unavailable",
      hint: `${e?.hint || e?.message || "The Smart mode server did not answer."} The private model is not saved in this browser yet, so nothing was downloaded.`,
      choices,
    });
  }

  /** The preliminary ranking: the shortlist ranked by its first-stage score, with the rule-only faithful check. No model. */
  async prescoreStage(r, short, progress, note = "These clips are ranked by the first-stage score only, because Smart mode was not answering. Open the video again later for a model's judgment.") {
    const job = r.job;
    progress("judge", { progress: 0.5, note: "ranking by the first-stage score" });
    const judged = short.map((c) => ({ ...c, scores: null, judgeTotal: null, total: c.pre ?? 0, judgedOn: "prescore", reason: "Ranked by the first-stage score (sentence shape, pauses, laughter, loudness), not by a model." }));
    r.judged = judged;
    let { ranked, curve } = rankAndCurve(judged, { k: job.settings.k, duration: job.source.duration });
    if ((job.settings.faithful ?? "model") !== "off" && ranked.length) {
      const maxLen = job.settings.maxLen ?? 60;
      const fr = await faithfulRound(ranked, null, { words: r.words, maxLen: Math.max(maxLen * 1.5, maxLen + 15), rulesOnly: true });
      ranked = orderByFaithful(fr.candidates);
      const count = (v) => ranked.filter((c) => c.faithful?.verdict === v).length;
      job.faithful = { mode: "rules", checked: ranked.length, faithful: count("faithful"), check: count("check"), misleading: count("misleading"), ...fr.stats };
    }
    const bar = applyQualityBar(ranked);
    ranked = bar.candidates;
    Object.assign(job, { verdict: bar.verdict, curve, listwise: null });
    job.judge = { backend: "prescore", model: null, where: "device", secPerCandidate: null, calls: [], fallbacks: 0, note };
    return { ranked, llm: { id: "prescore", model: null } };
  }

  /**
   * The judge's ranking with a person's decisions put back where their window is a candidate
   * again (decisions.mjs), misleading cuts ordered as the review shows them, and rendered
   * clips and kits linked back to the clips they were made from.
   */
  withDecisions(r, ranked) {
    const out = applyDecisions(structuredClone(ranked), r.decisions, { words: r.words }).candidates;
    const job = r.job;
    let cands = out;
    if (cands.some((c) => c.faithful)) {
      cands = orderByFaithful(cands);
      if (job.verdict) {
        const t = job.verdict.threshold;
        for (const x of cands) if (typeof x.weak === "boolean") x.weak = !(typeof x.total === "number" && x.total >= t && !x.demoted);
        job.verdict = qualityVerdict(cands, { threshold: t });
      }
    }
    job.candidates = cands;
    this.attachRenders(r);
    return job.candidates;
  }

  /** A light language check on the transcript text (lid-lite-5). Never fatal. */
  async languageNote(words) {
    try {
      if (!this.ng5) this.ng5 = await (await cachedFetch(MODELS.ng5.url, { expectedBytes: MODELS.ng5.bytes })).json();
      const text = words.slice(0, 600).map((w) => w.w).join(" ");
      const ng5 = ng5Predict(this.ng5, text);
      const cues = nigerianCues({ language: "en", texts: [{ asked: "en", ng5 }] });
      return {
        setting: "en",
        used: "en",
        decided: "setting",
        textLid: { models: ["lid-lite-5"], ng5 },
        accentCues: cues,
        warning: cues.length ? "This speech has signs of Nigerian English or Pidgin. The desktop app can transcribe it with a model fine-tuned for Nigerian accents; check the captions here before you post." : null,
      };
    } catch (e) {
      return { setting: "en", used: "en", decided: "setting", textLid: { error: e.message }, warning: null };
    }
  }

  /** Approve, skip or trim a candidate (trims snap to sentences, as the server's PATCH). */
  patchCandidate(id, cid, patch = {}) {
    const r = this.rec(id);
    const c = r.job.candidates.find((x) => x.id === cid);
    if (!c) throw Object.assign(new Error(`No candidate ${cid} in job ${id}.`), { status: 404 });
    // faithful: "accept" keeps the cut (a misleading clip goes back to its place), "fix"
    // applies the suggested start or end, "reset" takes the acceptance back (as job.mjs)
    let fixing = false;
    if (patch.faithful != null) {
      const bad = (m) => Object.assign(new Error(m), { status: 400 });
      if (!c.faithful) throw bad("This clip has no faithful check yet.");
      if (patch.faithful === "accept") c.faithful.accepted = true;
      else if (patch.faithful === "reset") delete c.faithful.accepted;
      else if (patch.faithful === "fix") {
        if (!c.faithful.fix) throw bad("There is no suggested fix for this clip.");
        patch = { ...patch, start: c.faithful.fix.start ?? c.start, end: c.faithful.fix.end ?? c.end };
        fixing = true;
      } else throw bad("faithful must be accept, fix or reset.");
    }
    if (patch.status) {
      if (!["proposed", "approved", "skipped"].includes(patch.status)) throw Object.assign(new Error("status must be proposed, approved or skipped."), { status: 400 });
      c.status = patch.status;
    }
    if (patch.start != null || patch.end != null) {
      const snapped = snapTrim(r.words, Number(patch.start ?? c.start), Number(patch.end ?? c.end));
      if (snapped.start !== c.start || snapped.end !== c.end) {
        c.origStart ??= c.start; // the window it came from, which keys the decision
        c.origEnd ??= c.end;
        c.start = snapped.start;
        c.end = snapped.end;
        const ws = r.words.filter((w) => w.s >= c.start - 1e-6 && w.e <= c.end + 1e-6);
        c.text = ws.map((w) => w.w).join(" ");
        c.hook = toSentences(ws)[0]?.text ?? c.text;
        c.trimmed = true;
        c.render = null;
      }
      // a trim that takes in the suggested fix counts as applying it
      const f = c.faithful?.fix;
      if (f && (fixing || ((f.start == null || c.start <= f.start + 1e-3) && (f.end == null || c.end >= f.end - 1e-3)))) c.faithful.applied = true;
    }
    if (c.faithful) {
      r.job.candidates = orderByFaithful(r.job.candidates);
      if (r.job.verdict) {
        const t = r.job.verdict.threshold;
        for (const x of r.job.candidates) if (typeof x.weak === "boolean") x.weak = !(typeof x.total === "number" && x.total >= t && !x.demoted);
        r.job.verdict = qualityVerdict(r.job.candidates, { threshold: t });
      }
    }
    this.emit(id, "candidates", { ranked: true, candidates: structuredClone(r.job.candidates), changed: cid });
    // approvals and trims survive a closed tab, and a new judgment (kept apart from it)
    r.decisions = captureDecisions(r.job.candidates, r.decisions);
    r.saving = Promise.all([this.save(r, null), this.store.savePart(r.key, "decisions", r.decisions).catch(() => {})]);
    return structuredClone(r.job.candidates.find((x) => x.id === cid));
  }

  patchJob(id, settings = {}) {
    const r = this.rec(id);
    const allowed = ["credit", "license", "sourceUrl", "captions", "k", "kit"];
    const bad = Object.keys(settings).filter((k) => !allowed.includes(k));
    if (bad.length) throw Object.assign(new Error(`These settings cannot be changed here: ${bad.join(", ")}.`), { status: 400 });
    Object.assign(r.job.settings, settings, settings.license ? { license: normaliseLicense(settings.license) ?? settings.license } : {});
    for (const [cid, k] of Object.entries(r.kits)) r.kits[cid] = this.kitWithCredit(r.job, k);
    if (settings.kit !== undefined) this.refreshKits(r); // plain or model kits
    this.emit(id, "job", structuredClone(r.job));
    this.save(r, null);
    this.store.savePart(r.key, "kits", r.kits).catch(() => {});
    return structuredClone(r.job);
  }

  // ---------------------------------------------------------------- captions

  captions(id) {
    const r = this.rec(id);
    if (!r.captions) r.captions = { edited: false, style: "bold", updatedAt: now(), cues: cuesFromWords(r.words, "bold") };
    return r.captions;
  }

  getCaptions(id) {
    return { ...structuredClone(this.captions(id)), lowP: 0.5 };
  }

  putCaptions(id, cues) {
    const r = this.rec(id);
    const cur = this.captions(id);
    r.captions = { edited: true, style: cur.style, updatedAt: now(), cues: applyCueEdits(cur.cues, cues) };
    this.store.savePart(r.key, "captions", r.captions).catch(() => {});
    this.emit(id, "captions", { cues: r.captions.cues.length, edited: true });
    this.refreshKits(r); // a kit written from words that changed is written again
    return this.getCaptions(id);
  }

  resetCaptions(id) {
    const r = this.rec(id);
    r.captions = null;
    this.store.savePart(r.key, "captions", null).catch(() => {});
    this.refreshKits(r);
    return this.getCaptions(id);
  }

  captionsFile(id, ext) {
    const cues = this.captions(id).cues;
    return URL.createObjectURL(new Blob([ext === "vtt" ? toVtt(cues) : toSrt(cues)], { type: ext === "vtt" ? "text/vtt" : "application/x-subrip" }));
  }

  // ---------------------------------------------------------------- render and kits

  kitWithCredit(job, k) {
    const base = k.captionText ?? k.caption;
    return { ...k, caption: captionWithCredit(base, job.settings), captionText: base, attribution: attributionLine(job.settings), reminder: mediaReminder(job.settings) };
  }

  /**
   * Render approved clips (or ids), one at a time. Progress via "render" events. Each clip is
   * ready (status "done", playable, saved) the moment its MP4 is stored; its posting kit is
   * written afterwards on its own queue, with its own status (render.kitStatus) and retry
   * (retryKit), so a slow or failing model never holds a finished clip back.
   */
  async render(id, { ids, preset = "shorts" } = {}) {
    const r = this.rec(id);
    const job = r.job;
    const field = preset === "preview" ? "preview" : "render";
    const targets = (ids?.length ? job.candidates.filter((c) => ids.includes(c.id)) : job.candidates.filter((c) => c.status === "approved"));
    if (!targets.length) throw Object.assign(new Error("No clips to render."), { status: 400, hint: "Approve at least one clip first." });
    if (!r.file) throw Object.assign(new Error("Selects needs the video again to render."), { status: 409, needsFile: true, hint: `Choose "${job.source.name}" again. It is checked against the saved job, and nothing is uploaded.` });
    job.stage = "rendering";
    const awake = typeof document !== "undefined" ? keepAwake() : null;
    Object.assign(job.stages.render, { status: "running", startedAt: now(), progress: 0 });
    this.emit(id, "stage", { stage: "rendering", name: "render", state: { ...job.stages.render } });
    const caps = job.settings.captions === false ? null : this.captions(id);
    const cues = caps?.cues ?? null;
    const style = clipCaptionStyle(job.settings);
    job.timings[field] ||= [];
    for (const [i, c] of targets.entries()) {
      c[field] = { status: "running", progress: 0, path: null, srt: null, kit: null };
      this.emit(id, "render", { id: c.id, preset, ...c[field] });
      try {
        const result = await this.renderClip(
          { file: r.file, source: job.source, candidate: { id: c.id, start: c.start, end: c.end }, cues, preset, style, edited: !!caps?.edited, gainDb: clipGainDb(await this.pcmRange(r, c.start, c.end), 0, c.end - c.start, { channels: Math.min(2, job.source.audioStreams?.[0]?.channels || 2) }) },
          { onProgress: (p) => {
            c[field].progress = +p.progress.toFixed(3);
            job.stages.render.progress = +((i + p.progress) / targets.length).toFixed(3);
            this.emit(id, "render", { id: c.id, preset, ...c[field] });
          } },
        );
        const prev = r.clips[`${c.id}:${preset}`];
        if (prev) URL.revokeObjectURL(prev.url);
        const url = URL.createObjectURL(new Blob([result.mp4], { type: "video/mp4" }));
        const srtUrl = URL.createObjectURL(new Blob([result.srt], { type: "application/x-subrip" }));
        r.clips[`${c.id}:${preset}`] = { url, srtUrl, bytes: result.mp4.byteLength, start: c.start, end: c.end };
        // "ready to download" (the MP4 is in this tab) and "saved for later" (kept on the device)
        // are separate: a failed save is said in plain words, never hidden
        let saved = true;
        let saveError = null;
        try {
          await this.store.saveClip(r.key, c.id, preset, { mp4: new Blob([result.mp4], { type: "video/mp4" }), srt: result.srt, start: c.start, end: c.end });
        } catch (e) {
          saved = false;
          const full = e?.name === "QuotaExceededError" || /quota|full|space/i.test(String(e?.message || ""));
          saveError = full
            ? "Ready to download, but not saved on this device: the browser's storage is full. Download it now; it will be gone when this tab closes."
            : "Ready to download, but not saved on this device, so it will be gone when this tab closes. Download it now.";
        }
        // the clip is ready now; the kit follows on its own
        const kitStatus = field === "render" ? "pending" : null;
        c[field] = { status: "done", progress: 1, path: url, srt: srtUrl, kit: null, saved, ...(saveError ? { saveError } : {}), ...(kitStatus ? { kitStatus } : {}), reframe: result.reframe, frames: result.frames, bytes: result.mp4.byteLength, wallSec: result.wallSec, audioCodec: result.audioCodec };
        job.timings[field] = job.timings[field].filter((t) => t.id !== c.id).concat({ id: c.id, sec: result.wallSec, clipSec: +(c.end - c.start).toFixed(1) });
        this.emit(id, "render", { id: c.id, preset, ...c[field] });
        if (field === "render") {
          if (r.kits[c.id]) delete r.kits[c.id]; // the old kit was for the old cut
          this.queueKit(r, c.id);
        }
      } catch (e) {
        c[field] = { status: "error", progress: 0, message: e.message, hint: e.hint || null };
        this.emit(id, "render", { id: c.id, preset, ...c[field] });
      }
    }
    Object.assign(job.stages.render, { status: "done", endedAt: now(), progress: 1, etaSec: 0, note: `rendered ${targets.length} clip${targets.length === 1 ? "" : "s"} (${preset})` });
    job.stage = "done";
    awake?.release();
    await this.save(r, null);
    notifyDone(`${targets.length} clip${targets.length === 1 ? " is" : "s are"} ready`, "Rendered on this device.");
    this.emit(id, "stage", { stage: "done", name: "render", state: { ...job.stages.render } });
    return { queued: true, clips: targets.map((c) => c.id) };
  }

  // ---------------------------------------------------------------- posting kits

  /** Write (or rewrite) a rendered clip's kit, on the job's kit queue: one at a time, the latest request for a clip wins. */
  queueKit(r, cid) {
    const c = r.job.candidates.find((x) => x.id === cid);
    if (!c?.render || c.render.status !== "done") return r.kitQueue;
    (r.kitWanted ||= new Set()).add(cid);
    if (c.render.kitStatus !== "running") {
      c.render.kitStatus = "pending";
      this.emit(r.job.id, "render", { id: cid, preset: "shorts", ...c.render });
    }
    r.kitQueue = (r.kitQueue || Promise.resolve()).then(() => (r.kitWanted.delete(cid) ? this.writeKit(r, cid) : null)).catch((e) => console.error(e));
    return r.kitQueue;
  }

  /** Try a clip's kit again (after an error, or to get a new suggestion). Resolves when it is written. */
  retryKit(id, cid) {
    const r = this.rec(id);
    const c = r.job.candidates.find((x) => x.id === cid);
    if (!c?.render || c.render.status !== "done") throw Object.assign(new Error("This clip has not been rendered yet."), { status: 409, hint: "Render the clip first." });
    return this.queueKit(r, cid);
  }

  /** What a clip's kit is written from, and the signature of those inputs (signatures.mjs kitSignature). */
  kitInputs(r, c) {
    const source = kitSourceFromCaptions(r.captions, c);
    const mode = r.job.settings.kit === "plain" ? "plain" : "model";
    return { source, mode, sig: kitSignature({ source, mode, madeFor: r.job.settings.madeFor || "shorts", prompts: PROMPTS }) };
  }

  /**
   * The judge for a kit, without a surprise download: Smart mode is woken, a private model is
   * used when it is loaded or already saved in this browser, and otherwise the kit is the
   * plain one (the clip's opening line), and says why.
   */
  async kitModel(r) {
    const P = await this.frozenProfile(r);
    let llm;
    try {
      llm = await this.getJudge(P);
    } catch (e) {
      return { llm: null, note: "No model is set up, so the title is the clip's opening line." };
    }
    if (llm.where !== "google" && !llm.loaded && P.inTabJudge === false) {
      return { llm: null, note: "Gemma is too big for a phone's browser, so the title is the clip's opening line." };
    }
    if (llm.where !== "google" && !llm.loaded && !(await llm.isCached?.().catch(() => false))) {
      return { llm: null, note: "Gemma is not saved in this browser yet, so the title is the clip's opening line." };
    }
    await llm.load?.({});
    return { llm, note: null };
  }

  async writeKit(r, cid) {
    const job = r.job;
    const c = job.candidates.find((x) => x.id === cid);
    if (!c?.render || c.render.status !== "done") return;
    const emit = () => this.emit(job.id, "render", { id: cid, preset: "shorts", ...c.render, title: c.title });
    Object.assign(c.render, { kitStatus: "running" });
    delete c.render.kitError;
    emit();
    const { source, mode, sig } = this.kitInputs(r, c);
    const k0 = performance.now();
    let k;
    let madeBy = "plain";
    let note = null;
    try {
      if (mode === "plain") k = plainKit(source);
      else {
        const m = await this.kitModel(r);
        note = m.note;
        k = m.llm ? await makeKit(source, m.llm, { madeFor: job.settings.madeFor, strict: true }) : plainKit(source);
        if (m.llm) madeBy = `${m.llm.id}:${m.llm.model}`;
      }
      c.render.kitStatus = "done";
    } catch (e) {
      k = plainKit(source);
      c.render.kitStatus = "error";
      c.render.kitError = `The title and caption could not be written (${String(e?.message || e).slice(0, 120)}). These are the clip's own words; try again for a suggestion.`;
    }
    const kitSec = +((performance.now() - k0) / 1000).toFixed(1);
    r.kits[cid] = this.kitWithCredit(job, { ...k, captionText: k.caption, start: c.start, end: c.end, sig, madeBy, ...(note ? { note } : {}) });
    c.title = k.title;
    Object.assign(c.render, { kit: `kit:${cid}`, kitSec });
    job.timings.render = (job.timings.render || []).map((t) => (t.id === cid ? { ...t, kitSec } : t));
    emit();
    await this.store.savePart(r.key, "kits", r.kits).catch(() => {});
    await this.save(r, null);
  }

  /** After a caption or kit-mode change: rewrite the kits whose inputs changed (only those). */
  refreshKits(r) {
    for (const c of r.job.candidates || []) {
      const k = r.kits[c.id];
      if (c.render?.status !== "done" || !k) continue;
      if (k.sig !== this.kitInputs(r, c).sig) this.queueKit(r, c.id);
    }
  }

  getKit(id, cid) {
    const r = this.rec(id);
    const c = r.job.candidates.find((x) => x.id === cid);
    const k = r.kits[cid];
    const fits = k && (k.start == null || !c || (Math.abs(k.start - c.start) < 0.01 && Math.abs(k.end - c.end) < 0.01));
    if (!fits) {
      if (c?.render?.status === "done" && ["pending", "running"].includes(c.render.kitStatus)) throw Object.assign(new Error("This clip's title and caption are still being written."), { status: 404, hint: "The clip itself is ready to play and save." });
      throw Object.assign(new Error("This clip has no posting kit yet."), { status: 404, hint: "Render the clip first." });
    }
    const clip = r.clips[`${cid}:shorts`];
    return { ...k, file: clip?.url ?? null, srtFile: clip?.srtUrl ?? null };
  }

  thumbUrl(id, n) {
    return this.rec(id).thumbs[Number(n) - 1] ?? null;
  }

  sourceUrl(id) {
    return this.rec(id).sourceUrl;
  }

  clipUrl(id, cid, preset = "shorts") {
    return this.rec(id).clips[`${cid}:${preset}`]?.url ?? null;
  }
}
