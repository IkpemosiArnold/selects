// Model tasks without Node imports: what to send for a judge, listwise or posting-kit call,
// and how to read the answer, for runtimes other than Ollama: Gemma in the browser
// (src/browser) and Gemma through the Gemini API (src/browser and server-proxy). Ollama's
// path (judge.mjs, kit.mjs) builds the same messages from the same prompt files.
//
// A task is { kind: "judge", candidate } | { kind: "listwise", top } | { kind: "kit", candidate }.
// prompts is { judge, listwise, kit }: the text of the three files in src/core/prompts.
import { JUDGE_SCHEMA, judgeMessages, listMessages, listSchema, parseListAnswer, salvageJudge, splitPrompt } from "./judge-core.mjs";
import { cleanKit, KIT_SCHEMA, kitMessages } from "./kit-core.mjs";

/** Output budgets, as on the desktop (num_predict): 80 for a judge call, 40 + 30 per clip for the round, 120 for a kit. */
export function maxTokensFor(task) {
  if (task.kind === "judge") return 80;
  if (task.kind === "listwise") return 40 + 30 * task.top.length;
  return 120;
}

export const lettersFor = (top) => top.map((_, i) => String.fromCharCode(65 + i));

/** { messages, schema, maxTokens } for a task. */
export function buildTask(task, prompts) {
  if (task.kind === "judge") return { messages: judgeMessages(splitPrompt(prompts.judge, "prompts/judge.md"), task.candidate), schema: JUDGE_SCHEMA, maxTokens: maxTokensFor(task) };
  if (task.kind === "listwise") return { messages: listMessages(splitPrompt(prompts.listwise, "prompts/listwise.md"), task.top), schema: listSchema(lettersFor(task.top)), maxTokens: maxTokensFor(task) };
  if (task.kind === "kit") return { messages: kitMessages(prompts.kit, task.candidate), schema: KIT_SCHEMA, maxTokens: maxTokensFor(task) };
  throw new Error(`unknown task kind ${task.kind}`);
}

/**
 * The first JSON object in a model's text: small models without constrained decoding
 * often wrap it in ```json fences or add a sentence around it. Returns the parsed object,
 * or null.
 */
export function extractJson(text) {
  const t = String(text ?? "").replace(/```(?:json)?/gi, "");
  const start = t.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(t.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Read a task's answer (parsed data or raw text).
 *   judge    -> { hook, standalone, payoff, clarity, reason, truncated? } or null when the scores are missing
 *   listwise -> { order: letters[], reasons: {letter: text}, complete }
 *   kit      -> { title, caption, hashtags }
 */
export function readTask(task, { data, text }) {
  const obj = data && typeof data === "object" ? data : extractJson(text);
  if (task.kind === "judge") {
    if (obj && ["hook", "standalone", "payoff", "clarity"].every((k) => Number.isFinite(Number(obj[k])))) return obj;
    return salvageJudge(text ?? JSON.stringify(data ?? ""));
  }
  if (task.kind === "listwise") return parseListAnswer(obj?.ranking ? obj : String(text ?? ""), lettersFor(task.top));
  if (task.kind === "kit") return cleanKit(obj || {});
  throw new Error(`unknown task kind ${task.kind}`);
}

/**
 * Check a structured task sent to a server (server-proxy): only clip text and timings, of
 * bounded size. Returns null when it is fine, or a reason when it is not.
 */
export function checkTaskShape(task, { maxChars = 3000, maxClips = 6 } = {}) {
  if (!task || typeof task !== "object") return "body must be a JSON object";
  const clip = (c) => c && typeof c === "object" && typeof c.text === "string" && c.text.trim() && c.text.length <= maxChars && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.end - c.start <= 600;
  if (task.kind === "judge" || task.kind === "kit") return clip(task.candidate) ? null : "candidate must be { text, start, end } with at most 3000 characters";
  if (task.kind === "listwise") {
    if (!Array.isArray(task.top) || task.top.length < 2 || task.top.length > maxClips) return `top must hold 2 to ${maxClips} clips`;
    return task.top.every((c) => clip(c) && typeof c.hook === "string" && c.hook.length <= maxChars) ? null : "each clip must be { text, hook, start, end }";
  }
  return "kind must be judge, listwise or kit";
}

/** Only the fields a task needs, so nothing else from a job ever leaves the device. */
export function slimTask(task) {
  const c = (x) => ({ text: x.text, hook: x.hook, start: x.start, end: x.end });
  if (task.kind === "listwise") return { kind: "listwise", top: task.top.map(c) };
  return { kind: task.kind, candidate: c(task.candidate) };
}
