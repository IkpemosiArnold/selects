#!/usr/bin/env node
// selects: pull the best clips from a long video, on your own laptop.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { FONT_PATH, config, ollamaModels, ollamaUrl, resolveModel, selectsHome, whisperBin, whisperModel } from "../src/core/config.mjs";
import { attributionLine, licenseCheck, mediaReminder, normaliseLicense } from "../src/core/attribution.mjs";
import { WEIGHTS, measuredSpeeds } from "../src/core/judge.mjs";
import { createJob, detectJobFaces, jobDir, jobEvents, listJobs, loadJob, renderJob, resumeJob, runJob, updateCandidate, updateJobSettings } from "../src/core/job.mjs";
import { editCaptions, loadCaptions, parseSubtitles, toSrt } from "../src/core/captions.mjs";
import { parseRegion } from "../src/core/blur.mjs";
import { facesAvailable } from "../src/core/faces.mjs";
import { languageName } from "../src/core/language.mjs";
import { asrModels } from "../src/core/config.mjs";
import { drainQueue, enqueue, queueState } from "../src/core/queue.mjs";
import { diskFreeGb, run, slugify, tc } from "../src/core/util.mjs";
import { aboutTime, overnightAdvice } from "../src/core/estimate.mjs";
import { AUDIOGRAM_PRESETS } from "../src/core/audiogram.mjs";

const HELP = `selects: pull the best clips from a long video. Everything runs on this laptop.

Usage
  selects <video> [options]      find clips, ask before cutting, render the approved ones
  selects caption <video>        caption the whole video (its own aspect, no clipping): MP4, SRT, VTT
  selects review <job-id>        review and render a job that already ran (for example overnight)
  selects queue add <video...>   queue videos for overnight mode
  selects queue run              work through the queue, one video at a time
  selects queue                  show the queue
  selects jobs                   list jobs
  selects serve [--port 4317]    start the local review app
  selects doctor [--json]        show the resolved config; check whisper, Ollama, the judge model and disk

Options
  --model <name>    Ollama model for the judge (default: gemma3:4b, else a local gemma3 tag)
  --k <n>           how many clips to propose (default 5)
  --made-for <p>    where the clips go: shorts (default: Shorts, Reels or TikTok, 20 to 60 s),
                    linkedin (30 to 90 s, subtitles, no hashtag spam), x (15 to 45 s, one short
                    line), story (60 to 90 s with a setup, a turn and a resolution)
  --min <sec>       shortest clip (default 20)
  --max <sec>       longest clip (default 60)
  --judge-n <n>     how many pre-scored windows the model reads (default: max(16, 2 x k), more
                    for long videos, capped at about half the video's length in judge time)
  --faithful <m>    check each pick still says what the speaker meant: model (default, one
                    call per pick), rules (no model), or off
  --h2h             order the best 8 clips by comparing them two at a time (about 12 more
                    model calls, 10 to 30 minutes on a laptop CPU) instead of one side-by-side call
  --preview         render fast 720x1280 drafts instead of final 1080x1920 clips
  --plain-kit       skip the model for post titles (use the clip's first line)
  --out <dir>       where clips go (default ./selects-out/<video-name>)
  --credit <text>   who to credit in each post caption, for example "Jenni, EMF 2026"
  --license <id>    the source's licence, for example CC-BY-SA-4.0 (adds the licence link), or own
  --source-url <u>  where the source video lives (added to the credit)
  --yes             approve every proposed clip without asking
  --force           judge clips even when the transcript looks unreliable

Speech and captions (clips and caption mode)
  --language <code> spoken language: en (default), auto (decode and compare), or a code like yo
  --asr-model <m>   whisper model: auto (base.en for English), small.en, medium.en-q5_0, a path...
  --prompt <text>   a short neutral context for whisper
  --accent <a>      auto (default: Nigerian-accented English goes to a fine-tuned model when the
                    language check finds cues), ng (always, for English), or none
  --clean-audio     cut rumble and hiss and even out loudness before whisper
  --fresh           check the language and transcribe again, even if this video was done before
  --no-captions     render clips without burned-in captions
  --style <s>       caption look: bold (2 to 4 words, current word yellow) or subtitle (two lines)
  --captions <l>    source (default); en and both are planned
  --edit            (caption) write an editable SRT, wait for you to fix it, then render
  --srt <file>      (caption) use your corrected SRT; words keep their timings

Audio files (MP3, M4A, AAC, WAV, FLAC, Ogg, Opus, WebM audio): clips become 9:16 audiograms
  --bg <name>       the background: sunny (default), moon, cat, robot, cactus or frog
  --cover <image>   your own background image (JPEG, PNG or WebP; it stays on this laptop)

Privacy blur
  --blur-faces <m>  all, or others (everyone except the main speaker); macOS only
  --blur-region <r> x,y,w,h as fractions of the frame, optionally @start-end in seconds;
                    repeat for more regions, for example --blur-region 0.6,0.05,0.35,0.1@12-30

Profiles (remember what worked for a speaker or channel)
  --profile <name>       start from a saved profile (language, model, prompt, style)
  --save-profile <name>  save this run's speech settings as a profile
  -h, --help        show this help
`;

