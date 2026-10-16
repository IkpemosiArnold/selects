// Speech-recognition providers behind one interface, so a cloud option can be added later
// without touching the pipeline. Only whisper.cpp (local) is built.
//
// Provider shape:
//   { id, label, local: boolean,
//     available(): Promise<boolean>,
//     transcribe(videoPath, { cacheDir, duration, language, model, prompt, translate,
//                             preprocess, audioStream, signal, onProgress, onWords }) -> Promise<Word[]> }
// Word: { w, s, e, p } (text, start s, end s, probability 0..1)
import fs from "node:fs";
import { whisperBin } from "../config.mjs";
import { transcribe as whisperTranscribe } from "../transcribe.mjs";

export const whisperCpp = {
  id: "whisper.cpp",
  label: "whisper.cpp (on this computer)",
  local: true,
  async available() {
    const b = whisperBin();
    return b.includes("/") ? fs.existsSync(b) : true;
  },
  transcribe: (videoPath, opts) => whisperTranscribe(videoPath, opts),
};

// A possible future option for Yoruba and other languages whisper handles poorly. It would
// upload audio, so it must stay opt-in and say so plainly. Not built.
export const elevenlabsScribe = {
  id: "elevenlabs-scribe",
  label: "ElevenLabs Scribe (cloud, opt-in, not built)",
  local: false,
  async available() {
    return false;
  },
  async transcribe() {
    const err = new Error("The ElevenLabs Scribe provider is not built yet.");
    err.hint = "Use the local whisper.cpp provider (the default).";
    throw err;
  },
};

export const PROVIDERS = { [whisperCpp.id]: whisperCpp, [elevenlabsScribe.id]: elevenlabsScribe };

export function asrProvider(id = "whisper.cpp") {
  const p = PROVIDERS[id];
  if (!p) throw Object.assign(new Error(`Unknown speech-recognition provider "${id}".`), { hint: `Known: ${Object.keys(PROVIDERS).join(", ")}.` });
  return p;
}
