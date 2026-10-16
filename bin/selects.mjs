#!/usr/bin/env node
// selects: pull the best clips from a long video, on your own laptop.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { FONT_PATH, ollamaModels, ollamaUrl, resolveModel, selectsHome, whisperBin, whisperModel } from "../src/core/config.mjs";
import { attributionLine, licenseCheck, MEDIA_REMINDER, normaliseLicense } from "../src/core/attribution.mjs";
import { WEIGHTS, measuredSpeeds } from "../src/core/judge.mjs";
import { createJob, jobDir, jobEvents, listJobs, loadJob, renderJob, resumeJob, runJob, updateCandidate, updateJobSettings } from "../src/core/job.mjs";
import { drainQueue, enqueue, queueState } from "../src/core/queue.mjs";
import { diskFreeGb, run, slugify, tc } from "../src/core/util.mjs";

const HELP = `selects: pull the best clips from a long video. Everything runs on this laptop.

Usage
  selects <video> [options]      find clips, ask before cutting, render the approved ones
  selects review <job-id>        review and render a job that already ran (for example overnight)
  selects queue add <video...>   queue videos for overnight mode
  selects queue run              work through the queue, one video at a time
  selects queue                  show the queue
  selects jobs                   list jobs
  selects serve [--port 4317]    start the local review app
  selects doctor                 check whisper, Ollama, the judge model and disk

Options
  --model <name>    Ollama model for the judge (default: gemma3:4b, else a local gemma3 tag)
  --k <n>           how many clips to propose (default 5)
  --min <sec>       shortest clip (default 20)
  --max <sec>       longest clip (default 60)
  --judge-n <n>     how many pre-scored windows the model reads (default 8; more is slower)
  --preview         render fast 720x1280 drafts instead of final 1080x1920 clips
  --plain-kit       skip the model for post titles (use the clip's first line)
  --out <dir>       where clips go (default ./selects-out/<video-name>)
  --credit <text>   who to credit in each post caption, for example "Jenni, EMF 2026"
  --license <id>    the source's licence, for example CC-BY-SA-4.0 (adds the licence link)
  --source-url <u>  where the source video lives (added to the credit)
  --yes             approve every proposed clip without asking
  -h, --help        show this help
`;

const isTTY = process.stdout.isTTY;
const say = (s = "") => process.stdout.write(s + "\n");
const dim = (s) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const blue = (s) => (isTTY ? `\x1b[34m${s}\x1b[0m` : s);
const yellow = (s) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s);
const red = (s) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s);

function fmtEta(sec) {
  if (sec == null) return "";
  if (sec < 90) return `about ${Math.max(1, Math.round(sec))} s left`;
  if (sec < 5400) return `about ${Math.round(sec / 60)} min left`;
  return `about ${(sec / 3600).toFixed(1)} h left`;
}

const STAGE_NAMES = { probe: "Reading video", transcribe: "Transcribing", candidates: "Finding windows", judge: "Judging", render: "Rendering" };

/** Show stage progress: one live line on a terminal, a line every 15 s otherwise. */
function progressReporter(jobId) {
  let lastLine = "";
  let lastPrint = 0;
  let tail = [];
  const write = (line, final = false) => {
    if (isTTY) {
      const cols = process.stdout.columns || 100;
      process.stdout.write("\r\x1b[2K" + line.slice(0, cols - 1) + (final ? "\n" : ""));
    } else if (final || Date.now() - lastPrint > 15000) {
      say(line);
      lastPrint = Date.now();
    }
    lastLine = final ? "" : line;
  };
  const onEvent = ({ type, data }) => {
    if (type === "words") {
      tail = tail.concat(data.map((w) => w.w)).slice(-8);
    } else if (type === "progress") {
      const pct = `${Math.round((data.progress ?? 0) * 100)}%`.padStart(4);
      const extra = data.name === "transcribe" && tail.length ? dim(`  ...${tail.join(" ")}`) : "";
      write(`${STAGE_NAMES[data.name] || data.name} ${pct}  ${data.note || ""}  ${fmtEta(data.etaSec)}${extra}`);
    } else if (type === "stage" && data.name && data.state) {
      const st = data.state;
      if (st.status === "running") write(`${STAGE_NAMES[data.name]}...`);
      if (st.status === "done") {
        const secs = st.startedAt && st.endedAt ? (Date.parse(st.endedAt) - Date.parse(st.startedAt)) / 1000 : null;
        write(`${STAGE_NAMES[data.name]}: done${secs != null ? ` in ${secs < 90 ? secs.toFixed(1) + " s" : (secs / 60).toFixed(1) + " min"}` : ""}. ${dim(st.note || "")}`, true);
      }
    } else if (type === "render") {
      if (data.status === "running") write(`Rendering ${data.id} ${Math.round((data.progress ?? 0) * 100)}%`);
      if (data.status === "done") write(`Rendered ${data.id}${data.title ? `: ${data.title}` : ""}`, true);
    } else if (type === "error") {
      if (lastLine && isTTY) process.stdout.write("\n");
    }
  };
  jobEvents.on(jobId, onEvent);
  return () => jobEvents.off(jobId, onEvent);
}

