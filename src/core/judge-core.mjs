// The judge's pure parts, with no Node imports: rubric weights and the blend, the JSON
// schemas, prompt building from the prompt files' text, answer parsing and salvage, and the
// listwise round's maths. judge.mjs (Ollama, the CLI and server) and the browser build
// (src/browser: Gemma in the tab, or Gemma through the Gemini API) share them.

/**
 * The rubric (prompts/judge.md): what makes a stranger stop scrolling and share, scored 1 to 5.
 *   moment      the best beat: a laugh or a joke landing, a hot take, a surprising story or
 *               reveal, a quotable line, an emotional peak, banter or conflict
 *   share       would people comment, argue or send it on: a relatable truth, a confession, a
 *               question the audience will want to answer
 *   hook        do the first seconds pull a stranger in
 *   standalone  can a stranger follow it without what came before (a gate, below)
 * The total is the weighted mean of the first three, times the standalone gate. A clip nobody
 * can follow fails every viewer, however good its beat, so a low standalone scales the total
 * down instead of adding a little; at 3 or more it costs nothing. The earlier rubric (hook,
 * standalone, payoff, clarity) scored tidy, self-contained points, and its scores bunched at
 * 2 and 3 for every clip of a conversation; answers in that shape still combine with its
 * own weights (LEGACY_WEIGHTS), so old jobs and caches read as they did.
 */
export const RUBRIC_KEYS = ["moment", "share", "hook", "standalone"];
export const WEIGHTS = { moment: 0.45, share: 0.3, hook: 0.25 };
// a conversation clip that starts mid-chat is normal: 2 means "needs a one-line caption", so it costs little
export const STANDALONE_GATE = { 1: 0.7, 2: 0.92 };
/** The note a clip gets when a stranger needs a line of context to follow it. */
export const CONTEXT_NOTE = "Needs a one-line caption for context.";
export const LEGACY_KEYS = ["hook", "standalone", "payoff", "clarity"];
export const LEGACY_WEIGHTS = { hook: 0.35, standalone: 0.3, payoff: 0.2, clarity: 0.15 };
/** Output budget for one judge answer: four scores, why (15 words) and watch (10 words). */
export const JUDGE_MAX_TOKENS = 100;

/**
 * The total a candidate is ranked by blends the judge with the cheap pre-score. On the
 * first real run, a small model put most clips on the same middle scores (three of eight
 * tied at 0.675), so the ranking came down to tie-breaks on list order. The pre-score is
 * independent evidence (hook phrases, pace, loudness, laughter), so it breaks those ties on
 * something measured. The judge still carries most of the weight.
 */
export const BLEND = { judge: 0.7, pre: 0.3 };
/** How much the listwise final round can move a clip (best of the round +0.15 x 1, last +0). */
export const LIST_WEIGHT = 0.15;

export function blend(judgeTotal, pre) {
  if (typeof pre !== "number") return judgeTotal;
  return +(BLEND.judge * judgeTotal + BLEND.pre * pre).toFixed(3);
}

/** Combine 1..5 scores into 0..1 (the current rubric, or the earlier one for old answers). */
export function combine(scores) {
  if (scores && scores.moment == null && scores.payoff != null) {
    let sum = 0;
    for (const [k, w] of Object.entries(LEGACY_WEIGHTS)) sum += w * clamp(scores[k]);
    return Math.max(0, +((sum - 1) / 4).toFixed(3)) + 0;
  }
  let sum = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) sum += w * clamp(scores?.[k]);
  const gate = STANDALONE_GATE[clamp(scores?.standalone ?? 3)] ?? 1;
  return Math.max(0, +(((sum - 1) / 4) * gate).toFixed(3)) + 0; // + 0 turns -0 into 0
}

export const clamp = (n) => Math.max(1, Math.min(5, Math.round(Number(n) || 1)));

// Scores first, then why, then watch: if the model runs past its output budget, only the
// texts are cut and salvageJudge() can still read the four scores. (Gemma ignores maxLength,
// so a reason-first answer ran out of tokens before the scores in the first real run.)
export const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    moment: { type: "integer", minimum: 1, maximum: 5 },
    share: { type: "integer", minimum: 1, maximum: 5 },
    hook: { type: "integer", minimum: 1, maximum: 5 },
    standalone: { type: "integer", minimum: 1, maximum: 5 },
    why: { type: "string", maxLength: 120 },
    watch: { type: "string", maxLength: 100 },
  },
  required: ["moment", "share", "hook", "standalone", "why", "watch"],
};

/** True when an answer object carries a full set of scores (either rubric). */
export function hasScores(obj) {
  if (!obj || typeof obj !== "object") return false;
  const num = (k) => Number.isFinite(Number(obj[k])) && obj[k] !== null && obj[k] !== "";
  return RUBRIC_KEYS.every(num) || LEGACY_KEYS.every(num);
}

/**
 * A judge answer (parsed or salvaged) -> { scores, why, watch, reason }. `reason` is `why`,
 * kept for everything that read the one text before (the CLI, clips.md, the eval).
 */
