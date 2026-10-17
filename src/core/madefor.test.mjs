// "Made for" presets: lengths, caption style, kit format, and the story line for the judge.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { applyMadeFor, clipCaptionStyle, MADE_FOR, madeForBlock, madeForPreset } from "./madefor.mjs";
import { cleanKit, kitMessages, kitSchema } from "./kit-core.mjs";
import { postingKit } from "./kit.mjs";
import { buildMessages, judge, judgeExtra } from "./judge.mjs";
import { buildTask, readTask, slimTask } from "./tasks.mjs";

const clip = { id: "c_0003", start: 10, end: 40, text: "Strength comes back slowly. Show up every week.", hook: "Strength comes back slowly." };
const kitMd = fs.readFileSync(new URL("./prompts/kit.md", import.meta.url), "utf8");
const judgeMd = fs.readFileSync(new URL("./prompts/judge.md", import.meta.url), "utf8");

test("each preset sets only the length range and the caption style; explicit settings win", () => {
  assert.deepEqual(Object.keys(MADE_FOR), ["shorts", "linkedin", "x", "story"]);
  const d = applyMadeFor({});
  assert.deepEqual([d.madeFor, d.minLen, d.maxLen, d.captionStyle], ["shorts", 20, 60, "bold"]);
  const li = applyMadeFor({ madeFor: "linkedin" });
  assert.deepEqual([li.minLen, li.maxLen, li.captionStyle], [30, 90, "subtitle"]);
  const x = applyMadeFor({ madeFor: "X" });
  assert.deepEqual([x.madeFor, x.minLen, x.maxLen], ["x", 15, 45]);
  const st = applyMadeFor({ madeFor: "story" });
  assert.deepEqual([st.minLen, st.maxLen], [60, 90]);
  const own = applyMadeFor({ madeFor: "linkedin", maxLen: 40, captionStyle: "bold" });
  assert.deepEqual([own.minLen, own.maxLen, own.captionStyle], [30, 40, "bold"]);
  assert.equal(applyMadeFor({ madeFor: "linkedin", mode: "caption" }).captionStyle, undefined, "caption mode keeps its own auto style");
  assert.throws(() => madeForPreset("outrage"), (e) => e.status === 400 && /shorts, linkedin, x, story/.test(e.message));
});

test("clip renders use the explicit style, else the preset's", () => {
  assert.equal(clipCaptionStyle({ madeFor: "linkedin" }), "subtitle");
  assert.equal(clipCaptionStyle({ madeFor: "linkedin", captionStyle: "bold" }), "bold");
  assert.equal(clipCaptionStyle({ captionStyle: "auto" }), "bold");
  assert.equal(clipCaptionStyle({}), "bold");
});

test("the kit prompt gets the platform's own format", () => {
  for (const k of Object.keys(MADE_FOR)) assert.ok(madeForBlock(kitMd, k).length > 50, `kit.md has a ${k} block`);
  const sys = (madeFor) => kitMessages(kitMd, clip, { madeFor })[0].content;
  assert.match(sys(), /YouTube Short/);
  assert.doesNotMatch(sys(), /\{\{format\}\}|made-for/);
  assert.match(sys("linkedin"), /see more/);
  assert.match(sys("linkedin"), /zero to three/);
  assert.match(sys("x"), /empty list, or one/);
  assert.match(sys("story"), /without giving away its ending/);
  assert.equal(sys("nonsense"), sys("shorts"));
});

test("hashtags follow the platform: LinkedIn at most 3, X at most 1", () => {
  assert.deepEqual([kitSchema("x").properties.hashtags.minItems, kitSchema("x").properties.hashtags.maxItems], [0, 1]);
  assert.equal(kitSchema("linkedin").properties.hashtags.maxItems, 3);
  assert.equal(kitSchema().properties.hashtags.minItems, 3);
  const tags = ["#Strength", "training", "habits", "gym", "health", "fitness"];
  assert.deepEqual(cleanKit({ title: "t", caption: "c", hashtags: tags }, { madeFor: "x" }).hashtags, ["strength"]);
  assert.equal(cleanKit({ title: "t", caption: "c", hashtags: tags }, { madeFor: "linkedin" }).hashtags.length, 3);
  assert.equal(cleanKit({ title: "t", caption: "c", hashtags: tags }).hashtags.length, 5);
  assert.equal(cleanKit({ title: "t", caption: "c" }, { madeFor: "x" }).madeFor, "x");
});

test("postingKit sends the preset's schema and format", async () => {
  let seen;
  const k = await postingKit(clip, { model: "m", madeFor: "linkedin", request: async (messages) => ((seen = messages), { data: { title: "Strength comes back", caption: "Twelve weeks off still left most of the gain. Here is why.", hashtags: ["strengthtraining", "a", "b", "c"] } }) });
  assert.match(seen[0].content, /LinkedIn/);
  assert.equal(k.hashtags.length, 3);
  assert.equal(k.madeFor, "linkedin");
});

test("story adds one line to the judge's system prompt; other presets leave it as it is", async () => {
  const story = madeForBlock(judgeMd, "story");
  assert.match(story, /setup, a turn and a resolution/);
  assert.equal(judgeExtra("story"), story);
  assert.equal(judgeExtra("linkedin"), "");
  const base = buildMessages(clip)[0].content;
  assert.equal(buildMessages(clip, { madeFor: "shorts" })[0].content, base);
  assert.equal(buildMessages(clip, { madeFor: "story" })[0].content, `${base}\n\n${story}`);
  // the story judge has its own cache entries
  const sys = [];
  const request = async (m) => (sys.push(m[0].content), { data: { hook: 3, standalone: 3, payoff: 3, clarity: 3, reason: "Fine." } });
  await judge([{ ...clip, pre: 0.5 }], { model: "m", request });
  await judge([{ ...clip, pre: 0.5 }], { model: "m", request, madeFor: "story" });
  assert.equal(sys.length, 2);
  assert.match(sys[1], /complete story/);
});

test("tasks: the browser judge and kit take the preset too", () => {
  const prompts = { judge: judgeMd, kit: kitMd };
  assert.match(buildTask({ kind: "judge", candidate: clip, madeFor: "story" }, prompts).messages[0].content, /complete story/);
  assert.doesNotMatch(buildTask({ kind: "judge", candidate: clip }, prompts).messages[0].content, /complete story/);
  const kit = buildTask({ kind: "kit", candidate: clip, madeFor: "x" }, prompts);
  assert.equal(kit.schema.properties.hashtags.maxItems, 1);
  assert.match(kit.messages[0].content, /posted on X/);
  assert.deepEqual(readTask({ kind: "kit", madeFor: "x" }, { data: { title: "t", caption: "c", hashtags: ["a", "b"] } }).hashtags, ["a"]);
  assert.equal(slimTask({ kind: "kit", candidate: clip, madeFor: "x" }).madeFor, "x");
  assert.equal(slimTask({ kind: "judge", candidate: clip, madeFor: "story" }).madeFor, "story");
});