function printCandidates(job) {
  const cs = job.candidates;
  if (!cs.length) {
    say("No clips stood out. Try a lower --min, a higher --max, or a higher --judge-n.");
    return;
  }
  say("");
  say(bold(`${cs.length} proposed clip${cs.length === 1 ? "" : "s"} from ${job.source.name}`));
  for (const c of cs) {
    const s = c.scores || {};
    say("");
    say(`${bold(String(c.rank ?? "-").padStart(2))}  ${tc(c.start)} to ${tc(c.end)}  ${Math.round(c.end - c.start)} s   ${blue(`score ${(c.total ?? 0).toFixed(2)}`)}   ${dim(`hook ${s.hook ?? "-"}  stands alone ${s.standalone ?? "-"}  payoff ${s.payoff ?? "-"}  clarity ${s.clarity ?? "-"}`)}`);
    say(`    "${c.hook.length > 110 ? c.hook.slice(0, 107) + "..." : c.hook}"`);
    if (c.reason) say(`    ${blue(c.reason)}`);
  }
  say("");
}

async function askApprovals(job, { yes }) {
  if (yes) {
    for (const c of job.candidates) updateCandidate(job.id, c.id, { status: "approved" });
    say(`Approved all ${job.candidates.length} (--yes).`);
    return loadJob(job.id);
  }
  if (!process.stdin.isTTY) {
    say(red("No terminal to ask in. Run again with --yes to approve every clip, or use `selects serve` to review in the browser."));
    say(`The job is saved as ${job.id}; \`selects review ${job.id}\` picks it up.`);
    process.exit(2);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  say("Nothing is cut until you approve it. y approves, n skips, q stops asking (the rest are skipped).");
  for (const c of job.candidates) {
    if (c.status !== "proposed") continue;
    const a = (await rl.question(`Approve clip ${c.rank} (${tc(c.start)} to ${tc(c.end)})? [y/n/q] `)).trim().toLowerCase();
    if (a === "q") break;
    updateCandidate(job.id, c.id, { status: a === "y" || a === "yes" ? "approved" : "skipped" });
  }
  rl.close();
  return loadJob(job.id);
}

function exportClips(job, outDir, { preview }) {
  fs.mkdirSync(outDir, { recursive: true });
  const field = preview ? "preview" : "render";
  const dir = jobDir(job.id);
  const done = job.candidates.filter((c) => c[field]?.status === "done");
  const lines = [`# Clips from ${job.source.name}`, "", `Job ${job.id}. Judge model: ${job.settings.model}.`, ""];
  for (const c of done) {
    const base = `${String(c.rank).padStart(2, "0")}-${slugify(c.title || c.hook, 40)}${preview ? "-preview" : ""}`;
    const place = (rel, ext) => {
      if (!rel) return null;
      const dst = path.join(outDir, base + ext);
      fs.rmSync(dst, { force: true });
      try {
        fs.linkSync(path.join(dir, rel), dst); // a hard link costs no extra disk
      } catch {
        fs.copyFileSync(path.join(dir, rel), dst);
      }
      return path.basename(dst);
    };
    const mp4 = place(c[field].path, ".mp4");
    place(c[field].srt, ".srt");
    place(c[field].kit, ".kit.json");
    let kit = null;
    try {
      kit = c[field].kit ? JSON.parse(fs.readFileSync(path.join(dir, c[field].kit), "utf8")) : null;
    } catch {}
    lines.push(`## ${c.rank}. ${c.title || c.hook}`, "", `- File: ${mp4}`, `- Source: ${tc(c.start)} to ${tc(c.end)} (${Math.round(c.end - c.start)} s)`, `- Scores: hook ${c.scores?.hook}, stands alone ${c.scores?.standalone}, payoff ${c.scores?.payoff}, clarity ${c.scores?.clarity} (total ${c.total})`, `- Why: ${c.reason}`);
    if (kit) lines.push(`- Caption: ${kit.caption.replace(/\n+/g, " ")}`, `- Hashtags: ${kit.hashtags.map((h) => "#" + h).join(" ")}`);
    lines.push("");
  }
  const credit = attributionLine(job.settings);
  if (credit) lines.push(`Credit: ${credit}`, "");
  lines.push(MEDIA_REMINDER, "");
  fs.writeFileSync(path.join(outDir, "clips.md"), lines.join("\n"));
  return done.length;
}

async function finishJob(job, values) {
  const stop = progressReporter(job.id);
  try {
    if (job.stage === "error") return fail(job);
    printCandidates(job);
    if (!job.candidates.length) return;
    job = await askApprovals(job, values);
    const approved = job.candidates.filter((c) => c.status === "approved");
    if (!approved.length) {
      say("No clips approved, so nothing was rendered.");
      return;
    }
    say("");
    say(`Rendering ${approved.length} clip${approved.length === 1 ? "" : "s"}${values.preview ? " as fast previews" : ""}...`);
    job = await renderJob(job.id, { preset: values.preview ? "preview" : undefined, kit: values["plain-kit"] ? "plain" : undefined });
    if (job.stage === "error") return fail(job);
    const outDir = path.resolve(values.out || path.join("selects-out", path.parse(job.source.name).name));
    const n = exportClips(job, outDir, values);
    say("");
    say(yellow(`Rendered ${n} clip${n === 1 ? "" : "s"} into ${outDir}`));
    const credit = attributionLine(job.settings);
    say(credit ? dim(`Credit added to each caption: ${credit}`) : dim("No credit set. If the source is someone else's work, add --credit and --license (selects review <job-id> --credit ...)."));
    say(MEDIA_REMINDER);
    printTimings(job);
  } finally {
    stop();
  }
}

function printTimings(job) {
  const t = job.timings || {};
  const parts = [];
  for (const k of ["probe", "transcribe", "candidates", "judge"]) if (t[k] != null) parts.push(`${k} ${t[k]} s`);
  const r = [...(Array.isArray(t.render) ? t.render : []), ...(Array.isArray(t.preview) ? t.preview : [])];
  if (r.length) parts.push(`render ${r.map((x) => `${x.sec} s`).join(", ")}`);
  if (parts.length) say(dim(`Time per stage: ${parts.join("; ")}`));
}

function fail(job) {
  say("");
  say(red(job.error?.message || "Something went wrong."));
  if (job.error?.hint) say(job.error.hint);
  say(dim(`Job ${job.id} is saved. \`selects review ${job.id}\` resumes it.`));
  process.exitCode = 1;
}

/** Warn about NC and stop on ND before any work is done. Returns false to stop. */
function checkLicense(license) {
  if (!license) return true;
  const id = normaliseLicense(license);
  if (!id) {
    say(red(`Unknown licence "${license}". Use an id like CC-BY-4.0, CC-BY-SA-4.0 or CC0-1.0.`));
    return false;
  }
  const chk = licenseCheck(id);
  for (const w of chk.warnings) say(yellow(w));
  return true;
}

async function cmdClip(video, values) {
  const settings = {
    model: values.model || (await resolveModel()),
    k: values.k ? +values.k : undefined,
    minLen: values.min ? +values.min : undefined,
    maxLen: values.max ? +values.max : undefined,
    judgeN: values["judge-n"] ? +values["judge-n"] : undefined,
    kit: values["plain-kit"] ? "plain" : undefined,
    credit: values.credit,
    license: values.license,
    sourceUrl: values["source-url"],
  };
  if (!checkLicense(values.license)) process.exit(1);
  let job;
  try {
    job = createJob(video, settings);
  } catch (e) {
    say(red(e.message));
    if (e.hint) say(e.hint);
    process.exit(1);
  }
  say(`${bold(job.source.name)}  ${dim(`job ${job.id}, judge ${job.settings.model}, top ${job.settings.judgeN} windows judged`)}`);
  const stop = progressReporter(job.id);
  const t0 = Date.now();
  job = await runJob(job.id);
  stop();
  if (job.stage !== "error") say(dim(`Found clips in ${((Date.now() - t0) / 60000).toFixed(1)} min.`));
  await finishJob(job, values);
}

async function cmdReview(id, values) {
  let job;
  try {
    job = loadJob(id);
  } catch (e) {
    say(red(e.message));
    process.exit(1);
  }
  const credit = {};
  if (values.credit != null) credit.credit = values.credit;
  if (values.license != null) credit.license = values.license;
  if (values["source-url"] != null) credit.sourceUrl = values["source-url"];
  if (Object.keys(credit).length) {
    if (!checkLicense(values.license)) process.exit(1);
    job = updateJobSettings(id, credit);
  }
  if (job.stage !== "ready" && job.stage !== "done") {
    say(`Resuming ${id} from ${job.stage}...`);
    const stop = progressReporter(id);
    job = await resumeJob(id);
    stop();
  }
  await finishJob(job, values);
}

async function cmdQueue(sub, files, values) {
  if (sub === "add") {
    const model = values.model || (await resolveModel());
    for (const f of files) {
      try {
        const job = createJob(f, { model, k: values.k ? +values.k : undefined, judgeN: values["judge-n"] ? +values["judge-n"] : undefined });
        enqueue({ jobId: job.id });
        say(`Queued ${job.source.name} as ${job.id}`);
      } catch (e) {
        say(red(`${f}: ${e.message}`));
      }
    }
    say("Run `selects queue run` and leave the laptop plugged in. Review in the morning with `selects review <job-id>` or `selects serve`.");
    return;
  }
  if (sub === "run") {
    const q = queueState();
    if (!q.items.length) return say("The queue is empty. Add videos with `selects queue add <video...>`.");
    say(`Working through ${q.items.length} queued job${q.items.length === 1 ? "" : "s"}, one at a time. Progress is saved after every stage.`);
    const stops = q.items.map((i) => progressReporter(i.jobId));
    const done = await drainQueue({
      onItem: (item, job) => say(`${item.jobId}: ${job.stage === "error" ? red(job.error?.message) : `${job.stage}, ${job.candidates?.length ?? 0} clips proposed`}`),
    });
    stops.forEach((s) => s());
    say(`Finished ${done.length}. Review with \`selects review <job-id>\` or \`selects serve\`.`);
    return;
  }
  const q = queueState();
  if (!q.items.length) say("The queue is empty.");
  for (const i of q.items) say(`${i.jobId}  ${i.kind}  added ${i.addedAt}`);
}

function cmdJobs() {
  const jobs = listJobs();
  if (!jobs.length) return say("No jobs yet.");
  for (const j of jobs) say(`${j.id}  ${j.stage.padEnd(12)} ${String(j.candidateCount).padStart(2)} clips, ${j.approvedCount} approved  ${j.source.name}`);
}

async function cmdDoctor() {
  const checks = [];
  const add = (name, ok, detail, hint) => checks.push({ name, ok, detail, hint });
  const nodeMajor = +process.versions.node.split(".")[0];
  add("Node", nodeMajor >= 20 ? "ok" : "fail", process.versions.node, "Install Node 20 or newer from nodejs.org.");
  try {
    const r = await run("ffmpeg", ["-hide_banner", "-encoders"]);
    add("ffmpeg", /libx264/.test(r.stdout) ? "ok" : "fail", /libx264/.test(r.stdout) ? "with libx264" : "no libx264 encoder", "Install ffmpeg with libx264: brew install ffmpeg");
  } catch {
    add("ffmpeg", "fail", "not found", "Install ffmpeg: brew install ffmpeg");
  }
  const wb = whisperBin();
  try {
    await run(wb, ["-h"], { allowFail: true });
    add("whisper-cli", "ok", wb, "");
  } catch {
    add("whisper-cli", "fail", `not found at ${wb}`, "Build whisper.cpp (cmake -B build && cmake --build build -j) and set SELECTS_WHISPER_BIN to build/bin/whisper-cli.");
  }
  const wm = whisperModel();
  add("whisper model", fs.existsSync(wm) ? "ok" : "fail", fs.existsSync(wm) ? `${path.basename(wm)}, ${(fs.statSync(wm).size / 1e6).toFixed(0)} MB` : `missing at ${wm}`, "Download ggml-base.en.bin from huggingface.co/ggerganov/whisper.cpp and set SELECTS_WHISPER_MODEL.");
  let version = null;
  try {
    const r = await fetch(`${ollamaUrl()}/api/version`, { signal: AbortSignal.timeout(3000) });
    version = (await r.json()).version;
  } catch {}
  add("Ollama", version ? "ok" : "fail", version ? `${ollamaUrl()}, version ${version}` : `not reachable at ${ollamaUrl()}`, "Open the Ollama app or run `ollama serve`. Get it from ollama.com.");
  const models = await ollamaModels();
  const judgeModel = await resolveModel();
  const have = models.find((m) => m.name === judgeModel);
  add("Judge model", have ? "ok" : version ? "fail" : "warn", have ? `${judgeModel}, ${have.sizeGb} GB` : `${judgeModel} is not pulled`, `ollama pull ${judgeModel}  (or pass --model with one of: ${models.map((m) => m.name).join(", ") || "none installed"})`);
  const speeds = measuredSpeeds();
  if (speeds[judgeModel]) add("Judge speed", "ok", `measured ${speeds[judgeModel].secPerCandidate} s per clip on this machine (${speeds[judgeModel].n} clips)`, "");
  let canvasOk = false;
  try {
    await import("@napi-rs/canvas");
    canvasOk = fs.existsSync(FONT_PATH);
  } catch {}
  add("Captions", canvasOk ? "ok" : "fail", canvasOk ? "@napi-rs/canvas and Atkinson Hyperlegible Next" : "canvas or font missing", "Run npm install in the selects folder.");
  fs.mkdirSync(selectsHome(), { recursive: true });
  const free = diskFreeGb(selectsHome());
  add("Free disk", free == null ? "warn" : free >= 5 ? "ok" : free >= 2 ? "warn" : "fail", free == null ? "unknown" : `${free} GB free at ${selectsHome()}`, "Free some space: a 30-minute job needs about 1 GB while it runs (the audio is deleted after transcription).");
  for (const c of checks) {
    const mark = c.ok === "ok" ? "ok  " : c.ok === "warn" ? yellow("warn") : red("fail");
    say(`${mark}  ${c.name.padEnd(14)} ${c.detail}`);
    if (c.ok !== "ok" && c.hint) say(`      ${dim("fix: " + c.hint)}`);
  }
  say(dim(`Judge weights: ${Object.entries(WEIGHTS).map(([k, v]) => `${k} ${v}`).join(", ")}`));
  if (checks.some((c) => c.ok === "fail")) process.exitCode = 1;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: "string" },
      k: { type: "string" },
      min: { type: "string" },
      max: { type: "string" },
      "judge-n": { type: "string" },
      out: { type: "string" },
      port: { type: "string" },
      yes: { type: "boolean", short: "y" },
      preview: { type: "boolean" },
      "plain-kit": { type: "boolean" },
      credit: { type: "string" },
      license: { type: "string" },
      "source-url": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) return say(HELP);
  if (cmd === "doctor") return cmdDoctor();
  if (cmd === "serve") {
    const { startServer } = await import("../src/server/server.mjs");
    return startServer({ port: values.port ? +values.port : undefined });
  }
  if (cmd === "queue") return cmdQueue(rest[0], rest.slice(1), values);
  if (cmd === "jobs") return cmdJobs();
  if (cmd === "review") return cmdReview(rest[0], values);
  return cmdClip(cmd, values);
}

main().catch((e) => {
  say(red(e.message || String(e)));
  if (e.hint) say(e.hint);
  process.exitCode = 1;
});
