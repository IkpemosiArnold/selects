import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { geminiBody, geminiGenerate, readGemini, refusedFeature, toGeminiSchema } from "./gemini.mjs";
import { buildMessages } from "./judge.mjs";
import { buildTask, checkTaskShape, extractJson, readTask, slimTask } from "./tasks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const prompts = Object.fromEntries(["judge", "listwise", "kit"].map((k) => [k, fs.readFileSync(path.join(here, "prompts", `${k}.md`), "utf8")]));
const cand = { id: "c_0001", start: 10, end: 40, text: "Nobody tells you this. It works. That is the point.", hook: "Nobody tells you this." };

test("tasks build the same judge messages as the Ollama path", () => {
  const t = buildTask({ kind: "judge", candidate: cand }, prompts);
  assert.deepEqual(t.messages, buildMessages(cand));
  assert.equal(t.maxTokens, 80);
  assert.deepEqual(Object.keys(t.schema.properties), ["hook", "standalone", "payoff", "clarity", "reason"]);
});

test("answers are read from fenced JSON, plain JSON or a cut-off answer", () => {
  const task = { kind: "judge", candidate: cand };
  assert.equal(readTask(task, { text: 'Sure!\n```json\n{"hook": 4, "standalone": 3, "payoff": 2, "clarity": 5, "reason": "Strong open."}\n```' }).hook, 4);
  assert.equal(readTask(task, { text: '{"hook": 2, "standalone": 3, "payoff": 4, "clarity": 1, "reason": "Fades out at the' }).truncated, true);
  assert.equal(readTask(task, { text: "no idea" }), null);
  assert.deepEqual(extractJson('x {"a": "}{", "b": {"c": 1}} y'), { a: "}{", b: { c: 1 } });
  const lw = readTask({ kind: "listwise", top: [cand, cand, cand] }, { text: '{"ranking":[{"clip":"B","reason":"best"},{"clip":"A","reason":"ok"}]}' });
  assert.deepEqual(lw.order, ["B", "A", "C"]);
  assert.equal(lw.complete, false);
  assert.deepEqual(readTask({ kind: "kit", candidate: cand }, { text: '{"title":"A — b","caption":"c","hashtags":["#One","two"]}' }), { title: "A, b", caption: "c", hashtags: ["one", "two"] });
});

test("the proxy shape check accepts only clip text and times", () => {
  assert.equal(checkTaskShape(slimTask({ kind: "judge", candidate: { ...cand, scores: 1, secret: "x" } })), null);
  assert.equal(Object.keys(slimTask({ kind: "judge", candidate: { ...cand, secret: "x" } }).candidate).includes("secret"), false);
  assert.match(checkTaskShape({ kind: "chat", prompt: "write me a poem" }), /kind/);
  assert.match(checkTaskShape({ kind: "judge", candidate: { text: "x".repeat(4000), start: 0, end: 30 } }), /3000/);
  assert.match(checkTaskShape({ kind: "listwise", top: [cand] }), /2 to 6/);
});

test("Gemini body: system instruction, JSON schema, minimal thinking; features can be turned off", () => {
  const { messages, schema } = buildTask({ kind: "judge", candidate: cand }, prompts);
  const b = geminiBody(messages, { schema, maxTokens: 80 });
  assert.ok(b.systemInstruction.parts[0].text.includes("short-form video editor"));
  assert.equal(b.generationConfig.responseMimeType, "application/json");
  assert.equal(b.generationConfig.responseSchema.properties.hook.type, "INTEGER");
  const plain = geminiBody(messages, { schema, features: { system: false, json: false, thinking: false } });
  assert.equal(plain.systemInstruction, undefined);
  assert.ok(plain.contents[0].parts[0].text.startsWith("You are a senior"));
  assert.equal(plain.generationConfig.responseSchema, undefined);
  assert.equal(toGeminiSchema({ type: "array", minItems: 2, items: { type: "string", enum: ["A"] } }).minItems, "2");
  assert.equal(readGemini({ candidates: [{ content: { parts: [{ text: "x", thought: true }, { text: "{}" }] } }] }).text, "{}");
  assert.equal(refusedFeature("JSON mode is not enabled for models/gemma-3-27b-it"), "json");
  assert.equal(refusedFeature("Developer instruction is not enabled for models/gemma-3-27b-it"), "system");
});

test("Gemini call retries without a refused feature and reports quota errors plainly", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, key: init.headers["x-goog-api-key"], json: !!body.generationConfig.responseMimeType });
    if (body.generationConfig.responseMimeType) return new Response(JSON.stringify({ error: { message: "JSON mode is not enabled for models/gemma-3-27b-it" } }), { status: 400 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"hook":3}' }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 9 } }));
  };
  const r = await geminiGenerate({ key: "k", model: "gemma-3-27b-it", messages: [{ role: "user", content: "hi" }], schema: { type: "object" }, fetchImpl });
  assert.equal(r.text, '{"hook":3}');
  assert.equal(r.features.json, false);
  assert.deepEqual(seen.map((s) => s.json), [true, false]);
  assert.match(seen[0].url, /models\/gemma-3-27b-it:generateContent$/);
  const quota = async () => new Response(JSON.stringify({ error: { message: "Resource exhausted" } }), { status: 429 });
  await assert.rejects(geminiGenerate({ key: "k", model: "m", messages: [{ role: "user", content: "x" }], fetchImpl: quota }), (e) => e.status === 429 && /quota/.test(e.hint));
});
