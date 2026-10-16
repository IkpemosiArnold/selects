import assert from "node:assert/strict";
import { test } from "node:test";
import { accentRoute, nigerianCues } from "./langid/accent.mjs";
import { toWhisperCode } from "./langid/codes.mjs";
import { ng5Features, ng5Predict } from "./langid/ng5.mjs";
import { ensemble, ng5Verdict, textSignal } from "./langid/rule.mjs";
import { read608 } from "./langid/textlid.mjs";

// helpers: a decode as language.mjs records it, with what the text models said
const ng5 = (top, p = 0.95) => {
  const rest = (1 - p) / 4;
  const o = { eng: rest, hau: rest, ibo: rest, pcm: rest, yor: rest };
  o[top] = p;
  return o;
};
const dec = (code, textCode, p = 0.95, words = 60, ng = null) => ({ code, words, meanP: 0.7, text: { lid608: textCode ? { code: textCode, p } : null, ng5: ng } });
const sig = (r, id) => r.signals.find((s) => s.id === id);

test("the grandmother case: English speech the detector calls Yoruba comes out English, with no question", () => {
  // measured shape (16 Oct): detector yo p = 0.90; told to write Yoruba, whisper wrote English
  const r = ensemble({
    setting: "auto",
    detected: { code: "yo", p: 0.9 },
    decode: { best: "en", margin: null },
    compared: [dec("en", "en", 0.97, 76, ng5("eng", 0.8)), dec("yo", "en", 0.95, 79, ng5("eng", 0.8))],
  });
  assert.equal(r.language, "en");
  assert.equal(r.used, "en");
  assert.equal(r.disagreement, false);
  assert.equal(r.question, null);
  assert.equal(sig(r, "whisper-detect").refuted, true, "the detector's Yoruba was tested and refuted");
  assert.equal(sig(r, "text-608").verdict, "en");
  assert.equal(sig(r, "text-ng5").verdict, "en");
  assert.ok(r.confidence > 0.8 && r.confidence < 1, `confidence ${r.confidence} keeps the detector's dissent`);
});

test("real Yoruba stays Yoruba even when whisper translates the English decode", () => {
  const r = ensemble({
    setting: "auto",
    detected: { code: "yo", p: 0.95 },
    decode: { best: "yo", margin: 0.2 },
    compared: [dec("yo", "yo", 0.99, 70, ng5("yor")), dec("en", "en", 0.9, 50, ng5("eng"))],
  });
  assert.equal(r.language, "yo");
  assert.equal(r.disagreement, false);
  assert.equal(sig(r, "text-608").verdict, null, "every decode came out in the language asked for: no opinion");
});

test("an English decode that comes out in Yoruba is a vote for Yoruba", () => {
  const r = ensemble({ setting: "auto", detected: { code: "yo", p: 0.7 }, decode: { best: "yo", margin: 0.1 }, compared: [dec("en", "yo", 0.8), dec("yo", "yo", 0.99)] });
  assert.equal(r.language, "yo");
  assert.equal(sig(r, "text-608").verdict, "yo");
  assert.deepEqual(sig(r, "whisper-decode").refuted, false);
});

test("disagreement: the detector's language decoded as itself, but English decoded better, so ask", () => {
  const r = ensemble({ setting: "auto", detected: { code: "yo", p: 0.9 }, decode: { best: "en", margin: 0.15 }, compared: [dec("en", "en"), dec("yo", "yo", 0.9)] });
  assert.equal(r.language, "en");
  assert.equal(r.disagreement, true);
  assert.match(r.reasons.join(";"), /whisper-detect says Yoruba/);
  assert.equal(r.question.text, "Is the speaker using English?");
  assert.deepEqual(r.question.choices, ["yo"]);
});

test("disagreement: decoding and text split, and no side has 60% of the vote", () => {
  const r = ensemble({ setting: "auto", detected: null, decode: { best: "en", margin: 0.1 }, compared: [dec("en", "fr", 0.9), dec("fr", "fr", 0.95)] });
  assert.equal(r.language, "en");
  assert.ok(r.confidence < 0.6);
  assert.equal(r.disagreement, true);
  assert.match(r.reasons.join(";"), /text-608 says French/);
  assert.ok(r.question.choices.includes("fr"));
});

test("an explicit setting is kept, and evidence against it raises the question", () => {
  const r = ensemble({ setting: "en", detected: { code: "fr", p: 0.97 }, decode: { best: "fr", margin: 0.4 }, compared: [dec("en", "fr", 0.9), dec("fr", "fr", 0.99)] });
  assert.equal(r.used, "en");
  assert.equal(r.language, "fr");
  assert.equal(r.disagreement, true);
  assert.match(r.reasons.join(";"), /you chose English, the evidence says French/);
  assert.equal(r.question.text, "Is the speaker using English?");
  assert.equal(r.question.choices[0], "fr");
});

test("the detector alone cannot outvote a decode", () => {
  const r = ensemble({ setting: "auto", detected: { code: "yo", p: 1 }, decode: { best: "en", margin: 0.3 }, compared: [dec("en", null), dec("yo", null)] });
  assert.equal(r.language, "en");
  assert.equal(r.disagreement, true, "but it is not ignored either: an untested dissent asks");
});

test("no compare needed: the detector agrees with the setting", () => {
  const r = ensemble({ setting: "en", detected: { code: "en", p: 0.98 }, decode: { best: null }, compared: [] });
  assert.equal(r.language, "en");
  assert.equal(r.confidence, 1);
  assert.equal(r.disagreement, false);
  assert.equal(r.signals.length, 1);
});

