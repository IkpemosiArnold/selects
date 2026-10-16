// Job lifecycle with whisper, Ollama and ffmpeg mocked out.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { talk } from "./test/fixtures.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "selects-job-"));
process.env.SELECTS_HOME = home;
const { createJob, jobEvents, listJobs, loadJob, renderJob, resumeJob, runJob, updateCandidate, updateJobSettings, jobDir } = await import("./job.mjs");

const video = path.join(home, "talk.mp4");
const WORDS = talk(120); // about 6 minutes of speech

function mocks(counter, { failJudgeAt = -1 } = {}) {
  return {
    probe: async (p) => {
      counter.probe++;
      return { path: p, name: "talk.mp4", duration: WORDS[WORDS.length - 1].e + 1, width: 1920, height: 1080, fps: 25 };
    },
    thumbs: async () => ({ count: 0, interval: 1, pattern: "thumbs/strip-%04d.jpg" }),
    decideLanguage: async (_p, { setting }) => ({ setting, used: setting === "auto" ? "en" : setting, detected: { code: "en", p: 0.9 }, compared: [], margin: null, decided: "setting", warning: null, sec: 0 }),
    transcribe: async (_p, { onProgress, onWords }) => {
      counter.transcribe++;
      onWords(WORDS.slice(0, 10));
      onProgress({ progress: 0.5, speed: 2, etaSec: 10, note: "transcribing at 2.00x real time" });
      onWords(WORDS.slice(10));
      return WORDS;
    },
    listwise: async (cands) => ({ candidates: cands, order: [], reasons: {} }),
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
  const job = createJob(video, { k: 3, model: "mock", qualityGate: false });
  assert.match(job.id, /^j_\d{8}_[0-9a-z]{4}$/);
  const onDisk = loadJob(job.id);
  assert.equal(onDisk.stage, "queued");
  assert.deepEqual(Object.keys(onDisk.stages), ["probe", "language", "transcribe", "candidates", "judge", "render"]);
  assert.equal(onDisk.settings.k, 3);
  assert.ok(listJobs().some((j) => j.id === job.id));
});

test("createJob rejects a missing file with a hint", () => {
  assert.throws(() => createJob(path.join(home, "nope.mp4")), (e) => /No file/.test(e.message) && !!e.hint);
});

test("a crash in judging resumes without redoing earlier stages", async () => {
  const job = createJob(video, { k: 3, model: "mock", qualityGate: false });
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
  const job = createJob(video, { k: 2, model: "mock", qualityGate: false });
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
  const job = createJob(video, { k: 2, model: "mock", qualityGate: false });
  await runJob(job.id, { deps: mocks({ probe: 0, transcribe: 0, judge: 0 }) });
  const files = fs.readdirSync(jobDir(job.id));
  assert.ok(!files.some((f) => f.endsWith(".tmp")), files.join(","));
  JSON.parse(fs.readFileSync(path.join(jobDir(job.id), "job.json"), "utf8"));
});

