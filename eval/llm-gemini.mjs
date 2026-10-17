// Gemma through the Gemini API for the eval, as a `request` function for src/core/judge.mjs
// and src/core/faithful.mjs. Same call as Smart mode (src/core/gemini.mjs), plus a client-side
// rate limit for the free tier (about 30 requests and 15,000 tokens a minute) and patient
// retries on 429. The key comes from GEMINI_API_KEY in the environment or the repo's .env.
// It is never logged or written anywhere.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { geminiGenerate } from "../src/core/gemini.mjs";
import { extractJson } from "../src/core/tasks.mjs";

export const GEMMA4 = "gemma-4-26b-a4b-it";

export function geminiKey(root) {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const f = join(root, ".env");
  if (!existsSync(f)) return null;
  const m = /^\s*GEMINI_API_KEY\s*=\s*["']?([^"'\s#]+)/m.exec(readFileSync(f, "utf8"));
  return m ? m[1] : null;
}

/**
 * A limiter shared by every call in the process. Keeps both the request count and an
 * estimate of the tokens in the last 60 s under the limits.
 */
export function rateLimiter({ rpm = 28, tpm = 14000 } = {}) {
  const log = []; // { t, tokens }
  return {
    async wait(tokens) {
      for (;;) {
        const now = Date.now();
        while (log.length && now - log[0].t > 60_000) log.shift();
        const used = log.reduce((s, x) => s + x.tokens, 0);
        if (log.length < rpm && used + tokens <= tpm) {
          log.push({ t: now, tokens });
          return;
        }
        const wait = log.length ? 60_000 - (now - log[0].t) + 50 : 1000;
        await sleep(Math.max(200, wait));
      }
    },
    correct(estimate, actual) {
      const last = [...log].reverse().find((x) => x.tokens === estimate);
      if (last && actual) last.tokens = actual;
    },
  };
}

/**
 * Make a request function: (messages) -> { data, stats }. Throws an error with `content`
 * and `retryable` when the answer is not JSON, so the core's salvage path can read it.
 */
export function geminiRequest({ key, model = GEMMA4, schema, maxTokens = 256, limiter, onCall, timeoutMs = 60000 }) {
  if (!key) throw new Error("GEMINI_API_KEY is not set (put it in .env)");
  let features = {};
  return async (messages) => {
    const chars = messages.reduce((s, m) => s + m.content.length, 0);
    const estimate = Math.ceil(chars / 3.5) + maxTokens;
    for (let attempt = 1; ; attempt++) {
      await limiter?.wait(estimate);
      try {
        const r = await geminiGenerate({ key, model, messages, schema, maxTokens, temperature: 0.2, features, timeoutMs, retries: 2 });
        features = r.features;
        limiter?.correct(estimate, (r.promptTokens || 0) + (r.outTokens || 0) + (r.thoughtTokens || 0));
        const stats = { wallSec: r.wallSec, promptTokens: r.promptTokens, outTokens: r.outTokens, thoughtTokens: r.thoughtTokens, finish: r.finish, attempts: attempt };
        onCall?.(stats);
        const data = extractJson(r.text);
        if (!data) throw Object.assign(new Error(`not JSON: ${String(r.text).slice(0, 80)}`), { content: r.text, retryable: true, stats });
        return { data, stats };
      } catch (e) {
        if (e.content != null) throw e;
        const quota = e.status === 429;
        if ((quota || e.transient) && attempt < 8) {
          await sleep(quota ? 30_000 * Math.min(attempt, 4) : 5_000 * attempt);
          continue;
        }
        throw e;
      }
    }
  };
}