const isTTY = process.stdout.isTTY;
const say = (s = "") => process.stdout.write(s + "\n");
const dim = (s) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const blue = (s) => (isTTY ? `\x1b[34m${s}\x1b[0m` : s);
const yellow = (s) => (isTTY ? `\x1b[33m${s}\x1b[0m` : s);
const red = (s) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s);


/** The judge's scores as text: the current rubric, or the earlier one for an older job. */
function scoreLine(s, sep = "  ") {
  const names = s.moment != null || s.payoff == null ? [["moment", "moment"], ["share", "share"], ["hook", "hook"], ["standalone", "stands alone"]] : [["hook", "hook"], ["standalone", "stands alone"], ["payoff", "payoff"], ["clarity", "clarity"]];
  return names.map(([k, l]) => `${l} ${s[k] ?? "-"}`).join(sep);
}
function fmtEta(sec) {
  if (sec == null) return "";
  if (sec < 90) return `about ${Math.max(1, Math.round(sec))} s left`;
  if (sec < 5400) return `about ${Math.round(sec / 60)} min left`;
  return `about ${(sec / 3600).toFixed(1)} h left`;
}

const STAGE_NAMES = { probe: "Reading the file", language: "Checking the language", transcribe: "Transcribing", candidates: "Finding windows", judge: "Judging", render: "Rendering" };

