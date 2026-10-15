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
