// Overnight mode: a persistent queue that runs jobs one at a time.
// The queue lives in <SELECTS_HOME>/queue.json, so closing the terminal, a crash or a
// reboot loses nothing: the next `selects queue run` (or `selects serve`) picks it up, and
// each job resumes from its last finished stage.
import path from "node:path";
import { selectsHome } from "./config.mjs";
import { jobEvents, loadJob, renderJob, resumeJob, runJob } from "./job.mjs";
import { readJson, writeJsonAtomic } from "./util.mjs";

const file = () => path.join(selectsHome(), "queue.json");
const load = () => readJson(file(), { items: [] });
const save = (q) => writeJsonAtomic(file(), q);

/**
 * Add work to the queue. kind "analyze" runs a job to "ready" (transcribe, candidates,
 * judge); kind "render" renders its approved clips.
 * @param {{jobId:string, kind?:"analyze"|"render", ids?:string[], preset?:string}} item
 */
export function enqueue({ jobId, kind = "analyze", ids, preset }) {
  const q = load();
  // the same work already waiting is not added twice; but an item that is running now has
  // already read its list of clips, so a new render request queues behind it
  const waiting = q.items.find((x) => x.jobId === jobId && x.kind === kind && !(current && sameItem(x, current)));
  if (waiting && kind === "render" && (waiting.preset ?? null) === (preset ?? null)) {
    // merge the clip lists: no list means "every approved clip"
    waiting.ids = waiting.ids && ids ? [...new Set([...waiting.ids, ...ids])] : null;
    save(q);
  } else if (!waiting) {
    q.items.push({ key: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, jobId, kind, ids: ids ?? null, preset: preset ?? null, addedAt: new Date().toISOString() });
    save(q);
  }
  jobEvents.emit("queue", queueState());
  return queueState();
}

export function queueState() {
  const q = load();
  return { running: current, items: q.items };
}

let draining = null;
let current = null;

/** One queue item, by its key (items from before keys existed: by job and kind). */
const sameItem = (a, b) => (a.key || b.key ? a.key === b.key : a.jobId === b.jobId && a.kind === b.kind);

/**
 * Work through the queue in order until it is empty. Safe to call repeatedly: only one
 * drain runs at a time. Resolves with the list of finished jobs.
 * @param {{deps?:object, onItem?:(item, job)=>void}} opts
 */
export function drainQueue(opts = {}) {
  if (!draining) draining = drain(opts).finally(() => (draining = null));
  return draining;
}

async function drain({ deps, onItem } = {}) {
  const done = [];
  for (;;) {
    const q = load();
    const item = q.items[0];
    if (!item) break;
    current = item;
    jobEvents.emit("queue", queueState());
    let job;
    try {
      job = loadJob(item.jobId);
      if (item.kind === "render") {
        job = await renderJob(item.jobId, { ids: item.ids ?? undefined, preset: item.preset ?? undefined, deps });
      } else if (job.stage === "ready" || job.stage === "done") {
        // already analysed
      } else if (job.stage === "queued" && Object.values(job.stages).every((s) => s.status === "pending")) {
        job = await runJob(item.jobId, { deps });
      } else {
        job = await resumeJob(item.jobId, { deps });
      }
    } catch (e) {
      job = { id: item.jobId, stage: "error", error: { message: e.message, hint: e.hint } };
    }
    // remove this item (by its key: the file may have changed while it ran, and a render
    // request for the same job may have queued behind it)
    const after = load();
    after.items = after.items.filter((x) => !sameItem(x, item));
    save(after);
    current = null;
    done.push(job);
    onItem?.(item, job);
    jobEvents.emit("queue", queueState());
  }
  return done;
}
