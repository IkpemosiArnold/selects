#!/usr/bin/env node
// Compare whisper models and settings on one stretch of a video: speed, confidence, and the
// transcripts side by side for a person to rate. It does not judge accuracy itself.
//
// node tools/asr-bench.mjs <video> --out <dir> [--start 20] [--dur 60]
//   [--runs "base.en,small.en,small.en+clean,base.en+prompt,medium.en-q5_0,small-nigerian-accent"]
//   [--prompt "text"] [--lang en]
// A run is a model name from the models folder, optionally with +clean (audio clean-up)
// and +prompt (pass --prompt). Writes <dir>/asr-compare.md and <dir>/asr-bench.json.
// Resumable: finished runs are kept in asr-bench.json and skipped.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { asrModels, modelsDir } from "../src/core/config.mjs";
import { transcriptQuality } from "../src/core/quality.mjs";
import { extractAudio, runWhisper, wordsFromWhisperJson } from "../src/core/transcribe.mjs";
import { readJson, writeJsonAtomic } from "../src/core/util.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    start: { type: "string", default: "20" },
    dur: { type: "string", default: "60" },
    runs: { type: "string", default: "base.en,base.en+clean,base.en+prompt,small.en,small.en+clean,small-nigerian-accent,medium.en-q5_0" },
    prompt: { type: "string", default: "Hello, and welcome. This is a recorded conversation in English." },
    lang: { type: "string", default: "en" },
  },
});
const video = positionals[0];
if (!video || !values.out) {
  console.error("Usage: node tools/asr-bench.mjs <video> --out <dir> [--start 20] [--dur 60] [--runs a,b+clean] [--prompt text]");
  process.exit(1);
}
const out = path.resolve(values.out);
fs.mkdirSync(out, { recursive: true });
const start = +values.start;
const dur = +values.dur;
const resultsFile = path.join(out, "asr-bench.json");
const results = readJson(resultsFile, { video: path.basename(video), start, dur, runs: {} });
const installed = new Map(asrModels().map((m) => [m.name, m]));

const wavFor = async (pre) => {
  const wav = path.join(out, `sample-${pre}.wav`);
  if (!fs.existsSync(wav)) await extractAudio(video, wav, { preprocess: pre, ranges: [{ start, dur }] });
  return wav;
};

for (const run of values.runs.split(",").map((s) => s.trim()).filter(Boolean)) {
  if (results.runs[run]?.done) {
    console.log(`${run}: done before, skipped`);
    continue;
  }
  const [model, ...flags] = run.split("+");
  const m = installed.get(model);
  if (!m) {
    console.log(`${run}: model ${model} is not in ${modelsDir()}, skipped`);
    continue;
  }
  const pre = flags.includes("clean") ? "clean" : "none";
  const wav = await wavFor(pre);
  const lang = m.english ? "en" : values.lang;
  const outBase = path.join(out, `run-${run.replace(/[^\w.-]+/g, "_")}`);
  const t0 = Date.now();
  process.stdout.write(`${run}: transcribing ${dur} s... `);
  const json = await runWhisper(wav, { outBase, model: m.path, language: lang, prompt: flags.includes("prompt") ? values.prompt : null });
  const sec = (Date.now() - t0) / 1000;
  const words = wordsFromWhisperJson(json);
  const q = transcriptQuality(words, { duration: dur });
  results.runs[run] = { done: true, model, sizeMb: m.sizeMb, preprocess: pre, prompt: flags.includes("prompt"), language: lang, sec: +sec.toFixed(1), speed: +(dur / sec).toFixed(2), words: words.length, meanP: q.meanP, lowShare: q.lowShare, verdict: q.verdict, text: words.map((w) => w.w).join(" ") };
  fs.rmSync(`${outBase}.json`, { force: true });
  writeJsonAtomic(resultsFile, results);
  console.log(`${sec.toFixed(1)} s (${(dur / sec).toFixed(2)}x real time), ${words.length} words, mean p ${q.meanP}`);
}
for (const pre of ["none", "clean"]) fs.rmSync(path.join(out, `sample-${pre}.wav`), { force: true });

const rows = Object.entries(results.runs);
const md = [
  `# Speech recognition comparison`,
  "",
  `Source: ${results.video}, ${start} s to ${start + dur} s. Rate each transcript; the numbers say how fast and how sure whisper was, not how right it was.`,
  "",
  "| Run | Model size | Time | Speed | Words | Mean word p | Unsure words | Your rating (1 to 5) |",
  "|---|---|---|---|---|---|---|---|",
  ...rows.map(([k, r]) => `| ${k} | ${r.sizeMb} MB | ${r.sec} s | ${r.speed}x | ${r.words} | ${r.meanP} | ${Math.round(r.lowShare * 100)}% | |`),
  "",
  "Runs: `+clean` = highpass 80 Hz, lowpass 7.6 kHz and loudness normalisation before whisper; `+prompt` = whisper `--prompt` with a neutral English sentence.",
  "",
  ...rows.flatMap(([k, r]) => [`## ${k}`, "", r.text || "(no words)", ""]),
];
fs.writeFileSync(path.join(out, "asr-compare.md"), md.join("\n"));
console.log(`Wrote ${path.join(out, "asr-compare.md")}`);
