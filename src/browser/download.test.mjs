// Resumable model downloads: a phone on mobile data loses the connection part way through a
// 140 MB file, and a single long fetch then fails with Safari's "Load failed". These tests
// drive download.js against a fake server that drops connections, ignores ranges or
// changes the file, and check that what arrived is kept and the rest is fetched once.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { DownloadError, memoryStore, resumableDownload } from "./download.js";

const MB = 2 ** 20;

function bytes(n, seed = 7) {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}
const cdn = (r) => Object.defineProperty(r, "url", { value: "https://cdn.example/file?sig=1" });
const sha = (b) => createHash("sha256").update(b).digest("hex");

/**
 * A fake Hugging Face: the resolve URL redirects to a CDN URL; the CDN answers closed byte
 * ranges with 206. `plan` can fail a given request: { at: n, kind: "throw" | "midway" | "status", status }.
 */
function fakeServer(file, { etag = sha(file), ignoreRange = false, fail = [], changeAt = null } = {}) {
  const log = [];
  let n = 0;
  let body = file;
  let tag = etag;
  const fetchImpl = async (url, init = {}) => {
    const i = n++;
    const range = new Headers(init.headers).get("range");
    log.push({ url, range });
    if (changeAt != null && i === changeAt) {
      body = bytes(file.length, 99);
      tag = sha(body);
    }
    const f = fail.find((x) => x.at === i);
    if (f?.kind === "throw") throw new TypeError("Load failed");
    if (f?.kind === "status") return new Response("busy", { status: f.status });
    const m = range && /^bytes=(\d+)-(\d+)$/.exec(range);
    const headers = { etag: `"${tag}"`, "content-type": "application/octet-stream" };
    if (!m || ignoreRange) {
      return cdn(new Response(body.slice(), { status: 200, headers: { ...headers, "content-length": String(body.length) } }));
    }
    const a = +m[1];
    const b = Math.min(+m[2], body.length - 1);
    const part = body.slice(a, b + 1);
    let stream;
    if (f?.kind === "midway") {
      // the connection drops after half of this range has arrived
      const half = part.subarray(0, Math.floor(part.length / 2));
      let sent = false;
      stream = new ReadableStream({
        pull(c) {
          if (!sent) c.enqueue(half), (sent = true);
          else c.error(new TypeError("Load failed"));
        },
      });
    }
    const res = new Response(stream || part, { status: 206, headers: { ...headers, "content-range": `bytes ${a}-${b}/${body.length}`, "content-length": String(part.length) } });
    return cdn(res);
  };
  return { fetchImpl, log, current: () => body };
}

const fast = { sleep: async () => {}, chunkBytes: 1 * MB };
const URL1 = "https://huggingface.co/x/resolve/main/onnx/model.onnx";

test("downloads in closed byte ranges and returns the exact file", async () => {
  const file = bytes(3.5 * MB);
  const srv = fakeServer(file);
  const seen = [];
  const blob = await resumableDownload(URL1, { store: memoryStore(), fetchImpl: srv.fetchImpl, onProgress: (p) => seen.push(p), ...fast });
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), file);
  assert.equal(srv.log.length, 4);
  assert.ok(srv.log.every((r) => /^bytes=\d+-\d+$/.test(r.range)), "never an open-ended range (the CDN answers those with the whole file)");
  assert.equal(seen.at(-1).loaded, file.length);
  assert.equal(seen.at(-1).total, file.length);
});

test("after the first chunk, ranges go straight to the CDN address instead of through the redirect", async () => {
  const srv = fakeServer(bytes(3 * MB));
  await resumableDownload(URL1, { store: memoryStore(), fetchImpl: srv.fetchImpl, ...fast });
  assert.equal(srv.log[0].url, URL1);
  assert.ok(srv.log.slice(1).every((r) => r.url === "https://cdn.example/file?sig=1"));
});

test("a dropped connection keeps what arrived and carries on from there", async () => {
  const file = bytes(4 * MB);
  const srv = fakeServer(file, { fail: [{ at: 2, kind: "midway" }, { at: 3, kind: "throw" }] });
  const blob = await resumableDownload(URL1, { store: memoryStore(), fetchImpl: srv.fetchImpl, ...fast });
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), file);
  // request 2 delivered half a chunk; request 3 failed outright; request 4 resumes mid-chunk
  assert.equal(srv.log[4].range, `bytes=${2.5 * MB}-${3.5 * MB - 1}`);
});

