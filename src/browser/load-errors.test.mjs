// What a person sees when the speech model cannot load: a plain cause and the next step,
// never Safari's bare "Load failed".
import assert from "node:assert/strict";
import { test } from "node:test";
import { explainModelError } from "./load-errors.js";

const MB = 1e6;

test("Safari's bare fetch failure reads as a dropped connection, with what is saved", () => {
  const e = explainModelError({ name: "TypeError", message: "Load failed", loaded: 38 * MB, total: 140 * MB });
  assert.equal(e.kind, "network");
  assert.doesNotMatch(e.message, /Load failed/);
  assert.match(e.hint, /38 of 140 MB/);
  assert.match(e.hint, /Try again/);
});

test("every browser's network failure wording is a network failure", () => {
  for (const message of ["Load failed", "Failed to fetch", "NetworkError when attempting to fetch resource.", "The network connection was lost.", "The Internet connection appears to be offline.", "network error"]) {
    assert.equal(explainModelError({ name: "TypeError", message }).kind, "network", message);
  }
  assert.equal(explainModelError({ name: "DownloadError", kind: "network", message: "The connection dropped 9 times in a row." }).kind, "network");
  // ONNX Runtime's own module failing to arrive is a network failure, not an unsupported browser
  assert.equal(explainModelError({ name: "Error", message: "no available backend found. ERR: [wasm] TypeError: Importing a module script failed." }).kind, "network");
  assert.equal(explainModelError({ name: "Error", message: "no available backend found. ERR: [wasm] TypeError: Failed to fetch dynamically imported module: https://x/ort.mjs" }).kind, "network");
});

test("nothing saved yet: no promise of resuming from a part", () => {
  const e = explainModelError({ name: "TypeError", message: "Load failed" });
  assert.doesNotMatch(e.hint, /of .* MB/);
});

test("storage full says how to make room", () => {
  for (const err of [{ name: "QuotaExceededError", message: "The quota has been exceeded." }, { name: "DownloadError", kind: "quota", message: "x" }]) {
    const e = explainModelError(err, { sizeBytes: 140 * MB });
    assert.equal(e.kind, "quota");
    assert.match(e.hint, /Free up space or add Selects to your Home Screen/);
  }
});

test("memory failures suggest a shorter video or the smaller model", () => {
  for (const message of ["Out of memory", "RangeError: Array buffer allocation failed", "Aborted(OOM)", "std::bad_alloc", "Can't create a session. failed to allocate a buffer"]) {
    const e = explainModelError({ name: "Error", message });
    assert.equal(e.kind, "memory", message);
    assert.match(e.message, /ran out of memory/);
    assert.match(e.hint, /shorter video or the smaller speech model/);
  }
});

test("blocked by the browser (CORS, isolation) is said plainly", () => {
  const e = explainModelError({ name: "SecurityError", message: "Cross-origin resource sharing denied" });
  assert.equal(e.kind, "blocked");
});

test("a damaged download, a missing file and an unsupported browser each have their own words", () => {
  assert.equal(explainModelError({ name: "DownloadError", kind: "integrity", message: "x" }).kind, "integrity");
  const http = explainModelError({ name: "DownloadError", kind: "http", status: 503, message: "x" });
  assert.equal(http.kind, "http");
  assert.match(http.message, /503/);
  assert.equal(explainModelError({ name: "Error", message: "no available backend found. ERR: [wasm] RuntimeError: unreachable" }).kind, "unsupported");
  assert.equal(explainModelError({ name: "Error", message: "WebAssembly is not defined" }).kind, "unsupported");
});

test("an unknown error keeps its own words, without a raw 'Load failed' anywhere", () => {
  const e = explainModelError({ name: "Error", message: "Something odd" });
  assert.equal(e.kind, "other");
  assert.match(e.message, /Something odd/);
});

test("no em dashes in any copy", () => {
  const all = [
    { name: "TypeError", message: "Load failed", loaded: 1, total: 2 },
    { name: "QuotaExceededError", message: "" },
    { name: "Error", message: "Out of memory" },
    { name: "SecurityError", message: "" },
    { name: "DownloadError", kind: "integrity", message: "" },
    { name: "DownloadError", kind: "http", status: 404, message: "" },
    { name: "Error", message: "no available backend found" },
    { name: "Error", message: "x" },
  ].map((x) => explainModelError(x, { sizeBytes: 140 * MB }));
  for (const e of all) assert.doesNotMatch(e.message + e.hint, /—/);
});