/** Show stage progress: one live line on a terminal, a line every 15 s otherwise. */
function progressReporter(jobId, { videoName = null } = {}) {
  let estimated = false;
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
    } else if (type === "estimate") {
      // the whole job, before it starts: honest numbers, and overnight mode when it is long
      if (!estimated) {
        estimated = true;
        const s = data.stages || {};
        write(dim(`Estimate on this laptop: ${aboutTime(data.analysisSec)} to find the clips (transcribing ${aboutTime(s.transcribe)}, judging ${aboutTime(s.judge)}), then ${aboutTime(data.renderSec)} to render them.`), true);
        const advice = overnightAdvice(data, { video: JSON.stringify(videoName || "<video>") });
        if (advice) write(yellow(advice), true);
      }
    } else if (type === "progress") {
      const pct = `${Math.round((data.progress ?? 0) * 100)}%`.padStart(4);
      const extra = data.name === "transcribe" && tail.length ? dim(`  ...${tail.join(" ")}`) : "";
      const all = data.jobEtaSec != null && data.jobEtaSec - (data.etaSec ?? 0) > 60 ? dim(` (${aboutTime(data.jobEtaSec)} for the whole job)`) : "";
      write(`${STAGE_NAMES[data.name] || data.name} ${pct}  ${data.note || ""}  ${fmtEta(data.etaSec)}${all}${extra}`);
    } else if (type === "stage" && data.name && data.state) {
      const st = data.state;
      if (st.status === "running") write(`${STAGE_NAMES[data.name]}...`);
      if (st.status === "done") {
        const secs = st.startedAt && st.endedAt ? (Date.parse(st.endedAt) - Date.parse(st.startedAt)) / 1000 : null;
        write(`${STAGE_NAMES[data.name]}: done${secs != null ? ` in ${secs < 90 ? secs.toFixed(1) + " s" : (secs / 60).toFixed(1) + " min"}` : ""}. ${dim(st.note || "")}`, true);
      }
    } else if (type === "render") {
      const q = data.queue ? ` (clip ${Math.min(data.queue.total, data.queue.done + (data.status === "done" ? 0 : 1))} of ${data.queue.total}${data.queue.etaSec ? `, ${fmtEta(data.queue.etaSec)}` : ""})` : "";
      if (data.status === "running") write(`Rendering ${data.id} ${Math.round((data.progress ?? 0) * 100)}%${q}`);
      if (data.status === "done") write(`Rendered ${data.id}${data.title ? `: ${data.title}` : ""}${q}`, true);
      if (data.status === "error") write(yellow(`Could not render ${data.id}: ${data.message}. The other clips carry on.`), true);
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
    say("No clips stood out. Try a lower --min, a higher --max, or a higher --judge-n so Gemma reads more moments.");
    return;
  }
  say("");
  if (job.verdict && !job.verdict.strong) {
    // the quality bar: no pretending that weak clips are good ones
    say(bold(yellow(`No strong clips in ${job.source.name}.`)));
    say(`${job.verdict.note.replace(/^No strong clips in this video\. /, "")} ${dim(`(The best scored ${job.verdict.best?.toFixed(2) ?? "-"}; a strong clip scores ${job.verdict.threshold} or more.)`)}`);
  } else say(bold(`${cs.length} proposed clip${cs.length === 1 ? "" : "s"} from ${job.source.name}${job.verdict && job.verdict.strong < cs.length ? `: ${job.verdict.note}` : ""}`));
  for (const c of cs) {
    const s = c.scores || {};
    say("");
    say(`${bold(String(c.rank ?? "-").padStart(2))}  ${tc(c.start)} to ${tc(c.end)}  ${Math.round(c.end - c.start)} s   ${blue(`score ${(c.total ?? 0).toFixed(2)}`)}${c.weak ? yellow(" (weak)") : ""}   ${dim(scoreLine(s))}`);
    say(`    "${c.hook.length > 110 ? c.hook.slice(0, 107) + "..." : c.hook}"`);
    if (c.why || c.reason) say(`    ${blue(c.why || c.reason)}`);
    if (c.watch) say(`    ${dim(`Watch: ${c.watch}`)}`);
    if (c.listRank) say(`    ${dim(`Side by side: ${c.listRank} of ${job.listwise?.order?.length ?? "?"}${c.listReason ? `. ${c.listReason}` : ""}`)}`);
    if (c.h2hRank) say(`    ${dim(`Head to head: ${c.h2hRank} of ${job.h2h?.clips ?? "?"} (won ${c.h2hRecord?.replace("-", ", lost ") ?? "?"})${c.h2hWhy ? `. ${c.h2hWhy}` : ""}`)}`);
    const f = c.faithful;
    if (f && f.verdict !== "faithful") {
      const label = f.verdict === "misleading" ? red("Misleading cut") : yellow("Check the cut");
      say(`    ${label}${f.issue ? dim(` (${f.issue})`) : ""}: ${f.note}${c.demoted ? dim(" Moved to the bottom.") : ""}`);
      if (f.fix) say(`    ${dim(`Suggested fix: ${fixText(c, f.fix)}.`)}`);
    } else if (f) say(`    ${dim("Keeps what the speaker meant.")}`);
  }
  say("");
}

/** "start at 0:21 instead of 0:23" and/or "end at 0:51 instead of 0:46". */
function fixText(c, fix) {
  const parts = [];
  if (fix.start != null) parts.push(`start at ${tc(fix.start)} instead of ${tc(c.start)}`);
  if (fix.end != null) parts.push(`end at ${tc(fix.end)} instead of ${tc(c.end)}`);
  return parts.join(" and ");
}

