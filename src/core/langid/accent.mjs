// Accent routing: English with a Nigerian accent goes to a whisper fine-tune for it
// (rishabbahal/whisper-small-nigerian-accent, Apache-2.0). On 60 s of an elderly Nigerian
// speaker it raised mean word confidence from 0.77 (base.en) to 0.93 and cut unsure words
// from 18% to 2%, at about a third of base.en's speed. So it is only used when there is a
// reason to: a setting or profile, or cues from the language check.
import fs from "node:fs";
import { accentModel } from "../config.mjs";
import { NIGERIAN_WHISPER } from "./codes.mjs";

/** lid-lite-5's Nigerian-language share on English text above this is a text cue. */
export const NG_TEXT_SHARE = 0.25;
/** whisper's detector hearing a Nigerian language at this p, on speech that is English, is an audio cue. */
export const NG_AUDIO_P = 0.5;

/**
 * Cues that English speech has a Nigerian accent.
 *   detected  whisper's audio guess { code, p }
 *   texts     [{ asked, ng5: probs | null, lid608: { pcm } | null }] for the samples
 * Returns [{ kind: "audio" | "text", note }].
 */
export function nigerianCues({ language, detected = null, texts = [] } = {}) {
  const cues = [];
  if (language !== "en") return cues;
  if (detected && NIGERIAN_WHISPER.has(detected.code) && detected.p >= NG_AUDIO_P) {
    cues.push({ kind: "audio", note: `whisper's detector heard ${detected.code} (p = ${detected.p}) in speech that is English` });
  }
  // the English decode's text: words and phrases lid-lite-5 knows from Nigerian languages or Pidgin
  const en = texts.find((t) => t.asked === "en" && t.ng5);
  if (en) {
    const share = 1 - (en.ng5.eng ?? 1);
    if (share >= NG_TEXT_SHARE) cues.push({ kind: "text", note: `lid-lite-5 gives the English text a ${Math.round(share * 100)}% Nigerian-language share` });
  }
  const pcm = texts.find((t) => t.asked === "en" && t.lid608?.pcm >= 0.3);
  if (pcm) cues.push({ kind: "text", note: `lid-lite-608 reads the English text as ${Math.round(pcm.lid608.pcm * 100)}% Nigerian Pidgin` });
  return cues;
}

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
