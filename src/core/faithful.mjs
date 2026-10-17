// Faithful cuts on the desktop: for each top pick, the rule check, then one Ollama call with
// the sentence before, the clip and the sentence after. Cached in judge-cache.json, logged in
// judge-calls.jsonl (kind "faithful"). The pure parts are in faithful-core.mjs.
import fs from "node:fs";
import path from "node:path";
import { PROMPTS_DIR } from "./config.mjs";
import { contextFor, FAITHFUL_SCHEMA, faithfulHints, faithfulMessages, faithfulPrompt, faithfulResult, readFaithful } from "./faithful-core.mjs";
import { ollamaJson } from "./judge.mjs";
import { toSentences } from "./sentences.mjs";
import { appendJsonLine, readJson, sha1, writeJsonAtomic } from "./util.mjs";

export { contextFor, faithfulHints, faithfulFix, faithfulMessages, faithfulResult, isDemoted, orderByFaithful, readFaithful, FAITHFUL_SCHEMA } from "./faithful-core.mjs";

let promptCache = null;
export function loadFaithfulPrompt() {
  if (promptCache) return promptCache;
  const p = faithfulPrompt(fs.readFileSync(path.join(PROMPTS_DIR, "faithful.md"), "utf8"));
  promptCache = { ...p, version: sha1(`${p.system}\n---\n${p.user}`).slice(0, 10) };
  return promptCache;
}

/**
 * Check that each candidate still says what the speaker meant.
 * @param {object[]} candidates the top picks (after ranking)
 * @param {{words:object[], model?:string, mode?:"model"|"rules", maxLen?:number, cacheDir?:string,
 *   request?:Function, signal?:AbortSignal, onProgress?:Function}} opts
 *   mode "rules" never calls the model. A failed model call falls back to the rules for that clip.
 * @returns {Promise<{candidates:object[], stats:{asked:number, cached:number, failed:number, sec:number, secPerCall:number|null}}>}
 */
export async function checkFaithful(candidates, { words, model, mode = "model", maxLen = 90, cacheDir, request, signal, onProgress } = {}) {
  const t0 = Date.now();
  const sentences = toSentences(words || []);
  const prompt = mode === "model" ? loadFaithfulPrompt() : null;
  const cacheFile = cacheDir ? path.join(cacheDir, "judge-cache.json") : null;
  const ask = request || ((messages) => ollamaJson({ model, messages, schema: FAITHFUL_SCHEMA, numPredict: 130, signal }));
  const out = [];
  const times = [];
  let cached = 0;
  let failed = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const c = candidates[i];
    const { before, after } = contextFor(sentences, c);
    const hints = faithfulHints({ text: c.text, before: before?.text, after: after?.text });
    let answer = null;
    let error = null;
    if (mode === "model") {
      const ctx = { text: c.text, before: before?.text, after: after?.text, hints };
      const messages = faithfulMessages(prompt, ctx);
      const key = sha1(`faithful|${model}|${prompt.version}|${messages[1].content}`);
      const cache = cacheFile ? readJson(cacheFile, {}) : {};
      if (cache[key]) {
        answer = cache[key].answer;
        cached++;
      } else {
        const started = Date.now();
        try {
          let res;
          try {
            res = await ask(messages);
            answer = readFaithful(res.data ?? res, hints);
          } catch (e) {
            if (e.name === "AbortError" || e.content == null) throw e;
            res = { stats: e.stats };
            answer = readFaithful(e.content, hints); // a cut-off answer may still hold the verdict
          }
          const sec = +((Date.now() - started) / 1000).toFixed(2);
          times.push(sec);
          if (cacheDir && res?.stats) appendJsonLine(path.join(cacheDir, "judge-calls.jsonl"), { at: new Date().toISOString(), model, id: c.id, kind: "faithful", words: c.text.split(/\s+/).length, ...res.stats });
          if (answer && cacheFile) {
            const fresh = readJson(cacheFile, {});
            fresh[key] = { answer, sec };
            writeJsonAtomic(cacheFile, fresh);
          }
          if (!answer) error = "The model's answer had no verdict, so only the rule check was used.";
        } catch (e) {
          if (e.name === "AbortError") throw e;
          failed++;
          error = `The model could not check this clip (${String(e.message).slice(0, 80)}), so only the rule check was used.`;
        }
      }
    }
    const faithful = faithfulResult(c, { hints, answer, before, after, words, sentences, maxLen, error });
    if (before || after) faithful.context = { before: before?.text ?? null, after: after?.text ?? null };
    out.push({ ...c, faithful });
    const secPer = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
    onProgress?.({ progress: (i + 1) / candidates.length, done: i + 1, total: candidates.length, etaSec: secPer == null ? null : Math.round(secPer * (candidates.length - i - 1)), note: `checked ${i + 1} of ${candidates.length} cuts keep what the speaker meant` });
  }
  const sec = +((Date.now() - t0) / 1000).toFixed(1);
  return { candidates: out, stats: { asked: times.length, cached, failed, sec, secPerCall: times.length ? +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1) : null } };
}
