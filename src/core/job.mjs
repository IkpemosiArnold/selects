// Job lifecycle: one folder per job, job.json written atomically after every change,
// each stage checkpointed so a crash, sleep or power cut resumes instead of restarting.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS, jobsDir, resolveAsrModel, resolveModel } from "./config.mjs";
import { captionsFile, clipCues, loadCaptions, textInRange } from "./captions.mjs";
import { detectFaces as realDetectFaces } from "./faces.mjs";
import { decideLanguage as realDecideLanguage } from "./language.mjs";
import { accentRoute, nigerianCues } from "./langid/accent.mjs";
import { applyProfile } from "./profiles.mjs";
import { transcriptQuality } from "./quality.mjs";
import { attributionLine, captionWithCredit, mediaReminder, normaliseLicense, OWN_FOOTAGE } from "./attribution.mjs";
import { makeCandidates, shortlist } from "./candidates.mjs";
import { splitNonSpeech, speechOnly } from "./nonspeech.mjs";
import { judge as realJudge, listwise as realListwise } from "./judge.mjs";
import { plainKit, postingKit as realKit } from "./kit.mjs";
import { probe as realProbe } from "./probe.mjs";
import { curve, rank } from "./rank.mjs";
import { hwaccelArgs, render as realRender, renderFull as realRenderFull } from "./render.mjs";
import { restorePunctuation as realRestorePunctuation } from "./punctuate.mjs";
import { isSparsePunctuation, snapTrim, toSentences } from "./sentences.mjs";
import { transcribe as realTranscribe } from "./transcribe.mjs";
import { readJson, run, sha1, writeJsonAtomic } from "./util.mjs";

/**
 * Every job event goes out twice: as "event" ({ jobId, type, data }) for listeners that
 * want everything, and on the job id itself ({ type, data }) for per-job listeners.
 * Types: stage, progress, words, candidates, render, error.
 */
export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(100);

const STAGES = ["probe", "language", "transcribe", "candidates", "judge", "render"];
const STAGE_LABEL = { probe: "probing", language: "transcribing", transcribe: "transcribing", candidates: "candidates", judge: "judging", render: "rendering" };
const running = new Map(); // jobId -> Promise

function emit(jobId, type, data) {
  jobEvents.emit("event", { jobId, type, data });
  jobEvents.emit(jobId, { type, data });
}

const now = () => new Date().toISOString();
export const jobDir = (id) => path.join(jobsDir(), id);
const jobFile = (id) => path.join(jobDir(id), "job.json");

function newId() {
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  let n = secs;
  for (;;) {
    const id = `j_${day}_${n.toString(36).padStart(4, "0")}`;
    if (!fs.existsSync(jobDir(id))) return id;
    n += 1;
  }
}

const freshStage = () => ({ status: "pending", startedAt: null, endedAt: null, progress: 0, etaSec: null, note: "" });

/** Create a job folder for a local video. Does not start it; call runJob. */
export function createJob(videoPath, settings = {}) {
  settings = applyProfile(settings);
  const expanded = String(videoPath).trim().replace(/^~(?=$|\/)/, os.homedir());
  const abs = path.resolve(expanded);
  if (!fs.existsSync(abs)) {
    const err = new Error(`No file at ${abs}.`);
    err.hint = "Check the path, or drag the file into the terminal to paste its full path.";
    throw err;
  }
  const id = newId();
  const job = {
    id,
    source: { path: abs, name: path.basename(abs), duration: null, width: null, height: null, fps: null },
    settings: { ...DEFAULT_SETTINGS, ...stripUndefined(settings), ...(settings.license ? { license: normaliseLicense(settings.license) ?? settings.license } : {}) },
    stage: "queued",
    stages: Object.fromEntries(STAGES.map((s) => [s, freshStage()])),
    error: null,
    words: null,
    candidates: [],
    curve: [],
    thumbs: null,
    timings: {},
    createdAt: now(),
    updatedAt: now(),
  };
  fs.mkdirSync(jobDir(id), { recursive: true });
  saveJob(job);
  return job;
}

function stripUndefined(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
}

export function loadJob(id) {
  const f = jobFile(id);
  if (!fs.existsSync(f)) {
    const err = new Error(`No job called ${id}.`);
    err.status = 404;
    throw err;
  }
  const job = readJson(f);
  for (const s of STAGES) if (!job.stages?.[s]) (job.stages ||= {})[s] = freshStage();
  return job;
}

export function saveJob(job) {
  job.updatedAt = now();
  writeJsonAtomic(jobFile(job.id), job);
  return job;
}

