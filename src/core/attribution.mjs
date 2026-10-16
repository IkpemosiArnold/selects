// Attribution for clips cut from Creative Commons work.
// A clip is an adaptation, so CC licences ask for: who made it, where it came from, the
// licence with a link, and a note that it was changed. ND licences do not allow
// adaptations at all, and SA licences ask that the clip be shared under the same licence.

export const LICENSES = {
  "CC-BY-4.0": { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
  "CC-BY-SA-4.0": { name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/", shareAlike: true },
  "CC-BY-NC-4.0": { name: "CC BY-NC 4.0", url: "https://creativecommons.org/licenses/by-nc/4.0/", nonCommercial: true },
  "CC-BY-NC-SA-4.0": { name: "CC BY-NC-SA 4.0", url: "https://creativecommons.org/licenses/by-nc-sa/4.0/", nonCommercial: true, shareAlike: true },
  "CC-BY-ND-4.0": { name: "CC BY-ND 4.0", url: "https://creativecommons.org/licenses/by-nd/4.0/", noDerivatives: true },
  "CC-BY-NC-ND-4.0": { name: "CC BY-NC-ND 4.0", url: "https://creativecommons.org/licenses/by-nc-nd/4.0/", nonCommercial: true, noDerivatives: true },
  "CC-BY-3.0": { name: "CC BY 3.0", url: "https://creativecommons.org/licenses/by/3.0/" },
  "CC-BY-SA-3.0": { name: "CC BY-SA 3.0", url: "https://creativecommons.org/licenses/by-sa/3.0/", shareAlike: true },
  "CC0-1.0": { name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/", publicDomain: true },
};

export const MEDIA_REMINDER = "Check slides and on-screen media: a talk's licence may not cover every figure.";

/** settings.license value for the person's own footage (not a licence id; no credit line). */
export const OWN_FOOTAGE = "own";

const filled = (v) => typeof v === "string" ? v.trim() !== "" : v != null;

/**
 * The slide and media reminder, or null when it does not apply. It applies when the job
 * credits someone or names a licence or source link, since that means someone else's
 * work. Own footage, or nothing set, gets no reminder. (web/src/lib/licences.js has the
 * same rule for the render screen.)
 */
export function mediaReminder({ credit, license, sourceUrl } = {}) {
  if (license === OWN_FOOTAGE) return null;
  return filled(credit) || filled(license) || filled(sourceUrl) ? MEDIA_REMINDER : null;
}

/** Accept "CC-BY-SA-4.0", "cc by-sa 4.0", "by-sa" and similar. Returns the canonical id or null. */
export function normaliseLicense(input) {
  if (!input) return null;
  let s = String(input).trim().toUpperCase().replace(/[\s_]+/g, "-").replace(/^CC-?/, "");
  if (/^(0|ZERO|CC0)/.test(s) || s === "PUBLIC-DOMAIN") return "CC0-1.0";
  s = s.replace(/-?(\d\.\d)$/, "-$1");
  const ver = s.match(/(\d\.\d)$/)?.[1] || "4.0";
  const parts = s.replace(/-?\d\.\d$/, "").split("-").filter(Boolean);
  const order = ["BY", "NC", "SA", "ND"].filter((p) => parts.includes(p));
  const id = `CC-${order.join("-")}-${ver}`;
  return LICENSES[id] ? id : null;
}

/**
 * Check a licence before clipping. Returns { ok, warnings[] }: ND means no clips at all,
 * NC means no paid campaigns.
 */
export function licenseCheck(licenseId) {
  const l = LICENSES[licenseId];
  if (!l) return { ok: true, warnings: [] };
  const warnings = [];
  if (l.noDerivatives) warnings.push(`${l.name} does not allow adaptations, and a clip is one. Do not post these clips without the creator's permission.`);
  if (l.nonCommercial) warnings.push(`${l.name} does not allow commercial use, so paid clipping campaigns are out.`);
  return { ok: !l.noDerivatives, warnings };
}

/**
 * One attribution line for a post caption, or null when there is nothing to credit.
 * @param {{credit?:string, license?:string, sourceUrl?:string}} s
 */
export function attributionLine({ credit, license, sourceUrl } = {}) {
  const id = normaliseLicense(license);
  const l = id ? LICENSES[id] : null;
  if (!credit && !l) return null;
  const parts = [];
  parts.push(`Clip from ${credit ? credit : "the original video"}${sourceUrl ? ` (${sourceUrl})` : ""}`);
  if (l?.publicDomain) parts.push(`Dedicated to the public domain under ${l.name}: ${l.url}`);
  else if (l) parts.push(`Licensed under ${l.name}: ${l.url}`);
  parts.push("Cut, reframed and captioned from the original");
  if (l?.shareAlike) parts.push(`This clip is shared under ${l.name} too`);
  return parts.join(". ") + ".";
}

/** The caption with the attribution line appended (if any). */
export function captionWithCredit(caption, settings) {
  const line = attributionLine(settings);
  return line ? `${caption.trim()}\n\n${line}` : caption.trim();
}
