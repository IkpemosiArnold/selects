import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockGemini } from "./mock-gemini.mjs";
import { createProxy, makeLimiter } from "./server.mjs";

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
const clip = { text: "Nobody tells you this. Strength comes from showing up. That is the whole trick.", hook: "Nobody tells you this.", start: 10, end: 40 };

async function setup(opts = {}) {
  const mock = createMockGemini();
  const base = `${await listen(mock.server)}/v1beta`;
  const logs = [];
  const proxy = createProxy({ key: "test-key", base, origins: ["http://localhost:4319"], log: (l) => logs.push(l), ...opts });
  const url = await listen(proxy);
  return { mock, url, logs, close: () => (mock.server.close(), proxy.close()) };
}

test("proxy judges a clip through Gemma and keeps clip text out of its log", async () => {
  const s = await setup();
  try {
    const r = await fetch(`${s.url}/v1/task`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:4319" }, body: JSON.stringify({ kind: "judge", candidate: { ...clip, secret: "not sent" } }) });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "http://localhost:4319");
    const j = await r.json();
    assert.match(j.text, /"hook"/);
    assert.equal(j.model, "gemma-4-26b-a4b-it");
    const sent = s.mock.seen.at(-1);
    assert.equal(sent.key, "test-key");
    assert.ok(!JSON.stringify(sent.body).includes("not sent"), "only the slim task reaches Google");
    assert.equal(s.mock.seen.length, 2, "JSON mode refused once, then retried without it");
    assert.ok(s.logs.length === 1 && !s.logs[0].includes("Nobody"), "the log has no clip text");
  } finally {
    s.close();
  }
});

test("proxy refuses other payloads, other origins and floods", async () => {
  const s = await setup({ limits: { perIpPerMinute: 2, perIpPerDay: 100, globalPerMinute: 100, globalPerDay: 100, bodyBytes: 4096 } });
  try {
    const post = (body, origin = "http://localhost:4319") => fetch(`${s.url}/v1/task`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
    assert.equal((await post({ kind: "chat", prompt: "write a poem" })).status, 400);
    assert.equal((await post({ kind: "judge", candidate: clip }, "https://evil.example")).status, 403);
    assert.equal((await post({ kind: "judge", candidate: clip })).status, 200);
    assert.equal((await post({ kind: "judge", candidate: clip })).status, 429, "third counted call in a minute from one IP (refused bodies count too)");
    const h = await (await fetch(`${s.url}/healthz`)).json();
    assert.equal(h.ok, true);
    assert.equal(h.counts.limited, 1);
  } finally {
    s.close();
  }
});

test("proxy falls back to the next Gemma model when one is not served", async () => {
  const s = await setup({ model: "missing-model", fallbacks: ["gemma-4-31b-it"] });
  try {
    const r = await fetch(`${s.url}/v1/task`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "listwise", top: [clip, clip, clip] }) });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.model, "gemma-4-31b-it");
    assert.match(j.text, /ranking/);
  } finally {
    s.close();
  }
});

test("limiter windows reset", () => {
  let t = 0;
  const l = makeLimiter(() => t);
  assert.equal(l.allow("a", 1, 1000).ok, true);
  assert.equal(l.allow("a", 1, 1000).ok, false);
  t = 1001;
  assert.equal(l.allow("a", 1, 1000).ok, true);
});