test("approve, trim with snapping, and render only approved clips", async () => {
  const job = createJob(video, { k: 3, model: "mock", qualityGate: false });
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

test("credit and licence go into the posting kit and can be changed later", async () => {
  const job = createJob(video, { k: 2, model: "mock", qualityGate: false, credit: "Jenni, EMF 2026", license: "cc by-sa 4.0" });
  assert.equal(loadJob(job.id).settings.license, "CC-BY-SA-4.0");
  const ready = await runJob(job.id, { deps: mocks({ probe: 0, transcribe: 0, judge: 0 }) });
  updateCandidate(job.id, ready.candidates[0].id, { status: "approved" });
  const done = await renderJob(job.id, {
    deps: {
      render: async (_j, c, { jobDir: dir }) => {
        fs.mkdirSync(path.join(dir, "clips"), { recursive: true });
        fs.writeFileSync(path.join(dir, "clips", `${c.id}.mp4`), "mp4");
        return { path: `clips/${c.id}.mp4`, srt: `clips/${c.id}.srt`, wallSec: 1 };
      },
      postingKit: async () => ({ title: "T", caption: "Watch this.", hashtags: [] }),
    },
  });
  const kitFile = path.join(jobDir(job.id), done.candidates[0].render.kit);
  let kit = JSON.parse(fs.readFileSync(kitFile, "utf8"));
  assert.match(kit.caption, /^Watch this\.\n\nClip from Jenni, EMF 2026\. Licensed under CC BY-SA 4\.0: https:\/\/creativecommons\.org\/licenses\/by-sa\/4\.0\//);
  assert.match(kit.reminder, /licence may not cover every figure/);
  updateJobSettings(job.id, { credit: "Jenni (EMF 2026)", sourceUrl: "https://media.ccc.de/v/x" });
  kit = JSON.parse(fs.readFileSync(kitFile, "utf8"));
  assert.match(kit.caption, /Clip from Jenni \(EMF 2026\) \(https:\/\/media\.ccc\.de\/v\/x\)/);
  assert.equal(kit.captionText, "Watch this.");
  assert.throws(() => updateJobSettings(job.id, { model: "x" }), /Only credit/);
  assert.throws(() => updateJobSettings(job.id, { license: "all rights reserved" }), /Unknown licence/);
});

test("an unreliable transcript stops before judging; --force judges it anyway", async () => {
  const job = createJob(video, { k: 2, model: "mock" });
  const counter = { probe: 0, transcribe: 0, judge: 0 };
  const deps = mocks(counter);
  deps.transcribe = async () => WORDS.map((w, i) => ({ ...w, p: i % 2 ? 0.2 : 0.45 }));
  let res = await runJob(job.id, { deps });
  assert.equal(res.stage, "error");
  assert.equal(res.error.stage, "transcribe");
  assert.match(res.error.hint, /small\.en/);
  assert.equal(res.stages.transcribe.status, "done", "the transcript is kept");
  assert.equal(res.transcriptQuality.verdict, "unreliable");
  assert.equal(counter.judge, 0);
  res = await resumeJob(job.id, { deps, force: true });
  assert.equal(res.stage, "ready");
  assert.ok(counter.judge > 0);
});

test("caption mode skips clip finding and waits for the caption review", async () => {
  const job = createJob(video, { mode: "caption", qualityGate: false });
  const counter = { probe: 0, transcribe: 0, judge: 0 };
  const res = await runJob(job.id, { deps: mocks(counter) });
  assert.equal(res.stage, "ready");
  assert.equal(res.stages.candidates.status, "skipped");
  assert.equal(counter.judge, 0);
  assert.ok(fs.existsSync(path.join(jobDir(job.id), "captions.json")));
  assert.equal(res.language.used, "en");
  assert.ok(res.transcriptQuality);
});

test("whisper's notes never reach sentences, candidates or captions; laughter is kept as an event", async () => {
  const job = createJob(video, { k: 3, model: "mock", qualityGate: false });
  const deps = mocks({ probe: 0, transcribe: 0, judge: 0 });
  // an older words.json: notes left in as words, split over tokens the way whisper -ml 1 does
  const noisy = [];
  WORDS.forEach((w, i) => {
    noisy.push(w);
    if (i % 25 === 12) for (const t of ["(speaking", "in", "foreign", "language)"]) noisy.push({ w: t, s: w.e + 0.01, e: w.e + 0.05, p: 0.3 });
    if (i % 40 === 20) noisy.push({ w: "(laughs)", s: w.e + 0.01, e: w.e + 0.06, p: 0.5 });
    if (i % 33 === 5) noisy.push({ w: "[BLANK_AUDIO]", s: w.e + 0.01, e: w.e + 0.06, p: 0.5 });
  });
  deps.transcribe = async () => noisy;
  const ready = await runJob(job.id, { deps });
  assert.equal(ready.stage, "ready");
  const dir = jobDir(job.id);
  const bad = /[[\]()]|speaking|BLANK|laughs/;
  const cands = JSON.parse(fs.readFileSync(path.join(dir, "candidates.json"), "utf8")).shortlist;
  assert.ok(cands.length > 0);
  for (const c of [...cands, ...ready.candidates]) assert.doesNotMatch(c.text, bad);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(dir, "words.json"), "utf8")).some((w) => bad.test(w.w)));
  const caps = (await import("./captions.mjs")).loadCaptions(dir);
  for (const cue of caps.cues) assert.doesNotMatch(cue.text, bad);
  const events = JSON.parse(fs.readFileSync(path.join(dir, "events.json"), "utf8"));
  assert.ok(events.some((e) => e.type === "laughter"));
});

