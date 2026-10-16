import assert from "node:assert/strict";
import { test } from "node:test";
import { splitNonSpeech } from "./nonspeech.mjs";
import { words } from "./test/fixtures.mjs";

const texts = (ws) => ws.map((x) => x.w);

test("splitNonSpeech drops whisper's notes, single tokens and runs", () => {
  const ws = words("So (speaking in foreign language) she said [Music] hello [BLANK_AUDIO] (laughs) there [inaudible] friend. * applause * Thanks ♪ ♪");
  const { words: out, events } = splitNonSpeech(ws);
  assert.deepEqual(texts(out), ["So", "she", "said", "hello", "there", "friend.", "Thanks"]);
  assert.deepEqual(
    events.map((e) => e.type),
    ["foreign", "music", "silence", "laughter", "inaudible", "applause", "music"],
  );
  // the run's span is the event, from its first token to its last
  assert.equal(events[0].s, ws[1].s);
  assert.equal(events[0].e, ws[4].e);
});

test("speech keeps its own times, so a dropped note leaves a gap", () => {
  const ws = words("We lifted (laughs) every week.");
  const { words: out, events } = splitNonSpeech(ws);
  assert.deepEqual(texts(out), ["We", "lifted", "every", "week."]);
  assert.equal(out[2].s, ws[3].s);
  assert.ok(out[2].s - out[1].e > 0.3, "the note's time is now a pause");
  assert.deepEqual(events, [{ type: "laughter", s: ws[2].s, e: ws[2].e }]);
});

test("notes glued to a word or followed by punctuation are removed, the word stays", () => {
  const ws = [
    { w: "great[BLANK_AUDIO]", s: 0, e: 0.5, p: 0.9 },
    { w: "(Laughter).", s: 0.6, e: 1, p: 0.9 },
    { w: "yes(speaking", s: 1.1, e: 1.3, p: 0.9 },
    { w: "Yoruba)", s: 1.3, e: 1.6, p: 0.9 },
    { w: "ok.", s: 2, e: 2.2, p: 0.9 },
  ];
  const { words: out, events } = splitNonSpeech(ws);
  assert.deepEqual(texts(out), ["great", "yes", "ok."]);
  assert.deepEqual(events.map((e) => e.type), ["silence", "laughter", "foreign"]);
});

test("an opener that never closes is left as speech", () => {
  const ws = words("a (b c d e f g h i j k l m n o p");
  assert.equal(splitNonSpeech(ws).words.length, ws.length);
});
