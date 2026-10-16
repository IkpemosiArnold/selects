import assert from "node:assert/strict";
import { test } from "node:test";
import { captionChunks, chunksToSrt, clipWords } from "./render.mjs";
import { words } from "./test/fixtures.mjs";

test("captions are 2 to 4 words and break after sentence ends", () => {
  const ws = words("Nobody tells you this. Lifting heavy is mostly about showing up every single week, for months.");
  const ch = captionChunks(ws);
  for (const c of ch) assert.ok(c.words.length >= 1 && c.words.length <= 4, c.text);
  assert.equal(ch[0].text, "Nobody tells you this.");
  assert.ok(ch.filter((c) => c.words.length === 1).length <= 1);
});

test("captions break at pauses", () => {
  const ws = words("one two three four", { gaps: { 2: 1 } });
  const ch = captionChunks(ws);
  assert.deepEqual(
    ch.map((c) => c.text),
    ["one two", "three four"],
  );
});

test("clipWords shifts to clip time and keeps only words inside", () => {
  const ws = words("a b c d e f", { start: 100, wps: 1 });
  const cw = clipWords(ws, 101, 103.9, 100.9);
  assert.deepEqual(
    cw.map((w) => w.w),
    ["b", "c", "d"],
  );
  assert.equal(cw[0].s, 0.1);
});

test("SRT cues are numbered and timed", () => {
  const srt = chunksToSrt(captionChunks(words("Hello there. General idea.")));
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:00,/);
  assert.match(srt, /\n2\n/);
});

test("caption layout keeps one line when it fits, else balances two lines", async () => {
  const { layoutCaption } = await import("./render.mjs");
  const c = { fontSize: 80, maxWidth: 900 };
  const measure = (t, s) => t.length * s * 0.55; // a fake monospace-ish font
  const one = layoutCaption(["that", "we", "should"], c, measure);
  assert.equal(one.lines.length, 1);
  const shrunk = layoutCaption(["that", "we", "should", "challenge"], c, measure);
  assert.equal(shrunk.lines.length, 1, "shrinks up to 15% to stay on one line");
  assert.ok(shrunk.size < 80 && shrunk.size >= 68);
  const two = layoutCaption(["that", "we", "should", "challenging"], c, measure);
  assert.equal(two.lines.length, 2);
  assert.deepEqual(
    two.lines.map((l) => l.map((x) => x.t).join(" ")),
    ["that we should", "challenging"],
  );
  assert.deepEqual(two.lines.flat().map((x) => x.i), [0, 1, 2, 3]);
});

test("portrait phone video: upright working size, 30 fps, plain scale into 9:16", async () => {
  const { videoGraph, workingSize, chooseReframe, captionOptions } = await import("./render.mjs");
  const src = { path: "/x.mov", width: 3840, height: 2160, rotation: 270, uprightWidth: 2160, uprightHeight: 3840, fps: 59.94, hasVideo: true };
  assert.deepEqual(workingSize(2160, 3840), { w: 1080, h: 1920 });
  assert.deepEqual(workingSize(720, 576), { w: 720, h: 576 }, "never upscales");
  assert.equal((await chooseReframe(src, 0, 10)).mode, "scale");
  const g = videoGraph({ src, W: 1080, H: 1920, reframe: "scale" });
  assert.match(g, /^\[0:v:0\]fps=30,scale=1080:1920,setsar=1\[pre\]/);
  assert.match(g, /pad=1080:1920/);
  assert.ok(!/crop=/.test(g));
  const full = videoGraph({ src: { ...src, fps: 25 }, W: 1080, H: 1920, reframe: "none" });
  assert.ok(!/fps=/.test(full), "25 fps stays 25 fps");
  assert.ok(captionOptions(1920, 1080, "subtitle").fontSize < captionOptions(1080, 1920, "bold").fontSize);
});

test("blur boxes slot in between the early scale and the reframe", async () => {
  const { videoGraph } = await import("./render.mjs");
  const src = { width: 1920, height: 1080, fps: 25 };
  const g = videoGraph({ src, W: 1080, H: 1920, reframe: "crop", blur: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.1, start: 0, end: 5 }], duration: 10 });
  assert.match(g, /\[pre\]split=2\[bb0\]\[bk0\]/);
  assert.match(g, /\[bl\]crop=trunc\(ih\*9\/16/);
});
