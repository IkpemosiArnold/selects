// Fakes for testing the browser engine in Node: a judge backend that answers every task kind
// with valid JSON and records its calls, a renderer that returns a tiny MP4 at once, and a
// store seeded as if the video had been probed and transcribed. Tests only.
import { lettersFor } from "../core/tasks.mjs";
import { talk } from "../core/test/fixtures.mjs";
import { contentKey, createJobStore, memoryBackend } from "./store.js";

export const WORDS = talk(120); // about 6 minutes of speech
export const DURATION = WORDS[WORDS.length - 1].e + 1;

/** A judge backend. gates: { kit: Promise } holds that kind's calls until it resolves; fail: kinds that throw. */
export function fakeBackend({ id = "fake-device", model = "fake-1", where = "device", cached = true, failLoad = null, gates = {}, fail = [] } = {}) {
  const calls = [];
  const b = {
    id,
    label: `${model} (fake)`,
    model,
    sigModel: model,
    where,
    bytes: 1000,
    loads: 0,
    calls,
    async isCached() {
      return cached;
    },
    async load() {
      if (failLoad) throw failLoad;
      b.loads++;
      b.loaded = true;
    },
    async run(task) {
      calls.push(task);
      if (gates[task.kind]) await gates[task.kind];
      if (fail.includes(task.kind)) throw Object.assign(new Error(`${task.kind} failed`), { status: 503 });
      return { data: null, text: JSON.stringify(answer(task)), stats: { wallSec: 0 } };
    },
    count: (kind) => calls.filter((t) => t.kind === kind).length,
  };
  return b;
}

function answer(task) {
  if (task.kind === "judge") {
    const n = task.candidate.text.length;
    const s = (k) => 1 + ((n * k) % 5);
    return { hook: s(7), standalone: s(11), payoff: s(13), clarity: s(17), reason: "Opens on a claim and resolves it." };
  }
  if (task.kind === "listwise") return { ranking: lettersFor(task.top).map((l) => ({ clip: l, reason: `Clip ${l} lands its point.` })) };
  if (task.kind === "faithful") return { clip_says: "x", speaker_means: "x", verdict: "faithful", issue: "none", extend: "none", note: "Keeps what the speaker meant." };
  if (task.kind === "kit") return { title: `About: ${task.candidate.hook}`.slice(0, 60), caption: task.candidate.text, hashtags: ["talks", "ideas", "learning"] };
  throw new Error(`no fake answer for ${task.kind}`);
}

/** A renderer that returns at once (or when `gate` resolves). */
export function fakeRender({ gate = null } = {}) {
  const seen = [];
  const fn = async (input, { onProgress } = {}) => {
    seen.push(input);
    onProgress?.({ progress: 0.5 });
    if (gate) await gate;
    return { mp4: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), srt: "1\n00:00:00,000 --> 00:00:01,000\nHi\n", wallSec: 0.1, frames: 10, reframe: "centre", audioCodec: "mp4a.40.2" };
  };
  fn.seen = seen;
  return fn;
}

/** A video file, a store with its probe and transcript saved, and the content key. */
export async function seeded(Engine, { settings = {}, words = WORDS } = {}) {
  const store = createJobStore(memoryBackend());
  const file = new File([new Uint8Array(4096).fill(7)], "talk.mp4", { lastModified: 1 });
  const key = await contentKey(file);
  const job = new Engine({ store }).newJob(file, settings);
  job.source = { ...job.source, duration: DURATION, width: 1920, height: 1080, uprightWidth: 1920, uprightHeight: 1080, fps: 25, audioStreams: [{ channels: 2 }] };
  for (const s of ["probe", "transcribe"]) Object.assign(job.stages[s], { status: "done", progress: 1 });
  await store.saveStage(key, job, "probe");
  await store.saveStage(key, job, "transcribe", { words, events: [], loudness: null });
  return { store, file, key };
}

/** An engine on that store with this judge, its job created and run to the end. */
export async function runOnce(Engine, { store, file }, backend, settings = {}, extra = {}) {
  const engine = new Engine({ store, getJudge: async () => backend, render: extra.render || fakeRender(), ...extra });
  const job = await engine.createJob(file, settings);
  await engine.idle(job.id);
  return { engine, job: engine.getJob(job.id) };
}
