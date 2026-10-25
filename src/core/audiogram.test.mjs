// Audiograms: the drawing rules (audiogram.mjs) and an end-to-end render of an audio-only
// file on the desktop path, checked with ffprobe and by reading pixels back out of the MP4.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { AUDIOGRAM_LAYOUT, AUDIOGRAM_PRESETS, audioEnvelope, audiogramSettings, coverPlan, dbMeter, envelopeFromDb, isAudioOnly, paintCover, paintMoving, paintPreset } from "./audiogram.mjs";
import { probe } from "./probe.mjs";
import { render, renderFull } from "./render.mjs";
import { run } from "./util.mjs";

const lum = (r, g, b) => {
  const f = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

test("six presets, each with a mouth inside the band the desktop repaints", () => {
  assert.equal(AUDIOGRAM_PRESETS.length, 6);
  const { band } = AUDIOGRAM_LAYOUT;
  for (const p of AUDIOGRAM_PRESETS) {
    assert.ok(p.id && p.label && p.swatch, p.id);
    const m = p.mouth;
    assert.ok(m.y - m.w * 0.5 >= band.y && m.y + m.w * 0.6 <= band.y + band.h, `${p.id} mouth leaves the band`);
  }
  const M = AUDIOGRAM_LAYOUT.meter;
  assert.ok(M.cy - M.maxHalf >= band.y && M.cy + M.maxHalf <= band.y + band.h, "the meter is inside the band");
  assert.ok(M.x >= 80 && M.x + M.w <= 1000, "the meter stays clear of the right-hand buttons");
});

test("white captions stand out over every preset's caption zone", () => {
  const W = 270, H = 480;
  const top = Math.round(H * (1174 / 1920));
  const bottom = Math.round(H * 0.82);
  for (const p of AUDIOGRAM_PRESETS) {
    const c = createCanvas(W, H);
    const ctx = c.getContext("2d");
    paintPreset(ctx, p.id, W, H);
    const d = ctx.getImageData(0, top, W, bottom - top).data;
    let worst = Infinity;
    for (let i = 0; i < d.length; i += 4 * 7) worst = Math.min(worst, contrast(1, lum(d[i], d[i + 1], d[i + 2])));
    assert.ok(worst >= 7, `${p.id}: white on its caption zone is only ${worst.toFixed(1)}:1`);
  }
});

test("the envelope follows the real samples: silence is flat, speech fills the meter", () => {
  const rate = 16000;
  const pcm = new Float32Array(rate * 2);
  for (let i = rate; i < pcm.length; i++) pcm[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / rate);
  const env = audioEnvelope(pcm, rate, { fps: 30 });
  assert.equal(env.v.length, 60);
  assert.equal(Math.max(...env.v.slice(0, 29)), 0, "the silent second reads 0");
  assert.ok(Math.min(...env.v.slice(31)) > 0.9, "the loud second reads near 1");
  assert.equal(env.mouth[10], 0, "the mouth is shut in silence");
  assert.ok(env.mouth[45] > 0.8, "and open while the voice is loud");
  // the streaming meter gives the same numbers as the one-shot one
  const m = dbMeter(rate, 30);
  for (let i = 0; i < pcm.length; i += 5000) m.push(pcm.subarray(i, i + 5000));
  const env2 = envelopeFromDb(m.finish(), 30);
  assert.deepEqual(Array.from(env2.v).map((x) => +x.toFixed(3)), Array.from(env.v).map((x) => +x.toFixed(3)));
});

test("an uploaded image: portrait covers around a focal point, square sits as a card over a blur", () => {
  const W = 1080, H = 1920;
  const portrait = coverPlan(3000, 4000, W, H);
  assert.equal(portrait.mode, "cover");
  assert.ok(portrait.image.w >= W && portrait.image.h >= H, "covers the frame");
  assert.ok(portrait.image.x <= 0 && portrait.image.x + portrait.image.w >= W);
  const square = coverPlan(1400, 1400, W, H);
  assert.equal(square.mode, "card");
  assert.ok(square.card.y + square.card.h <= AUDIOGRAM_LAYOUT.meter.cy - AUDIOGRAM_LAYOUT.meter.maxHalf, "the card stays above the meter");
  // and the caption zone is darkened whatever the image is (a white image here)
  const img = createCanvas(800, 800);
  const ic = img.getContext("2d");
  ic.fillStyle = "#ffffff";
  ic.fillRect(0, 0, 800, 800);
  const c = createCanvas(270, 480);
  paintCover(c.getContext("2d"), img, 270, 480, { makeCanvas: (w, h) => createCanvas(w, h) });
  const d = c.getContext("2d").getImageData(0, 330, 270, 60).data;
  let worst = Infinity;
  for (let i = 0; i < d.length; i += 4 * 5) worst = Math.min(worst, contrast(1, lum(d[i], d[i + 1], d[i + 2])));
  assert.ok(worst >= 4.5, `white captions over a white image's scrim: ${worst.toFixed(1)}:1`);
});

test("settings fall back to the default preset, and only a source with no picture is audio-only", () => {
  assert.deepEqual(audiogramSettings({}), { bg: "sunny" });
  assert.deepEqual(audiogramSettings({ audiogram: { bg: "nope" } }), { bg: "sunny" });
  assert.deepEqual(audiogramSettings({ audiogram: { bg: "cover" } }), { bg: "sunny" }, "a cover choice needs an image");
  assert.deepEqual(audiogramSettings({ audiogram: { bg: "cover", cover: "cover.jpg" } }), { bg: "cover", cover: "cover.jpg" });
  assert.equal(isAudioOnly({ hasVideo: false }), true);
  assert.equal(isAudioOnly({ hasVideo: true }), false);
  assert.equal(isAudioOnly({}), false, "old jobs without the field are videos");
});

test("the moving band draws the meter and a preset's mouth", () => {
  const W = 1080, H = 1920;
  const c = createCanvas(W, 480);
  const ctx = c.getContext("2d");
  const env = { fps: 30, v: new Float32Array(300).fill(1), mouth: new Float32Array(300).fill(1) };
  paintMoving(ctx, { env, t: 5, W, H, bg: "frog", offsetY: 680 });
  const px = (x, y) => Array.from(ctx.getImageData(x, y - 680, 1, 1).data);
  // a played bar left of centre is marker yellow, a coming one right of centre is pale
  const row = ctx.getImageData(140, 1075 - 680, 800, 1).data;
  let yellow = 0;
  let pale = 0;
  for (let i = 0; i < row.length; i += 4) {
    if (row[i] > 200 && row[i + 1] > 150 && row[i + 2] < 90) yellow += i / 4 < 400 ? 1 : 0;
    if (row[i + 3] > 0 && row[i] > 200 && row[i + 2] > 200) pale += i / 4 > 400 ? 1 : 0;
  }
  assert.ok(yellow > 50 && pale > 50, `yellow ${yellow}, pale ${pale}`);
  assert.ok(px(540, 850)[3] > 0, "the open mouth is drawn");
});

// ---------------------------------------------------------------- end to end

const ffprobeJson = async (file) => JSON.parse((await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", file])).stdout);
async function frameAt(file, t, W = 1080, H = 1920) {
  // run() reads stdout as text, so the frame goes through a file
  const out = `${file}.${t}.rgb`;
  await run("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", out]);
  const buf = fs.readFileSync(out);
  fs.rmSync(out);
  return { buf, W, H, at: (x, y) => [buf[(y * W + x) * 3], buf[(y * W + x) * 3 + 1], buf[(y * W + x) * 3 + 2]] };
}
const count = (f, x0, y0, x1, y1, pred) => {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (pred(...f.at(x, y))) n++;
  return n;
};
const isYellow = (r, g, b) => r > 200 && g > 150 && b < 100;
const isWhite = (r, g, b) => r > 235 && g > 235 && b > 235;

/** A short voice-like fixture: 2.5 s of modulated tone, a second of silence, 2.5 s more. AAC in M4A, like a voice memo. */
async function fixture(dir) {
  const file = path.join(dir, "memo.m4a");
  const expr = "0.5*sin(2*PI*200*t)*(0.55+0.45*sin(2*PI*3*t))*between(t,0,2.5)+0.5*sin(2*PI*300*t)*(0.55+0.45*sin(2*PI*4*t))*between(t,3.5,6)";
  await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='${expr}':s=44100:d=6`, "-ac", "2", "-c:a", "aac", "-b:a", "96k", file]);
  return file;
}
const memoWords = () => {
  const ws = [];
  "Hello there, this is the first part.".split(" ").forEach((w, i) => ws.push({ w, s: +(0.2 + i * 0.35).toFixed(2), e: +(0.2 + i * 0.35 + 0.3).toFixed(2), p: 0.95 }));
  "And this is the second.".split(" ").forEach((w, i) => ws.push({ w, s: +(3.7 + i * 0.4).toFixed(2), e: +(3.7 + i * 0.4 + 0.34).toFixed(2), p: 0.95 }));
  return ws;
};

test("end to end: an audio-only M4A renders a 1080x1920 audiogram with audio, a live meter and burned-in captions", { timeout: 240000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selects-audiogram-"));
  try {
    const file = await fixture(dir);
    const source = await probe(file);
    assert.equal(source.hasVideo, false);
    const words = memoWords();
    fs.writeFileSync(path.join(dir, "words.json"), JSON.stringify(words));
    const job = { id: "t_audiogram", source, settings: { captions: true, audiogram: { bg: "frog" } } };
    const cand = { id: "c_0001", start: 0.2, end: 5.66 };
    const r = await render(job, cand, { jobDir: dir, words });
    assert.equal(r.reframe.mode, "audiogram");
    const out = path.join(dir, r.path);
    const info = await ffprobeJson(out);
    const v = info.streams.find((s) => s.codec_type === "video");
    const a = info.streams.find((s) => s.codec_type === "audio");
    assert.equal(v.codec_name, "h264");
    assert.equal(v.width, 1080);
    assert.equal(v.height, 1920);
    assert.ok(a, "the clip has its audio");
    assert.equal(a.codec_name, "aac");
    const want = cand.end + 0.35 - (cand.start - 0.08);
    assert.ok(Math.abs(+info.format.duration - want) < 0.2, `duration ${info.format.duration}, want about ${want.toFixed(2)}`);
    const vol = (await run("ffmpeg", ["-v", "info", "-i", out, "-map", "0:a", "-af", "volumedetect", "-f", "null", "-"])).stderr;
    const mean = +vol.match(/mean_volume: (-?[\d.]+) dB/)[1];
    assert.ok(mean > -40, `the audio is real sound (mean ${mean} dB)`);

    // 1.2 s into the clip (1.48 s of the source): speech, a caption on screen, tall played bars
    const talking = await frameAt(out, 1.2);
    // 3.1 s into the clip (3.38 s of the source): the silence, no caption
    const quiet = await frameAt(out, 3.1);
    const capBox = [80, 1174, 1000, 1574];
    const whiteTalking = count(talking, ...capBox, isWhite);
    const whiteQuiet = count(quiet, ...capBox, isWhite);
    assert.ok(whiteTalking > 3000, `a caption is burned in while words are spoken (${whiteTalking} white pixels)`);
    assert.ok(whiteQuiet < 200, `and gone in the silence (${whiteQuiet})`);
    // the bar just played (left of centre) is tall in speech and short in silence
    const tallness = (f) => {
      let top = 1075;
      for (let y = 1075 - 70; y < 1075; y++) if (count(f, 500, y, 540, y + 1, isYellow) > 0) { top = y; break; }
      return 1075 - top;
    };
    const tTalk = tallness(talking);
    const tQuiet = tallness(quiet);
    assert.ok(tTalk > 30, `played bars are tall in speech (${tTalk} px)`);
    assert.ok(tQuiet < 15, `and short in the silence (${tQuiet} px)`);
    assert.ok(count(talking, 140, 1005, 940, 1145, isYellow) > 800, "the meter is burned in");
    // the frog's background is there too (its green above the band)
    const [rr, gg, bb] = talking.at(540, 760);
    assert.ok(gg > rr && gg > bb, "the preset background is drawn");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("end to end: caption mode on an audio-only file makes one 9:16 audiogram of the whole recording", { timeout: 240000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selects-audiogram-full-"));
  try {
    const file = await fixture(dir);
    const source = await probe(file);
    fs.writeFileSync(path.join(dir, "words.json"), JSON.stringify(memoWords()));
    const job = { id: "t_full", source, settings: { mode: "caption", captions: true, audiogram: { bg: "moon" } } };
    const r = await renderFull(job, { jobDir: dir });
    assert.equal(r.width, 1080);
    assert.equal(r.height, 1920);
    const info = await ffprobeJson(path.join(dir, r.path));
    assert.ok(info.streams.some((s) => s.codec_type === "audio"));
    assert.ok(Math.abs(+info.format.duration - source.duration) < 0.2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
