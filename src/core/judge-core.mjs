// The judge's pure parts, with no Node imports: rubric weights and the blend, the JSON
// schemas, prompt building from the prompt files' text, answer parsing and salvage, and the
// listwise round's maths. judge.mjs (Ollama, the CLI and server) and the browser build
// (src/browser: Gemma in the tab, or Gemma through the Gemini API) share them.

/**
 * Weights for the combined score. For a short, the first two seconds decide whether
 * anyone watches at all, so the hook carries the most weight. A clip that needs earlier
 * context fails every viewer who did not see the talk, which is nearly all of them, so
 * standalone comes next. Payoff decides whether people finish, rewatch and share, which
 * matters but only for viewers the hook already kept. Clarity is partly covered by the
 * other three (filler weakens the hook and the payoff), so it carries the least.
 */
export const WEIGHTS = { hook: 0.35, standalone: 0.3, payoff: 0.2, clarity: 0.15 };

/**
 * The total a candidate is ranked by blends the judge with the cheap pre-score. On the
 * first real run, a small model put most clips on the same middle scores (three of eight
 * tied at 0.675), so the ranking came down to tie-breaks on list order. The pre-score is
 * independent evidence (hook phrases, pace, loudness), so it breaks those ties on
 * something measured. The judge still carries most of the weight.
 */
export const BLEND = { judge: 0.7, pre: 0.3 };
/** How much the listwise final round can move a clip (best of the round +0.15 x 1, last +0). */
export const LIST_WEIGHT = 0.15;

export function blend(judgeTotal, pre) {
  if (typeof pre !== "number") return judgeTotal;
  return +(BLEND.judge * judgeTotal + BLEND.pre * pre).toFixed(3);
}

/** Combine 1..5 scores into 0..1. */
export function combine(scores) {
  let sum = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) sum += w * clamp(scores[k]);
  return Math.max(0, +((sum - 1) / 4).toFixed(3)) + 0; // + 0 turns -0 into 0
}

export const clamp = (n) => Math.max(1, Math.min(5, Math.round(Number(n) || 1)));

// Scores first, reason last: if the model runs past num_predict, only the reason is cut
// and salvageJudge() can still read the four scores. (Gemma ignores maxLength, so a
// reason-first answer ran out of tokens before the scores in the first real run.)
export const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    hook: { type: "integer", minimum: 1, maximum: 5 },
    standalone: { type: "integer", minimum: 1, maximum: 5 },
    payoff: { type: "integer", minimum: 1, maximum: 5 },
    clarity: { type: "integer", minimum: 1, maximum: 5 },
    reason: { type: "string", maxLength: 140 },
  },
  required: ["hook", "standalone", "payoff", "clarity", "reason"],
};

/**
 * Read scores and as much of the reason as there is from a JSON answer that was cut off.
 * Returns null unless all four scores are present.
 */
