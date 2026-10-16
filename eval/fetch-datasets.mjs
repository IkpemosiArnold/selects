#!/usr/bin/env node
// Build eval/datasets/manifest.json from YouTube videos that are licensed Creative Commons BY
// and carry a "Most Replayed" heatmap.
//
//   node eval/fetch-datasets.mjs fetch <id> [<id> ...]   one yt-dlp call: info JSON for every id, and low-bitrate
//                                                        audio only for those that pass the filter (CC BY,
//                                                        heatmap present, 15 to 45 min)
//   node eval/fetch-datasets.mjs build                    write the manifest with heatmap labels from cached info
//   node eval/fetch-datasets.mjs video <id> [<id> ...]    download 720p-or-less video for the demo
//
// yt-dlp needs browser cookies because YouTube's bot check blocks this machine otherwise:
// it runs with --cookies-from-browser chrome (override with SELECTS_YTDLP_COOKIES_BROWSER).
// Extracting Chrome cookies takes a few minutes on this machine, so every command batches
// all ids into a single yt-dlp call.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { heatmapToLabels } from "./heatmap.mjs";

const EVAL = dirname(fileURLToPath(import.meta.url));
const ROOT = join(EVAL, "..");
const DS = join(EVAL, "datasets");
const INFO = join(DS, "info");
const MEDIA = join(EVAL, "media");
const MANIFEST = join(DS, "manifest.json");
const BROWSER = process.env.SELECTS_YTDLP_COOKIES_BROWSER || "chrome";
const MIN_DUR = 10 * 60, MAX_DUR = 45 * 60;
// Whisper (about 1.6x real time) and Gemma 4B (minutes per window) are slow on this laptop, so
// videos longer than 20 minutes are evaluated on their first 15 minutes only.
const LONG = 20 * 60, CLIP_TO = 15 * 60;

// YouTube offers exactly one Creative Commons option, CC BY 3.0 Unported.
const YT_CC = { name: "CC BY 3.0", url: "https://creativecommons.org/licenses/by/3.0/" };