async function askApprovals(job, { yes }) {
  if (yes) {
    // --yes never posts a cut that changes what the speaker meant: misleading clips stay unapproved
    const ok = job.candidates.filter((c) => !c.demoted);
    for (const c of ok) updateCandidate(job.id, c.id, { status: "approved" });
    const held = job.candidates.length - ok.length;
    if (job.verdict && !job.verdict.strong) say(yellow(`None of these is a strong clip; rendering the closest ${ok.length} because of --yes.`));
    say(`Approved ${ok.length === job.candidates.length ? "all " : ""}${ok.length} (--yes).${held ? ` Left out ${held} misleading cut${held === 1 ? "" : "s"}; review ${held === 1 ? "it" : "them"} with selects review ${job.id}.` : ""}`);
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
    // a cut that may change what the speaker meant: offer the fix first, never apply it unasked
    if (c.faithful?.fix && c.faithful.verdict !== "faithful") {
      const f = (await rl.question(`Clip ${c.rank}: ${c.faithful.note} Fix it (${fixText(c, c.faithful.fix)})? [y/n] `)).trim().toLowerCase();
      if (f === "y" || f === "yes") updateCandidate(job.id, c.id, { faithful: "fix" });
      else if (c.faithful.verdict === "misleading") updateCandidate(job.id, c.id, { faithful: "accept" });
    }
    const cur = loadJob(job.id).candidates.find((x) => x.id === c.id);
    const a = (await rl.question(`Approve clip ${cur.rank} (${tc(cur.start)} to ${tc(cur.end)})? [y/n/q] `)).trim().toLowerCase();
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
    lines.push(`## ${c.rank}. ${c.title || c.hook}`, "", `- File: ${mp4}`, `- Source: ${tc(c.start)} to ${tc(c.end)} (${Math.round(c.end - c.start)} s)`, `- Scores: ${scoreLine(c.scores || {}, ", ")} (total ${c.total})`, `- Why: ${c.why || c.reason}`, ...(c.watch ? [`- Watch: ${c.watch}`] : []));
    if (kit) lines.push(`- Caption: ${kit.caption.replace(/\n+/g, " ")}`, `- Hashtags: ${kit.hashtags.map((h) => "#" + h).join(" ")}`);
    lines.push("");
  }
  const credit = attributionLine(job.settings);
  if (credit) lines.push(`Credit: ${credit}`, "");
  if (mediaReminder(job.settings)) lines.push(mediaReminder(job.settings), "");
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
    await prepareFaces(job, [job.settings.blur, ...approved.map((c) => c.blur)]);
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
    if (mediaReminder(job.settings)) say(mediaReminder(job.settings));
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
  if (!license || license === "own") return true;
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
    madeFor: values["made-for"],
    faithful: values.faithful,
    h2h: values.h2h ? true : undefined,
    kit: values["plain-kit"] ? "plain" : undefined,
    credit: values.credit,
    license: values.license,
    sourceUrl: values["source-url"],
    ...speechSettings(values),
  };
  if (!checkLicense(values.license)) process.exit(1);
  if (values["made-for"] && !["shorts", "linkedin", "x", "story"].includes(values["made-for"].toLowerCase())) {
    say(red(`--made-for takes shorts, linkedin, x or story, not "${values["made-for"]}".`));
    process.exit(1);
  }
  if (values.faithful && !["model", "rules", "off"].includes(values.faithful)) {
    say(red(`--faithful takes model, rules or off, not "${values.faithful}".`));
    process.exit(1);
  }
  let job;
  try {
    job = createJob(video, settings);
  } catch (e) {
    say(red(e.message));
    if (e.hint) say(e.hint);
    process.exit(1);
  }
  say(`${bold(job.source.name)}  ${dim(`job ${job.id}, ${job.settings.model} reads ${job.settings.judgeN ? `the best ${job.settings.judgeN}` : "the best"} moments${job.settings.judgeN ? "" : " (more for longer videos and higher --k)"}`)}`);
  const stop = progressReporter(job.id, { videoName: video });
  const t0 = Date.now();
  job = await runJob(job.id);
  stop();
  printSpeech(job);
  if (job.stage !== "error") say(dim(`Found clips in ${((Date.now() - t0) / 60000).toFixed(1)} min.`));
  await finishJob(job, values);
}

/** Speech, caption and blur settings from the flags (shared by clips and caption mode). */
function speechSettings(values) {
  const blur = blurFromFlags(values);
  return {
    language: values.language,
    asrModel: values["asr-model"],
    asrPrompt: values.prompt,
    accent: values.accent,
    asrPreprocess: values["clean-audio"] ? "clean" : undefined,
    captions: values["no-captions"] ? false : undefined,
    captionStyle: values.style,
    captionLang: values.captions,
    qualityGate: values.force ? false : undefined,
    reuse: values.fresh ? false : undefined,
    blur: blur ?? undefined,
    profile: values.profile,
    audiogram: audiogramFromFlags(values),
  };
}