test("no signals at all falls back to the setting or English", () => {
  assert.equal(ensemble({ setting: "auto" }).language, "en");
  assert.equal(ensemble({ setting: "auto" }).confidence, null);
  assert.equal(ensemble({ setting: "auto" }).disagreement, false);
  assert.equal(ensemble({ setting: "yo" }).used, "yo");
});

test("a language whisper cannot transcribe (Igbo) never wins, and raises the question", () => {
  const r = ensemble({ setting: "auto", detected: null, decode: { best: "en", margin: 0.02 }, compared: [dec("en", "ig", 0.95)] });
  assert.equal(r.language, "en");
  assert.equal(r.disagreement, true);
  assert.match(r.reasons.join(";"), /Igbo cannot be transcribed/);
});

test("text verdicts need enough words and enough probability", () => {
  const s = textSignal([
    { asked: "yo", words: 3, verdict: { code: "en", p: 0.99 } },
    { asked: "fr", words: 50, verdict: { code: "en", p: 0.4 } },
  ]);
  assert.equal(s.verdict, null);
  assert.deepEqual(s.refuted, []);
  assert.equal(s.detail[0].note, "too few words");
  const t = textSignal([{ asked: "yo", words: 50, verdict: { code: "en", p: 0.9 } }]);
  assert.deepEqual([t.verdict, t.p, t.refuted], ["en", 0.9, ["yo"]]);
});

test("lid-lite-5's verdict folds Pidgin into English", () => {
  assert.deepEqual(ng5Verdict({ eng: 0.3, hau: 0, ibo: 0, pcm: 0.6, yor: 0.1 }), { code: "en", p: 0.9 });
  assert.deepEqual(ng5Verdict({ eng: 0.1, hau: 0, ibo: 0, pcm: 0.1, yor: 0.8 }), { code: "yo", p: 0.8 });
  assert.equal(ng5Verdict(null), null);
});

test("lid-lite-5 in JavaScript: sublinear TF-IDF, L2 norm, softmax", () => {
  const model = { classes: ["eng", "yor"], intercept: [0, 0], features: { hello: { weights: [3, -3], idf: 1 }, bawo: { weights: [-3, 3], idf: 2 }, "bawo ni": { weights: [-1, 1], idf: 1 } } };
  assert.deepEqual(ng5Features("Bawo ni, Ọmọ!"), ["bawo", "ni", "ọmọ", "bawo ni", "ni ọmọ"]);
  const en = ng5Predict(model, "hello hello");
  assert.ok(en.eng > 0.99 && en.matched === 1);
  const yo = ng5Predict(model, "bawo ni");
  assert.ok(yo.yor > 0.99 && yo.matched === 2);
  assert.equal(ng5Predict(model, "   "), null);
  const none = ng5Predict(model, "zzz");
  assert.equal(none.eng, 0.5, "no known words: the intercepts decide");
});

test("lid-lite-608 output: unknown and noise labels are dropped, the rest renormalised", () => {
  const r = read608([
    [0.5, "__label__eng_Latn"],
    [0.3, "__label__zxx_Zxxx"],
    [0.1, "__label__pcm_Latn"],
    [0.1, "__label__trc_Latn"],
  ]);
  assert.equal(r.code, "en");
  assert.equal(r.p, 0.833);
  assert.equal(r.pcm, 0.167);
  assert.equal(read608([[1, "__label__zxx_Zxxx"]]), null);
  assert.equal(toWhisperCode("yor_Latn"), "yo");
  assert.equal(toWhisperCode("pcm_Latn"), "en");
  assert.equal(toWhisperCode("arz_Arab"), "ar");
  assert.equal(toWhisperCode("trc_Latn"), null);
});

test("accent cues: the detector hearing Yoruba in English speech, and Nigerian text", () => {
  const audio = nigerianCues({ language: "en", detected: { code: "yo", p: 0.9 } });
  assert.equal(audio.length, 1);
  assert.equal(audio[0].kind, "audio");
  assert.deepEqual(nigerianCues({ language: "en", detected: { code: "cy", p: 0.9 } }), []);
  assert.deepEqual(nigerianCues({ language: "yo", detected: { code: "yo", p: 0.9 } }), [], "not English: no accent routing");
  const text = nigerianCues({ language: "en", detected: { code: "en", p: 0.9 }, texts: [{ asked: "en", ng5: { eng: 0.6 }, lid608: { pcm: 0.4 } }] });
  assert.deepEqual(text.map((c) => c.kind), ["text", "text"]);
  assert.deepEqual(nigerianCues({ language: "en", texts: [{ asked: "en", ng5: { eng: 0.9 }, lid608: { pcm: 0.01 } }] }), []);
});

test("accent routing: cues, settings, the user's model choice and a missing model", () => {
  const cues = [{ kind: "audio", note: "heard yo" }];
  const yes = () => true;
  const r = accentRoute({ language: "en", cues, exists: yes });
  assert.equal(r.accent, "ng");
  assert.match(r.model, /ggml-small-nigerian-accent\.bin$/);
  assert.equal(accentRoute({ language: "en", cues: [], exists: yes }).model, null);
  assert.ok(accentRoute({ language: "en", accent: "ng", cues: [], exists: yes }).model, "the setting or profile routes without cues");
  assert.equal(accentRoute({ language: "en", accent: "none", cues, exists: yes }).model, null);
  const kept = accentRoute({ language: "en", cues, asrModel: "small.en", exists: yes });
  assert.equal(kept.model, null);
  assert.match(kept.reason, /set to small\.en/);
  assert.equal(accentRoute({ language: "yo", accent: "ng", cues, exists: yes }).model, null);
  assert.match(accentRoute({ language: "en", cues, exists: () => false }).reason, /not installed/);
});
