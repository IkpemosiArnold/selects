// Signs of Nigerian-accented English, with no Node imports (accent.mjs re-exports these;
// the browser build reads them to say when the desktop app would do better).
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