test("a reload resumes from the bytes already stored", async () => {
  const file = bytes(4 * MB);
  const store = memoryStore();
  const first = fakeServer(file, { fail: [{ at: 2, kind: "throw" }, { at: 3, kind: "throw" }, { at: 4, kind: "throw" }] });
  await assert.rejects(resumableDownload(URL1, { store, fetchImpl: first.fetchImpl, retries: 2, ...fast }), (e) => e instanceof DownloadError && e.kind === "network" && e.loaded === 2 * MB && e.total === 4 * MB);
  const again = fakeServer(file);
  const blob = await resumableDownload(URL1, { store, fetchImpl: again.fetchImpl, ...fast });
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), file);
  assert.equal(again.log[0].range, `bytes=${2 * MB}-${3 * MB - 1}`, "the second visit starts where the first stopped");
  assert.equal(again.log.length, 2);
});

test("a finished file is served from the store with no network", async () => {
  const file = bytes(2 * MB);
  const store = memoryStore();
  await resumableDownload(URL1, { store, fetchImpl: fakeServer(file).fetchImpl, ...fast });
  const none = async () => assert.fail("no request expected");
  const blob = await resumableDownload(URL1, { store, fetchImpl: none, ...fast });
  assert.equal(blob.size, file.length);
});

test("a server that ignores ranges still works: the whole file in one response", async () => {
  const file = bytes(3 * MB);
  const srv = fakeServer(file, { ignoreRange: true });
  const blob = await resumableDownload(URL1, { store: memoryStore(), fetchImpl: srv.fetchImpl, ...fast });
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), file);
});

test("a file that changes upstream part way is started again, not stitched together", async () => {
  const file = bytes(3 * MB);
  const srv = fakeServer(file, { changeAt: 1 });
  const blob = await resumableDownload(URL1, { store: memoryStore(), fetchImpl: srv.fetchImpl, ...fast });
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), srv.current());
});

test("a corrupt file (hash differs from the ETag) is deleted and reported", async () => {
  const file = bytes(2 * MB);
  const store = memoryStore();
  const srv = fakeServer(file, { etag: "a".repeat(64) });
  await assert.rejects(resumableDownload(URL1, { store, fetchImpl: srv.fetchImpl, ...fast }), (e) => e.kind === "integrity");
  assert.equal((await store.info(URL1)).bytes, 0);
});

test("server errors are retried with backoff; a 404 is not", async () => {
  const file = bytes(2 * MB);
  const waits = [];
  const srv = fakeServer(file, { fail: [{ at: 1, kind: "status", status: 503 }, { at: 2, kind: "status", status: 503 }] });
  await resumableDownload(URL1, { store: memoryStore(), fetchImpl: srv.fetchImpl, ...fast, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(waits, [1000, 2000]);
  const gone = fakeServer(file, { fail: [{ at: 0, kind: "status", status: 404 }] });
  await assert.rejects(resumableDownload(URL1, { store: memoryStore(), fetchImpl: gone.fetchImpl, ...fast }), (e) => e.kind === "http" && e.status === 404);
  assert.equal(gone.log.length, 1);
});

test("running out of storage stops at once with a quota error", async () => {
  const store = memoryStore({ quotaBytes: 1.5 * MB });
  await assert.rejects(resumableDownload(URL1, { store, fetchImpl: fakeServer(bytes(3 * MB)).fetchImpl, ...fast }), (e) => e.kind === "quota");
});

test("a stop request ends the download with an AbortError", async () => {
  const ctl = new AbortController();
  const srv = fakeServer(bytes(4 * MB));
  const p = resumableDownload(URL1, { store: memoryStore(), fetchImpl: srv.fetchImpl, signal: ctl.signal, ...fast, onProgress: (x) => x.loaded >= 2 * MB && ctl.abort() });
  await assert.rejects(p, (e) => e.name === "AbortError");
});
