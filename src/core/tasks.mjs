// Model tasks without Node imports: what to send for a judge, listwise or posting-kit call,
// and how to read the answer, for runtimes other than Ollama: Gemma in the browser
// (src/browser) and Gemma through the Gemini API (src/browser and server-proxy). Ollama's
// path (judge.mjs, kit.mjs) builds the same messages from the same prompt files.
//
// A task is { kind: "judge", candidate } | { kind: "listwise", top } | { kind: "kit", candidate }
// | { kind: "judgeBatch", candidates } (Smart mode: the whole shortlist in one call, each
// clip still scored on its own with the same rubric)
// | { kind: "faithful", candidate, before, after, hints } (does the cut keep what the speaker
// meant? before/after are the sentences around the clip, hints from faithfulHints)
// | { kind: "pair", a, b } (the head-to-head round: which of two clips to post first, a shown
// first; h2h-core.mjs).
// prompts is { judge, listwise, kit, faithful, pairwise }: the text of the files in src/core/prompts.
import { hasScores, JUDGE_MAX_TOKENS, JUDGE_SCHEMA, judgeMessages, judgeText, listMessages, listSchema, parseListAnswer, salvageJudge, splitPrompt } from "./judge-core.mjs";
import { cleanKit, KIT_SCHEMA, kitMessages, kitSchema } from "./kit-core.mjs";
import { MADE_FOR, madeForBlock } from "./madefor.mjs";
import { FAITHFUL_SCHEMA, faithfulMessages, faithfulPrompt, readFaithful } from "./faithful-core.mjs";
import { PAIR_MAX_TOKENS, PAIR_SCHEMA, pairMessages, parsePairAnswer } from "./h2h-core.mjs";

/** Output budgets, as on the desktop (num_predict): 100 for a judge call, 40 + 30 per clip for the round, 120 for a kit. */
export function maxTokensFor(task) {
  if (task.kind === "judge") return JUDGE_MAX_TOKENS;
  if (task.kind === "judgeBatch") return 40 + (JUDGE_MAX_TOKENS - 10) * task.candidates.length;
  if (task.kind === "listwise") return 40 + 30 * task.top.length;
  if (task.kind === "faithful") return 130;
  if (task.kind === "pair") return PAIR_MAX_TOKENS;
  return 120;
}

export const lettersFor = (top) => top.map((_, i) => String.fromCharCode(65 + i));

/** { messages, schema, maxTokens } for a task. */
export function buildTask(task, prompts) {
  if (task.kind === "judge") return { messages: judgeMessages(splitPrompt(prompts.judge, "prompts/judge.md"), task.candidate, { extra: MADE_FOR[task.madeFor]?.storyJudge ? madeForBlock(prompts.judge, task.madeFor) : "" }), schema: JUDGE_SCHEMA, maxTokens: maxTokensFor(task) };
  if (task.kind === "listwise") return { messages: listMessages(splitPrompt(prompts.listwise, "prompts/listwise.md"), task.top), schema: listSchema(lettersFor(task.top)), maxTokens: maxTokensFor(task) };
  if (task.kind === "kit") return { messages: kitMessages(prompts.kit, task.candidate, { madeFor: task.madeFor }), schema: task.madeFor ? kitSchema(task.madeFor) : KIT_SCHEMA, maxTokens: task.madeFor === "linkedin" ? 200 : maxTokensFor(task) };
  if (task.kind === "faithful") return { messages: faithfulMessages(faithfulPrompt(prompts.faithful), { text: task.candidate.text, before: task.before, after: task.after, hints: task.hints }), schema: FAITHFUL_SCHEMA, maxTokens: maxTokensFor(task) };
  if (task.kind === "judgeBatch") return { messages: batchMessages(storyPrompt(prompts.judge, task.madeFor), task.candidates), schema: batchSchema(lettersFor(task.candidates)), maxTokens: maxTokensFor(task) };
  if (task.kind === "pair") return { messages: pairMessages(splitPrompt(prompts.pairwise, "prompts/pairwise.md"), task.a, task.b), schema: PAIR_SCHEMA, maxTokens: maxTokensFor(task) };
  throw new Error(`unknown task kind ${task.kind}`);
}

