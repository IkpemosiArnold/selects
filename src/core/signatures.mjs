// Versioned signatures of what each computed result was made from, shared by the desktop job
// (job.mjs) and the browser engine (src/browser/engine.js). A saved result is reused only
// when the signature of its inputs matches the one the current settings would produce:
//
//   transcript   the source, the speech model, its precision and device, the language, the prompt
//   selection    the transcript's own content (hashed), the length range, the stride, how many
//                windows the judge reads, the stretches kept out (whisper loops)
//   judgment     the selection, the judge backend and model, the prompt files it reads, and
//                every setting that changes a score, the side-by-side round, the faithful check
//                or the ranking
//   kit          the text the kit is written from (the edited captions when there are any), the
//                kit prompt, the platform and the kit mode
//
// Each stage chains the one before it, so a new transcript changes everything after it, while
// a new judge model leaves the transcript and the selection alone. Human decisions (approvals,
// trims, faithful accepts) are not part of any signature: they are kept on their own
// (decisions.mjs) and put back on whatever the judge produces next.
// Pure and browser-safe: no Node imports.
import { MADE_FOR } from "./madefor.mjs";
import { judgeCount } from "./select.mjs";

/** Bump one of these when the code that computes that stage changes what it produces. */
export const SIG_VERSIONS = { transcript: 1, selection: 1, judgment: 1, kit: 1 };

/** A 64-bit string hash (two cyrb53 lanes), as 16 hex characters. Not cryptographic; it only has to notice change. */
export function hashText(str) {
  const s = String(str ?? "");
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** JSON with object keys sorted, so the same inputs always give the same text. */
export function stableStringify(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

export const digest = (v) => hashText(stableStringify(v));
const sig = (stage, inputs) => `${stage}@${SIG_VERSIONS[stage]}:${digest(inputs)}`;

/** The transcript's content: every word with its times, the non-speech events, the loudness track. */
export function transcriptHash({ words = [], events = [], loudness = null } = {}) {
  const w = (words || []).map((x) => `${x.w}|${x.s}|${x.e}`).join("\n");
  const ev = (events || []).map((x) => `${x.type}|${x.s}|${x.e}`).join("\n");
  const db = loudness?.db ? `${loudness.step}|${loudness.db.map((d) => Math.round(d * 10)).join(",")}` : "";
  return hashText(`${w}\n--\n${ev}\n--\n${db}`);
}

/**
 * What a transcript was made from.
 * @param {{ source: string, model: string, language?: string, device?: string|null, dtype?: object|null,
 *           prompt?: string|null, preprocess?: string|null, audioStream?: number|null }} o
 */
export function transcriptSignature({ source, model, language = "en", device = null, dtype = null, prompt = null, preprocess = null, audioStream = null }) {
  return sig("transcript", { source, model, language, device, dtype, prompt, preprocess, audioStream });
}

/**
 * What a shortlist was made from. `transcript` is transcriptHash of the words it was built on;
 * the window count is the effective one (judgeCount), so an auto count that was then saved as
 * a number signs the same.
 */
export function selectionSignature({ transcript, settings = {}, duration = null, exclude = [], secPerCall = null }) {
  const n = judgeCount({ k: settings.k ?? null, duration, judgeN: settings.judgeN ?? null, secPerCall, budgetSec: settings.judgeBudgetSec ?? undefined }).n;
  return sig("selection", {
    transcript,
    minLen: settings.minLen ?? 20,
    maxLen: settings.maxLen ?? 60,
    stride: settings.stride ?? 6,
    n,
    duration: duration == null ? null : Math.round(duration * 10) / 10,
    exclude: (exclude || []).map((x) => [x.s, x.e]),
  });
}

/** One hash per prompt file, for the kinds a stage reads. */
export function promptsHash(prompts = {}, kinds = []) {
  return Object.fromEntries(kinds.map((k) => [k, hashText(prompts[k] ?? "")]));
}

/** Which judge made a judgment: { backend, model }. For a backend, its configured model, not one learned after loading. */
export const judgeIdentity = (llm) => ({ backend: llm?.id ?? "none", model: llm?.sigModel ?? llm?.model ?? null });

/**
 * What a judgment (scores, the side-by-side round, faithful checks, ranking, quality bar) was
 * made from.
 * @param {{ selection: string, judge: {backend:string, model:string|null}, prompts: object, settings: object }} o
 */
export function judgmentSignature({ selection, judge, prompts = {}, settings = {} }) {
  const madeFor = settings.madeFor || "shorts";
  return sig("judgment", {
    selection,
    backend: judge?.backend ?? "none",
    model: judge?.model ?? null,
    prompts: promptsHash(prompts, ["judge", "listwise", "faithful"]),
    // only the story preset changes what the judge is told
    judgeAs: MADE_FOR[madeFor]?.storyJudge ? madeFor : "default",
    listwise: settings.listwise !== false,
    listN: settings.listN ?? 4,
    faithful: settings.faithful ?? "model",
    maxLen: settings.maxLen ?? 60,
    k: settings.k ?? 5,
    smartBatch: !!settings.smartBatch,
  });
}

/**
 * What a posting kit was written from. Which model wrote it is recorded beside it (madeBy),
 * not signed: switching between Private and Smart mode does not rewrite kits a person may
 * already have copied, but a caption fix inside the clip does.
 * @param {{ source: {text:string, hook:string}, mode: "model"|"plain", madeFor?: string, prompts?: object }} o
 */
export function kitSignature({ source, mode = "model", madeFor = "shorts", prompts = {} }) {
  return sig("kit", { text: source?.text ?? "", hook: source?.hook ?? "", mode, madeFor, prompt: mode === "plain" ? null : hashText(prompts.kit ?? "") });
}

/**
 * The cache key for one model call: the backend and model plus the exact messages, schema and
 * output budget the task builds to (buildTask from tasks.mjs), so two tasks share an answer
 * only when the model would see the same thing.
 */
export function taskKey(judge, built) {
  return `${judge.backend}|${judge.model}|${digest(built)}`;
}
