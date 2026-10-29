// Taste labels in the browser: the person's Post and Skip answers, kept in this browser's
// IndexedDB (the job store's backend, one key), never uploaded. Each answer keeps only the
// numbers its clip was ranked on (src/core/taste.mjs), not words or audio. The model is fitted
// again in the tab whenever the answers change; that takes milliseconds.
import { labelForStatus, labelRecord, tasteStatus, tasteSummary, trainTaste, upsertLabel } from "../core/taste.mjs";

export const TASTE_KEY = "taste:labels";

/** backend: { get, put, del } (store.js memoryBackend or indexedDbBackend). */
export function createTasteStore(backend) {
  let labels = null;
  let model = null;
  let queue = Promise.resolve();
  const load = async () => {
    if (labels) return labels;
    try {
      const v = await backend.get(TASTE_KEY);
      labels = Array.isArray(v?.labels) ? v.labels : [];
    } catch {
      labels = [];
    }
    return labels;
  };
  const save = async () => {
    model = null;
    try {
      await backend.put(TASTE_KEY, { v: 1, labels });
    } catch {}
  };
  // one change at a time, so two quick answers never overwrite each other
  const serial = (fn) => (queue = queue.then(fn, fn));
  return {
    /** Record a review decision: approved is a Post, skipped a Skip, proposed takes it back. */
    record(job, c, status, { by = "review" } = {}) {
      return serial(async () => {
        await load();
        const label = labelForStatus(status);
        labels = upsertLabel(labels, label ? labelRecord(job, c, label, { by }) : { k: `${job}:${c.id}`, label: null });
        await save();
        return tasteStatus(labels);
      });
    },
    /** The fitted model (cached until the answers change). */
    async model() {
      await queue;
      await load();
      return (model ??= trainTaste(labels));
    },
    /** { n, posts, skips, active, weight, need }. */
    async status() {
      return tasteSummary(await this.model());
    },
    async reset() {
      return serial(async () => {
        labels = [];
        await save();
        try {
          await backend.del(TASTE_KEY);
        } catch {}
        return tasteStatus([]);
      });
    },
    /** The raw answers (for tests and an export). */
    async labels() {
      await queue;
      return [...(await load())];
    },
  };
}
