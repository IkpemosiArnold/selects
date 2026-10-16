// Licence choices offered in the brief. Values are the ids the core normalises to.
export const LICENCES = [
  ["", "Choose a licence"],
  ["CC-BY-4.0", "CC BY 4.0"],
  ["CC-BY-SA-4.0", "CC BY-SA 4.0"],
  ["CC0-1.0", "Public domain"],
  ["own", "Own footage"],
  ["other", "Other"],
];

const filled = (v) => (typeof v === "string" ? v.trim() !== "" : v != null);

/**
 * Whether to show the slide and media reminder: only when the job credits someone or
 * names a licence or source link. Own footage, or nothing set, needs none.
 * Same rule as mediaReminder in src/core/attribution.mjs.
 */
export function needsMediaReminder({ credit, license, sourceUrl } = {}) {
  if (license === "own") return false;
  return filled(credit) || filled(license) || filled(sourceUrl);
}
