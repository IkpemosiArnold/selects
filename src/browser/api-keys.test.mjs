// Keys in the browser adapter (api.js): forgetting a key stops its use at once, and replacing
// one key with another never leaves a client that still sends the old one.
import assert from "node:assert/strict";
import { test } from "node:test";

await import("./test-env.mjs");
const mem = new Map();
globalThis.sessionStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { createBrowserApi } = await import("./api.js");

const geminiOk = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"hook":3,"standalone":3,"payoff":3,"clarity":3,"reason":"ok"}' }] }, finishReason: "STOP" }], usageMetadata: {} }), { status: 200, headers: { "content-type": "application/json" } });
const task = { kind: "judge", candidate: { text: "Nobody tells you this. It works.", hook: "Nobody tells you this.", start: 0, end: 30 } };

/** Run fn with a global fetch that records the headers it was called with. */
async function withFetch(reply, fn) {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: new Headers(init.headers) });
    return reply(url, init);
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return seen;
}

test("keys: forgetting the Gemini key stops its use at once", async () => {
  mem.clear();
  const api = createBrowserApi({ mode: "smart", smart: { proxyUrl: "https://proxy.example" } });
  api.setMode("smart", { key: "gemini-AAA" });
  assert.equal(api.getMode().hasKey, true);
  assert.equal((await api.engine.getJudge()).id, "gemini-key");
  api.setMode("smart", { key: null });
  assert.equal(api.getMode().hasKey, false, "the page no longer says a key is in use");
  assert.equal((await api.engine.getJudge()).id, "gemini-proxy", "the judge no longer uses the forgotten key");
  const noProxy = createBrowserApi({ mode: "smart", smart: { proxyUrl: null } });
  noProxy.setMode("smart", { key: "gemini-AAA" });
  noProxy.setMode("smart", { key: null });
  await assert.rejects(noProxy.engine.getJudge(), /needs a Gemini API key/);
});

test("keys: replacing Gemini key A with B sends B, never A", async () => {
  mem.clear();
  const api = createBrowserApi({ mode: "smart", smart: { proxyUrl: null } });
  api.setMode("smart", { key: "gemini-AAA" });
  await api.engine.getJudge();
  api.setMode("smart", { key: "gemini-BBB" });
  const seen = await withFetch(geminiOk, async () => {
    await (await api.engine.getJudge()).run(task);
  });
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((s) => s.headers.get("x-goog-api-key") === "gemini-BBB"), `sent ${seen.map((s) => s.headers.get("x-goog-api-key")).join(", ")}`);
});

test("keys: replacing Groq key A with B sends B; forgetting it falls back to the shared transcriber", async () => {
  mem.clear();
  const api = createBrowserApi({ mode: "light", smart: { proxyUrl: "https://proxy.example" } });
  api.setMode("light", { groqKey: "gsk_AAA" });
  const a = await api.engine.getTranscriber();
  api.setMode("light", { groqKey: "gsk_BBB" });
  const b = await api.engine.getTranscriber();
  assert.notEqual(a, b, "a new client for the new key");
  const groqOk = () => new Response(JSON.stringify({ text: "Hi.", duration: 1, words: [{ word: "Hi", start: 0, end: 0.4 }] }), { status: 200 });
  const seen = await withFetch(groqOk, async () => {
    await b.sender.send({ blob: new Blob([new Uint8Array(8)], { type: "audio/ogg" }), mime: "audio/ogg", ext: "ogg" });
  });
  assert.equal(seen[0].headers.get("authorization"), "Bearer gsk_BBB");
  api.setMode("light", { groqKey: null });
  assert.equal(api.getMode().hasGroqKey, false);
  assert.equal((await api.engine.getTranscriber()).id, "remote:proxy");
});
