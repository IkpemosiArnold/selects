// Posting kit: a suggested title, caption and hashtags for an approved clip.
import fs from "node:fs";
import path from "node:path";
import { PROMPTS_DIR } from "./config.mjs";
import { ollamaJson } from "./judge.mjs";
import { cleanKit, kitMessages, kitSchema } from "./kit-core.mjs";
import { appendJsonLine } from "./util.mjs";

// the schema, the messages and the answer clean-up have no Node imports (kit-core.mjs)
export { plainKit, kitMessages, cleanKit, KIT_SCHEMA, kitSchema } from "./kit-core.mjs";

/**
 * @param {object} candidate
 * @param {{model:string, madeFor?:string, request?:Function, signal?:AbortSignal, cacheDir?:string}} opts
 *   madeFor: the platform preset (shorts, linkedin, x, story) that sets the copy's tone and format;
 *   with `cacheDir`, the call is appended to <cacheDir>/judge-calls.jsonl (kind "kit")
 * @returns {Promise<{title:string, caption:string, hashtags:string[]}>}
 */
export async function postingKit(candidate, { model, request, signal, cacheDir, madeFor = "shorts" } = {}) {
  const messages = kitMessages(fs.readFileSync(path.join(PROMPTS_DIR, "kit.md"), "utf8"), candidate, { madeFor });
  // LinkedIn copy runs longer (a hook line, then two or three sentences)
  const ask = request || ((m) => ollamaJson({ model, messages: m, schema: kitSchema(madeFor), numPredict: madeFor === "linkedin" ? 200 : 120, signal }));
  const res = await ask(messages);
  if (cacheDir && res.stats) appendJsonLine(path.join(cacheDir, "judge-calls.jsonl"), { at: new Date().toISOString(), model, id: candidate.id, kind: "kit", ...res.stats });
  return cleanKit(res.data ?? res, { madeFor });
}
