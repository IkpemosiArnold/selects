// Language ID: the ensemble (rule.mjs), text models (textlid.mjs), accent routing (accent.mjs).
export { ensemble, textSignal, ng5Verdict, WEIGHTS, MIN_CONFIDENCE } from "./rule.mjs";
export { identifyTexts, textLidModels, read608 } from "./textlid.mjs";
export { accentRoute, nigerianCues, NG_TEXT_SHARE, NG_AUDIO_P } from "./accent.mjs";
export { toWhisperCode, WHISPER_LANGS } from "./codes.mjs";
