// Job lifecycle with whisper, Ollama and ffmpeg mocked out.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { talk } from "./test/fixtures.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "selects-job-"));
process.env.SELECTS_HOME = home;
const { createJob, jobEvents, listJobs, loadJob, renderJob, resumeJob, runJob, updateCandidate, jobDir } = await import("./job.mjs");

const video = path.join(home, "talk.mp4");
const WORDS = talk(120); // about 6 minutes of speech

function mocks(counter, { failJudgeAt = -1 } = {}) {
  return {
    probe: async (p) => {
      counter.probe++;
      return { path: p, name: "talk.mp4", duration: WORDS[WORDS.length - 1].e + 1, width: 1920, height: 1080, fps: 25 };
    },
    thumbs: async () => ({ count: 0, interval: 1, pattern: "thumbs/strip-%04d.jpg" }),
    transcribe: async (_p, { onProgress, onWords }) => {
      counter.transcribe++;
      onWords(WORDS.slice(0, 10));
      onProgress({ progress: 0.5, speed: 2, etaSec: 10, note: "transcribing at 2.00x real time" });
      onWords(WORDS.slice(10));
      return WORDS;
    },
    judge: async (cands, { onProgress }) => {
      const out = [];
      for (let i = 0; i < cands.length; i++) {
        if (i === failJudgeAt) throw Object.assign(new Error("Could not reach Ollama."), { hint: "Start Ollama." });
        counter.judge++;
        const v = ((i * 7) % 5) + 1;
        out.push({ ...cands[i], scores: { hook: v, standalone: v, payoff: v, clarity: v }, total: (v - 1) / 4, reason: "Because." });
        onProgress({ progress: (i + 1) / cands.length });
      }
      return out;
    },
  };
}

before(() => fs.writeFileSync(video, "not really a video"));
after(() => fs.rmSync(home, { recursive: true, force: true }));

test("createJob writes job.json with all stages pending", () => {
  const job = createJob(video, { k: 3, model: "mock" });
  assert.match(job.id, /^j_\d{8}_[0-9a-z]{4}$/);
  const onDisk = loadJob(job.id);
  assert.equal(onDisk.stage, "queued");
  assert.deepEqual(Object.keys(onDisk.stages), ["probe", "transcribe", "candidates", "judge", "render"]);
  assert.equal(onDisk.settings.k, 3);
  assert.ok(listJobs().some((j) => j.id === job.id));
});

test("createJob rejects a missing file with a hint", () => {
  assert.throws(() => createJob(path.join(home, "nope.mp4")), (e) => /No file/.test(e.message) && !!e.hint);
});

test("a crash in judging resumes without redoing earlier stages", async () => {
  const job = createJob(video, { k: 3, model: "mock" });
  const counter = { probe: 0, transcribe: 0, judge: 0 };
  const events = [];
  const listen = (e) => events.push(e.type);
  jobEvents.on(job.id, listen);

  const failed = await runJob(job.id, { deps: mocks(counter, { failJudgeAt: 2 }) });
  assert.equal(failed.stage, "error");
  assert.equal(failed.error.stage, "judge");
  assert.equal(failed.error.hint, "Start Ollama.");
  assert.equal(failed.stages.transcribe.status, "done");
  assert.equal(failed.stages.judge.status, "error");
  assert.ok(fs.existsSync(path.join(jobDir(job.id), "words.json")));
  assert.ok(events.includes("words") && events.includes("progress") && events.includes("error"));

  const done = await resumeJob(job.id, { deps: mocks(counter) });
  assert.equal(done.stage, "ready");
  assert.equal(counter.probe, 1, "probe ran once");
  assert.equal(counter.transcribe, 1, "transcribe ran once");
  assert.equal(done.candidates.length, 3);
  assert.deepEqual(
    done.candidates.map((c) => c.rank),
    [1, 2, 3],
  );
  assert.ok(done.curve.length > 10);
  assert.equal(done.error, null);
  jobEvents.off(job.id, listen);
});

test("a stage left 'running' by a killed process is redone on resume", async () => {
  const job = createJob(video, { k: 2, model: "mock" });
  const counter = { probe: 0, transcribe: 0, judge: 0 };
  await runJob(job.id, { deps: mocks(counter) });
  // simulate a power cut during judging
  const j = loadJob(job.id);
  j.stage = "judging";
  j.stages.judge = { ...j.stages.judge, status: "running", endedAt: null };
  fs.writeFileSync(path.join(jobDir(job.id), "job.json"), JSON.stringify(j));
  const before = { ...counter };
  const done = await resumeJob(job.id, { deps: mocks(counter) });
  assert.equal(done.stage, "ready");
  assert.equal(counter.transcribe, before.transcribe);
  assert.ok(counter.judge > before.judge);
});

test("job.json is never left half-written (atomic writes leave no temp files)", async () => {
  const job = createJob(video, { k: 2, model: "mock" });
  await runJob(job.id, { deps: mocks({ probe: 0, transcribe: 0, judge: 0 }) });
  const files = fs.readdirSync(jobDir(job.id));
  assert.ok(!files.some((f) => f.endsWith(".tmp")), files.join(","));
  JSON.parse(fs.readFileSync(path.join(jobDir(job.id), "job.json"), "utf8"));
});

test("approve, trim with snapping, and render only approved clips", async () => {
  const job = createJob(video, { k: 3, model: "mock" });
  const ready = await runJob(job.id, { deps: mocks({ probe: 0, transcribe: 0, judge: 0 }) });
  const [a, b] = ready.candidates;
  updateCandidate(job.id, a.id, { status: "approved" });
  updateCandidate(job.id, b.id, { status: "skipped" });
  const trimmed = updateCandidate(job.id, a.id, { start: a.start + 3.5 });
  assert.equal(trimmed.trimmed, true);
  assert.ok(WORDS.some((w) => w.s === trimmed.start), "start snapped to a word");
  assert.ok(/[.!?]$/.test(trimmed.text));

  const rendered = [];
  const done = await renderJob(job.id, {
    deps: {
      render: async (_job, c, { onProgress, jobDir: dir }) => {
        rendered.push(c.id);
        onProgress({ progress: 0.5 });
        fs.mkdirSync(path.join(dir, "clips"), { recursive: true });
        fs.writeFileSync(path.join(dir, "clips", `${c.id}.mp4`), "mp4");
        return { path: `clips/${c.id}.mp4`, srt: `clips/${c.id}.srt`, wallSec: 1 };
      },
      postingKit: async () => ({ title: "A title", caption: "A caption.", hashtags: ["x"] }),
    },
  });
  assert.deepEqual(rendered, [a.id]);
  assert.equal(done.stage, "done");
  const c = done.candidates.find((x) => x.id === a.id);
  assert.equal(c.render.status, "done");
  assert.equal(c.title, "A title");
  assert.ok(fs.existsSync(path.join(jobDir(job.id), c.render.kit)));
  // rendering again with nothing left to do keeps the stage's timings
  const before = loadJob(job.id).stages.render;
  const again = await renderJob(job.id, { deps: { render: async () => assert.fail("should not re-render") } });
  assert.deepEqual(again.stages.render, before);
});