/** The audiogram background from --bg or --cover (used only when the file has no picture). */
function audiogramFromFlags(values) {
  if (values.cover) {
    const file = path.resolve(values.cover.replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.existsSync(file)) {
      say(red(`No image at ${file}.`));
      process.exit(1);
    }
    if (!/\.(jpe?g|png|webp|gif)$/i.test(file)) {
      say(red("--cover takes a JPEG, PNG, WebP or GIF image."));
      process.exit(1);
    }
    return { bg: "cover", cover: file };
  }
  if (!values.bg) return undefined;
  const id = values.bg.toLowerCase();
  if (!AUDIOGRAM_PRESETS.some((p) => p.id === id)) {
    say(red(`--bg takes ${AUDIOGRAM_PRESETS.map((p) => p.id).join(", ")}, not "${values.bg}".`));
    process.exit(1);
  }
  return { bg: id };
}

function blurFromFlags(values) {
  const regions = (values["blur-region"] || []).map((r) => {
    try {
      return parseRegion(r);
    } catch (e) {
      say(red(e.message));
      say(e.hint);
      process.exit(1);
    }
  });
  const mode = values["blur-faces"];
  if (mode && !["all", "others"].includes(mode)) {
    say(red(`--blur-faces takes all or others, not "${mode}".`));
    process.exit(1);
  }
  if (!mode && !regions.length) return null;
  return { faces: { mode: mode || "off", tracks: [] }, regions };
}

