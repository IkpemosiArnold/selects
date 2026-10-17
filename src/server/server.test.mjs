// HTTP API against a job built with mocked whisper and judge.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { talk } from "../core/test/fixtures.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "selects-server-"));
process.env.SELECTS_HOME = home;
process.env.SELECTS_OLLAMA_URL = "http://127.0.0.1:9"; // nothing listens there: health reports ollama false fast
const { createJob, runJob, saveJob, loadJob, jobDir } = await import("../core/job.mjs");
const { startServer } = await import("./server.mjs");

const WORDS = talk(100);
const video = path.join(home, "talk.mp4");
let server;
let base;
let job;

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

before(async () => {
  fs.writeFileSync(video, Buffer.from("0123456789".repeat(100)));
  job = createJob(video, { model: "mock", qualityGate: false, k: 3 });
  job = await runJob(job.id, {
    deps: {
      probe: async (p) => ({ path: p, name: "talk.mp4", duration: WORDS[WORDS.length - 1].e + 1, width: 1920, height: 1080, fps: 25 }),
      thumbs: async () => null,
      decideLanguage: async (_p, { setting }) => ({ setting, used: setting === "auto" ? "en" : setting, detected: null, compared: [], margin: null, decided: "setting", warning: null, sec: 0 }),
      transcribe: async () => WORDS,
      listwise: async (cs) => ({ candidates: cs, order: [], reasons: {} }),
      judge: async (cs) => cs.map((c, i) => ({ ...c, scores: { hook: 4, standalone: 4, payoff: 3, clarity: 3 }, total: 0.7 - i * 0.01, reason: "Fine." })),
    },
  });
  server = await startServer({ port: 0, quiet: true });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("health reports whisper, ollama, models and disk", async () => {
  const r = await req("GET", "/api/health");
  assert.equal(r.status, 200);
  for (const k of ["ok", "whisper", "ollama", "models", "diskFreeGb"]) assert.ok(k in r.json, k);
  assert.equal(r.json.ollama, false);
});

test("lists and gets jobs; words; 404 for unknown", async () => {
  const list = await req("GET", "/api/jobs");
  assert.equal(list.json[0].id, job.id);
  const one = await req("GET", `/api/jobs/${job.id}`);
  assert.equal(one.json.stage, "ready");
  assert.equal(one.json.candidates.length, 3);
  const words = await req("GET", `/api/jobs/${job.id}/words`);
  assert.equal(words.json.length, WORDS.length);
  assert.equal((await req("GET", "/api/jobs/j_nope")).status, 404);
  assert.equal((await req("GET", "/api/nothing")).status, 404);
});

test("PATCH approves and snaps a trim", async () => {
  const c = job.candidates[0];
  const r = await req("PATCH", `/api/jobs/${job.id}/candidates/${c.id}`, { body: { status: "approved", end: c.end - 2.2 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "approved");
  assert.equal(r.json.trimmed, true);
  assert.ok(WORDS.some((w) => w.e === r.json.end), "end snapped to a word end");
  const bad = await req("PATCH", `/api/jobs/${job.id}/candidates/${c.id}`, { body: { status: "maybe" } });
  assert.equal(bad.status, 400);
});

test("POST /api/jobs rejects a missing file with a message and hint", async () => {
  const r = await req("POST", "/api/jobs", { body: { path: path.join(home, "missing.mp4") } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /No file/);
  assert.ok(r.json.hint);
});

test("render needs an approved clip", async () => {
  const fresh = await req("POST", `/api/jobs/${job.id}/render`, { body: { ids: [] } });
  assert.equal(fresh.status, 400);
});

test("media supports Range requests", async () => {
  const full = await req("GET", `/media/${job.id}/source`);
  assert.equal(full.status, 200);
  assert.equal(full.headers["accept-ranges"], "bytes");
  assert.equal(full.text.length, 1000);
  const part = await req("GET", `/media/${job.id}/source`, { headers: { range: "bytes=10-19" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers["content-range"], "bytes 10-19/1000");
  assert.equal(part.text, "0123456789");
  const tail = await req("GET", `/media/${job.id}/source`, { headers: { range: "bytes=-5" } });
  assert.equal(tail.text, "56789");
  const bad = await req("GET", `/media/${job.id}/source`, { headers: { range: "bytes=5000-" } });
  assert.equal(bad.status, 416);
});

test("SSE sends the job first", async () => {
  const text = await new Promise((resolve, reject) => {
    const r = http.get(`${base}/api/jobs/${job.id}/events`, (res) => {
      assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        if (buf.includes("event: job")) {
          r.destroy();
          resolve(buf);
        }
      });
    });
    r.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
  });
  assert.match(text, /event: job\ndata: \{/);
});

test("cross-site writes are refused, local origins allowed", async () => {
  const c = job.candidates[1];
  const evil = await req("PATCH", `/api/jobs/${job.id}/candidates/${c.id}`, { body: { status: "skipped" }, headers: { origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  const ok = await req("PATCH", `/api/jobs/${job.id}/candidates/${c.id}`, { body: { status: "skipped" }, headers: { origin: "http://localhost:5173" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["access-control-allow-origin"], "http://localhost:5173");
});

test("locate finds a dropped file by name and size", async () => {
  process.chdir(home);
  const r = await req("GET", `/api/locate?name=talk.mp4&size=1000`);
  assert.equal(r.status, 200);
  assert.equal(fs.realpathSync(r.json.path), fs.realpathSync(video));
  assert.equal((await req("GET", `/api/locate?name=talk.mp4&size=7`)).status, 404);
});

test("PATCH a job's credit and licence", async () => {
  const r = await req("PATCH", `/api/jobs/${job.id}`, { body: { settings: { credit: "Jenni, EMF 2026", license: "by-sa" } } });
  assert.equal(r.status, 200);
  assert.equal(r.json.settings.license, "CC-BY-SA-4.0");
  assert.equal(r.json.settings.credit, "Jenni, EMF 2026");
  const bad = await req("PATCH", `/api/jobs/${job.id}`, { body: { settings: { k: 9 } } });
  assert.equal(bad.status, 400);
});

test("GET a clip's posting kit with absolute paths", async () => {
  const j = loadJob(job.id);
  const c = j.candidates[0];
  c.render = { status: "done", path: `clips/${c.id}.mp4`, srt: `clips/${c.id}.srt`, kit: `clips/${c.id}.kit.json`, progress: 1 };
  saveJob(j);
  fs.mkdirSync(path.join(jobDir(j.id), "clips"), { recursive: true });
  fs.writeFileSync(path.join(jobDir(j.id), c.render.kit), JSON.stringify({ title: "T", caption: "C", captionText: "C", hashtags: ["a"], attribution: null }));
  const r = await req("GET", `/api/jobs/${j.id}/candidates/${c.id}/kit`);
  assert.equal(r.status, 200);
  assert.equal(r.json.caption, "C");
  assert.equal(r.json.file, path.join(jobDir(j.id), "clips", `${c.id}.mp4`));
  assert.equal((await req("GET", `/api/jobs/${j.id}/candidates/${j.candidates[1].id}/kit`)).status, 404);
});

test("captions: get, edit keeping timings, SRT and VTT downloads, reset", async () => {
  const g = await req("GET", `/api/jobs/${job.id}/captions`);
  assert.equal(g.status, 200);
  assert.ok(g.json.cues.length > 10);
  assert.equal(g.json.lowP, 0.5);
  const cues = g.json.cues.map((c) => ({ s: c.s, e: c.e, text: c.text }));
  cues[0].text = "Edited " + cues[0].text.split(" ").slice(1).join(" ");
  const put = await req("PUT", `/api/jobs/${job.id}/captions`, { body: { cues } });
  assert.equal(put.status, 200);
  assert.equal(put.json.edited, true);
  assert.equal(put.json.cues[0].words[0].w, "Edited");
  assert.equal(put.json.cues[0].words[0].s, g.json.cues[0].words[0].s);
  const srt = await req("GET", `/api/jobs/${job.id}/captions.srt`);
  assert.match(srt.text, /^1\n00:00:00,000 --> .*\nEdited /);
  const vtt = await req("GET", `/api/jobs/${job.id}/captions.vtt`);
  assert.match(vtt.text, /^WEBVTT/);
  const bad = await req("PUT", `/api/jobs/${job.id}/captions`, { body: { nope: 1 } });
  assert.equal(bad.status, 400);
  const reset = await req("POST", `/api/jobs/${job.id}/captions/reset`);
  assert.equal(reset.json.edited, false);
});

test("blur is validated on clips and job settings", async () => {
  const cid = (await req("GET", `/api/jobs/${job.id}`)).json.candidates[0].id;
  const ok = await req("PATCH", `/api/jobs/${job.id}/candidates/${cid}`, { body: { blur: { faces: { mode: "others" }, regions: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, start: null, end: null }] } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.blur.faces.mode, "others");
  const bad = await req("PATCH", `/api/jobs/${job.id}/candidates/${cid}`, { body: { blur: { regions: [{ x: 2, y: 0, w: 1, h: 1 }] } } });
  assert.equal(bad.status, 400);
  const js = await req("PATCH", `/api/jobs/${job.id}`, { body: { settings: { blur: { faces: { mode: "all" } }, captions: false } } });
  assert.equal(js.status, 200);
  assert.equal(js.json.settings.blur.faces.mode, "all");
  assert.equal(js.json.settings.captions, false);
  const lang = await req("POST", `/api/jobs/${job.id}/language`, { body: { language: "not a code" } });
  assert.equal(lang.status, 400);
  // the answer to "Is the speaker using English?": yes keeps the transcript
  const yes = await req("POST", `/api/jobs/${job.id}/language`, { body: { language: "en", confirm: true } });
  assert.equal(yes.status, 200);
  assert.equal(yes.json.language.confirmed.language, "en");
  assert.equal(yes.json.language.question, null);
  assert.equal(yes.json.stages.transcribe.status, "done", "nothing is transcribed again");
  const wrong = await req("POST", `/api/jobs/${job.id}/language`, { body: { language: "yo", confirm: true } });
  assert.equal(wrong.status, 409);
  const badAccent = await req("POST", `/api/jobs/${job.id}/language`, { body: { language: "en", accent: "xx" } });
  assert.equal(badAccent.status, 400);
  const faces = await req("GET", `/api/jobs/${job.id}/faces`);
  assert.equal(faces.status, 404);
});

test("approve top N: the best clips in one call, without rendering unless asked", async () => {
  const before = (await req("GET", `/api/jobs/${job.id}`)).json.candidates;
  const top = await req("POST", `/api/jobs/${job.id}/approve`, { body: { top: 2 } });
  assert.equal(top.status, 200);
  const best = before.filter((c) => c.status !== "skipped").slice(0, 2).map((c) => c.id);
  assert.ok(top.json.approved >= 2);
  for (const id of best) assert.equal(top.json.candidates.find((c) => c.id === id).status, "approved");
  const bad = await req("POST", `/api/jobs/${job.id}/approve`, { body: { top: "lots" } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.hint, /top: 10/);
});
