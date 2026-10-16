// Job lifecycle: one folder per job, job.json written atomically after every change,
// each stage checkpointed so a crash, sleep or power cut resumes instead of restarting.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS, jobsDir, resolveModel } from "./config.mjs";
import { makeCandidates, shortlist } from "./candidates.mjs";
import { judge as realJudge } from "./judge.mjs";
import { plainKit, postingKit as realKit } from "./kit.mjs";
import { probe as realProbe } from "./probe.mjs";
import { curve, rank } from "./rank.mjs";
import { render as realRender } from "./render.mjs";
import { snapTrim, toSentences } from "./sentences.mjs";
import { transcribe as realTranscribe } from "./transcribe.mjs";
import { readJson, run, writeJsonAtomic } from "./util.mjs";

/**
 * Every job event goes out twice: as "event" ({ jobId, type, data }) for listeners that
 * want everything, and on the job id itself ({ type, data }) for per-job listeners.
 * Types: stage, progress, words, candidates, render, error.
 */
export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(100);

const STAGES = ["probe", "transcribe", "candidates", "judge", "render"];
const STAGE_LABEL = { probe: "probing", transcribe: "transcribing", candidates: "candidates", judge: "judging", render: "rendering" };
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
    settings: { ...DEFAULT_SETTINGS, ...stripUndefined(settings) },
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
  return readJson(f);
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

export function loadWords(id) {
  return readJson(path.join(jobDir(id), "words.json"), []);
}

/** Make thumbnails for the filmstrip from keyframes only (fast: no full decode). */
async function makeThumbs(job, { count = 60 } = {}) {
  const dir = path.join(jobDir(job.id), "thumbs");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const interval = +(job.source.duration / count).toFixed(2);
  const map = job.source.videoStream != null ? `0:${job.source.videoStream}` : "0:v:0";
  await run("ffmpeg", [
    "-v", "error", "-y", "-skip_frame", "nokey", "-i", job.source.path, "-map", map,
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
  const renderPending = (job.candidates || []).some((c) => c.status === "approved" && c.render && c.render.status !== "done");
  job.stage = "queued";
  saveJob(job);
  if (job.stages.judge.status === "done" && renderPending) return renderJob(id, opts);
  return runJob(id, opts);
}

async function runStages(id, { deps = {}, signal } = {}) {
  const d = {
    probe: realProbe,
    transcribe: realTranscribe,
    judge: realJudge,
    thumbs: makeThumbs,
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
    if (!job.settings.model) {
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

    // 2. transcribe
    const wordsFile = path.join(dir, "words.json");
    let words;
    if (job.stages.transcribe.status !== "done" || !fs.existsSync(wordsFile)) {
      current = "transcribe";
      begin("transcribe");
      words = await d.transcribe(job.source.path, {
        cacheDir: dir,
        duration: job.source.duration,
        signal,
        onProgress: (p) => progress("transcribe", p),
        onWords: (chunk) => emit(id, "words", chunk),
      });
      writeJsonAtomic(wordsFile, words);
      const speed = job.source.duration / ((Date.now() - Date.parse(job.stages.transcribe.startedAt)) / 1000);
      finish("transcribe", `${words.length} words, ${speed.toFixed(2)}x real time`);
    } else {
      words = readJson(wordsFile);
    }
    if (!words.length) {
      const err = new Error("Whisper found no speech in this video.");
      err.hint = "Selects needs spoken English. Check that the video has a voice track.";
      throw Object.assign(err, { stage: "transcribe" });
    }

    // 3. candidates (deterministic windows, prefilter, shortlist for the judge)
    const candFile = path.join(dir, "candidates.json");
    let short;
    if (job.stages.candidates.status !== "done" || !fs.existsSync(candFile)) {
      current = "candidates";
      begin("candidates");
      const sentences = toSentences(words);
      const loudness = readJson(path.join(dir, "loudness.json"), null);
      const all = makeCandidates(sentences, { minLen: job.settings.minLen, maxLen: job.settings.maxLen, stride: job.settings.stride ?? 6, loudness });
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
      const judged = await d.judge(short, {
        model: job.settings.model,
        cacheDir: dir,
        signal,
        onProgress: (p) => progress("judge", p),
      });
      writeJsonAtomic(path.join(dir, "judged.json"), judged);
      const ranked = rank(judged, { k: job.settings.k, iou: 0.3 });
      // keep any human decisions from an earlier run of the same windows
      const prev = new Map((job.candidates || []).map((c) => [c.id, c]));
      job.candidates = ranked.map((c) => (prev.get(c.id)?.status && prev.get(c.id).status !== "proposed" ? { ...c, status: prev.get(c.id).status } : c));
      job.curve = curve(judged, job.source.duration, { step: 5 });
      const st = judged.stats;
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
  if (stage && job.stages[stage]) Object.assign(job.stages[stage], { status: "error", endedAt: now() });
  job.error = {
    stage: stage || null,
    message: aborted ? "Stopped before it finished." : e.message || String(e),
    hint: e.hint || "Resume the job to continue from the last finished stage. Your progress is saved.",
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

async function renderStage(id, { ids, deps = {}, signal, kit, preset } = {}) {
  const d = { render: realRender, postingKit: realKit, ...deps };
  const job = loadJob(id);
  const dir = jobDir(id);
  const usePreset = preset || job.settings.preset || "shorts";
  const field = usePreset === "preview" ? "preview" : "render";
  const kitMode = field === "preview" ? false : (kit ?? job.settings.kit ?? "model");
  const targets = job.candidates.filter((c) => (ids ? ids.includes(c.id) : c.status === "approved"));
  if (!targets.length) return job;
  const isDone = (c) => c[field]?.status === "done" && c[field].path && fs.existsSync(path.join(dir, c[field].path));
  if (targets.every(isDone)) return job; // nothing to do: keep the stage's real timings
  const words = readJson(path.join(dir, "words.json"));
  const prevStage = job.stage;
  job.stage = "rendering";
  job.stages.render = { ...freshStage(), status: "running", startedAt: now(), note: `${usePreset} preset` };
  const blank = () => ({ status: "pending", path: null, srt: null, kit: null, progress: 0 });
  for (const c of targets) if (c[field]?.status !== "done") c[field] = blank();
  saveJob(job);
  emit(id, "stage", { stage: "rendering", name: "render", state: job.stages.render });
  let lastSave = 0;
  try {
    let i = 0;
    for (const c of targets) {
      i++;
      if (c[field]?.status === "done" && c[field].path && fs.existsSync(path.join(dir, c[field].path))) continue;
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
      c[field] = { status: "done", path: r.path, srt: r.srt, kit: null, progress: 1, reframe: r.reframe?.mode, wallSec: r.wallSec };
      if (kitMode) {
        let k;
        const k0 = Date.now();
        try {
          k = kitMode === "model" ? await d.postingKit(c, { model: job.settings.model, signal }) : plainKit(c);
        } catch {
          k = plainKit(c);
        }
        const kitRel = `clips/${c.id}.kit.json`;
        writeJsonAtomic(path.join(dir, kitRel), { ...k, start: c.start, end: c.end, source: job.source.name, reason: c.reason, scores: c.scores });
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
