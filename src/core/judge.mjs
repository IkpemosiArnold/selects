// The rubric judge: one Ollama request per candidate, structured JSON out, cached on disk.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ollamaUrl, PROMPTS_DIR, selectsHome } from "./config.mjs";
import { appendJsonLine, readJson, sha1, writeJsonAtomic } from "./util.mjs";

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

const clamp = (n) => Math.max(1, Math.min(5, Math.round(Number(n) || 1)));

// Scores first, reason last: if the model runs past num_predict, only the reason is cut
// and salvageJudge() can still read the four scores. (Gemma ignores maxLength, so a
// reason-first answer ran out of tokens before the scores in the first real run.)
const SCHEMA = {
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

let promptCache = null;
/** Load prompts/judge.md and split it into the system and user parts. */
export function loadPrompt() {
  if (promptCache) return promptCache;
  const md = fs.readFileSync(path.join(PROMPTS_DIR, "judge.md"), "utf8");
  const sys = md.split("<!-- system -->")[1]?.split("<!-- user -->")[0]?.trim();
  const user = md.split("<!-- user -->")[1]?.trim();
  if (!sys || !user) throw new Error("prompts/judge.md must contain <!-- system --> and <!-- user --> sections");
  // the version covers only what the model sees, so editing the notes above it keeps the cache
  promptCache = { system: sys, user, version: sha1(`${sys}\n---\n${user}`).slice(0, 10) };
  return promptCache;
}

export function buildMessages(candidate) {
  const p = loadPrompt();
  const user = p.user
    .replace("{{duration}}", String(Math.round(candidate.end - candidate.start)))
    .replace("{{text}}", candidate.text.trim());
  return [
    { role: "system", content: p.system },
    { role: "user", content: user },
  ];
}

/**
 * POST JSON with node:http rather than fetch: fetch gives up after 300 s without response
 * headers, and on a throttled CPU Ollama can take longer than that to read a prompt.
 */
function postJson(url, body, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { hostname: u.hostname, port: u.port || 80, path: u.pathname, method: "POST", headers: { "content-type": "application/json", "content-length": data.length } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    const timer = setTimeout(() => req.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })), timeoutMs);
    const onAbort = () => req.destroy(Object.assign(new Error("aborted"), { name: "AbortError" }));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", reject);
    req.on("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
    req.end(data);
  });
}

/** Ollama durations are nanoseconds; keep seconds and token counts for the timings table. */
export function callStats(j, wallSec) {
  const s = (ns) => (typeof ns === "number" ? +(ns / 1e9).toFixed(2) : null);
  const rate = (n, ns) => (n && ns ? +(n / (ns / 1e9)).toFixed(2) : null);
  return {
    wallSec,
    loadSec: s(j.load_duration),
    promptTokens: j.prompt_eval_count ?? null,
    promptSec: s(j.prompt_eval_duration),
    promptTokPerSec: rate(j.prompt_eval_count, j.prompt_eval_duration),
    outTokens: j.eval_count ?? null,
    outSec: s(j.eval_duration),
    outTokPerSec: rate(j.eval_count, j.eval_duration),
    totalSec: s(j.total_duration),
  };
}

/**
 * Ollama's num_thread. SELECTS_THREADS overrides; "auto" (or 0) leaves it to Ollama.
 * Default: leave it to Ollama. On the i5-7360U, Ollama's own choice beat num_thread 2 in an
 * A/B (median prompt 20.7 vs 14.6 tok/s, output 2.9 vs 2.8 tok/s, wall 39 vs 47 s per
 * call; notes/timings.md), so there is no override unless SELECTS_THREADS sets one.
 */
export const DEFAULT_THREADS = null;
export function threadOption() {
  const env = process.env.SELECTS_THREADS;
  if (env === "auto" || env === "0") return {};
  const n = env ? Number(env) : DEFAULT_THREADS;
  return Number.isInteger(n) && n > 0 ? { num_thread: n } : {};
}

/**
 * Low-level: one structured chat request to Ollama. Returns { data, stats }.
 * Options follow the measured budget: short output (num_predict 80), a 2048 context,
 * the model kept loaded for 30 minutes between calls, and temperature 0.2.
 */
