// The posting kit's pure parts, with no Node imports: the JSON schema, the chat messages
// from the kit.md prompt text, and cleaning the model's answer. kit.mjs (Ollama) and the
// browser build (src/browser) share them.
import { splitPrompt } from "./judge-core.mjs";
import { DEFAULT_MADE_FOR, MADE_FOR, madeForBlock } from "./madefor.mjs";

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

/** The kit's JSON schema for a "made for" preset: the hashtag count follows the platform. */
export function kitSchema(madeFor = DEFAULT_MADE_FOR) {
  const [min, max] = (MADE_FOR[madeFor] || MADE_FOR[DEFAULT_MADE_FOR]).hashtags;
  return { ...KIT_SCHEMA, properties: { ...KIT_SCHEMA.properties, hashtags: { type: "array", items: { type: "string" }, minItems: min, maxItems: max } } };
}

/**
 * The kit's chat messages for one candidate, from the text of prompts/kit.md. The system
 * part's {{format}} gets the block for the "made for" preset (default shorts).
 */
export function kitMessages(md, candidate, { madeFor = DEFAULT_MADE_FOR } = {}) {
  const { system: raw, user } = splitPrompt(md, "prompts/kit.md");
  const format = madeForBlock(md, MADE_FOR[madeFor] ? madeFor : DEFAULT_MADE_FOR);
  const system = raw.replace("{{format}}", format).replace(/\n{3,}/g, "\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user.replace("{{duration}}", String(Math.round(candidate.end - candidate.start))).replace("{{text}}", candidate.text.trim()) },
  ];
}

/**
 * Tidy a parsed answer: no dashes, lowercase hashtags without # (at most 5, or the preset's
 * most: 3 for LinkedIn, 1 for X), a title under 80 characters.
 */
export function cleanKit(d, { madeFor } = {}) {
  const max = MADE_FOR[madeFor]?.hashtags?.[1] ?? 5;
  const tags = (Array.isArray(d?.hashtags) ? d.hashtags : [])
    .map((t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
  const out = { title: noDash(d?.title).replace(/^["']|["']$/g, "").slice(0, 80), caption: noDash(d?.caption), hashtags: [...new Set(tags)].slice(0, max) };
  if (madeFor) out.madeFor = madeFor;
  return out;
}
