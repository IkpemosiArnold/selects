// In-browser stand-in for the core server: same interface as the HTTP client
// in lib/api.js, with a fake SSE stream that replays a believable pipeline.
//
// URL params (all optional):
//   mock=1                 turn the mock on
//   scenario=fresh|midreview|rendered|error
//   health=bad             show health warnings on the new job screen
//   speed=0.3              slow the simulated pipeline (for screen recording)
//   at=0.4                 start the live job part way through transcription
import { buildTalk, makeJob } from "./fixture.js";
import { frameSvg } from "./frames.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (x) => JSON.parse(JSON.stringify(x));

export function createMockApi(params) {
  const scenario = params.get("scenario") || "fresh";
  const speed = Math.max(0.05, Number(params.get("speed")) || 1);
  const startAt = Math.min(0.98, Math.max(0, Number(params.get("at")) || 0));
  const healthBad = params.get("health") === "bad";
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
  if (scenario === "worst") applyWorst(demo);
  if (scenario === "empty") demo.candidates = [];
  if (scenario === "one") demo.candidates = demo.candidates.filter((c) => c.rank === 1);
  if (scenario === "rendered") {
    demo.stage = "done";
    for (const c of demo.candidates.filter((c) => c.status === "approved")) finishRender(demo, c);
  }
  jobs.set(demo.id, demo);
  const older = makeJob({ id: "j_20261012_k7q2", name: "sunday-service-oct-12.mp4", stage: "done", createdAt: "2026-10-12T19:02:11.000Z" });
  older.source.duration = 5412.6;
  for (const c of older.candidates.slice(0, 3)) {
    c.status = "approved";
    finishRender(older, c);
  }
  jobs.set(older.id, older);

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

  function fixEnd(c) {
    // Snap a fixture trim to a real sentence end.
    const sentEnds = words.filter((w) => /[.?!]$/.test(w.w)).map((w) => w.e);
    c.end = sentEnds.reduce((a, b) => (Math.abs(b - c.end) < Math.abs(a - c.end) ? b : a));
  }

  function finishRender(job, c) {
    c.render = {
      status: "done",
      progress: 1,
      path: `/Users/demo/selects/.selects/jobs/${job.id}/clips/${c.id}.mp4`,
      srt: `clips/${c.id}.srt`,
      kit: `clips/${c.id}.kit.json`,
    };
    Object.assign(c, c._kit);
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
    if (job.stages.transcribe.status !== "done") {
      setStage(job, "transcribing", "transcribe", { status: "running", startedAt: job.stages.transcribe.startedAt || now() });
      const rtf = 2.4;
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
        st.progress = last / duration;
        st.etaSec = (duration - last) / rtf;
        st.note = `transcribing at ${rtf}x real time`;
        emit(job.id, "words", chunk);
        emit(job.id, "progress", { stage: "transcribe", ...st });
        await tick(260);
      }
      setStage(job, "candidates", "transcribe", { status: "done", endedAt: now(), progress: 1, etaSec: 0, note: `transcribed at ${rtf}x real time` });
    }
    setStage(job, "candidates", "candidates", { status: "running", startedAt: now() });
    await tick(900);
    const n = 148;
    setStage(job, "judging", "candidates", { status: "done", endedAt: now(), progress: 1, note: `${n} moments` });
    setStage(job, "judging", "judge", { status: "running", startedAt: now() });
    for (let i = 1; i <= n; i += 2) {
      const st = job.stages.judge;
      st.progress = i / n;
      st.etaSec = (n - i) * 2.1;
      st.note = `${i} of ${n} moments, 2.1 s each`;
      emit(job.id, "progress", { stage: "judge", ...st });
      await tick(70);
    }
    job.candidates = job._candidates;
    job.curve = makeJob({ id: "x" }).curve;
    emit(job.id, "candidates", job.candidates);
    setStage(job, "ready", "judge", { status: "done", endedAt: now(), progress: 1, etaSec: 0, note: `${n} moments, 2.1 s each` });
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
        emit(job.id, "render", { id, ...c.render, etaSec: Math.round((1 - p) * (c.end - c.start) * 1.6) });
        await wait(110 / speed);
      }
      finishRender(job, c);
      emit(job.id, "render", { id, ...c.render, title: c.title, caption: c.caption, hashtags: c.hashtags });
    }
    job.stage = "done";
    job.stages.render = { ...job.stages.render, status: "done", progress: 1, endedAt: new Date().toISOString() };
    emit(job.id, "stage", { stage: job.stage, stages: job.stages });
  }

  const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const summary = (j) => {
    const { _candidates, _emitted, ...rest } = j;
    return clone(rest);
  };

  return {
    mock: true,
    async health() {
      await wait(120);
      return healthBad
        ? { ok: false, whisper: false, ollama: false, models: [], diskFreeGb: 3.1 }
        : { ok: true, whisper: true, ollama: true, models: ["gemma3:1b", "gemma3:4b", "qwen3:4b"], diskFreeGb: 34.6 };
    },
    async models() {
      await wait(100);
      return [
        { name: "gemma3:1b", sizeGb: 0.8, measuredSecPerCandidate: 0.9 },
        { name: "gemma3:4b", sizeGb: 3.3, measuredSecPerCandidate: 2.1 },
        { name: "qwen3:4b", sizeGb: 2.6, measuredSecPerCandidate: null },
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
      return job._emitted != null ? words.slice(0, job._emitted) : words;
    },
    async createJob(path, settings) {
      await wait(300);
      if (!/\.(mp4|mov|mkv|webm|m4v)$/i.test(path)) {
        throw Object.assign(new Error(`Selects cannot open ${path.split("/").pop()}. Choose an MP4, MOV, MKV or WebM video.`), { status: 400 });
      }
      const id = "j_live_" + Math.random().toString(36).slice(2, 6);
      return summary(newJob(id, path, settings));
    },
    async patchCandidate(id, cid, body) {
      await wait(140);
      const job = jobs.get(id);
      const c = job.candidates.find((x) => x.id === cid);
      if (body.status) c.status = body.status;
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
      }
      return clone(c);
    },
    async render(id, ids) {
      await wait(150);
      const job = jobs.get(id);
      const list = ids || job.candidates.filter((c) => c.status === "approved").map((c) => c.id);
      runRender(job, list);
      return null;
    },
    async resume(id) {
      await wait(150);
      const job = jobs.get(id);
      job.error = null;
      job.stage = "transcribing";
      sims.set(id, runSim(job));
      return summary(job);
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