function ytdlp(args) {
  const r = spawnSync("yt-dlp", ["--no-update", "--js-runtimes", "node", "--remote-components", "ejs:github", "--cookies-from-browser", BROWSER, ...args], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  return r;
}

function writeJson(file, data) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

function trimInfo(j) {
  return {
    id: j.id, title: j.title, channel: j.channel, channel_url: j.channel_url, uploader: j.uploader,
    webpage_url: j.webpage_url, duration: j.duration, upload_date: j.upload_date, view_count: j.view_count,
    license: j.license ?? null, categories: j.categories, tags: (j.tags || []).slice(0, 20),
    heatmap: j.heatmap ?? null, fetchedAt: new Date().toISOString(),
  };
}

function fetchAll(ids) {
  mkdirSync(INFO, { recursive: true });
  mkdirSync(MEDIA, { recursive: true });
  // ids, or full URLs (for example a YouTube search filtered to Creative Commons)
  const todo = ids.filter((id) => /^https?:/.test(id) || !existsSync(join(INFO, `${id}.json`)));
  if (todo.length) {
    // Pass 1 output: --print writes the info for every id (even ones the filter rejects), as JSON lines.
    // Audio is downloaded only for ids that pass the match filter.
    const r = ytdlp([
      "--ignore-errors", "--no-playlist", "--playlist-end", "15", "--sleep-requests", "0.5",
      "--print", "pre_process:%()j",
      "--match-filters", `license~='(?i)creative commons' & heatmap & duration>=${MIN_DUR} & duration<=${MAX_DUR}`,
      "--no-simulate",
      // Prefer the original-language track: some channels add auto-dubbed audio tracks, and a
      // low-bitrate filter alone once picked a non-English dub.
      "-f", "ba[abr<=80][format_note*=original]/ba[format_note*=original]/ba[abr<=80]/wa",
      "-o", join(MEDIA, "%(id)s.%(ext)s"),
      ...todo.map((id) => (/^https?:/.test(id) ? id : `https://www.youtube.com/watch?v=${id}`)),
    ]);
    for (const line of r.stdout.split("\n")) {
      if (!line.startsWith("{")) continue;
      const keep = trimInfo(JSON.parse(line));
      writeJson(join(INFO, `${keep.id}.json`), keep);
      console.log(`${keep.id}  ${Math.round(keep.duration / 60)} min  license=${keep.license}  heatmap=${keep.heatmap ? keep.heatmap.length : "none"}  ${keep.title}`);
    }
    const errs = r.stderr.split("\n").filter((l) => /ERROR|does not pass filter/.test(l));
    if (errs.length) console.error(errs.join("\n"));
  }
  build();
}

export function eligibility(i) {
  const why = [];
  if (!/creative commons/i.test(i.license || "")) why.push(`license is ${i.license || "standard YouTube"}`);
  if (!Array.isArray(i.heatmap) || i.heatmap.length < 10) why.push("no heatmap");
  if (!(i.duration >= MIN_DUR && i.duration <= MAX_DUR)) why.push(`duration ${Math.round(i.duration / 60)} min`);
  return why;
}

function build() {
  const existing = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : [];
  const keepIds = existsSync(join(DS, "selected.json")) ? JSON.parse(readFileSync(join(DS, "selected.json"), "utf8")) : null;
  const all = readdirSync(INFO).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(INFO, f), "utf8")));
  const items = [];
  for (const i of all) {
    const why = eligibility(i);
    if (why.length) { console.log(`skip ${i.id}: ${why.join(", ")}`); continue; }
    if (keepIds && !keepIds.includes(i.id)) continue;
    const prev = existing.find((e) => e.id === i.id);
    const media = existsSync(MEDIA) ? readdirSync(MEDIA).find((f) => f.startsWith(i.id + ".") && !f.includes(".video.") && !/\.(part|ytdl|json)$/.test(f)) : null;
    const video = existsSync(MEDIA) ? readdirSync(MEDIA).find((f) => f.startsWith(i.id + ".video.")) : null;
    items.push({
      id: i.id,
      title: i.title,
      channel: i.channel,
      url: i.webpage_url,
      license: YT_CC.name,
      licenseUrl: YT_CC.url,
      licenseEvidence: `yt-dlp info JSON license field: "${i.license}" (fetched ${i.fetchedAt.slice(0, 10)})`,
      localPath: media ? relative(ROOT, join(MEDIA, media)) : `eval/media/${i.id}.webm`,
      ...(video ? { videoPath: relative(ROOT, join(MEDIA, video)) } : {}),
      duration: i.duration > LONG ? CLIP_TO : i.duration,
      ...(i.duration > LONG ? { evalRange: [0, CLIP_TO], fullDuration: i.duration } : {}),
      heatmapPath: relative(ROOT, join(INFO, `${i.id}.json`)),
      labels: [
        ...heatmapToLabels(i.heatmap, { rangeEnd: i.duration > LONG ? CLIP_TO : null }),
        ...(prev?.labels || []).filter((l) => l.source !== "heatmap"),
      ],
    });
  }
  items.sort((a, b) => a.duration - b.duration);
  writeJson(MANIFEST, items);
  console.log(`manifest: ${items.length} videos, ${items.reduce((s, v) => s + v.labels.length, 0)} labels`);
}

function video(ids) {
  mkdirSync(MEDIA, { recursive: true });
  const r = ytdlp(["-f", "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]", "--merge-output-format", "mp4", "-o", join(MEDIA, "%(id)s.video.%(ext)s"), ...ids.map((id) => `https://www.youtube.com/watch?v=${id}`)]);
  if (r.status !== 0) console.error(r.stderr.split("\n").filter((l) => /ERROR/.test(l)).join("\n"));
  build();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "fetch") fetchAll(rest);
  else if (cmd === "build") build();
  else if (cmd === "video") video(rest);
  else console.log("usage: node eval/fetch-datasets.mjs fetch <ids...> | build | video <ids...>");
}