test("the posting kit is written from the edited captions, not the raw whisper text", async () => {
  const { editCaptions, loadCaptions } = await import("./captions.mjs");
  const job = createJob(video, { k: 2, model: "mock", qualityGate: false });
  const ready = await runJob(job.id, { deps: mocks({ probe: 0, transcribe: 0, judge: 0 }) });
  const c = ready.candidates[0];
  updateCandidate(job.id, c.id, { status: "approved" });
  const dir = jobDir(job.id);
  // a person fixes an ASR error inside the clip: "tried" was really "Jedidiah's plan"
  const cues = loadCaptions(dir).cues;
  const i = cues.findIndex((q) => q.s >= c.start && q.e <= c.end && / tried /.test(` ${q.text} `));
  assert.ok(i >= 0);
  editCaptions(dir, cues.map((q, j) => ({ s: q.s, e: q.e, text: j === i ? q.text.replace("tried", "tested Jedidiah's plan") : q.text })));
  const seen = [];
  const deps = {
    render: async (_j, cand, { jobDir: d }) => {
      fs.mkdirSync(path.join(d, "clips"), { recursive: true });
      fs.writeFileSync(path.join(d, "clips", `${cand.id}.mp4`), "mp4");
      return { path: `clips/${cand.id}.mp4`, srt: `clips/${cand.id}.srt`, wallSec: 1 };
    },
    postingKit: async (cand) => {
      seen.push(cand);
      return { title: "T", caption: "C.", hashtags: [] };
    },
  };
  await renderJob(job.id, { deps });
  assert.equal(seen.length, 1);
  assert.match(seen[0].text, /tested Jedidiah's plan/);
  assert.equal(seen[0].id, c.id);
  assert.equal(loadJob(job.id).candidates.find((x) => x.id === c.id).text, c.text, "the candidate itself is not rewritten");
});

test("a plain kit takes its title from the edited first line", async () => {
  const { editCaptions, loadCaptions } = await import("./captions.mjs");
  const job = createJob(video, { k: 2, model: "mock", qualityGate: false, kit: "plain" });
  const ready = await runJob(job.id, { deps: mocks({ probe: 0, transcribe: 0, judge: 0 }) });
  const c = ready.candidates[0];
  updateCandidate(job.id, c.id, { status: "approved" });
  const dir = jobDir(job.id);
  const cues = loadCaptions(dir).cues;
  const first = cues.findIndex((q) => q.s >= c.start - 1e-6);
  editCaptions(dir, cues.map((q, j) => ({ s: q.s, e: q.e, text: j === first ? "Edited opener" : q.text })));
  const done = await renderJob(job.id, {
    deps: {
      render: async (_j, cand, { jobDir: d }) => {
        fs.mkdirSync(path.join(d, "clips"), { recursive: true });
        fs.writeFileSync(path.join(d, "clips", `${cand.id}.mp4`), "mp4");
        return { path: `clips/${cand.id}.mp4`, srt: `clips/${cand.id}.srt`, wallSec: 1 };
      },
    },
  });
  const kit = JSON.parse(fs.readFileSync(path.join(dir, done.candidates.find((x) => x.id === c.id).render.kit), "utf8"));
  assert.match(kit.title, /^Edited opener/);
});

test("kits carry the slide reminder only when the job has a credit, licence or source link", async () => {
  const renderDeps = {
    render: async (_j, cand, { jobDir: d }) => {
      fs.mkdirSync(path.join(d, "clips"), { recursive: true });
      fs.writeFileSync(path.join(d, "clips", `${cand.id}.mp4`), "mp4");
      return { path: `clips/${cand.id}.mp4`, srt: `clips/${cand.id}.srt`, wallSec: 1 };
    },
    postingKit: async () => ({ title: "T", caption: "C.", hashtags: [] }),
  };
  const kitOf = (id) => {
    const j = loadJob(id);
    const c = j.candidates.find((x) => x.render?.kit);
    return JSON.parse(fs.readFileSync(path.join(jobDir(id), c.render.kit), "utf8"));
  };
  for (const settings of [{}, { license: "own" }]) {
    const job = createJob(video, { k: 2, model: "mock", qualityGate: false, ...settings });
    const ready = await runJob(job.id, { deps: mocks({ probe: 0, transcribe: 0, judge: 0 }) });
    updateCandidate(job.id, ready.candidates[0].id, { status: "approved" });
    await renderJob(job.id, { deps: renderDeps });
    assert.equal(kitOf(job.id).reminder, null, JSON.stringify(settings));
    if (!settings.license) {
      // adding a credit later brings the reminder back; marking it own footage removes it
      updateJobSettings(job.id, { credit: "Jenni, EMF 2026" });
      assert.match(kitOf(job.id).reminder, /licence may not cover every figure/);
      updateJobSettings(job.id, { credit: "", license: "own" });
      assert.equal(loadJob(job.id).settings.license, "own");
      assert.equal(kitOf(job.id).reminder, null);
    }
  }
});

test("accent routing: English that whisper's detector heard as Yoruba is transcribed with the Nigerian-accent model", async () => {
  const fine = path.join(home, "ggml-small-nigerian-accent.bin");
  fs.writeFileSync(fine, "x");
  process.env.SELECTS_ACCENT_MODEL_NG = fine;
  try {
    const run = async (settings, detected) => {
      const job = createJob(video, { model: "mock", mode: "caption", ...settings });
      const seen = [];
      const deps = {
        ...mocks({ probe: 0, transcribe: 0, judge: 0 }),
        decideLanguage: async () => ({ setting: "auto", used: "en", detected, compared: [], margin: null, decided: "ensemble", warning: null, sec: 0 }),
      };
      const transcribe = deps.transcribe;
      deps.transcribe = async (p, o) => (seen.push(o.model), transcribe(p, o));
      const done = await runJob(job.id, { deps });
      return { done, model: seen[0] };
    };
    const ng = await run({}, { code: "yo", p: 0.9 });
    assert.equal(ng.model, fine);
    assert.equal(ng.done.accent.routed, true);
    assert.equal(ng.done.asr.accent, "ng");
    assert.equal(ng.done.accent.cues[0].kind, "audio");
    const plain = await run({}, { code: "en", p: 0.95 });
    assert.notEqual(plain.model, fine);
    assert.equal(plain.done.accent.routed, false);
    const off = await run({ accent: "none" }, { code: "yo", p: 0.9 });
    assert.notEqual(off.model, fine);
    const chosen = await run({ asrModel: "small.en" }, { code: "yo", p: 0.9 });
    assert.match(chosen.model, /ggml-small\.en\.bin$/, "the user's model choice wins");
    const profile = await run({ accent: "ng" }, { code: "en", p: 0.95 });
    assert.equal(profile.model, fine, "a profile that says Nigerian English routes without cues");
  } finally {
    delete process.env.SELECTS_ACCENT_MODEL_NG;
  }
});