/** The split judge prompt, with the story preset's extra line added to the system part. */
function storyPrompt(md, madeFor) {
  const p = splitPrompt(md, "prompts/judge.md");
  return MADE_FOR[madeFor]?.storyJudge ? { ...p, system: `${p.system}\n\n${madeForBlock(md, madeFor)}` } : p;
}

/**
 * The judge rubric over several clips in one call: the same system prompt, told that each
 * clip is scored on its own, and the clips lettered A, B, C with their lengths.
 */
export function batchMessages(prompt, cands) {
  const blocks = cands.map((c, i) => `Clip ${String.fromCharCode(65 + i)}, ${Math.round(c.end - c.start)} seconds:\n${judgeText(c)}`);
  return [
    { role: "system", content: `${prompt.system}\n\nYou will see several clips. Score each one on its own, as if it were the only clip, and give each its own why and watch.` },
    { role: "user", content: `${blocks.join("\n\n")}\n\nScore every clip, as JSON.` },
  ];
}

export function batchSchema(letters) {
  const item = { ...JUDGE_SCHEMA, properties: { clip: { type: "string", enum: letters }, ...JUDGE_SCHEMA.properties }, required: ["clip", ...JUDGE_SCHEMA.required] };
  return { type: "object", properties: { clips: { type: "array", minItems: letters.length, maxItems: letters.length, items: item } }, required: ["clips"] };
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
 *   judge    -> { moment, share, hook, standalone, why, watch, truncated? } (or an answer in the
 *               earlier rubric's shape) or null when the scores are missing
 *   listwise -> { order: letters[], reasons: {letter: text}, complete }
 *   kit      -> { title, caption, hashtags }
 *   pair     -> { first: "A"|"B", why } or null when no choice can be read
 */
export function readTask(task, { data, text }) {
  const obj = data && typeof data === "object" ? data : extractJson(text);
  if (task.kind === "judge") {
    if (hasScores(obj)) return obj;
    return salvageJudge(text ?? JSON.stringify(data ?? ""));
  }
  if (task.kind === "listwise") return parseListAnswer(obj?.ranking ? obj : String(text ?? ""), lettersFor(task.top));
  if (task.kind === "kit") return cleanKit(obj || {}, { madeFor: task.madeFor });
  if (task.kind === "faithful") return readFaithful(obj || String(text ?? ""), task.hints || []); // null when there is no verdict
  if (task.kind === "pair") return (obj && parsePairAnswer(obj)) || parsePairAnswer(String(text ?? ""));
  if (task.kind === "judgeBatch") {
    // { byLetter: { A: { moment, share, hook, standalone, why, watch } } }; clips the answer left out are missing
    const letters = lettersFor(task.candidates);
    const byLetter = {};
    const items = Array.isArray(obj?.clips) ? obj.clips : [];
    for (const it of items) {
      const l = String(it?.clip || "").trim().toUpperCase();
      if (letters.includes(l) && hasScores(it)) byLetter[l] = it;
    }
    if (!items.length) {
      // a cut-off answer: salvage each complete clip object
      for (const m of String(text ?? "").matchAll(/\{[^{}]*"clip"\s*:\s*"([A-Z])"[^{}]*\}/g)) {
        const s = salvageJudge(m[0]);
        if (s && letters.includes(m[1])) byLetter[m[1]] = s;
      }
    }
    return { byLetter, complete: letters.every((l) => byLetter[l]) };
  }
  throw new Error(`unknown task kind ${task.kind}`);
}

/**
 * Check a structured task sent to a server (server-proxy): only clip text and timings, of
 * bounded size. Returns null when it is fine, or a reason when it is not.
 */
export function checkTaskShape(task, { maxChars = 3000, maxClips = 6 } = {}) {
  if (!task || typeof task !== "object") return "body must be a JSON object";
  const clip = (c) => c && typeof c === "object" && typeof c.text === "string" && c.text.trim() && c.text.length <= maxChars && (c.cueText == null || (typeof c.cueText === "string" && c.cueText.length <= maxChars * 1.2)) && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.end - c.start <= 600;
  if (task.kind === "judge" || task.kind === "kit") return clip(task.candidate) ? null : "candidate must be { text, start, end } with at most 3000 characters";
  if (task.kind === "faithful") {
    if (!clip(task.candidate)) return "candidate must be { text, start, end } with at most 3000 characters";
    const side = (s) => s == null || (typeof s === "string" && s.length <= 1000);
    return side(task.before) && side(task.after) ? null : "before and after must be one sentence each (at most 1000 characters) or null";
  }
  if (task.kind === "judgeBatch") {
    if (!Array.isArray(task.candidates) || task.candidates.length < 1 || task.candidates.length > 8) return "candidates must hold 1 to 8 clips";
    return task.candidates.every(clip) ? null : "each clip must be { text, start, end } with at most 3000 characters";
  }
  if (task.kind === "pair") return clip(task.a) && clip(task.b) ? null : "a and b must each be { text, start, end } with at most 3000 characters";
  if (task.kind === "listwise") {
    if (!Array.isArray(task.top) || task.top.length < 2 || task.top.length > maxClips) return `top must hold 2 to ${maxClips} clips`;
    return task.top.every((c) => clip(c) && typeof c.hook === "string" && c.hook.length <= maxChars) ? null : "each clip must be { text, hook, start, end }";
  }
  return "kind must be judge, judgeBatch, listwise, pair, kit or faithful";
}

/**
 * Only the fields a task needs, so nothing else from a job ever leaves the device. cueText is
 * the clip's own words with "(laughter)" and "(louder)" marks (delivery.mjs), when it has any.
 */
export function slimTask(task) {
  const c = (x) => ({ text: x.text, hook: x.hook, start: x.start, end: x.end, ...(typeof x.cueText === "string" && x.cueText ? { cueText: x.cueText } : {}) });
  if (task.kind === "listwise") return { kind: "listwise", top: task.top.map(c) };
  if (task.kind === "pair") return { kind: "pair", a: c(task.a), b: c(task.b) };
  if (task.kind === "judgeBatch") return { kind: "judgeBatch", candidates: task.candidates.map(c), ...(task.madeFor ? { madeFor: task.madeFor } : {}) };
  if (task.kind === "faithful") return { kind: "faithful", candidate: c(task.candidate), before: task.before ?? null, after: task.after ?? null, hints: (task.hints || []).map((h) => ({ issue: h.issue, cue: h.cue })) };
  return { kind: task.kind, candidate: c(task.candidate), ...(task.madeFor ? { madeFor: task.madeFor } : {}) };
}

/**
 * A one-line description of the answer's JSON shape, appended to the user message for
 * runtimes that cannot force a schema (MediaPipe in the browser, or a Gemini model that
 * refuses JSON mode). Example: {"hook": 1-5, ..., "reason": "text"}.
 */
export function schemaHint(schema) {
  const show = (s) => {
    if (!s) return '"text"';
    if (s.type === "integer") return s.minimum != null && s.maximum != null ? `${s.minimum}-${s.maximum}` : "0";
    if (s.type === "string") return s.enum ? s.enum.map((e) => `"${e}"`).join(" or ") : '"text"';
    if (s.type === "array") return `[${show(s.items)}, ...]`;
    if (s.type === "object") return `{${Object.entries(s.properties || {}).map(([k, v]) => `"${k}": ${show(v)}`).join(", ")}}`;
    return "null";
  };
  return `Answer with only this JSON, nothing before or after it: ${show(schema)}`;
}

/** The task's messages with the JSON-shape line added to the user turn. */
export function withSchemaHint(messages, schema) {
  return messages.map((m, i) => (i === messages.length - 1 && m.role === "user" ? { ...m, content: `${m.content}\n\n${schemaHint(schema)}` } : m));
}