/** All jobs, newest first, as summaries (no transcript, candidates trimmed to the essentials). */
export function listJobs() {
  if (!fs.existsSync(jobsDir())) return [];
  return fs
    .readdirSync(jobsDir())
    .filter((d) => d.startsWith("j_") && fs.existsSync(jobFile(d)))
    .map((d) => {
      try {
        const j = readJson(jobFile(d));
        return {
          id: j.id,
          source: j.source,
          settings: j.settings,
          stage: j.stage,
          stages: j.stages,
          error: j.error,
          candidateCount: j.candidates?.length ?? 0,
          approvedCount: (j.candidates || []).filter((c) => c.status === "approved").length,
          language: j.language ?? null,
          transcriptQuality: j.transcriptQuality ?? null,
          output: j.output ?? null,
          createdAt: j.createdAt,
          updatedAt: j.updatedAt,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

/** The job's speech words (whisper's notes like "[Music]" are dropped, even from older words.json files). */
export function loadWords(id) {
  return speechOnly(readJson(path.join(jobDir(id), "words.json"), []));
}

/** Non-speech events ([{ type, s, e }]): events.json plus any notes left in an older words.json. */
function loadEvents(dir, rawWords) {
  const saved = readJson(path.join(dir, "events.json"), []);
  return [...(Array.isArray(saved) ? saved : []), ...splitNonSpeech(rawWords).events].sort((a, b) => a.s - b.s);
}

/** Make thumbnails for the filmstrip from keyframes only (fast: no full decode). */
async function makeThumbs(job, { count = 60 } = {}) {
  const dir = path.join(jobDir(job.id), "thumbs");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const interval = +(job.source.duration / count).toFixed(2);
  const map = job.source.videoStream != null ? `0:${job.source.videoStream}` : "0:v:0";
  await run("ffmpeg", [
    "-v", "error", "-y", ...hwaccelArgs(job.source), "-skip_frame", "nokey", "-i", job.source.path, "-map", map,
    "-vf", `fps=1/${interval},scale=trunc(iw*sar/2)*2:ih,setsar=1,scale=192:-2`,
    "-fps_mode", "vfr", "-frames:v", String(count), "-q:v", "5",
    path.join(dir, "strip-%04d.jpg"),
  ]);
  const n = fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).length;
  return { count: n, interval, pattern: "thumbs/strip-%04d.jpg" };
}

/**
 * Run a job through probe, transcribe, candidates and judge, skipping stages already done.
 * Ends at stage "ready" (waiting for a person to approve clips). Rendering is renderJob.
 * @param {string|object} idOrJob
 * @param {{deps?:object, signal?:AbortSignal}} opts deps replaces stage functions (tests)
 */
export function runJob(idOrJob, opts = {}) {
  const id = typeof idOrJob === "string" ? idOrJob : idOrJob.id;
  if (running.has(id)) return running.get(id);
  const p = runStages(id, opts).finally(() => running.delete(id));
  running.set(id, p);
  return p;
}

export const isRunning = (id) => running.has(id);

/** Resume after a crash or error: reset unfinished stages and run again. */
export function resumeJob(id, opts = {}) {
  if (running.has(id)) return running.get(id);
  const job = loadJob(id);
  for (const s of STAGES) {
    if (job.stages[s].status === "running" || job.stages[s].status === "error") job.stages[s] = freshStage();
  }
  job.error = null;
  if (opts.force) job.settings.qualityGate = false; // judge an unreliable transcript anyway
  const renderPending = (job.candidates || []).some((c) => c.status === "approved" && c.render && c.render.status !== "done") || (job.output && job.output.status !== "done");
  job.stage = "queued";
  saveJob(job);
  const analysed = job.settings.mode === "caption" ? job.stages.transcribe.status === "done" : job.stages.judge.status === "done";
  if (analysed && renderPending) return renderJob(id, opts);
  return runJob(id, opts);
}

/**
 * Transcribe again with another language or model (the one-click override). Clears the
 * language decision, the transcript, the captions and everything picked from them.
 */
export function retranscribe(id, patch = {}, opts = {}) {
  resetTranscript(id, patch);
  return runJob(id, opts);
}

/**
 * The answer "yes" to the language question: the language Selects used is right. Nothing is
 * transcribed again; the question is cleared and the answer recorded. Returns the job.
 */
export function confirmLanguage(id, language) {
  const job = loadJob(id);
  if (!job.language || job.language.used !== language) {
    const err = new Error(`This job was transcribed as ${job.language?.used ?? "nothing yet"}, not ${language}.`);
    err.status = 409;
    err.hint = "To change the language, send { language } without confirm: the video is transcribed again.";
    throw err;
  }
  job.language = { ...job.language, question: null, confirmed: { by: "user", language, at: new Date().toISOString() } };
  saveJob(job);
  emit(id, "job", job);
  return job;
}

/** The reset half of retranscribe, for callers that run the job through the queue. */
export function resetTranscript(id, { language, asrModel, asrPrompt, asrPreprocess, accent } = {}) {
  if (running.has(id)) {
    const err = new Error("This job is still running. Wait for it to finish, then change the language.");
    err.status = 409;
    throw err;
  }
  const job = loadJob(id);
  if (language) job.settings.language = language;
  if (asrModel) job.settings.asrModel = asrModel;
  if (asrPrompt !== undefined) job.settings.asrPrompt = asrPrompt || null;
  if (asrPreprocess) job.settings.asrPreprocess = asrPreprocess;
  if (accent) job.settings.accent = accent;
  const dir = jobDir(id);
  for (const f of ["whisper.json", "whisper.meta.json", "words.json", "events.json", "captions.json", "candidates.json", "judged.json", "loudness.json"]) fs.rmSync(path.join(dir, f), { force: true });
  for (const s of ["language", "transcribe", "candidates", "judge"]) job.stages[s] = freshStage();
  job.language = null;
  job.accent = null;
  job.transcriptQuality = null;
  job.candidates = [];
  job.curve = [];
  job.output = null;
  job.error = null;
  job.stage = "queued";
  saveJob(job);
  emit(id, "job", job);
  return job;
}

/** Run face detection for a job (macOS) and keep the tracks in faces.json. */
export async function detectJobFaces(id, { deps = {}, signal, force = false } = {}) {
  const job = loadJob(id);
  const detect = deps.detectFaces || realDetectFaces;
  emit(id, "faces", { status: "running" });
  try {
    const res = await detect(job.source.path, jobDir(id), { signal, force, onProgress: (p) => emit(id, "faces", { status: "running", progress: +p.progress.toFixed(3) }) });
    emit(id, "faces", { status: "done", ...res });
    return res;
  } catch (e) {
    emit(id, "faces", { status: "error", message: e.message, hint: e.hint });
    throw e;
  }
}

/**
 * What a render depended on: the captions it showed and the blur it applied. A render whose
 * fingerprint no longer matches is "stale" (edits since then are not in the file yet).
 */
export function renderFingerprint(job, c = null) {
  const dir = jobDir(job.id);
  let cues = [];
  try {
    if (fs.existsSync(path.join(dir, "captions.json")) || fs.existsSync(path.join(dir, "words.json"))) cues = loadCaptions(dir).cues;
  } catch {}
  const shown = c ? clipCues(cues, c.start, c.end) : cues;
  const capText = job.settings.captions === false ? "off" : shown.map((x) => `${x.s}|${x.e}|${x.text}`).join("\n");
  const blur = c ? (c.blur ?? job.settings.blur ?? null) : (job.settings.blur ?? null);
  const hasBlur = !!(blur && ((blur.faces?.mode && blur.faces.mode !== "off") || blur.regions?.length));
  return sha1(JSON.stringify({ capText, blur: hasBlur ? blur : null, style: c ? null : job.settings.captionStyle ?? "auto" })).slice(0, 12);
}

/** Recompute `stale` on every finished render and caption-mode output. Mutates and returns job. */
export function refreshStale(job) {
  for (const c of job.candidates || []) {
    if (c.render?.status !== "done") continue;
    const fp = renderFingerprint(job, c);
    c.render.stale = c.render.inputs ? c.render.inputs !== fp : false;
  }
  if (job.output?.status === "done") job.output.stale = job.output.inputs ? job.output.inputs !== renderFingerprint(job) : false;
  return job;
}

/** Check a blur spec from the UI or CLI. Returns a clean copy, or throws a 400. */
export function cleanBlur(blur) {
  if (blur == null) return null;
  const bad = (m) => Object.assign(new Error(m), { status: 400, hint: "blur is { faces: { mode, tracks }, regions: [{ x, y, w, h, start, end }] } with x, y, w, h between 0 and 1." });
  if (typeof blur !== "object") throw bad("blur must be an object.");
  const mode = blur.faces?.mode ?? "off";
  if (!["off", "all", "others", "chosen"].includes(mode)) throw bad(`Unknown face blur mode "${mode}".`);
  const regions = (blur.regions || []).map((r) => {
    const n = ["x", "y", "w", "h"].map((k) => Number(r[k]));
    if (n.some((v) => !Number.isFinite(v) || v < 0 || v > 1) || n[2] <= 0 || n[3] <= 0) throw bad("A blur region is outside the frame.");
    const t = (v) => (v == null || v === "" ? null : Number(v));
    return { x: n[0], y: n[1], w: Math.min(n[2], 1 - n[0]), h: Math.min(n[3], 1 - n[1]), start: t(r.start), end: t(r.end) };
  });
  return { faces: { mode, tracks: Array.isArray(blur.faces?.tracks) ? blur.faces.tracks.map(String) : [] }, regions };
}

async function runStages(id, { deps = {}, signal } = {}) {
  const d = {
    probe: realProbe,
    transcribe: realTranscribe,
    judge: realJudge,
    listwise: realListwise,
    thumbs: makeThumbs,
    decideLanguage: realDecideLanguage,
    restorePunctuation: realRestorePunctuation,
    ...deps,
  };
  let job = loadJob(id);
  const dir = jobDir(id);
  let lastSave = 0;
  const save = (force = true) => {
    if (force || Date.now() - lastSave > 2000) {
      saveJob(job);
      lastSave = Date.now();
    }
  };
  const begin = (s) => {
    job.stage = STAGE_LABEL[s];
    job.stages[s] = { ...freshStage(), status: "running", startedAt: now() };
    save();
    emit(id, "stage", { stage: job.stage, name: s, state: job.stages[s] });
  };
  const progress = (s, p) => {
    Object.assign(job.stages[s], {
      progress: +(p.progress ?? 0).toFixed(3),
      etaSec: p.etaSec ?? null,
      note: p.note ?? job.stages[s].note,
    });
    save(false);
    emit(id, "progress", { name: s, ...job.stages[s], ...(p.speed != null ? { speed: +p.speed.toFixed(2) } : {}) });
  };
  const finish = (s, note) => {
    const st = job.stages[s];
    Object.assign(st, { status: "done", endedAt: now(), progress: 1, etaSec: 0, ...(note ? { note } : {}) });
    job.timings = job.timings || {};
    job.timings[s] = +((Date.parse(st.endedAt) - Date.parse(st.startedAt)) / 1000).toFixed(1);
    save();
    emit(id, "stage", { stage: job.stage, name: s, state: st });
  };

  let current = null;
  try {
    const mode = job.settings.mode || "clips";
    if (!job.settings.model && mode === "clips") {
      job.settings.model = await resolveModel();
      save();
    }

    // 1. probe (and filmstrip thumbnails)
    if (job.stages.probe.status !== "done") {
      current = "probe";
      begin("probe");
      job.source = await d.probe(job.source.path);
      save();
      try {
        job.thumbs = await d.thumbs(job);
      } catch {
        job.thumbs = null; // thumbnails are nice to have, never fatal
      }
      finish("probe", `${Math.round(job.source.duration)} s of video`);
    }

    const audioStream = job.source.audioStreams?.[0]?.index ?? null;

    // 2. language: decode-and-compare, because whisper's own guess is biased against accents
    if (job.stages.language.status !== "done" || !job.language) {
      current = "language";
      begin("language");
      job.language = await d.decideLanguage(job.source.path, {
        duration: job.source.duration,
        setting: job.settings.language || "en",
        remembered: job.settings.rememberedLanguage ?? null,
        cacheDir: dir,
        audioStream,
        signal,
        onProgress: (p) => progress("language", p),
      });
      finish("language", job.language.warning ? job.language.warning : `${job.language.used}${job.language.detected ? `, whisper guessed ${job.language.detected.code} (p = ${job.language.detected.p})` : ""}`);
      emit(id, "job", job);
    }
    const lang = job.language?.used || job.settings.language || "en";

    // 3. transcribe
    const wordsFile = path.join(dir, "words.json");
    let words;
    if (job.stages.transcribe.status !== "done" || !fs.existsSync(wordsFile)) {
      current = "transcribe";
      begin("transcribe");
      // accent routing: Nigerian-accented English goes to the fine-tune when there is a reason to
      const cues = nigerianCues({ language: lang, detected: job.language?.detected ?? null, texts: (job.language?.compared || []).map((c) => ({ asked: c.code, ng5: c.text?.ng5 ?? null, lid608: c.text?.lid608 ?? null })) });
      const route = accentRoute({ accent: job.settings.accent || "auto", asrModel: job.settings.asrModel || "auto", language: lang, cues });
      job.accent = { accent: route.accent, routed: !!route.model, model: route.model ? path.basename(route.model) : null, cues, reason: route.reason };
      const model = route.model || resolveAsrModel(job.settings.asrModel || "auto", lang);
      const t0 = Date.now();
      words = await d.transcribe(job.source.path, {
        cacheDir: dir,
        duration: job.source.duration,
        signal,
        language: lang,
        model,
        prompt: job.settings.asrPrompt || null,
        preprocess: job.settings.asrPreprocess || "none",
        audioStream,
        onProgress: (p) => progress("transcribe", p),
        onWords: (chunk) => emit(id, "words", chunk),
      });
      const split = splitNonSpeech(words); // a no-op for segmentsToWords output, which is already clean
      writeJsonAtomic(path.join(dir, "events.json"), [...(words.events || []), ...split.events].sort((a, b) => a.s - b.s));
      words = split.words;
      // whisper sometimes writes long runs with no full stops; a punctuation model puts them back
      job.punctuation = null;
      if (lang === "en" && job.settings.punctuate !== false && isSparsePunctuation(words)) {
        progress("transcribe", { progress: 0.999, note: "adding punctuation" });
        const r = d.restorePunctuation(words);
        words = r.words;
        job.punctuation = r.info;
      }
      writeJsonAtomic(wordsFile, words);
      fs.rmSync(path.join(dir, "captions.json"), { force: true }); // new words, new cues
      const sec = (Date.now() - t0) / 1000;
      job.asr = { provider: "whisper.cpp", model: path.basename(model), accent: job.accent?.routed ? job.accent.accent : null, language: lang, prompt: job.settings.asrPrompt || null, preprocess: job.settings.asrPreprocess || "none", sec: +sec.toFixed(1), speed: +(job.source.duration / Math.max(0.1, sec)).toFixed(2) };
      job.transcriptQuality = transcriptQuality(words, { duration: job.source.duration });
      const speed = job.source.duration / ((Date.now() - Date.parse(job.stages.transcribe.startedAt)) / 1000);
      finish("transcribe", `${words.length} words, ${speed.toFixed(2)}x real time, transcript ${job.transcriptQuality.verdict}`);
    } else {
      words = readJson(wordsFile);
      if (!job.transcriptQuality) job.transcriptQuality = transcriptQuality(words, { duration: job.source.duration });
    }
    if (!words.length) {
      const err = new Error("Whisper found no speech in this video.");
      err.hint = "Check that the video has a voice track, and that the language is right (--language).";
      throw Object.assign(err, { stage: "transcribe" });
    }
    emit(id, "quality", job.transcriptQuality);

    // Caption mode: no clips to find. Build the cues and wait for the caption review.
    if (mode === "caption") {
      for (const s of ["candidates", "judge"]) if (job.stages[s].status === "pending") job.stages[s] = { ...freshStage(), status: "skipped" };
      const caps = loadCaptions(dir, { style: job.settings.captionStyle && job.settings.captionStyle !== "auto" ? job.settings.captionStyle : (job.source.uprightHeight || job.source.height) > (job.source.uprightWidth || job.source.width) ? "bold" : "subtitle" });
      job.stage = "ready";
      save();
      emit(id, "captions", { cues: caps.cues.length, edited: caps.edited });
      emit(id, "stage", { stage: "ready" });
      return job;
    }

    // The quality gate: clips picked from words whisper did not really hear are guesses.
    if (job.transcriptQuality.verdict === "unreliable" && job.settings.qualityGate !== false) {
      const err = new Error(`The transcript looks unreliable (mean word confidence ${job.transcriptQuality.meanP}, ${Math.round(job.transcriptQuality.lowShare * 100)}% of words unsure), so Selects stopped before judging.`);
      err.hint = `${job.transcriptQuality.hint} To judge it anyway, resume with --force.`;
      throw Object.assign(err, { stage: "transcribe", keepStage: true, suggest: job.transcriptQuality.suggest });
    }

    // 3. candidates (deterministic windows, prefilter, shortlist for the judge)
    const candFile = path.join(dir, "candidates.json");
    let short;
    if (job.stages.candidates.status !== "done" || !fs.existsSync(candFile)) {
      current = "candidates";
      begin("candidates");
      // sentences and windows are built from speech only; laughter is kept as a pre-score signal
      const events = loadEvents(dir, words);
      const speech = speechOnly(words);
      const sentences = toSentences(speech);
      const loudness = readJson(path.join(dir, "loudness.json"), null);
      const all = makeCandidates(sentences, { minLen: job.settings.minLen, maxLen: job.settings.maxLen, stride: job.settings.stride ?? 6, loudness, words: speech, events });
      short = shortlist(all, { n: job.settings.judgeN ?? 8, duration: job.source.duration });
      writeJsonAtomic(candFile, { sentences: sentences.length, windows: all.length, shortlist: short });
      job.candidates = short;
      finish("candidates", `${all.length} windows passed the filter, ${short.length} go to the judge`);
      emit(id, "candidates", { ranked: false, candidates: short });
    } else {
      short = readJson(candFile).shortlist;
    }

    // 4. judge, rank, curve
    if (job.stages.judge.status !== "done") {
      current = "judge";
      begin("judge");
      let judged = await d.judge(short, {
        model: job.settings.model,
        cacheDir: dir,
        signal,
        onProgress: (p) => progress("judge", { ...p, progress: (p.progress ?? 0) * 0.9 }),
      });
      const st = judged.stats;
      if (job.settings.listwise !== false && judged.length >= 3) {
        progress("judge", { progress: 0.9, note: "comparing the best clips side by side" });
        const t0 = Date.now();
        const lw = await d.listwise(judged, { model: job.settings.model, n: job.settings.listN ?? 4, cacheDir: dir, signal });
        judged = lw.candidates;
        job.listwise = { order: lw.order, reasons: lw.reasons, complete: lw.complete ?? true, sec: +((Date.now() - t0) / 1000).toFixed(1) };
      }
      writeJsonAtomic(path.join(dir, "judged.json"), judged);
      const ranked = rank(judged, { k: job.settings.k, iou: 0.3 });
      // keep any human decisions from an earlier run of the same windows
      const prev = new Map((job.candidates || []).map((c) => [c.id, c]));
      job.candidates = ranked.map((c) => (prev.get(c.id)?.status && prev.get(c.id).status !== "proposed" ? { ...c, status: prev.get(c.id).status } : c));
      job.curve = curve(judged, job.source.duration, { step: 5 });
      finish("judge", st?.secPerCandidate ? `${judged.length} clips judged, ${st.secPerCandidate} s each` : `${judged.length} clips judged`);
      emit(id, "candidates", { ranked: true, candidates: job.candidates, curve: job.curve });
    }
    job.stage = "ready";
    save();
    emit(id, "stage", { stage: "ready" });
    return job;
  } catch (e) {
    return fail(job, e.stage || current, e);
  }
}

function fail(job, stage, e) {
  const aborted = e?.name === "AbortError";
  job.stage = "error";
  if (stage && job.stages[stage] && !e?.keepStage) Object.assign(job.stages[stage], { status: "error", endedAt: now() });
  job.error = {
    stage: stage || null,
    message: aborted ? "Stopped before it finished." : e.message || String(e),
    hint: e.hint || "Resume the job to continue from the last finished stage. Your progress is saved.",
    ...(e.suggest ? { suggest: e.suggest } : {}),
  };
  saveJob(job);
  emit(job.id, "error", job.error);
  return job;
}

/**
 * Change a candidate: approve or skip it, or move its in and out points (snapped to
 * sentence boundaries). Returns the updated candidate.
 */
export function updateCandidate(id, cid, patch = {}) {
  const job = loadJob(id);
  const c = job.candidates.find((x) => x.id === cid);
  if (!c) {
    const err = new Error(`No candidate ${cid} in job ${id}.`);
    err.status = 404;
    throw err;
  }
  if (patch.status) {
    if (!["proposed", "approved", "skipped"].includes(patch.status)) {
      const err = new Error(`status must be proposed, approved or skipped.`);
      err.status = 400;
      throw err;
    }
    c.status = patch.status;
  }
  if (patch.blur !== undefined) {
    c.blur = cleanBlur(patch.blur);
    refreshStale(job); // a render made with other blur boxes says so
  }
  if (patch.start != null || patch.end != null) {
    const words = loadWords(id);
    const snapped = snapTrim(words, Number(patch.start ?? c.start), Number(patch.end ?? c.end));
    if (snapped.start !== c.start || snapped.end !== c.end) {
      c.start = snapped.start;
      c.end = snapped.end;
      const ws = words.filter((w) => w.s >= c.start - 1e-6 && w.e <= c.end + 1e-6);
      c.text = ws.map((w) => w.w).join(" ");
      c.hook = toSentences(ws)[0]?.text ?? c.text;
      c.trimmed = true;
      c.render = null; // an old render no longer matches
    }
  }
  saveJob(job);
  emit(id, "candidates", { ranked: true, candidates: job.candidates, changed: cid });
  return c;
}

/**
 * What the posting kit reads for a clip: the person's edited captions when there are any,
 * so a fixed ASR error (a misheard name) is not repeated in the title or caption. Without
 * edits, the candidate as it is.
 */
export function kitSource(dir, c) {
  const caps = readJson(captionsFile(dir), null);
  if (!caps?.edited || !Array.isArray(caps.cues)) return c;
  const text = textInRange(caps.cues, c.start, c.end);
  if (!text) return c;
  const hook = text.match(/^.*?[.!?]["')\]]*(?=\s|$)/)?.[0] || text.split(/\s+/).slice(0, 14).join(" ");
  return { ...c, text, hook };
}

/** Write clips/<cid>.kit.json: the model's (or plain) kit plus credit for the source. */
function writeKit(job, c, k) {
  const kitRel = `clips/${c.id}.kit.json`;
  const baseCaption = k.captionText ?? k.caption;
  writeJsonAtomic(path.join(jobDir(job.id), kitRel), {
    title: k.title,
    caption: captionWithCredit(baseCaption, job.settings),
    captionText: baseCaption,
    hashtags: k.hashtags,
    attribution: attributionLine(job.settings),
    reminder: mediaReminder(job.settings),
    start: c.start,
    end: c.end,
    source: job.source.name,
    reason: c.reason,
    scores: c.scores,
  });
  return kitRel;
}

const SETTABLE = ["credit", "license", "sourceUrl", "blur", "captions", "captionStyle", "captionLang"];

/**
 * Change a job's attribution settings (credit, license, sourceUrl). Kits already written
 * are rewritten so their captions carry the new credit. Returns the job.
 */
export function updateJobSettings(id, patch = {}) {
  const job = loadJob(id);
  for (const key of Object.keys(patch)) {
    if (!SETTABLE.includes(key)) {
      const err = new Error(`Only ${SETTABLE.join(", ")} can be changed on an existing job.`);
      err.status = 400;
      throw err;
    }
  }
  if (patch.license != null && patch.license !== "" && patch.license !== OWN_FOOTAGE && !normaliseLicense(patch.license)) {
    const err = new Error(`Unknown licence "${patch.license}". Use an id like CC-BY-4.0 or CC-BY-SA-4.0.`);
    err.status = 400;
    throw err;
  }
  if (patch.captionStyle != null && !["auto", "bold", "subtitle"].includes(patch.captionStyle)) throw Object.assign(new Error("captionStyle must be auto, bold or subtitle."), { status: 400 });
  if (patch.captionLang != null && !["source", "en", "both"].includes(patch.captionLang)) throw Object.assign(new Error("captionLang must be source, en or both."), { status: 400 });
  for (const key of SETTABLE) {
    if (patch[key] === undefined) continue;
    const v = patch[key] === "" ? null : patch[key];
    job.settings[key] = key === "license" && v ? (v === OWN_FOOTAGE ? OWN_FOOTAGE : normaliseLicense(v)) : key === "blur" ? cleanBlur(v) : key === "captions" ? v !== false : v;
  }
  refreshStale(job);
  for (const c of job.candidates) {
    const rel = c.render?.kit;
    if (!rel) continue;
    const file = path.join(jobDir(id), rel);
    const k = readJson(file, null);
    if (k) writeKit(job, c, k);
  }
  saveJob(job);
  emit(id, "job", job);
  return job;
}

/**
 * Render approved clips (or the given ids). Only approved clips are ever rendered unless
 * ids are passed. The final preset ("shorts") fills candidate.render and writes a posting
 * kit; the fast "preview" preset fills candidate.preview and skips the kit.
 * @param {string} id
 * @param {{ids?:string[], deps?:object, signal?:AbortSignal, kit?:"model"|"plain"|false, preset?:string}} opts
 */
export function renderJob(id, opts = {}) {
  if (running.has(id)) return running.get(id);
  const p = renderStage(id, opts).finally(() => running.delete(id));
  running.set(id, p);
  return p;
}

async function renderStage(id, opts = {}) {
  const job0 = loadJob(id);
  if (job0.settings.mode === "caption") return renderCaptioned(id, opts);
  return renderClips(id, opts);
}

/** Caption mode: render the whole video with burned-in captions into job.output. */
async function renderCaptioned(id, { deps = {}, signal } = {}) {
  const d = { renderFull: realRenderFull, ...deps };
  const job = loadJob(id);
  if (job.stages.transcribe.status !== "done") {
    const err = new Error("This video has not been transcribed yet.");
    return fail(job, "render", Object.assign(err, { hint: "Resume the job first." }));
  }
  job.stage = "rendering";
  job.stages.render = { ...freshStage(), status: "running", startedAt: now(), note: "whole video" };
  job.output = { status: "running", path: null, srt: null, vtt: null, progress: 0 };
  saveJob(job);
  emit(id, "stage", { stage: "rendering", name: "render", state: job.stages.render });
  let lastSave = 0;
  try {
    const r = await d.renderFull(job, {
      jobDir: jobDir(id),
      signal,
      style: job.settings.captionStyle,
      captions: job.settings.captions !== false,
      onProgress: (p) => {
        job.output.progress = +p.progress.toFixed(3);
        job.stages.render.progress = job.output.progress;
        if (Date.now() - lastSave > 2000) {
          saveJob(job);
          lastSave = Date.now();
        }
        emit(id, "output", job.output);
      },
    });
    const abs = (rel) => path.join(jobDir(id), rel);
    job.output = { status: "done", inputs: renderFingerprint(job), stale: false, path: r.path, srt: r.srt, vtt: r.vtt, file: abs(r.path), srtFile: abs(r.srt), vttFile: abs(r.vtt), progress: 1, width: r.width, height: r.height, style: r.style, blurBoxes: r.blurBoxes, decode: r.decode, wallSec: r.wallSec };
    job.timings = { ...(job.timings || {}), renderFull: r.wallSec };
    Object.assign(job.stages.render, { status: "done", endedAt: now(), progress: 1, etaSec: 0, note: `captioned the whole video (${r.width}x${r.height})` });
    job.stage = "done";
    saveJob(job);
    emit(id, "output", job.output);
    emit(id, "stage", { stage: "done", name: "render", state: job.stages.render });
    return job;
  } catch (e) {
    job.output.status = "error";
    return fail(job, "render", e);
  }
}

async function renderClips(id, { ids, deps = {}, signal, kit, preset } = {}) {
  const d = { render: realRender, postingKit: realKit, ...deps };
  const job = loadJob(id);
  const dir = jobDir(id);
  const usePreset = preset || job.settings.preset || "shorts";
  const field = usePreset === "preview" ? "preview" : "render";
  const kitMode = field === "preview" ? false : (kit ?? job.settings.kit ?? "model");
  const targets = job.candidates.filter((c) => (ids ? ids.includes(c.id) : c.status === "approved"));
  if (!targets.length) return job;
  const isDone = (c) => c[field]?.status === "done" && !c[field].stale && c[field].path && fs.existsSync(path.join(dir, c[field].path));
  if (targets.every(isDone)) return job; // nothing to do: keep the stage's real timings
  const words = loadWords(id);
  const prevStage = job.stage;
  job.stage = "rendering";
  job.stages.render = { ...freshStage(), status: "running", startedAt: now(), note: `${usePreset} preset` };
  const blank = () => ({ status: "pending", path: null, srt: null, kit: null, progress: 0 });
  for (const c of targets) if (!isDone(c)) c[field] = blank();
  saveJob(job);
  emit(id, "stage", { stage: "rendering", name: "render", state: job.stages.render });
  let lastSave = 0;
  try {
    let i = 0;
    for (const c of targets) {
      i++;
      if (isDone(c)) continue;
      c[field] = { ...blank(), status: "running" };
      saveJob(job);
      emit(id, "render", { id: c.id, preset: usePreset, ...c[field] });
      const r = await d.render(job, c, {
        preset: usePreset,
        jobDir: dir,
        words,
        signal,
        onProgress: (p) => {
          c[field].progress = +p.progress.toFixed(3);
          job.stages.render.progress = +((i - 1 + p.progress) / targets.length).toFixed(3);
          if (Date.now() - lastSave > 2000) {
            saveJob(job);
            lastSave = Date.now();
          }
          emit(id, "render", { id: c.id, preset: usePreset, ...c[field] });
        },
      });
      c[field] = { status: "done", inputs: renderFingerprint(job, c), stale: false, path: r.path, srt: r.srt, kit: null, progress: 1, reframe: r.reframe?.mode, decode: r.decode, blurBoxes: r.blurBoxes, wallSec: r.wallSec };
      if (kitMode) {
        let k;
        const k0 = Date.now();
        try {
          k = kitMode === "model" ? await d.postingKit(kitSource(dir, c), { model: job.settings.model, signal, cacheDir: dir }) : plainKit(kitSource(dir, c));
        } catch {
          k = plainKit(kitSource(dir, c));
        }
        const kitRel = writeKit(job, c, k);
        c.title = k.title;
        c[field].kit = kitRel;
        c[field].kitSec = +((Date.now() - k0) / 1000).toFixed(1);
      }
      job.timings = job.timings || {};
      const key = field === "preview" ? "preview" : "render";
      job.timings[key] = (Array.isArray(job.timings[key]) ? job.timings[key] : []).filter((t) => t.id !== c.id).concat({ id: c.id, sec: r.wallSec, clipSec: +(c.end - c.start).toFixed(1), kitSec: c[field].kitSec ?? null });
      saveJob(job);
      emit(id, "render", { id: c.id, preset: usePreset, ...c[field], title: c.title });
    }
    Object.assign(job.stages.render, { status: "done", endedAt: now(), progress: 1, etaSec: 0, note: `rendered ${targets.length} clip${targets.length === 1 ? "" : "s"} (${usePreset})` });
    // a preview leaves the job in review; a final render finishes it
    job.stage = field === "preview" ? (prevStage === "done" ? "done" : "ready") : "done";
    saveJob(job);
    emit(id, "stage", { stage: job.stage, name: "render", state: job.stages.render });
    return job;
  } catch (e) {
    for (const c of targets) if (c[field]?.status === "running") c[field].status = "error";
    return fail(job, "render", e);
  }
}
