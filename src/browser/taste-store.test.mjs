// Taste answers in the browser, with a Map in place of IndexedDB.
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryBackend } from "./store.js";
import { createTasteStore, TASTE_KEY } from "./taste-store.js";

const cand = (id, hook) => ({ id, start: 0, end: 40, text: "words that must stay out", hook: "words that must stay out", pre: 0.5, scores: { moment: 3, share: 3, hook, standalone: 4 }, total: 0.5 });

test("answers are kept on the device as numbers, replaced when changed, and forgotten on reset", async () => {
  const backend = memoryBackend();
  const t = createTasteStore(backend);
  assert.deepEqual(await t.status(), { n: 0, posts: 0, skips: 0, active: false, weight: 0, need: 8 });
  // quick answers in a row: none is lost
  await Promise.all([t.record("v_1", cand("c_1", 5), "approved"), t.record("v_1", cand("c_2", 1), "skipped"), t.record("v_1", cand("c_3", 2), "skipped")]);
  await t.record("v_1", cand("c_3", 2), "proposed");
  const saved = await backend.get(TASTE_KEY);
  assert.deepEqual(saved.labels.map((x) => [x.k, x.label]), [["v_1:c_1", "post"], ["v_1:c_2", "skip"]]);
  assert.ok(!JSON.stringify(saved).includes("words"), "no words stored");
  for (let i = 0; i < 8; i++) await t.record("v_2", cand(`c_${i}`, i % 2 ? 5 : 1), i % 2 ? "approved" : "skipped");
  const s = await t.status();
  assert.equal(s.n, 10);
  assert.equal(s.active, true);
  const m = await t.model();
  assert.ok(m.w[m.features.indexOf("hook")] > 0, "it learned the hook");
  // a fresh store on the same backend (a reload) reads the same answers
  assert.equal((await createTasteStore(backend).status()).n, 10);
  await t.reset();
  assert.equal((await t.status()).n, 0);
  assert.equal(await backend.get(TASTE_KEY), undefined);
});

test("a store whose backend fails still answers, with no labels", async () => {
  const broken = { get: async () => { throw new Error("blocked"); }, put: async () => { throw new Error("blocked"); }, del: async () => {} };
  const t = createTasteStore(broken);
  assert.equal((await t.status()).n, 0);
  assert.equal((await t.record("v", cand("c", 3), "approved")).n, 1, "kept in memory for this tab");
});
