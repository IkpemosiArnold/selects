// The posting kit's pure parts, with no Node imports: the JSON schema, the chat messages
// from the kit.md prompt text, and cleaning the model's answer. kit.mjs (Ollama) and the
// browser build (src/browser) share them.
import { splitPrompt } from "./judge-core.mjs";

export const KIT_SCHEMA = {
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

/** The kit's chat messages for one candidate, from the text of prompts/kit.md. */
export function kitMessages(md, candidate) {
  const { system, user } = splitPrompt(md, "prompts/kit.md");
  return [
    { role: "system", content: system },
    { role: "user", content: user.replace("{{duration}}", String(Math.round(candidate.end - candidate.start))).replace("{{text}}", candidate.text.trim()) },
  ];
}

/** Tidy a parsed answer: no dashes, at most 5 lowercase hashtags without #, a title under 80 characters. */
export function cleanKit(d) {
  const tags = (Array.isArray(d?.hashtags) ? d.hashtags : [])
    .map((t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter(Boolean)
    .slice(0, 5);
  return { title: noDash(d?.title).replace(/^["']|["']$/g, "").slice(0, 80), caption: noDash(d?.caption), hashtags: [...new Set(tags)] };
}
