// Storage and resume logic for Selects Web, with a Map in place of IndexedDB.
import assert from "node:assert/strict";
import { test } from "node:test";
import { contentKey, createJobStore, memoryBackend, resumePoint } from "./store.js";

const bytes = (n, seed = 1) => {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * 31 + seed) & 255;
  return a;
};

test("content key: same file, same key; a changed byte at either end or another name changes it", async () => {
  const big = bytes(3 * 1024 * 1024);
  const a = await contentKey(new File([big], "talk.mp4", { lastModified: 1 }));
  assert.equal(a, await contentKey(new File([big], "talk.mp4", { lastModified: 1 })));
  assert.match(a, /^v_[0-9a-f]{32}$/);
  const head = big.slice();
  head[10] ^= 1;
  assert.notEqual(a, await contentKey(new File([head], "talk.mp4", { lastModified: 1 })));
  const tail = big.slice();
  tail[tail.length - 5] ^= 1;
  assert.notEqual(a, await contentKey(new File([tail], "talk.mp4", { lastModified: 1 })));
  assert.notEqual(a, await contentKey(new File([big], "other.mp4", { lastModified: 1 })));
  assert.ok(await contentKey(new File([bytes(100)], "tiny.mp4")), "files under 1 MB work");
});

test("resume point follows the finished stages in order", () => {
  assert.deepEqual(resumePoint(null), { from: "probe", done: [] });
  assert.deepEqual(resumePoint({ stages: { probe: "done" } }), { from: "transcribe", done: ["probe"] });
  assert.deepEqual(resumePoint({ stages: { probe: "done", transcribe: "done", candidates: "done" } }).from, "judge");
  assert.equal(resumePoint({ stages: { probe: "done", candidates: "done" } }).from, "transcribe", "a gap means redo from the gap");
  assert.equal(resumePoint({ stages: { probe: "done", transcribe: "done", candidates: "done", judge: "done" } }).from, "ready");
});

test("a job saved stage by stage lists as unfinished, keeps its parts, clips and approvals, and can be removed", async () => {
  const store = createJobStore(memoryBackend());
  const job = { id: "j_1", source: { name: "talk.mp4", size: 1234 }, candidates: [] };
  await store.saveStage("v_a", job, "probe");
  const pcm = new Float32Array([0.1, -0.2, 0.3]);
  await store.saveStage("v_a", job, "transcribe", { words: [{ w: "Hi.", s: 0, e: 0.4 }], events: [], loudness: { step: 0.5, db: [-20] }, pcm });
  let list = await store.list();
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].from, list[0].finished, list[0].name], ["candidates", false, "talk.mp4"]);
  assert.deepEqual(await store.part("v_a", "words"), [{ w: "Hi.", s: 0, e: 0.4 }]);
  assert.deepEqual([...(await store.part("v_a", "pcm"))].map((x) => +x.toFixed(1)), [0.1, -0.2, 0.3]);
  // a person's decisions are saved without a stage
  await store.saveStage("v_a", { ...job, candidates: [{ id: "c_0001", status: "approved", start: 1, end: 30 }] }, null);
  assert.equal((await store.load("v_a")).job.candidates[0].status, "approved");
  assert.equal(resumePoint(await store.load("v_a")).from, "candidates", "saving decisions does not mark stages");
  await store.saveStage("v_a", job, "candidates", { shortlist: [] });
  await store.saveStage("v_a", job, "judge", { judged: [] });
  await store.saveClip("v_a", "c_0001", "shorts", new Blob(["mp4"]));
  assert.deepEqual(await store.clips("v_a"), [{ cid: "c_0001", preset: "shorts" }]);
  list = await store.list();
  assert.equal(list[0].finished, true);
  await store.remove("v_a");
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await store.backend.keys(""), []);
});
