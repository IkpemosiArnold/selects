// Plain copy for the Selects Web UI. The UI builder can use these strings as they are.
// No em dashes; short sentences; say what leaves the device and what does not.

export const COPY = {
  title: "Selects Web",
  tagline: "Find the best short clips in a long video, in this browser tab. Your video is not uploaded.",

  privateMode: {
    name: "Private",
    line: "Everything runs in this tab. Your video, its audio and its transcript stay on this device.",
  },
  lightMode: {
    name: "Light",
    line: "Light mode sends your audio, not your video, to be transcribed.",
    detail: "For slow or costly data: about half a megabyte of compressed audio for 4 minutes of recording, instead of a 140 MB speech model. The transcript's shortlisted passages are then judged as in Smart mode.",
    busy: "The free transcriber is busy right now. Use your own free key, or transcribe on this phone.",
    keyLine: "Optional: a free Groq key from console.groq.com (no card needed). It stays in this tab and goes only to Groq.",
    waking: "Getting ready...",
  },
  smartMode: {
    name: "Smart",
    line: "Smart mode sends the transcript text of the 8 shortlisted passages to Google's Gemma model. Your video and audio stay on this device.",
    keyLine: "Paste a free Gemini API key from Google AI Studio. It is kept in this tab only and sent only to Google.",
    proxyLine: "No key? Selects can use its own key through a small server. Only the passage text goes through it, and it is not logged.",
    waking: "Waking the Smart mode server. Free hosting sleeps when idle, so this can take up to a minute.",
  },

  limits: [
    "Best for videos up to about 10 to 15 minutes. Longer videos are slow in a tab and can run out of memory.",
    "Speech is transcribed in English. For other languages, Nigerian-accented English or long videos, use the desktop app.",
    "The first run downloads the models once (sizes below). Later runs use this browser's cache.",
    "Chrome or Edge on a computer works best. A browser with WebGPU runs the larger judge model.",
  ],

  downloadsIntro: "Private mode downloads these open models once and keeps them in this browser:",
  noWebgpu: "This browser has no WebGPU, so the judge is Gemma 3 1B on the CPU. It is smaller and slower than the WebGPU model.",
  accentNote: "This speech has signs of Nigerian English or Pidgin. The desktop app can transcribe it with a model fine-tuned for Nigerian accents. Check the captions before you post.",
  rights: "Only clip video you have the rights to: your own, a paid clipping campaign, or a licence that allows adaptations, such as CC BY.",

  desktopOnly: {
    language: "Choosing another spoken language needs the desktop app. The browser build transcribes English.",
    faces: "Face blur needs the desktop app on a Mac.",
    caption: "Captioning a whole video needs the desktop app. The browser build makes short clips.",
  },
};

/**
 * Whether a picked file (a File, or a path or name) is a sound recording with no picture, from
 * its type or its extension, so the copy can say "recording" instead of "video". null when it
 * cannot tell (no file yet, or a .webm that does not say).
 */
export function isAudioFile(f) {
  if (!f) return null;
  const type = typeof f === "object" ? String(f.type || "") : "";
  const name = typeof f === "string" ? f : String(f.name || "");
  if (type.startsWith("audio/")) return true;
  if (type.startsWith("video/")) return false;
  if (/\.(m4a|mp3|aac|wav|flac|ogg|oga|opus)$/i.test(name)) return true;
  if (/\.(mp4|mov|m4v|mkv|avi|mts|3gp)$/i.test(name)) return false;
  return null;
}

/** "recording", "video" or "file" for isAudioFile's answer. */
export const fileWord = (audio) => (audio === true ? "recording" : audio === false ? "video" : "file");

/**
 * The key hint in Light mode. The shared transcriber is promised only when the proxy confirmed
 * it is on; when the check failed (CORS on a preview, a cold server) or said it is off, the
 * hint asks for a key; while it is still checking, it says so.
 */
export function lightHint(mode) {
  if (mode?.lightShared === true) return "Without a key, Selects uses its free shared transcriber, which does not keep the audio or the words. Your key stays in this tab and goes only to Groq.";
  if (mode?.lightShared === false || mode?.lightChecked) return "Make one free at console.groq.com, no card needed. It stays in this tab and goes only to Groq.";
  return "Checking whether the free shared transcriber is on. Your key stays in this tab and goes only to Groq.";
}

/** The warning above the key field in Light mode, or null when there is nothing to warn about. */
export function lightWarning(mode) {
  if (mode?.hasGroqKey || mode?.lightShared === true) return null;
  if (mode?.lightShared === false) return "The free shared transcriber is not switched on yet, so Light mode needs your own free Groq key for now. Or use Private.";
  if (mode?.lightChecked) return "Selects could not reach its free shared transcriber, so Light mode needs your own free Groq key for now. Or use Private.";
  return null;
}
