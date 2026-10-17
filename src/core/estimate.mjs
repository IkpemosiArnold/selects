// What a job will cost before it runs: time per stage, disk space, and whether it belongs in
// overnight mode. Pure and browser-safe (no Node imports). The defaults are the measured
// numbers in notes/timings.md for a 2017 dual-core MacBook Pro under load; callers pass
// better rates when this machine has measured its own (models.json, earlier jobs).

/** Rates measured on the reference laptop (notes/timings.md). */
export const DEFAULT_RATES = {
  asrSpeed: 2.0, // whisper base.en, greedy, 2 threads: 0.86x to 2.8x real time under load, 3 to 6x quiet
  judgeSec: 70, // local Gemma 3 4B per window: 40 to 80 s, mean 73 s
  smartJudgeSec: 4, // Gemma through the Gemini API, including the free tier's rate limit
  listwiseSec: 140,
  renderFactor: 1.2, // wall seconds per second of clip, 1080x1920 shorts preset
  previewFactor: 0.6, // the 720x1280 preview preset
  kitSec: 90, // one posting-kit call with local Gemma
  thumbsPerHourSec: 20, // keyframe thumbnails
};

/** Bytes per second of 16 kHz mono 16-bit audio (the WAV whisper reads). */
export const WAV_BYTES_PER_SEC = 32000;
/** A rendered clip, generously (SD sources measured 0.06 MB per second; 4K sources are larger). */
export const CLIP_BYTES_PER_SEC = 250000;
/** Room kept free on top of the estimate. */
export const DISK_MARGIN_BYTES = 300e6;
/** Above this, Selects suggests overnight mode. */
export const OVERNIGHT_SEC = 30 * 60;

/**
 * Seconds per stage for a job, from its settings and the source length.
 * @param {{duration:number, k?:number, judgeN?:number, minLen?:number, maxLen?:number, faithful?:string,
 *   listwise?:boolean, language?:string, smart?:boolean, clips?:number, preset?:string, kit?:string|false}} o
 * @param {Partial<typeof DEFAULT_RATES>} rates
 * @returns {{stages:{probe:number,language:number,transcribe:number,judge:number,render:number},
 *   analysisSec:number, renderSec:number, totalSec:number, overnight:boolean}}
 */
export function estimateJob(o, rates = {}) {
  const r = { ...DEFAULT_RATES, ...stripNull(rates) };
  const dur = Math.max(0, o.duration || 0);
  const k = o.k ?? 5;
  const n = o.judgeN ?? Math.max(16, 2 * k);
  const per = o.smart ? r.smartJudgeSec : r.judgeSec;
  const clipLen = ((o.minLen ?? 20) + (o.maxLen ?? 60)) / 2;
  const clips = o.clips ?? k;
  const preview = o.preset === "preview";
  const stages = {
    probe: 2 + (dur / 3600) * r.thumbsPerHourSec,
    language: o.language === "auto" ? 60 : 8,
    transcribe: dur / Math.max(0.05, r.asrSpeed),
    judge: o.mode === "caption" ? 0 : n * per + (o.listwise === false ? 0 : o.smart ? per * 2 : r.listwiseSec) + (o.faithful === "off" || o.faithful === "rules" ? 0 : k * per),
    render: o.mode === "caption" ? dur * (preview ? r.previewFactor : r.renderFactor) : clips * clipLen * (preview ? r.previewFactor : r.renderFactor) + (preview || o.kit === false || o.kit === "plain" ? 0 : clips * (o.smart ? per : r.kitSec)),
  };
  for (const s in stages) stages[s] = Math.round(stages[s]);
  const analysisSec = stages.probe + stages.language + stages.transcribe + stages.judge;
  return { stages, analysisSec, renderSec: stages.render, totalSec: analysisSec + stages.render, overnight: analysisSec > OVERNIGHT_SEC };
}

/** Free space a job needs: the WAV while it is transcribed, or the clips while they render. */
export function diskNeed({ duration = 0, clips = 0, minLen = 20, maxLen = 60, stage = "analysis" } = {}) {
  if (stage === "render") return Math.round(clips * ((minLen + maxLen) / 2 + 2) * CLIP_BYTES_PER_SEC + DISK_MARGIN_BYTES);
  // the WAV, one part sliced out of it, whisper's JSON (about 1 KB a second of speech) and thumbnails
  return Math.round(duration * (WAV_BYTES_PER_SEC + 1000) + 600 * WAV_BYTES_PER_SEC + DISK_MARGIN_BYTES);
}

/** The disk-full error people read: what happened and what to do. */
export function diskFullError({ needBytes = null, freeBytes = null, home = null, during = "this step" } = {}) {
  const gb = (b) => `${(b / 1e9).toFixed(b < 1e9 ? 2 : 1)} GB`;
  const msg =
    needBytes != null && freeBytes != null
      ? `Not enough free disk space for ${during}: Selects needs about ${gb(needBytes)} and ${gb(freeBytes)} is free.`
      : `The disk is full, so Selects stopped during ${during}.`;
  const hint = `Free up space (empty the Bin, or delete old jobs${home ? ` in ${home}/jobs` : ""}), or set SELECTS_HOME to a folder on a bigger drive, then resume the job. Work already finished is kept.`;
  return Object.assign(new Error(msg), { code: "disk_full", status: 507, hint });
}

/** True for an error that came from a full disk (Node's ENOSPC, or ffmpeg and whisper saying so). */
export function isDiskFull(e) {
  if (!e) return false;
  if (e.code === "ENOSPC" || e.code === "disk_full") return true;
  return /no space left on device|ENOSPC|disk full/i.test(`${e.message || ""} ${e.stderr || ""}`);
}

/** How many filmstrip thumbnails: one every 30 s, at least 60, at most 240. */
export function thumbCount(duration) {
  return Math.max(60, Math.min(240, Math.ceil((duration || 0) / 30)));
}

/** "about 45 min", "about 2.4 h". */
export function aboutTime(sec) {
  if (sec == null || !Number.isFinite(sec)) return "";
  if (sec < 90) return `about ${Math.max(1, Math.round(sec))} s`;
  if (sec < 5400) return `about ${Math.round(sec / 60)} min`;
  return `about ${(sec / 3600).toFixed(1)} h`;
}

/** The overnight nudge, or null when the job is short enough to wait for. */
export function overnightAdvice(est, { video = "<video>" } = {}) {
  if (!est?.overnight) return null;
  const s = est.stages;
  return `This will take ${aboutTime(est.analysisSec)} on this laptop before the clips are ready to review (transcribing ${aboutTime(s.transcribe)}, judging ${aboutTime(s.judge)}). That is a good one for overnight: run \`selects queue add ${video}\`, then \`selects queue run\`, and review in the morning.`;
}

function stripNull(o) {
  return Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v != null && Number.isFinite(v)));
}
