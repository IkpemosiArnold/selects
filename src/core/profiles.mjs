// Speaker or channel profiles: remember the language and speech settings that worked for
// someone, so the next video of the same person starts right (and the language check
// includes their language). Stored in <SELECTS_HOME>/profiles.json.
import path from "node:path";
import { selectsHome } from "./config.mjs";
import { readJson, writeJsonAtomic } from "./util.mjs";

const KEYS = ["language", "asrModel", "asrPrompt", "asrPreprocess", "captionStyle"];
const file = () => path.join(selectsHome(), "profiles.json");

export function loadProfiles() {
  return readJson(file(), {});
}

export function saveProfile(name, settings) {
  if (!name || !/^[\w .'-]{1,60}$/.test(name)) throw Object.assign(new Error("A profile name is 1 to 60 letters, digits, spaces, dots, dashes or apostrophes."), { status: 400 });
  const all = loadProfiles();
  const p = {};
  for (const k of KEYS) if (settings[k] != null) p[k] = settings[k];
  all[name] = { ...p, updatedAt: new Date().toISOString() };
  writeJsonAtomic(file(), all);
  return all[name];
}

/**
 * Merge a profile into job settings. Explicit settings win. The profile's language is also
 * kept as rememberedLanguage, so the language check always tries it.
 */
export function applyProfile(settings, profiles = loadProfiles()) {
  const name = settings.profile;
  if (!name) return settings;
  const p = profiles[name];
  if (!p) throw Object.assign(new Error(`No profile called "${name}".`), { status: 400, hint: `Known: ${Object.keys(profiles).join(", ") || "none yet"}. Save one with --save-profile.` });
  const out = { ...settings };
  for (const k of KEYS) if (out[k] == null && p[k] != null) out[k] = p[k];
  if (p.language && p.language !== "auto") out.rememberedLanguage = p.language;
  return out;
}
