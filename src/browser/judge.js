// The judge stage in the browser: the same rubric, scoring, blend, listwise round, ranking
// and curve as the desktop (src/core/judge-core.mjs, rank.mjs), with the call itself made
// by whichever backend runs here (llm.js).
import { applyListOrder, blend, combine, readJudge } from "../core/judge-core.mjs";
import { plainKit } from "../core/kit-core.mjs";
import { curve, rank } from "../core/rank.mjs";
import { buildTask, readTask } from "../core/tasks.mjs";
import { taskKey } from "../core/signatures.mjs";
import { PROMPTS } from "./prompts.js";
import { contextFor, faithfulHints, faithfulResult } from "../core/faithful-core.mjs";
import { toSentences } from "../core/sentences.mjs";

// Answers are cached for the page's life, keyed by the backend, the model and everything the
// model is sent (the messages built from the prompt files, the schema and the output budget:
// signatures.mjs taskKey), so a re-run does not pay for the same call twice and a changed
// task never gets an old answer.
const memo = new Map();
const key = (llm, task) => taskKey({ backend: llm.id, model: llm.model }, buildTask(task, PROMPTS));

async function ask(llm, task) {
  const k = key(llm, task);
  if (memo.has(k)) return { ...memo.get(k), cached: true };
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await llm.run(task);
    const parsed = readTask(task, res);
    if (parsed && (task.kind !== "listwise" || parsed.order?.length)) {
      const out = { parsed, stats: res.stats, raw: res.text };
      memo.set(k, out);
      return out;
    }
    last = res;
  }
  const err = new Error(`The model did not return usable scores: ${String(last?.text ?? "").slice(0, 120)}`);
  err.hint = "Try again, or switch to Smart mode for a larger model.";
  throw err;
}

const FALLBACK_NOTE = "Google's free Gemma was slow, so this clip was judged on your device.";

function scored(c, d, extra = {}) {
  const { scores, why, watch } = readJudge(d);
  const judgeTotal = combine(scores);
  // why leads the review card; watch (a critique or trim tip, often null) sits behind a tap
  return { ...c, scores, judgeTotal, total: blend(judgeTotal, c.pre), reason: why, why, watch, ...extra };
}

/**
 * Judge the shortlist. Returns { judged, calls, secPerCandidate, fallbacks } where judged
 * are Candidate[] with scores, judgeTotal, total and reason (CONTRACTS.md), and calls lists
 * each model call's stats.
 *   fallback     async () => a loaded on-device backend, used for any clip a Smart mode
 *                call could not judge (timeout, Google's free tier failing); that clip gets
 *                judgedOn: "device" and fallbackNote
 *   concurrency  parallel calls (Smart mode only; the device runs one at a time)
 *   batch        Smart mode: the whole shortlist in one call first (tasks.mjs judgeBatch)
 */
export async function judgeShortlist(short, llm, { onProgress, onResult, onFallback, signal, fallback, concurrency = 1, batch = false, madeFor } = {}) {
  const out = new Array(short.length);
  const calls = [];
  const times = [];
  let done = 0;
  let fallbacks = 0;
  const where = llm.where === "google" ? "google" : "device";
  const report = () => {
    const secPer = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
    const left = short.length - done;
    onProgress?.({
      progress: done / short.length,
      done,
      total: short.length,
      secPerCandidate: secPer == null ? null : +secPer.toFixed(1),
      etaSec: secPer == null ? null : Math.round((secPer * left) / Math.max(1, concurrency)),
      note: `judged ${done} of ${short.length}` + (secPer ? `, about ${secPer.toFixed(0)} s each` : "") + (fallbacks ? `; ${fallbacks} on this device` : ""),
    });
  };

  if (batch && llm.where === "google" && short.length > 1) {
    const t0 = performance.now();
    try {
      const r = await ask(llm, { kind: "judgeBatch", candidates: short, madeFor });
      const sec = +((performance.now() - t0) / 1000).toFixed(2);
      calls.push({ kind: "judgeBatch", clips: short.length, sec, complete: r.parsed.complete, ...(r.stats || {}) });
      short.forEach((c, i) => {
        const d = r.parsed.byLetter[String.fromCharCode(65 + i)];
        if (!d) return;
        out[i] = scored(c, d, { judgedOn: where });
        onResult?.(out[i]);
        done++;
      });
      if (done) times.push(sec / done);
      report();
    } catch (e) {
      calls.push({ kind: "judgeBatch", failed: e.message.slice(0, 100) });
    }
  }

  let device = null;
  const judgeOne = async (i) => {
    const c = short[i];
    if (signal?.aborted) throw Object.assign(new Error("Stopped before it finished."), { name: "AbortError" });
    const t0 = performance.now();
    try {
      const r = await ask(llm, { kind: "judge", candidate: c, madeFor });
      const sec = +((performance.now() - t0) / 1000).toFixed(2);
      if (!r.cached) times.push(sec);
      out[i] = scored(c, r.parsed, { judgedOn: where });
      calls.push({ id: c.id, kind: "judge", sec, cached: !!r.cached, truncated: !!r.parsed.truncated, ...(r.stats || {}) });
    } catch (e) {
      calls.push({ id: c.id, kind: "judge", failed: e.message.slice(0, 100), sec: +((performance.now() - t0) / 1000).toFixed(2) });
      if (fallback && llm.where === "google" && e.name !== "AbortError") {
        try {
          onFallback?.(c, e);
          device ??= fallback();
          const dev = await device;
          const t1 = performance.now();
          const r = await ask(dev, { kind: "judge", candidate: c, madeFor });
          fallbacks++;
          out[i] = scored(c, r.parsed, { judgedOn: "device", fallbackNote: FALLBACK_NOTE });
          calls.push({ id: c.id, kind: "judge", backend: dev.id, sec: +((performance.now() - t1) / 1000).toFixed(2), fallback: true, ...(r.stats || {}) });
        } catch (e2) {
          out[i] = { ...c, scores: null, judgeTotal: null, total: c.pre ?? 0, reason: "Neither Smart mode nor this device could judge this clip, so it keeps its first-stage score." };
        }
      } else {
        // one bad answer should not sink the run: the clip keeps its pre-score and says so
        // (Smart mode without a saved private model: nothing is downloaded for one clip)
        const why = llm.where === "google" ? "Smart mode could not judge this clip, so it keeps its first-stage score." : "The model's answer could not be read, so this clip keeps its first-stage score.";
        out[i] = { ...c, scores: null, judgeTotal: null, total: c.pre ?? 0, reason: why };
      }
    }
    onResult?.(out[i]);
    done++;
    report();
  };

  const todo = short.map((_, i) => i).filter((i) => !out[i]);
  const lanes = Math.max(1, llm.where === "google" ? concurrency : 1);
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (todo.length) await judgeOne(todo.shift());
  }));
  return { judged: out, calls, fallbacks, secPerCandidate: times.length ? +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2) : null };
}