export async function ollamaJson({ model, messages, schema, timeoutMs = 60 * 60 * 1000, numPredict = 80, signal }) {
  const body = {
    model,
    messages,
    format: schema,
    stream: false,
    keep_alive: "30m",
    options: { temperature: 0.2, num_ctx: 2048, num_predict: numPredict, ...threadOption() },
  };
  const t0 = Date.now();
  let res;
  try {
    res = await postJson(`${ollamaUrl()}/api/chat`, body, { timeoutMs, signal });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    const err = new Error(e.name === "TimeoutError" ? `Ollama took longer than ${Math.round(timeoutMs / 60000)} min to answer.` : `Could not reach Ollama at ${ollamaUrl()}.`);
    err.hint = e.name === "TimeoutError" ? "Try a smaller model with --model, or close other heavy apps, then resume." : "Start Ollama (open the Ollama app or run `ollama serve`), then resume.";
    throw err;
  }
  if (res.status !== 200) {
    const err = new Error(`Ollama returned ${res.status}: ${res.text.slice(0, 200)}`);
    err.hint = /not found/i.test(res.text) ? `Pull the model first: ollama pull ${model}` : "Check `ollama ps` and the Ollama logs, then resume.";
    throw err;
  }
  const j = JSON.parse(res.text);
  const content = j.message?.content ?? "";
  const stats = callStats(j, +((Date.now() - t0) / 1000).toFixed(2));
  try {
    return { data: JSON.parse(content), stats };
  } catch {
    throw Object.assign(new Error(`The model did not return valid JSON: ${content.slice(0, 120)}`), { retryable: true, stats, content });
  }
}

function tidyReason(s) {
  let r = String(s || "").replace(/\s+/g, " ").trim();
  r = r.replace(/\s*[—–]\s*/g, ", ").replace(/^["']|["']$/g, "");
  const first = r.match(/^.*?[.!?](\s|$)/);
  if (first && first[0].length > 20) r = first[0].trim();
  if (r && !/[.!?]$/.test(r)) r += ".";
  return r;
}

/**
 * Score candidates with the rubric. Returns new candidate objects with scores, total and
 * reason. Results are cached by hash(model + prompt version + clip text), so a resumed or
 * repeated run only pays for clips it has not seen.
 * @param {object[]} candidates
 * @param {{model:string, cacheDir?:string, onProgress?:Function, onResult?:Function, signal?:AbortSignal, request?:Function}} opts
 *   `request` replaces the Ollama call (tests use it).
 * @returns {Promise<object[]>} judged candidates, with a non-enumerable `stats` property
 */
export async function judge(candidates, { model, cacheDir, onProgress, onResult, signal, request } = {}) {
  if (!model) throw new Error("judge needs a model name");
  const prompt = loadPrompt();
  const cacheFile = cacheDir ? path.join(cacheDir, "judge-cache.json") : null;
  const cache = cacheFile ? readJson(cacheFile, {}) : {};
  const ask = request || ((messages) => ollamaJson({ model, messages, schema: SCHEMA, signal }));
  const out = [];
  const times = [];
  const t0 = Date.now();
  for (let i = 0; i < candidates.length; i++) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const c = candidates[i];
    const key = sha1(`${model}|${prompt.version}|${c.text.trim()}`);
    let hit = cache[key];
    if (!hit) {
      const started = Date.now();
      let res;
      const logCall = (stats, extra = {}) => {
        if (cacheDir && stats) appendJsonLine(path.join(cacheDir, "judge-calls.jsonl"), { at: new Date().toISOString(), model, id: c.id, words: c.text.split(/\s+/).length, ...stats, ...extra });
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          res = await ask(buildMessages(c));
          break;
        } catch (e) {
          const salvaged = e.content != null ? salvageJudge(e.content) : null;
          if (salvaged) {
            res = { data: salvaged, stats: e.stats };
            break;
          }
          logCall(e.stats, { failed: e.message.slice(0, 80) });
          if (!e.retryable || attempt === 1) throw e;
        }
      }
      const d = res.data ?? res;
      const scores = { hook: clamp(d.hook), standalone: clamp(d.standalone), payoff: clamp(d.payoff), clarity: clamp(d.clarity) };
      hit = { scores, reason: tidyReason(d.reason), sec: +((Date.now() - started) / 1000).toFixed(2), stats: res.stats ?? null };
      logCall(res.stats, d.truncated ? { truncated: true } : {});
      times.push(hit.sec);
      cache[key] = hit;
      if (cacheFile) writeJsonAtomic(cacheFile, cache);
    }
    const judgeTotal = combine(hit.scores);
    const judged = { ...c, scores: hit.scores, judgeTotal, total: blend(judgeTotal, c.pre), reason: hit.reason };
    out.push(judged);
    onResult?.(judged);
    const secPer = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
    const left = candidates.length - i - 1;
    onProgress?.({
      progress: (i + 1) / candidates.length,
      done: i + 1,
      total: candidates.length,
      secPerCandidate: secPer == null ? null : +secPer.toFixed(1),
      etaSec: secPer == null ? null : Math.round(secPer * left),
      note: `judged ${i + 1} of ${candidates.length}` + (secPer ? `, about ${secPer.toFixed(0)} s each` : ""),
    });
  }
  if (times.length && !request) recordModelSpeed(model, times);
  // Contract: returns Candidate[]. Timing rides along as a non-enumerable `stats` property.
  Object.defineProperty(out, "stats", {
    value: { wallSec: +((Date.now() - t0) / 1000).toFixed(1), judged: times.length, cached: candidates.length - times.length, secPerCandidate: times.length ? +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2) : null },
    enumerable: false,
  });
  return out;
}

