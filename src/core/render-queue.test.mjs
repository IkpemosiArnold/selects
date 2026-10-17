// Many clips: the render queue (one at a time, each clip ready the moment it is done, a
// failure does not stop the rest, clips approved meanwhile join, resumable), approve top N,
// the disk checks and the estimate that sends long jobs to overnight mode.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { talk } from "./test/fixtures.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "selects-rq-"));
process.env.SELECTS_HOME = home;
process.env.SELECTS_REUSE = "0";
const { approveTop, checkDisk, createJob, jobDir, loadJob, renderJob, resumeJob, runJob, updateCandidate } = await import("./job.mjs");
const { checkFaithful } = await import("./faithful.mjs");
const { diskFullError, diskNeed, estimateJob, isDiskFull, overnightAdvice, thumbCount } = await import("./estimate.mjs");
const { enqueue, queueState } = await import("./queue.mjs");

const video = path.join(home, "talk.mp4");
const WORDS = talk(400); // about 21 minutes of speech

const analyse = {
  probe: async (p) => ({ path: p, name: "talk.mp4", duration: WORDS[WORDS.length - 1].e + 1, width: 1920, height: 1080, fps: 25 }),
  thumbs: async () => null,
  decideLanguage: async (_p, { setting }) => ({ setting, used: "en", detected: null, compared: [], margin: null, decided: "setting", warning: null, sec: 0 }),
  transcribe: async () => WORDS,
  listwise: async (cands) => ({ candidates: cands, order: [], reasons: {} }),
  faithful: (cands, o) => checkFaithful(cands, { ...o, mode: "rules" }),
  judge: async (cands) => cands.map((c, i) => ({ ...c, scores: { hook: 4, standalone: 4, payoff: 4, clarity: 4 }, total: 0.9 - i * 0.001, reason: "Good." })),
};

/** A stand-in renderer: writes a small file, can fail or wait on chosen clips. */
function fakeRender({ calls = [], failOn = new Set(), errorFor = () => new Error("ffmpeg exited with code 1: bad frame"), during = null } = {}) {
  return async (job, c, { jobDir: dir, preset, onProgress, signal }) => {
    calls.push(c.id);
    onProgress?.({ progress: 0.5 });
    if (during) await during(c, calls.length);
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    if (failOn.has(c.id)) throw errorFor(c);
    const rel = `clips/${c.id}${preset === "preview" ? ".preview" : ""}.mp4`;
    fs.mkdirSync(path.join(dir, "clips"), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), "mp4");
    return { path: rel, srt: `clips/${c.id}.srt`, wallSec: 0.01 };
  };
}

async function readyJob(k = 8) {
  const j = createJob(video, { k, model: "mock", qualityGate: false, kit: "plain" });
  return runJob(j.id, { deps: analyse });
}

before(() => fs.writeFileSync(video, "not really a video"));
after(() => fs.rmSync(home, { recursive: true, force: true }));

test("approveTop approves the best n clips a person has not skipped", async () => {
  const job = await readyJob(8);
  assert.ok(job.candidates.length >= 8, `${job.candidates.length} candidates`);
  updateCandidate(job.id, job.candidates[1].id, { status: "skipped" });
  const after = approveTop(job.id, 5);
  const approved = after.candidates.filter((c) => c.status === "approved").map((c) => c.id);
  assert.equal(approved.length, 5);
  assert.deepEqual(approved, after.candidates.filter((c) => c.status !== "skipped").slice(0, 5).map((c) => c.id));
  assert.equal(loadJob(job.id).candidates[1].status, "skipped", "a skip stays a skip");
  assert.throws(() => approveTop(job.id, 0), /whole number/);
});

test("a render queue of many clips: one failure does not stop the rest, and each clip is ready the moment it is done", async () => {
  const job = await readyJob(8);
  approveTop(job.id, 6);
  const ids = loadJob(job.id).candidates.filter((c) => c.status === "approved").map((c) => c.id);
  const calls = [];
  const seenDone = [];
  const render = fakeRender({
    calls,
    failOn: new Set([ids[1]]),
    // while clip n renders, the clips before it are already on disk and marked done
    during: (c) => seenDone.push(loadJob(job.id).candidates.filter((x) => x.render?.status === "done").length),
  });
  const out = await renderJob(job.id, { deps: { render } });
  assert.deepEqual(calls, ids, "one at a time, in review order");
  assert.deepEqual(seenDone, [0, 1, 1, 2, 3, 4]);
  assert.equal(out.stage, "done");
  const disk = loadJob(job.id);
  const bad = disk.candidates.find((c) => c.id === ids[1]);
  assert.equal(bad.render.status, "error");
  assert.match(bad.render.message, /bad frame/);
  assert.equal(disk.candidates.filter((c) => c.render?.status === "done").length, 5);
  assert.match(disk.stages.render.note, /rendered 5 of 6 clips.*1 failed/);
  // rendering again only redoes the failed clip
  const again = [];
  await renderJob(job.id, { deps: { render: fakeRender({ calls: again }) } });
  assert.deepEqual(again, [ids[1]]);
});

