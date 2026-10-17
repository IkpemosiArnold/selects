// "Made for" presets: where the clips will be posted. A preset changes only three things: the
// clip length range, the caption style default and the posting kit's tone and format. Clip
// selection is the same for all of them, except "story", where the judge gets one extra line
// asking for a complete story (setup, turn, resolution). No Node imports (the browser build
// shares this file).

export const MADE_FOR = {
  shorts: { label: "Shorts, Reels or TikTok", minLen: 20, maxLen: 60, captionStyle: "bold", hashtags: [3, 5], captionMax: 200, titleMax: 60 },
  linkedin: { label: "LinkedIn", minLen: 30, maxLen: 90, captionStyle: "subtitle", hashtags: [0, 3], captionMax: 600, titleMax: 70 },
  x: { label: "X", minLen: 15, maxLen: 45, captionStyle: "bold", hashtags: [0, 1], captionMax: 200, titleMax: 60 },
  story: { label: "A story (60 to 90 s)", minLen: 60, maxLen: 90, captionStyle: "bold", hashtags: [3, 5], captionMax: 200, titleMax: 60, storyJudge: true },
};

export const DEFAULT_MADE_FOR = "shorts";

/** The preset for a name (undefined or null is the default). Throws a 400 for an unknown name. */
export function madeForPreset(name) {
  const key = name == null || name === "" ? DEFAULT_MADE_FOR : String(name).toLowerCase();
  const p = MADE_FOR[key];
  if (!p) throw Object.assign(new Error(`Unknown "made for" preset "${name}". Use ${Object.keys(MADE_FOR).join(", ")}.`), { status: 400, hint: "shorts is Shorts, Reels or TikTok (20 to 60 s), linkedin (30 to 90 s), x (15 to 45 s), story (60 to 90 s with a complete arc)." });
  return { key, ...p };
}

/**
 * Settings for a clips job with the preset filled in: the length range and the caption style
 * come from the preset unless the person set them. `given` is what the person passed.
 */
export function applyMadeFor(given = {}) {
  const p = madeForPreset(given.madeFor);
  const out = { ...given, madeFor: p.key };
  if (given.minLen == null && given.maxLen == null) {
    out.minLen = p.minLen;
    out.maxLen = p.maxLen;
  } else if (given.minLen == null) out.minLen = Math.min(p.minLen, given.maxLen);
  else if (given.maxLen == null) out.maxLen = Math.max(p.maxLen, given.minLen);
  if ((given.mode ?? "clips") === "clips" && (given.captionStyle == null || given.captionStyle === "auto")) out.captionStyle = p.captionStyle;
  return out;
}

/** The caption style a clip render uses: an explicit bold or subtitle, else the preset's. */
export function clipCaptionStyle(settings = {}) {
  if (settings.captionStyle === "bold" || settings.captionStyle === "subtitle") return settings.captionStyle;
  return MADE_FOR[settings.madeFor]?.captionStyle ?? "bold";
}

/**
 * A `<!-- made-for: key -->` ... `<!-- /made-for -->` block from a prompt file's notes, or "".
 * The judge and kit prompts keep their per-preset lines there, outside the system and user
 * parts, so the prompt files stay readable and their cache versions do not change.
 */
export function madeForBlock(md, key) {
  const re = new RegExp(`<!--\\s*made-for:\\s*${String(key).replace(/[^a-z]/gi, "")}\\s*-->([\\s\\S]*?)<!--\\s*/made-for\\s*-->`, "i");
  return (String(md).match(re)?.[1] ?? "").trim();
}
