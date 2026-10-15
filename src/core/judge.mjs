// The rubric judge: one Ollama request per candidate, structured JSON out, cached on disk.
import fs from "node:fs";
import path from "node:path";
import { ollamaUrl, PROMPTS_DIR, selectsHome } from "./config.mjs";
import { readJson, sha1, writeJsonAtomic } from "./util.mjs";

/**
 * Weights for the combined score. For a short, the first two seconds decide whether
 * anyone watches at all, so the hook carries the most weight. A clip that needs earlier
 * context fails every viewer who did not see the talk, which is nearly all of them, so
 * standalone comes next. Payoff decides whether people finish, rewatch and share, which
 * matters but only for viewers the hook already kept. Clarity is partly covered by the
 * other three (filler weakens the hook and the payoff), so it carries the least.
 */
export const WEIGHTS = { hook: 0.35, standalone: 0.3, payoff: 0.2, clarity: 0.15 };

/** Combine 1..5 scores into 0..1. */
export function combine(scores) {
  let sum = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) sum += w * clamp(scores[k]);
  return Math.max(0, +((sum - 1) / 4).toFixed(3)) + 0; // + 0 turns -0 into 0
}

const clamp = (n) => Math.max(1, Math.min(5, Math.round(Number(n) || 1)));

const SCHEMA = {
  type: "object",
  properties: {
    reason: { type: "string" },
    hook: { type: "integer", minimum: 1, maximum: 5 },
    standalone: { type: "integer", minimum: 1, maximum: 5 },
    payoff: { type: "integer", minimum: 1, maximum: 5 },
    clarity: { type: "integer", minimum: 1, maximum: 5 },
  },
  required: ["reason", "hook", "standalone", "payoff", "clarity"],
};

let promptCache = null;
/** Load prompts/judge.md and split it into the system and user parts. */
export function loadPrompt() {
  if (promptCache) return promptCache;
  const md = fs.readFileSync(path.join(PROMPTS_DIR, "judge.md"), "utf8");
  const sys = md.split("<!-- system -->")[1]?.split("<!-- user -->")[0]?.trim();
  const user = md.split("<!-- user -->")[1]?.trim();
  if (!sys || !user) throw new Error("prompts/judge.md must contain <!-- system --> and <!-- user --> sections");
  promptCache = { system: sys, user, version: sha1(md).slice(0, 10) };
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

/** Low-level: one structured chat request to Ollama. Returns the parsed JSON. */
export async function ollamaJson({ model, messages, schema, timeoutMs = 300000, numPredict = 160, signal }) {
  const body = {
    model,
    messages,
    format: schema,
    stream: false,
    keep_alive: "15m",
    options: { temperature: 0.2, num_ctx: 2048, num_predict: numPredict },
  };
  let res;
  try {
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    res = await fetch(`${ollamaUrl()}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: sig });
  } catch (e) {
    if (signal?.aborted) throw e;
    const err = new Error(e.name === "TimeoutError" ? `Ollama took longer than ${Math.round(timeoutMs / 1000)} s to answer.` : `Could not reach Ollama at ${ollamaUrl()}.`);
    err.hint = e.name === "TimeoutError" ? "Try a smaller model with --model, or close other heavy apps, then resume." : "Start Ollama (open the Ollama app or run `ollama serve`), then resume.";
    throw err;
  }
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Ollama returned ${res.status}: ${text.slice(0, 200)}`);
    err.hint = /not found/i.test(text) ? `Pull the model first: ollama pull ${model}` : "Check `ollama ps` and the Ollama logs, then resume.";
    throw err;
  }
  const j = await res.json();
  const content = j.message?.content ?? "";
  try {
    return { data: JSON.parse(content), evalCount: j.eval_count, promptEvalCount: j.prompt_eval_count };
  } catch {
    throw Object.assign(new Error(`The model did not return valid JSON: ${content.slice(0, 120)}`), { retryable: true });
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
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          res = await ask(buildMessages(c));
          break;
        } catch (e) {
          if (!e.retryable || attempt === 1) throw e;
        }
      }
      const d = res.data ?? res;
      const scores = { hook: clamp(d.hook), standalone: clamp(d.standalone), payoff: clamp(d.payoff), clarity: clamp(d.clarity) };
      hit = { scores, reason: tidyReason(d.reason), sec: +((Date.now() - started) / 1000).toFixed(2) };
      times.push(hit.sec);
      cache[key] = hit;
      if (cacheFile) writeJsonAtomic(cacheFile, cache);
    }
    const judged = { ...c, scores: hit.scores, total: combine(hit.scores), reason: hit.reason };
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