test("clips approved while the queue runs are rendered too, and the renderer never undoes an approval", async () => {
  const job = await readyJob(8);
  approveTop(job.id, 2);
  const late = loadJob(job.id).candidates.filter((c) => c.status !== "approved").slice(0, 2).map((c) => c.id);
  const calls = [];
  const render = fakeRender({
    calls,
    during: (c, n) => {
      if (n === 1) for (const id of late) updateCandidate(job.id, id, { status: "approved" });
    },
  });
  await renderJob(job.id, { deps: { render } });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.slice(2), late);
  const disk = loadJob(job.id);
  for (const id of late) {
    const c = disk.candidates.find((x) => x.id === id);
    assert.equal(c.status, "approved");
    assert.equal(c.render.status, "done");
  }
});

test("a render stopped part way resumes with the clips still to do, and never renders one twice", async () => {
  const job = await readyJob(8);
  approveTop(job.id, 5);
  const ids = loadJob(job.id).candidates.filter((c) => c.status === "approved").map((c) => c.id);
  const ctl = new AbortController();
  const first = [];
  await renderJob(job.id, { signal: ctl.signal, deps: { render: fakeRender({ calls: first, during: (_c, n) => n === 3 && ctl.abort() }) } });
  const stopped = loadJob(job.id);
  assert.equal(stopped.stage, "error");
  assert.equal(stopped.error.message, "Stopped before it finished.");
  assert.deepEqual(first, ids.slice(0, 3));
  assert.equal(stopped.candidates.filter((c) => c.render?.status === "done").length, 2);
  const second = [];
  const resumed = await resumeJob(job.id, { deps: { render: fakeRender({ calls: second }) } });
  assert.deepEqual(second, ids.slice(2));
  assert.equal(resumed.stage, "done");
  const files = fs.readdirSync(path.join(jobDir(job.id), "clips")).filter((f) => f.endsWith(".mp4"));
  assert.equal(files.length, 5, "one file per clip, no duplicates");
});

test("a full disk stops the queue with a message that says what happened and what to do", async () => {
  const job = await readyJob(8);
  approveTop(job.id, 4);
  const ids = loadJob(job.id).candidates.filter((c) => c.status === "approved").map((c) => c.id);
  const calls = [];
  const enospc = () => Object.assign(new Error("ffmpeg exited with code 1: av_interleaved_write_frame(): No space left on device"), { stderr: "No space left on device" });
  const out = await renderJob(job.id, { deps: { render: fakeRender({ calls, failOn: new Set([ids[1]]), errorFor: enospc }) } });
  assert.deepEqual(calls, ids.slice(0, 2), "the clips after a full disk are not attempted");
  assert.equal(out.stage, "error");
  assert.equal(out.error.code, "disk_full");
  assert.match(out.error.message, /disk is full/);
  assert.match(out.error.hint, /Free up space.*SELECTS_HOME.*resume/);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(jobDir(job.id), "job.json"), "utf8")));
});

test("the disk check before a step says how much is needed and how much is free", () => {
  assert.throws(
    () => checkDisk(diskNeed({ duration: 7316 }), "transcribing this video", { free: 200e6 }),
    (e) => e.code === "disk_full" && /needs about 0\.56 GB and 0\.20 GB is free/.test(e.message) && /SELECTS_HOME/.test(e.hint),
  );
  assert.doesNotThrow(() => checkDisk(diskNeed({ duration: 7316 }), "x", { free: 5e9 }));
  assert.ok(isDiskFull({ code: "ENOSPC" }) && isDiskFull(new Error("write failed: No space left on device")) && !isDiskFull(new Error("bad frame")));
  assert.equal(diskFullError({}).status, 507);
});

test("a render request made while a render runs queues behind it instead of being dropped", () => {
  enqueue({ jobId: "j_a", kind: "render", ids: ["c_0001"] });
  enqueue({ jobId: "j_a", kind: "render", ids: ["c_0002"] });
  const items = queueState().items.filter((x) => x.jobId === "j_a");
  assert.equal(items.length, 1, "waiting requests merge");
  assert.deepEqual(items[0].ids, ["c_0001", "c_0002"]);
  assert.ok(items[0].key);
});

test("estimates: a 2-hour video with 30 clips on local Gemma is an overnight job, a 6-minute talk is not", () => {
  const long = estimateJob({ duration: 7316, k: 30, judgeN: 36 });
  assert.equal(long.overnight, true);
  assert.equal(long.stages.transcribe, Math.round(7316 / 2));
  assert.ok(long.stages.judge > 36 * 70);
  const advice = overnightAdvice(long, { video: "sermon.mp4" });
  assert.match(advice, /selects queue add sermon\.mp4/);
  assert.doesNotMatch(advice, /—/, "no em dashes in what people read");
  const short = estimateJob({ duration: 360, k: 3, judgeN: 8 }, { asrSpeed: 3 });
  assert.equal(short.overnight, false);
  assert.equal(overnightAdvice(short), null);
  const smart = estimateJob({ duration: 3849, k: 30, judgeN: 60, smart: true }, { asrSpeed: 3 });
  assert.ok(smart.stages.judge < 10 * 60, `Smart mode judges 60 windows in minutes: ${smart.stages.judge}`);
  assert.deepEqual([thumbCount(360), thumbCount(3849), thumbCount(7316), thumbCount(36000)], [60, 129, 240, 240]);
});

test("a job records its estimate after the probe, and the judge count it used", async () => {
  const job = await readyJob(12);
  assert.ok(job.estimate?.stages?.transcribe > 0);
  assert.equal(typeof job.estimate.overnight, "boolean");
  assert.equal(job.judgeN.auto, true);
  assert.equal(job.settings.judgeN, job.judgeN.n, "the count it used is kept for estimates and reruns");
  assert.ok(job.judgeN.n >= 12 + 3);
});
