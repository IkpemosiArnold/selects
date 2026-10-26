// The copy rules: Light mode never promises a service it could not confirm, and a sound
// recording is never called a video.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileWord, isAudioFile, lightHint, lightWarning } from "./copy.js";
import { longVideoNote } from "./pcm.js";

test("Light mode promises the shared transcriber only when the proxy confirmed it", () => {
  assert.match(lightHint({ lightShared: true }), /uses its free shared transcriber/);
  for (const mode of [{ lightShared: null, lightChecked: true }, { lightShared: false, lightChecked: true }, { lightShared: null, lightChecked: false }]) {
    assert.doesNotMatch(lightHint(mode), /uses its free shared transcriber/, JSON.stringify(mode));
  }
  assert.match(lightHint({ lightShared: null, lightChecked: false }), /Checking/);
  assert.match(lightWarning({ lightShared: null, lightChecked: true }), /could not reach/, "a failed check (CORS, cold) asks for a key");
  assert.match(lightWarning({ lightShared: false }), /not switched on/);
  assert.equal(lightWarning({ lightShared: null, lightChecked: true, hasGroqKey: true }), null);
  assert.equal(lightWarning({ lightShared: true }), null);
});

test("a sound recording is a recording, not a video", () => {
  assert.equal(isAudioFile({ name: "episode.m4a", type: "audio/x-m4a" }), true);
  assert.equal(isAudioFile({ name: "memo.m4a", type: "" }), true);
  assert.equal(isAudioFile("~/Movies/talk.mp4"), false);
  assert.equal(isAudioFile({ name: "clip.webm", type: "" }), null);
  assert.deepEqual([fileWord(true), fileWord(false), fileWord(null)], ["recording", "video", "file"]);
  assert.match(longVideoNote(3700, { mobile: false, audio: true }), /long recording/);
  assert.doesNotMatch(longVideoNote(3700, { mobile: false, audio: true }), /video/);
  assert.match(longVideoNote(3700, { mobile: false }), /long video/);
});
