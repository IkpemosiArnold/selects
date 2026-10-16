import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCueEdits, chunkWords, clipCues, cuesFromWords, parseSubtitles, STYLES, toSrt, toVtt } from "./captions.mjs";
import { words } from "./test/fixtures.mjs";

const ws = words("Nobody tells you this. Lifting heavy is mostly about showing up every single week.");

test("SRT and VTT are numbered, timed and hold briefly after the last word", () => {
  const cues = cuesFromWords(ws);
  const srt = toSrt(cues);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,/);
  assert.match(srt, /\n2\n/);
  const vtt = toVtt(cues);
  assert.match(vtt, /^WEBVTT\n\n1\n00:00:00\.000 --> /);
  assert.ok(!/,\d{3} -->/.test(vtt));
});

test("subtitle style makes longer cues than bold", () => {
  assert.ok(chunkWords(ws, STYLES.subtitle).length < chunkWords(ws, STYLES.bold).length);
});

test("parsing an SRT gives back the cues", () => {
  const cues = cuesFromWords(ws);
  const back = parseSubtitles(toSrt(cues));
  assert.equal(back.length, cues.length);
  assert.equal(back[0].text, cues[0].text);
  assert.equal(back[0].s, cues[0].s);
  const vtt = parseSubtitles("WEBVTT\n\n00:00:01.500 --> 00:00:02.000\n<b>Hello</b>\nthere\n");
  assert.deepEqual(vtt, [{ s: 1.5, e: 2, text: "Hello there" }]);
});

test("editing a word keeps every word's timing", () => {
  const cues = cuesFromWords(ws);
  const edits = cues.map((c) => ({ s: c.s, e: c.e, text: c.text }));
  edits[0].text = edits[0].text.replace("Nobody", "Nobody,");
  const out = applyCueEdits(cues, edits);
  assert.equal(out.length, cues.length);
  assert.equal(out[0].words[0].w, "Nobody,");
  assert.equal(out[0].words[0].s, cues[0].words[0].s);
  assert.equal(out[0].words[0].p, 1);
  assert.equal(out[0].words[1].p, cues[0].words[1].p, "untouched words keep their confidence");
});

test("changing the word count spreads words over the old span", () => {
  const cues = cuesFromWords(ws);
  const edits = [{ s: cues[0].s, e: cues[0].e, text: "No one ever tells you this." }, ...cues.slice(1).map((c) => ({ s: c.s, e: c.e, text: c.text }))];
  const out = applyCueEdits(cues, edits);
  assert.equal(out[0].words.length, 6);
  assert.equal(out[0].words[0].s, cues[0].words[0].s);
  assert.ok(out[0].words[5].e <= cues[0].words[cues[0].words.length - 1].e + 1e-6);
  for (let i = 1; i < 6; i++) assert.ok(out[0].words[i].s >= out[0].words[i - 1].e);
});

test("splitting and merging cues moves phrase breaks without moving words", () => {
  const cues = cuesFromWords(ws);
  const all = cues.flatMap((c) => c.words);
  // one cue for the first 6 words, then the rest
  const merged = [
    { s: all[0].s, e: all[5].e, text: all.slice(0, 6).map((w) => w.w).join(" ") },
    { s: all[6].s, e: all[all.length - 1].e, text: all.slice(6).map((w) => w.w).join(" ") },
  ];
  const out = applyCueEdits(cues, merged);
  assert.equal(out.length, 2);
  assert.deepEqual(out.flatMap((c) => c.words.map((w) => w.s)), all.map((w) => w.s));
});

test("an empty cue is deleted and cues never overlap", () => {
  const cues = cuesFromWords(ws);
  const edits = cues.map((c) => ({ s: c.s, e: c.e, text: c.text }));
  edits[1].text = "  ";
  const out = applyCueEdits(cues, edits);
  assert.equal(out.length, cues.length - 1);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].s >= out[i - 1].e);
});

test("clipCues keeps only words in the clip, shifted to clip time", () => {
  const cues = cuesFromWords(words("a b c d e f", { start: 100, wps: 1 }));
  const cc = clipCues(cues, 101, 103.9, 100.9);
  assert.deepEqual(cc.flatMap((c) => c.words.map((w) => w.w)), ["b", "c", "d"]);
  assert.equal(cc[0].s, 0.1);
});

test("captions built from words.json never show whisper's notes", async () => {
  const fs = (await import("node:fs")).default;
  const os = (await import("node:os")).default;
  const path = (await import("node:path")).default;
  const { loadCaptions } = await import("./captions.mjs");
  const { words } = await import("./test/fixtures.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selects-caps-ns-"));
  fs.writeFileSync(path.join(dir, "words.json"), JSON.stringify(words("Hello [Music] there (speaking in foreign language) friend (laughs) [BLANK_AUDIO] bye.")));
  const caps = loadCaptions(dir);
  const text = caps.cues.map((c) => c.text).join(" ");
  assert.equal(text, "Hello there friend bye.");
  fs.rmSync(dir, { recursive: true, force: true });
});