/** Remember measured seconds per candidate per model, for the Faster to Smarter control. */
export function recordModelSpeed(model, times) {
  const file = path.join(selectsHome(), "models.json");
  const all = readJson(file, {});
  const prev = all[model] || { n: 0, secPerCandidate: 0 };
  const n = prev.n + times.length;
  const mean = (prev.secPerCandidate * prev.n + times.reduce((a, b) => a + b, 0)) / n;
  all[model] = { n, secPerCandidate: +mean.toFixed(2), updatedAt: new Date().toISOString() };
  writeJsonAtomic(file, all);
}

export function measuredSpeeds() {
  return readJson(path.join(selectsHome(), "models.json"), {});
}

export { SCHEMA as JUDGE_SCHEMA };

// ---------------------------------------------------------------- listwise final round

let listPromptCache = null;
function loadListPrompt() {
  if (listPromptCache) return listPromptCache;
  const md = fs.readFileSync(path.join(PROMPTS_DIR, "listwise.md"), "utf8");
  listPromptCache = {
    system: md.split("<!-- system -->")[1].split("<!-- user -->")[0].trim(),
    user: md.split("<!-- user -->")[1].trim(),
    version: null,
  };
  listPromptCache.version = sha1(`${listPromptCache.system}\n---\n${listPromptCache.user}`).slice(0, 10);
  return listPromptCache;
}

const lastSentence = (text) => {
  const parts = text.trim().split(/(?<=[.!?]["')\]]?)\s+/);
  return parts[parts.length - 1];
};

export function buildListMessages(top) {
  const p = loadListPrompt();
  const blocks = top.map((c, i) => `Clip ${String.fromCharCode(65 + i)} (${Math.round(c.end - c.start)} s)\nFirst: "${c.hook.trim()}"\nLast: "${lastSentence(c.text)}"`);
  return [
    { role: "system", content: p.system },
    { role: "user", content: p.user.replace("{{clips}}", blocks.join("\n\n")) },
  ];
}

function listSchema(letters) {
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
 * Listwise final round: take the top n distinct candidates (NMS on time overlap), show the
 * model only their first and last sentences, and let it order them. The order moves each
 * total by up to LIST_WEIGHT; every candidate not in the round is scaled the same way, so
 * totals stay comparable. Returns { candidates, order: ids[], reasons: {id: reason}, stats }.
 */
export async function listwise(candidates, { model, n = 4, cacheDir, request, signal, rankFn } = {}) {
  const { rank } = await import("./rank.mjs");
  const top = (rankFn || rank)(candidates, { k: n, iou: 0.3 });
  if (top.length < 2) return { candidates, order: top.map((c) => c.id), reasons: {}, stats: null };
  const letters = top.map((_, i) => String.fromCharCode(65 + i));
  const messages = buildListMessages(top);
  const p = loadListPrompt();
  const cacheFile = cacheDir ? path.join(cacheDir, "judge-cache.json") : null;
  const cache = cacheFile ? readJson(cacheFile, {}) : {};
  const key = sha1(`list|${model}|${p.version}|${messages[1].content}`);
  let hit = cache[key];
  let stats = null;
  if (!hit) {
    const ask = request || ((m) => ollamaJson({ model, messages: m, schema: listSchema(letters), numPredict: 40 + 30 * letters.length, signal }));
    let parsed;
    try {
      const res = await ask(messages);
      stats = res.stats ?? null;
      parsed = parseListAnswer(res.data ?? res, letters);
    } catch (e) {
      if (e.content == null) throw e;
      stats = e.stats ?? null;
      parsed = parseListAnswer(e.content, letters);
    }
    hit = { order: parsed.order, reasons: parsed.reasons, complete: parsed.complete, stats };
    if (cacheFile) {
      cache[key] = hit;
      writeJsonAtomic(cacheFile, cache);
    }
    if (cacheDir && stats) appendJsonLine(path.join(cacheDir, "judge-calls.jsonl"), { at: new Date().toISOString(), model, id: "listwise", kind: "listwise", clips: letters.length, complete: parsed.complete, ...stats });
  }
  const byLetter = Object.fromEntries(top.map((c, i) => [letters[i], c]));
  const listScore = new Map();
  const listInfo = new Map();
  hit.order.forEach((l, pos) => {
    const c = byLetter[l];
    listScore.set(c.id, (letters.length - 1 - pos) / (letters.length - 1));
    listInfo.set(c.id, { listRank: pos + 1, listReason: hit.reasons[l] || null });
  });
  const out = candidates.map((c) => {
    if (typeof c.total !== "number") return c;
    const total = +((1 - LIST_WEIGHT) * c.total + LIST_WEIGHT * (listScore.get(c.id) ?? 0)).toFixed(3);
    return { ...c, total, ...(listInfo.get(c.id) || {}) };
  });
  return { candidates: out, order: hit.order.map((l) => byLetter[l].id), reasons: Object.fromEntries(hit.order.map((l) => [byLetter[l].id, hit.reasons[l] || null])), complete: hit.complete, stats: hit.stats };
}