/** Say which language and model were used, and how much to trust the transcript. */
function printSpeech(job) {
  const L = job.language;
  if (L?.warning) say(yellow(`Language: ${L.warning}`));
  else if (L) say(dim(`Language: ${languageName(L.used)}${L.detected ? ` (whisper's guess: ${languageName(L.detected.code)}, p = ${L.detected.p})` : ""}`));
  if (L?.compared?.length) say(dim(`Decode and compare: ${L.compared.map((c) => `${c.code} ${c.meanP}${c.text?.lid608 ? ` (text reads as ${c.text.lid608.code})` : ""}`).join(", ")}${L.margin != null ? `, margin ${L.margin}` : ""}`));
  const E = L?.ensemble;
  if (E?.signals?.length) say(dim(`Language vote: ${E.signals.map((s) => `${s.id} ${s.verdict ?? "no opinion"}${s.refuted ? " (refuted)" : ""}`).join(", ")}; ${languageName(E.language)}${E.confidence != null ? ` with ${Math.round(E.confidence * 100)}% of the vote` : ""}.`));
  if (L?.question) say(yellow(`${L.question.text} The language checks disagree (${E.reasons.join("; ")}). If not, run again with --language ${L.question.choices[0] || "<code>"}.`));
  if (job.accent?.routed) say(dim(`Accent: Nigerian English, so ${job.accent.model} transcribed it (${job.accent.reason}).`));
  const q = job.transcriptQuality;
  if (q) {
    const line = `Transcript ${q.verdict}: mean word confidence ${q.meanP}, ${Math.round(q.lowShare * 100)}% of words unsure${job.asr ? `, ${job.asr.model} at ${job.asr.speed}x real time` : ""}.`;
    say(q.verdict === "good" ? dim(line) : yellow(line));
    if (q.verdict === "shaky" && q.hint) say(yellow(q.hint));
  }
}

/** Detect faces before rendering when face blur is on (macOS). Returns false if it failed. */
async function prepareFaces(job, blurSpecs) {
  if (!blurSpecs.some((b) => b?.faces?.mode && b.faces.mode !== "off")) return true;
  if (!facesAvailable()) {
    say(yellow(process.platform === "darwin" ? "Face blur needs the face detector: run sh tools/faces/build.sh. Rendering without face blur." : "Face blur needs macOS. Rendering with manual regions only."));
    return false;
  }
  say("Finding faces...");
  try {
    const res = await detectJobFaces(job.id);
    const main = res.tracks.find((t) => t.main);
    say(dim(`Found ${res.tracks.length} face${res.tracks.length === 1 ? "" : "s"} in ${res.sec} s${main ? `; main speaker ${main.id} (${tc(main.start)} to ${tc(main.end)})` : ""}.`));
    return true;
  } catch (e) {
    say(yellow(`Face detection failed: ${e.message}`));
    return false;
  }
}

async function cmdCaption(target, values) {
  let job;
  if (/^j_\d{8}_/.test(target)) {
    job = loadJob(target);
  } else {
    try {
      job = createJob(target, { mode: "caption", ...speechSettings(values) });
    } catch (e) {
      say(red(e.message));
      if (e.hint) say(e.hint);
      process.exit(1);
    }
  }
  if (values.captions && values.captions !== "source") say(yellow(`--captions ${values.captions} is not built yet; captioning in the spoken language.`));
  say(`${bold(job.source.name)}  ${dim(`caption job ${job.id}`)}`);
  if (job.stage !== "ready" && job.stage !== "done") {
    const stop = progressReporter(job.id);
    job = job.stage === "queued" && Object.values(job.stages).every((s) => s.status === "pending") ? await runJob(job.id) : await resumeJob(job.id);
    stop();
    if (job.stage === "error") return fail(job);
  }
  printSpeech(job);
  const dir = jobDir(job.id);
  const outDir = path.resolve(values.out || path.join("selects-out", path.parse(job.source.name).name));
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.parse(job.source.name).name;
  if (values.srt) {
    const text = fs.readFileSync(path.resolve(values.srt), "utf8");
    const cues = parseSubtitles(text);
    if (!cues.length) {
      say(red(`No subtitles found in ${values.srt}.`));
      process.exit(1);
    }
    const caps = editCaptions(dir, cues);
    say(`Read ${cues.length} captions from ${values.srt}; ${caps.cues.reduce((a, c) => a + c.words.filter((w) => w.edited).length, 0)} words changed, timings kept.`);
  } else if (values.edit) {
    const editFile = path.join(outDir, `${base}.edit.srt`);
    fs.writeFileSync(editFile, toSrt(loadCaptions(dir).cues));
    say(`Wrote ${editFile}`);
    say("Fix the words in any text editor. Keep the numbers and times as they are; you can join or split lines.");
    if (!process.stdin.isTTY) {
      say(`Then run: selects caption ${job.id} --srt "${editFile}"`);
      process.exitCode = 2;
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Press Enter when you have saved the file. ");
    rl.close();
    const caps = editCaptions(dir, parseSubtitles(fs.readFileSync(editFile, "utf8")));
    say(`Read your edits: ${caps.cues.length} captions.`);
  }
  job = loadJob(job.id);
  const blur = job.settings.blur;
  await prepareFaces(job, [blur]);
  say("Rendering the captioned video...");
  const stop = progressReporter(job.id);
  const onOut = ({ type, data }) => {
    if (type === "output" && data.status === "running" && isTTY) process.stdout.write(`\r\x1b[2KRendering ${Math.round((data.progress ?? 0) * 100)}%`);
  };
  jobEvents.on(job.id, onOut);
  job = await renderJob(job.id);
  jobEvents.off(job.id, onOut);
  stop();
  if (isTTY) process.stdout.write("\n");
  if (job.stage === "error") return fail(job);
  const place = (rel, name) => {
    const dst = path.join(outDir, name);
    fs.rmSync(dst, { force: true });
    try {
      fs.linkSync(path.join(dir, rel), dst);
    } catch {
      fs.copyFileSync(path.join(dir, rel), dst);
    }
    return dst;
  };
  const mp4 = place(job.output.path, `${base}-captioned.mp4`);
  place(job.output.srt, `${base}.srt`);
  place(job.output.vtt, `${base}.vtt`);
  say(yellow(`Captioned ${job.source.name} (${job.output.width}x${job.output.height}, ${job.output.style} captions) in ${job.output.wallSec} s:`));
  say(`  ${mp4}`);
  say(dim(`  plus ${base}.srt and ${base}.vtt in the same folder`));
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
    job = await resumeJob(id, { force: !!values.force });
    stop();
    printSpeech(job);
  }
  await finishJob(job, values);
}

async function cmdQueue(sub, files, values) {
  if (sub === "add") {
    const model = values.model || (await resolveModel());
    for (const f of files) {
      try {
        const job = createJob(f, { model, k: values.k ? +values.k : undefined, judgeN: values["judge-n"] ? +values["judge-n"] : undefined, madeFor: values["made-for"] });
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

async function cmdDoctor({ json = false } = {}) {
  const cfg = config();
  if (json) return say(JSON.stringify(cfg, null, 2));
  say(dim(`Config (env, then ${cfg.configFile}${fs.existsSync(cfg.configFile) ? "" : ", not present"}, then defaults and PATH)`));
  for (const k of ["home", "modelsDir", "whisperBin", "whisperModel", "ffmpeg", "ffprobe", "ollamaUrl", "model", "langidDir", "punctDir", "accentModelNg", "facesBin"]) say(dim(`  ${k.padEnd(14)} ${cfg[k] ?? "(auto)"}`));
  const checks = [];
  const add = (name, ok, detail, hint) => checks.push({ name, ok, detail, hint });
  const nodeMajor = +process.versions.node.split(".")[0];
  add("Node", nodeMajor >= 20 ? "ok" : "fail", process.versions.node, "Install Node 20 or newer from nodejs.org.");
  try {
    const r = await run(cfg.ffmpeg, ["-hide_banner", "-encoders"]);
    add("ffmpeg", /libx264/.test(r.stdout) ? "ok" : "fail", /libx264/.test(r.stdout) ? "with libx264" : "no libx264 encoder", "Install ffmpeg with libx264: brew install ffmpeg");
  } catch {
    add("ffmpeg", "fail", "not found", "Install ffmpeg: brew install ffmpeg");
  }
  const wb = whisperBin();
  try {
    await run(wb, ["-h"], { allowFail: true });
    add("whisper-cli", "ok", wb, "");
  } catch {
    add("whisper-cli", "fail", `not found at ${wb}`, `Build whisper.cpp (cmake -B build && cmake --build build -j), then put "whisperBin": "<path>/build/bin/whisper-cli" in ${cfg.configFile} or set SELECTS_WHISPER_BIN.`);
  }
  const wm = whisperModel();
  add("whisper model", fs.existsSync(wm) ? "ok" : "fail", fs.existsSync(wm) ? `${path.basename(wm)}, ${(fs.statSync(wm).size / 1e6).toFixed(0)} MB` : `missing at ${wm}`, `Download ggml-base.en.bin from huggingface.co/ggerganov/whisper.cpp into ${cfg.modelsDir} (or set SELECTS_WHISPER_MODEL).`);
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
  const installed = asrModels();
  add("Whisper models", installed.length ? "ok" : "warn", installed.map((m) => `${m.name} (${m.sizeMb} MB)`).join(", ") || "none found", "Put ggml models in the models folder (SELECTS_MODELS_DIR). small.en handles accents better than base.en.");
  add("Face blur", facesAvailable() ? "ok" : "warn", facesAvailable() ? "Apple Vision face detector built" : process.platform === "darwin" ? "not built" : "needs macOS (manual blur regions still work)", "Run sh tools/faces/build.sh");
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
      "made-for": { type: "string" },
      fresh: { type: "boolean" },
      faithful: { type: "string" },
      h2h: { type: "boolean" },
      out: { type: "string" },
      port: { type: "string" },
      yes: { type: "boolean", short: "y" },
      preview: { type: "boolean" },
      "plain-kit": { type: "boolean" },
      credit: { type: "string" },
      license: { type: "string" },
      "source-url": { type: "string" },
      force: { type: "boolean" },
      language: { type: "string" },
      "asr-model": { type: "string" },
      accent: { type: "string" },
      prompt: { type: "string" },
      "clean-audio": { type: "boolean" },
      "no-captions": { type: "boolean" },
      style: { type: "string" },
      captions: { type: "string" },
      edit: { type: "boolean" },
      srt: { type: "string" },
      "blur-faces": { type: "string" },
      bg: { type: "string" },
      cover: { type: "string" },
      "blur-region": { type: "string", multiple: true },
      profile: { type: "string" },
      "save-profile": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd) return say(HELP);
  if (values["save-profile"]) {
    const { saveProfile } = await import("../src/core/profiles.mjs");
    const sp = speechSettings(values);
    saveProfile(values["save-profile"], sp);
    say(dim(`Saved profile "${values["save-profile"]}". Use it with --profile "${values["save-profile"]}".`));
  }
  if (cmd === "doctor") return cmdDoctor({ json: !!values.json });
  if (cmd === "serve") {
    const { startServer } = await import("../src/server/server.mjs");
    return startServer({ port: values.port ? +values.port : undefined });
  }
  if (cmd === "queue") return cmdQueue(rest[0], rest.slice(1), values);
  if (cmd === "jobs") return cmdJobs();
  if (cmd === "review") return cmdReview(rest[0], values);
  if (cmd === "caption") {
    if (!rest[0]) return say("Usage: selects caption <video or job-id> [--language en] [--edit | --srt fixed.srt] [--blur-faces others]");
    return cmdCaption(rest[0], values);
  }
  return cmdClip(cmd, values);
}

main().catch((e) => {
  say(red(e.message || String(e)));
  if (e.hint) say(e.hint);
  process.exitCode = 1;
});