export function salvageJudge(text) {
  const out = {};
  for (const k of ["hook", "standalone", "payoff", "clarity"]) {
    const m = String(text).match(new RegExp(`"${k}"\\s*:\\s*([1-5])`));
    if (!m) return null;
    out[k] = +m[1];
  }
  const r = String(text).match(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)/);
  let reason = r ? r[1].replace(/\\"/g, '"') : "";
  // models sometimes close the string with a curly quote and then ramble on
  reason = reason.split(/[\u201d"]\s*[}\n]|\n/)[0].replace(/[\u201d]$/, "").trim();
  if (/[.!?][\u201d']?$/.test(reason)) reason = reason.replace(/[\u201d']$/, "");
  if (reason && !/[.!?]$/.test(reason)) {
    const ws = reason.split(/\s+/).slice(0, -1); // the last word may be cut in half
    while (ws.length && /^(the|a|an|at|of|to|and|but|or|with|for|in|on|into|from|by|that|which|is|was|its|their|this)$/i.test(ws[ws.length - 1].replace(/[,;:]$/, ""))) ws.pop();
    reason = ws.join(" ").replace(/[,;:]$/, "");
  }
  out.reason = reason;
  out.truncated = true;
  return out;
}

/** Split a prompt file into its <!-- system --> and <!-- user --> parts. */
export function splitPrompt(md, name = "prompt") {
  const system = md.split("<!-- system -->")[1]?.split("<!-- user -->")[0]?.trim();
  const user = md.split("<!-- user -->")[1]?.trim();
  if (!system || !user) throw new Error(`${name} must contain <!-- system --> and <!-- user --> sections`);
  return { system, user };
}

/** The judge's chat messages for one candidate, from the split judge.md. */
export function judgeMessages(prompt, candidate) {
  const user = prompt.user
    .replace("{{duration}}", String(Math.round(candidate.end - candidate.start)))
    .replace("{{text}}", candidate.text.trim());
  return [
    { role: "system", content: prompt.system },
    { role: "user", content: user },
  ];
}

export function tidyReason(s) {
  let r = String(s || "").replace(/\s+/g, " ").trim();
  r = r.replace(/\s*[—–]\s*/g, ", ").replace(/^["']|["']$/g, "");
  const first = r.match(/^.*?[.!?](\s|$)/);
  if (first && first[0].length > 20) r = first[0].trim();
  if (r && !/[.!?]$/.test(r)) r += ".";
  return r;
}

export const lastSentence = (text) => {
  const parts = text.trim().split(/(?<=[.!?]["')\]]?)\s+/);
  return parts[parts.length - 1];
};

/** The listwise round's chat messages: first and last sentence of each clip, lettered A, B, ... */
export function listMessages(prompt, top) {
  const blocks = top.map((c, i) => `Clip ${String.fromCharCode(65 + i)} (${Math.round(c.end - c.start)} s)\nFirst: "${c.hook.trim()}"\nLast: "${lastSentence(c.text)}"`);
  return [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user.replace("{{clips}}", blocks.join("\n\n")) },
  ];
}

export function listSchema(letters) {
  return {
    type: "object",
    properties: {
      ranking: {
        type: "array",
        minItems: letters.length,
        maxItems: letters.length,
        items: { type: "object", properties: { clip: { type: "string", enum: letters }, reason: { type: "string" } }, required: ["clip", "reason"] },
      },
    },
    required: ["ranking"],
  };
}

/** Turn the model's answer (parsed or raw text) into a full order of letters plus reasons. */
export function parseListAnswer(answer, letters) {
  let items = [];
  if (answer && typeof answer === "object" && Array.isArray(answer.ranking)) items = answer.ranking;
  else if (typeof answer === "string") {
    const re = /"clip"\s*:\s*"([A-Z])"(?:\s*,\s*"reason"\s*:\s*"((?:[^"\\]|\\.)*)")?/g;
    let m;
    while ((m = re.exec(answer))) items.push({ clip: m[1], reason: m[2] || "" });
  }
  const order = [];
  const reasons = {};
  for (const it of items) {
    const l = String(it.clip || "").trim().toUpperCase();
    if (letters.includes(l) && !order.includes(l)) {
      order.push(l);
      reasons[l] = tidyReason(it.reason || "");
    }
  }
  const complete = order.length === letters.length;
  for (const l of letters) if (!order.includes(l)) order.push(l); // anything missing keeps its place at the end
  return { order, reasons, complete };
}

/**
 * Apply the listwise order to every judged candidate: each total becomes
 * (1 - LIST_WEIGHT) x total + LIST_WEIGHT x listScore, where listScore runs from 1 (first)
 * to 0 (last), and 0 for clips outside the round. Clips in the round get listRank and
 * listReason. top: the candidates sent, in letter order; order: letters best first.
 */
export function applyListOrder(candidates, top, order, reasons = {}) {
  const letters = top.map((_, i) => String.fromCharCode(65 + i));
  const byLetter = Object.fromEntries(top.map((c, i) => [letters[i], c]));
  const listScore = new Map();
  const listInfo = new Map();
  order.forEach((l, pos) => {
    const c = byLetter[l];
    listScore.set(c.id, (letters.length - 1 - pos) / (letters.length - 1));
    listInfo.set(c.id, { listRank: pos + 1, listReason: reasons[l] || null });
  });
  const out = candidates.map((c) => {
    if (typeof c.total !== "number") return c;
    const total = +((1 - LIST_WEIGHT) * c.total + LIST_WEIGHT * (listScore.get(c.id) ?? 0)).toFixed(3);
    return { ...c, total, ...(listInfo.get(c.id) || {}) };
  });
  return { candidates: out, byLetter };
}