/** The listwise round (top n distinct windows, first and last sentence only), as on the desktop. */
export async function listwiseRound(judged, llm, { n = 4 } = {}) {
  const top = rank(judged, { k: n, iou: 0.3 });
  if (top.length < 2) return { candidates: judged, order: top.map((c) => c.id), reasons: {}, complete: true, sec: 0 };
  const t0 = performance.now();
  const r = await ask(llm, { kind: "listwise", top });
  const { order, reasons, complete } = r.parsed;
  const { candidates, byLetter } = applyListOrder(judged, top, order, reasons);
  return {
    candidates,
    order: order.map((l) => byLetter[l].id),
    reasons: Object.fromEntries(order.map((l) => [byLetter[l].id, reasons[l] || null])),
    complete,
    sec: +((performance.now() - t0) / 1000).toFixed(1),
    stats: r.stats,
  };
}

/** Rank and curve, exactly as runJob does after judging. */
export function rankAndCurve(judged, { k = 5, duration }) {
  return { ranked: rank(judged, { k, iou: 0.3 }), curve: curve(judged, duration, { step: 5 }) };
}

/**
 * A posting kit for an approved clip, or the plain one (the hook as the title) with kit: "plain".
 * strict: a failed or empty answer throws (the engine then shows the kit's own error and a
 * retry) instead of quietly returning the plain kit.
 */
export async function makeKit(candidate, llm, { plain = false, madeFor, strict = false } = {}) {
  if (plain || !llm) return plainKit(candidate);
  try {
    const r = await ask(llm, { kind: "kit", candidate, madeFor });
    if (r.parsed.title) return r.parsed;
    if (strict) throw new Error("The model's answer had no title.");
    return plainKit(candidate);
  } catch (e) {
    if (strict) throw e;
    return plainKit(candidate);
  }
}

/**
 * Faithful cuts, as checkFaithful in src/core/faithful.mjs: for each top pick, the rule
 * check, then one model call with the sentence before, the clip and the sentence after.
 * A failed or unreadable answer falls back to the rule check for that clip.
 * Returns { candidates (each with .faithful), stats }.
 */
export async function faithfulRound(ranked, llm, { words, maxLen = 90, rulesOnly = false, onProgress } = {}) {
  const t0 = performance.now();
  const sentences = toSentences(words || []);
  const out = [];
  const times = [];
  let failed = 0;
  for (let i = 0; i < ranked.length; i++) {
    const c = ranked[i];
    const { before, after } = contextFor(sentences, c);
    const hints = faithfulHints({ text: c.text, before: before?.text, after: after?.text });
    let answer = null;
    let error = null;
    if (!rulesOnly && llm) {
      const t1 = performance.now();
      try {
        const r = await ask(llm, { kind: "faithful", candidate: c, before: before?.text ?? null, after: after?.text ?? null, hints });
        answer = r.parsed;
        if (!r.cached) times.push((performance.now() - t1) / 1000);
      } catch (e) {
        failed++;
        error = `The model could not check this clip (${String(e.message).slice(0, 80)}), so only the rule check was used.`;
      }
    }
    const faithful = faithfulResult(c, { hints, answer, before, after, words, sentences, maxLen, error });
    if (before || after) faithful.context = { before: before?.text ?? null, after: after?.text ?? null };
    out.push({ ...c, faithful });
    onProgress?.({ progress: (i + 1) / ranked.length, note: `checked ${i + 1} of ${ranked.length} cuts keep what the speaker meant` });
  }
  const sec = +((performance.now() - t0) / 1000).toFixed(1);
  return { candidates: out, stats: { asked: times.length, failed, sec, secPerCall: times.length ? +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1) : null } };
}
