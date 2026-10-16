// Posting kit: a suggested title, caption and hashtags for an approved clip.
import fs from "node:fs";
import path from "node:path";
import { PROMPTS_DIR } from "./config.mjs";
import { ollamaJson } from "./judge.mjs";
import { appendJsonLine } from "./util.mjs";

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    caption: { type: "string" },
    hashtags: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 5 },
  },
  required: ["title", "caption", "hashtags"],
};

const noDash = (s) => String(s || "").replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim();

/** Fallback when no model is available: the hook line as the title. */
export function plainKit(candidate) {
  const title = candidate.hook.replace(/[.!?]+$/, "").slice(0, 60);
  return { title, caption: candidate.hook, hashtags: [] };
}

/**
 * @param {object} candidate
 * @param {{model:string, request?:Function, signal?:AbortSignal, cacheDir?:string}} opts
 *   with `cacheDir`, the call is appended to <cacheDir>/judge-calls.jsonl (kind "kit")
 * @returns {Promise<{title:string, caption:string, hashtags:string[]}>}
 */
export async function postingKit(candidate, { model, request, signal, cacheDir } = {}) {
  const md = fs.readFileSync(path.join(PROMPTS_DIR, "kit.md"), "utf8");
  const system = md.split("<!-- system -->")[1].split("<!-- user -->")[0].trim();
  const user = md
    .split("<!-- user -->")[1]
    .trim()
    .replace("{{duration}}", String(Math.round(candidate.end - candidate.start)))
    .replace("{{text}}", candidate.text.trim());
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const ask = request || ((m) => ollamaJson({ model, messages: m, schema: SCHEMA, numPredict: 120, signal }));
  const res = await ask(messages);
  if (cacheDir && res.stats) appendJsonLine(path.join(cacheDir, "judge-calls.jsonl"), { at: new Date().toISOString(), model, id: candidate.id, kind: "kit", ...res.stats });
  const d = res.data ?? res;
  const tags = (Array.isArray(d.hashtags) ? d.hashtags : [])
    .map((t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter(Boolean)
    .slice(0, 5);
  return { title: noDash(d.title).replace(/^["']|["']$/g, "").slice(0, 80), caption: noDash(d.caption), hashtags: [...new Set(tags)] };
}