export function readJudge(d) {
  const legacy = d && d.moment == null && d.payoff != null;
  const keys = legacy ? LEGACY_KEYS : RUBRIC_KEYS;
  const scores = Object.fromEntries(keys.map((k) => [k, clamp(d?.[k])]));
  const why = capWords(tidyReason(d?.why ?? d?.reason ?? ""), 25);
  const w = capWords(tidyReason(d?.watch ?? ""), 20);
  let watch = w && !/^(none|n\/a|nothing|no)\.?$/i.test(w) && w !== why ? w : null;
  // a strong moment that needs a line of context goes through, with that said
  if (!legacy && scores.standalone <= 2) watch = watch ? `${CONTEXT_NOTE} ${watch}` : CONTEXT_NOTE;
  return { scores, why, watch, reason: why };
}

const STOP_TAIL = /^(the|a|an|at|of|to|and|but|or|with|for|in|on|into|from|by|that|which|is|was|its|their|this|as|so|while|like)$/i;

/**
 * At most `n` words: a model that falls into a loop ("of crush of crush of crush ...") would
 * otherwise fill the card. A repeated run of up to 4 words is cut at its second appearance.
 */
export function capWords(text, n) {
  let ws = String(text || "").split(/\s+/).filter(Boolean);
  for (let len = 1; len <= 4; len++) {
    for (let i = 0; i + 2 * len <= ws.length; i++) {
      const a = ws.slice(i, i + len).join(" ").toLowerCase();
      if (a === ws.slice(i + len, i + 2 * len).join(" ").toLowerCase()) {
        ws = ws.slice(0, i + len);
        break;
      }
    }
  }
  if (ws.length <= n && ws.length === String(text || "").split(/\s+/).filter(Boolean).length) return text;
  ws = ws.slice(0, n).filter((w) => /[\p{L}\p{N}]/u.test(w));
  // end on a whole thought: drop a trailing "and", "of the" and the like
  while (ws.length > 3 && STOP_TAIL.test(ws[ws.length - 1].replace(/[,;:.!?]+$/, ""))) ws.pop();
  const out = ws.join(" ").replace(/[,;:.]+$/, "");
  return out ? `${out}.` : "";
}

/** One text field from a JSON answer that may be cut off mid-string. */
function salvageText(text, key) {
  const r = String(text).match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
  let t = r ? r[1].replace(/\\"/g, '"') : "";
  const closed = r ? new RegExp(`"${key}"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*"`).test(String(text)) : false;
  // models sometimes close the string with a curly quote and then ramble on
  t = t.split(/[\u201d"]\s*[},\n]|\n/)[0].replace(/[\u201d]$/, "").trim();
  if (/[.!?][\u201d']?$/.test(t)) t = t.replace(/[\u201d']$/, "");
  if (t && !closed && !/[.!?]$/.test(t)) {
    const ws = t.split(/\s+/).slice(0, -1); // the last word may be cut in half
    while (ws.length && /^(the|a|an|at|of|to|and|but|or|with|for|in|on|into|from|by|that|which|is|was|its|their|this)$/i.test(ws[ws.length - 1].replace(/[,;:]$/, ""))) ws.pop();
    t = ws.join(" ").replace(/[,;:]$/, "");
  }
  return t;
}

/**
 * Read scores and as much of the texts as there is from a JSON answer that was cut off.
 * Returns null unless all four scores of one rubric are present.
 */
export function salvageJudge(text) {
  const out = {};
  const grab = (keys) => {
    const got = {};
    for (const k of keys) {
      const m = String(text).match(new RegExp(`"${k}"\\s*:\\s*([1-5])`));
      if (!m) return null;
      got[k] = +m[1];
    }
    return got;
  };
  const scores = grab(RUBRIC_KEYS) || grab(LEGACY_KEYS);
  if (!scores) return null;
  Object.assign(out, scores);
  if (/"why"\s*:/.test(text)) out.why = salvageText(text, "why");
  if (/"watch"\s*:/.test(text)) out.watch = salvageText(text, "watch");
  if (/"reason"\s*:/.test(text)) out.reason = salvageText(text, "reason");
  if (out.why == null && out.reason == null) out.why = "";
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

/**
 * The judge's chat messages for one candidate, from the split judge.md. `extra` is one more
 * line for the system part (the "story" preset's line; empty for every other preset).
 */
export function judgeMessages(prompt, candidate, { extra = "" } = {}) {
  const user = prompt.user
    .replace("{{duration}}", String(Math.round(candidate.end - candidate.start)))
    .replace("{{text}}", judgeText(candidate));
  return [
    { role: "system", content: extra ? `${prompt.system}\n\n${extra}` : prompt.system },
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

/**
 * What the judge reads of a clip: its words, with "(laughter)" and "(louder)" where the sound
 * analysis heard them (candidate.cueText, delivery.mjs markCues), else the plain words.
 */
export const judgeText = (c) => String(typeof c.cueText === "string" && c.cueText.trim() ? c.cueText : c.text).trim();

/**
 * A clip for the side-by-side round: all its words up to `maxWords`, else its opening and its
 * ending with "..." between, so the model can judge the build-up, the energy and the payoff
 * (the first and last sentence alone hid every laugh in the middle).
 */
export function clipExcerpt(c, maxWords = 90) {
  const words = judgeText(c).split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  const head = Math.ceil(maxWords * 0.45);
  return `${words.slice(0, head).join(" ")} ... ${words.slice(words.length - (maxWords - head)).join(" ")}`;
}

/** The listwise round's chat messages: each clip's words (or an excerpt), lettered A, B, ... */
export function listMessages(prompt, top) {
  const blocks = top.map((c, i) => `Clip ${String.fromCharCode(65 + i)} (${Math.round(c.end - c.start)} s):\n${clipExcerpt(c)}`);
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
