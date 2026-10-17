// Faithful cuts: the rule check, the context, reading the answer, the fix and the ranking rule.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { words as mkWords } from "./test/fixtures.mjs";
import { contextFor, faithfulFix, faithfulHints, faithfulMessages, faithfulResult, isDemoted, orderByFaithful, readFaithful } from "./faithful-core.mjs";
import { checkFaithful, loadFaithfulPrompt } from "./faithful.mjs";
import { toSentences } from "./sentences.mjs";
import { buildTask, checkTaskShape, readTask, slimTask } from "./tasks.mjs";

// A real shape from the eval set (Sam Altman, How to Start a Startup, CC BY 3.0): the clip
// describes the fashionable view, and the turn comes in the next sentence.
const TALK = [
  "In fact, it's almost uncool to spend a lot of time thinking about the idea for a startup.",
  "You're just supposed to start, throw stuff at the wall, and see what sticks.",
  "And pivots are supposed to be great, the more pivots the better.",
  "So this isn't totally wrong.",
  "Great execution is at least ten times more important than a good idea.",
  "But the pendulum has swung way out of whack here.",
  "A bad idea is still bad, and the idea really does matter.",
].join(" ");
const W = mkWords(TALK);
const S = toSentences(W);
// the clip: sentences 1 to 4 ("You're just supposed to start" ... "a good idea.")
const CLIP = { id: "c_0001", start: S[1].s, end: S[4].e, text: S.slice(1, 5).map((s) => s.text).join(" "), total: 0.7 };

test("rules: a next sentence that opens with But is a possible turn", () => {
  const { before, after } = contextFor(S, CLIP);
  assert.match(before.text, /^In fact/);
  assert.match(after.text, /^But the pendulum/);
  const h = faithfulHints({ text: CLIP.text, before: before.text, after: after.text });
  assert.deepEqual(h.map((x) => x.issue), ["turn"]);
  assert.match(h[0].cue, /"But the pendulum"/);
});

test("rules: quotes, sarcasm, qualifiers, references, and a clean clip", () => {
  const issues = (o) => faithfulHints(o).map((x) => x.issue);
  assert.deepEqual(issues({ text: "A lot of people say it's taking over the game." }), ["quote"]);
  assert.deepEqual(issues({ text: "We are told sugar is the enemy." }), ["quote"]);
  assert.deepEqual(issues({ text: "Ship it on Friday, what could possibly go wrong." }), ["sarcasm"]);
  assert.deepEqual(issues({ text: "Lifting is always safe.", after: "Unless you have a back injury." }), ["qualifier"]);
  assert.deepEqual(issues({ text: "This is the most dangerous part of the job.", before: "We wire the mains by hand." }), ["reference"]);
  assert.deepEqual(issues({ text: "Lifting makes women bulky. That's what they say." }), ["turn", "quote"]);
  assert.deepEqual(issues({ text: "Strength training keeps its gains for months.", before: "Here is a study.", after: "So start now." }), []);
  // a pointing word with no sentence before it (the start of the video) is not a reference
  assert.deepEqual(issues({ text: "This is the most dangerous part of the job." }), []);
});

test("context: a very short neighbour brings the next sentence along", () => {
  const ws = mkWords("We train every day. It works for most people. But. Not for everyone, and not at first.");
  const ss = toSentences(ws);
  const c = { start: ss[0].s, end: ss[1].e };
  const { before, after } = contextFor(ss, c);
  assert.equal(before, null);
  assert.equal(after.text, "But. Not for everyone, and not at first.");
});

test("readFaithful reads a parsed answer, a cut-off one, and rejects one with no verdict", () => {
  assert.deepEqual(readFaithful({ issue: "turn", verdict: "misleading", extend: "after", note: "She goes on to say the opposite" }), { verdict: "misleading", issue: "turn", extend: "after", note: "She goes on to say the opposite." });
  const cut = readFaithful('{"issue": "quote", "verdict": "check", "extend": "after", "note": "He is describing what');
  assert.equal(cut.verdict, "check");
  assert.equal(cut.issue, "quote");
  assert.equal(readFaithful({ issue: "turn", note: "x" }), null);
  assert.equal(readFaithful({ issue: "none", verdict: "faithful", extend: "none", note: "Fine." }).issue, null);
  const r = readFaithful({ clip_says: "Lifting weights is risky", speaker_means: "Lifting is — relatively safe", verdict: "check", issue: "turn", extend: "after", note: "x" });
  assert.deepEqual(r.reading, { clip: "Lifting weights is risky", speaker: "Lifting is, relatively safe" });
  assert.deepEqual(faithfulResult(CLIP, { answer: r }).reading, r.reading);
});

test("a misleading turn suggests growing to the end of the next sentence, snapped", () => {
  const { before, after } = contextFor(S, CLIP);
  const f = faithfulResult(CLIP, { hints: [{ issue: "turn", cue: "x" }], answer: { verdict: "misleading", issue: "turn", extend: "after", note: "He goes on to say the pendulum swung too far." }, before, after, words: W, sentences: S });
  assert.equal(f.verdict, "misleading");
  assert.equal(f.issue, "turn");
  assert.equal(f.by, "model");
  assert.deepEqual(f.fix, { end: S[5].e });
  assert.equal(f.note, "He goes on to say the pendulum swung too far.");
});

