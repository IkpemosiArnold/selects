// Accent routing: English with a Nigerian accent goes to a whisper fine-tune for it
// (rishabbahal/whisper-small-nigerian-accent, Apache-2.0). On 60 s of an elderly Nigerian
// speaker it raised mean word confidence from 0.77 (base.en) to 0.93 and cut unsure words
// from 18% to 2%, at about a third of base.en's speed. So it is only used when there is a
// reason to: a setting or profile, or cues from the language check.
import fs from "node:fs";
import { accentModel } from "../config.mjs";
import { nigerianCues, NG_AUDIO_P, NG_TEXT_SHARE } from "./cues.mjs";

// the cues have no Node imports (cues.mjs), so the browser build reads the same signs
export { nigerianCues, NG_AUDIO_P, NG_TEXT_SHARE };

/**
 * Decide which whisper model to use for an accent.
 *   accent    setting: "auto" (route on cues), "ng" (always, for English), "none" (never)
 *   asrModel  the asrModel setting; anything but "auto" is the user's choice and wins
 *   language  the language Selects will transcribe
 *   cues      from nigerianCues
 * Returns { accent: "ng" | null, model: path | null, cues, reason }.
 */
export function accentRoute({ accent = "auto", asrModel = "auto", language = "en", cues = [], exists = fs.existsSync } = {}) {
  const out = (a, model, reason) => ({ accent: a, model, cues, reason });
  if (language !== "en") return out(null, null, "the language is not English");
  if (accent === "none") return out(null, null, "accent routing is off");
  const wants = accent === "ng" || (accent === "auto" && cues.length > 0);
  if (!wants) return out(null, null, "no accent cues");
  if (asrModel && asrModel !== "auto") return out("ng", null, `the speech model is set to ${asrModel}, so it is kept`);
  const model = accentModel("ng");
  if (!model || !exists(model)) return out("ng", null, "the Nigerian-accent model is not installed");
  return out("ng", model, accent === "ng" ? "the setting or profile says Nigerian English" : cues.map((c) => c.note).join("; "));
}
