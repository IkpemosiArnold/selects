import assert from "node:assert/strict";
import { test } from "node:test";
import { failover, providerRequest } from "./provider-request.mjs";

const slowBody = (chunks, gapMs) => new ReadableStream({
  async pull(c) {
    if (!chunks.length) return c.close();
    await new Promise((r) => setTimeout(r, gapMs));
    c.enqueue(chunks.shift());
  },
});

test("deadline covers the body: headers in time, body too slow, is a transient timeout", async () => {
  const fetchImpl = async () => new Response(slowBody([new Uint8Array(10), new Uint8Array(10)], 300), { status: 200 });
  await assert.rejects(providerRequest("https://x", {}, { deadlineMs: 100, fetchImpl }), (e) => e.timeout && e.status === 0 && e.transient);
});

test("a fetch that ignores the abort signal still times out", async () => {
  await assert.rejects(providerRequest("https://x", {}, { deadlineMs: 50, fetchImpl: () => new Promise(() => {}) }), (e) => e.timeout);
});

test("size cap: an error by default, or a cancelled, truncated read", async () => {
  let cancelled = false;
  const big = () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1000)); }, cancel() { cancelled = true; } }), { status: 200 });
  await assert.rejects(providerRequest("https://x", {}, { maxBytes: 5000, fetchImpl: async () => big() }), (e) => e.tooLarge && !e.transient);
  assert.equal(cancelled, true);
  const r = await providerRequest("https://x", {}, { maxBytes: 5000, overCap: "truncate", read: "bytes", fetchImpl: async () => big() });
  assert.equal(r.bytes, 5000);
  assert.equal(r.truncated, true);
});

test("non-2xx answers resolve with their body; JSON is parsed when asked", async () => {
  const r = await providerRequest("https://x", {}, { read: "json", fetchImpl: async () => new Response('{"error":"busy"}', { status: 429 }) });
  assert.equal(r.status, 429);
  assert.equal(r.ok, false);
  assert.deepEqual(r.json, { error: "busy" });
});

test("the caller's signal stops it as an AbortError, not a transient failure", async () => {
  const ctl = new AbortController();
  const p = providerRequest("https://x", {}, { signal: ctl.signal, fetchImpl: () => new Promise(() => {}) });
  ctl.abort();
  await assert.rejects(p, (e) => e.name === "AbortError");
});

test("failover: in order, only past no-answer, timeouts, 429 and 5xx", async () => {
  const seen = [];
  const call = (p) => (seen.push(p.id), p.run());
  const down = { id: "a", run: async () => { throw Object.assign(new Error("x"), { status: 503 }); } };
  const quota = { id: "b", run: async () => { throw Object.assign(new Error("x"), { status: 429 }); } };
  const ok = { id: "c", run: async () => "done" };
  assert.equal(await failover([down, quota, ok], call), "done");
  assert.deepEqual(seen, ["a", "b", "c"]);
  const refused = { id: "d", run: async () => { throw Object.assign(new Error("bad audio"), { status: 400 }); } };
  await assert.rejects(failover([refused, ok], call), /bad audio/);
});