test("a faithful answer has no issue and no fix; a missing direction falls back by issue", () => {
  const { before, after } = contextFor(S, CLIP);
  const ok = faithfulResult(CLIP, { answer: { verdict: "faithful", issue: "turn", extend: "after", note: "" }, before, after, words: W });
  assert.deepEqual([ok.verdict, ok.issue, ok.fix], ["faithful", null, null]);
  const ref = faithfulResult(CLIP, { answer: { verdict: "check", issue: "reference", extend: "none", note: "" }, before, after, words: W });
  assert.deepEqual(ref.fix, { start: S[0].s });
  assert.match(ref.note, /something said just before/);
});

test("rules alone never say misleading: a hint is a check, no hint is faithful", () => {
  const r = faithfulResult(CLIP, { hints: [{ issue: "turn", cue: 'the next sentence starts with "But the"' }] });
  assert.equal(r.verdict, "check");
  assert.equal(r.by, "rules");
  assert.match(r.note, /^The next sentence starts with "But the": check/);
  assert.equal(faithfulResult(CLIP, {}).verdict, "faithful");
});

test("no fix when growing would make the clip too long", () => {
  const { after } = contextFor(S, CLIP);
  assert.equal(faithfulFix(CLIP, { extend: "after", after, words: W, maxLen: CLIP.end - CLIP.start + 0.5 }), null);
  assert.ok(faithfulFix(CLIP, { extend: "after", after, words: W, maxLen: 90 }));
});

test("ranking: a misleading cut drops below the rest until accepted or fixed", () => {
  const mk = (id, total, verdict, extra = {}) => ({ id, total, rank: null, faithful: { verdict, ...extra } });
  const order = (cs) => orderByFaithful(cs).map((c) => `${c.rank}:${c.id}${c.demoted ? "!" : ""}`).join(" ");
  const cs = [mk("a", 0.8, "misleading"), mk("b", 0.7, "faithful"), mk("c", 0.6, "check")];
  assert.equal(order(cs), "1:b 2:c 3:a!");
  assert.equal(order([mk("a", 0.8, "misleading", { accepted: true }), cs[1], cs[2]]), "1:a 2:b 3:c");
  assert.equal(order([mk("a", 0.8, "misleading", { applied: true }), cs[1], cs[2]]), "1:a 2:b 3:c");
  assert.equal(isDemoted(cs[0]), true);
  assert.equal(isDemoted({ total: 1 }), false);
});

test("checkFaithful asks once per clip with the hint, caches the answer, and falls back to rules", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selects-faithful-"));
  const seen = [];
  const request = async (messages) => {
    seen.push(messages[1].content);
    return { data: { issue: "turn", verdict: "misleading", extend: "after", note: "He disagrees in the next sentence." }, stats: { wallSec: 1 } };
  };
  const r1 = await checkFaithful([CLIP], { words: W, model: "m", cacheDir: dir, request });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /Sentence after the clip:\nBut the pendulum/);
  assert.match(seen[0], /possible turn/);
  assert.equal(r1.candidates[0].faithful.verdict, "misleading");
  assert.equal(r1.candidates[0].faithful.context.after, "But the pendulum has swung way out of whack here.");
  assert.equal(r1.stats.asked, 1);
  const r2 = await checkFaithful([CLIP], { words: W, model: "m", cacheDir: dir, request });
  assert.equal(seen.length, 1, "the second run is served from the cache");
  assert.equal(r2.stats.cached, 1);
  const down = await checkFaithful([CLIP], { words: W, model: "other", cacheDir: dir, request: async () => { throw new Error("Could not reach Ollama."); } });
  assert.equal(down.candidates[0].faithful.by, "rules");
  assert.equal(down.candidates[0].faithful.verdict, "check");
  assert.match(down.candidates[0].faithful.error, /Could not reach Ollama/);
  const rules = await checkFaithful([CLIP], { words: W, mode: "rules", request: async () => assert.fail("rules mode never calls the model") });
  assert.equal(rules.candidates[0].faithful.by, "rules");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the prompt file has the five issues and the three fields to fill", () => {
  const p = loadFaithfulPrompt();
  for (const k of ["turn =", "quote =", "sarcasm =", "qualifier =", "reference =", "clip_says:", "speaker_means:"]) assert.ok(p.system.includes(k), k);
  for (const k of ["{{before}}", "{{text}}", "{{after}}", "{{hints}}"]) assert.ok(p.user.includes(k), k);
  const m = faithfulMessages(p, { text: "Clip.", before: null, after: null, hints: [] });
  assert.match(m[1].content, /starts at the beginning of the video/);
  assert.doesNotMatch(m[1].content, /\{\{|rule check/);
});

test("tasks: the browser and the proxy build and read the faithful task the same way", () => {
  const prompts = { faithful: fs.readFileSync(new URL("./prompts/faithful.md", import.meta.url), "utf8") };
  const task = { kind: "faithful", candidate: CLIP, before: "Before.", after: "But no.", hints: [{ issue: "turn", cue: "c" }] };
  const built = buildTask(task, prompts);
  assert.equal(built.maxTokens, 130);
  assert.deepEqual(built.schema.required, ["clip_says", "speaker_means", "verdict", "issue", "extend", "note"]);
  assert.match(built.messages[1].content, /But no\./);
  assert.equal(readTask(task, { text: '```json\n{"issue":"turn","verdict":"check","extend":"after","note":"Hm."}\n```' }).verdict, "check");
  assert.equal(readTask(task, { text: "no idea" }), null);
  assert.equal(checkTaskShape(slimTask(task)), null);
  assert.equal(checkTaskShape({ ...task, after: "x".repeat(2000) }) !== null, true);
  assert.deepEqual(Object.keys(slimTask(task).candidate), ["text", "hook", "start", "end"]);
});
