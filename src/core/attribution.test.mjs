import assert from "node:assert/strict";
import { test } from "node:test";
import { attributionLine, captionWithCredit, licenseCheck, normaliseLicense } from "./attribution.mjs";

test("normaliseLicense accepts the usual spellings", () => {
  assert.equal(normaliseLicense("CC-BY-SA-4.0"), "CC-BY-SA-4.0");
  assert.equal(normaliseLicense("cc by-sa 4.0"), "CC-BY-SA-4.0");
  assert.equal(normaliseLicense("by-sa"), "CC-BY-SA-4.0");
  assert.equal(normaliseLicense("CC BY 3.0"), "CC-BY-3.0");
  assert.equal(normaliseLicense("by-nc-nd"), "CC-BY-NC-ND-4.0");
  assert.equal(normaliseLicense("cc0"), "CC0-1.0");
  assert.equal(normaliseLicense("all rights reserved"), null);
});

test("attribution names the creator, the licence with its URL, and the change", () => {
  const line = attributionLine({ credit: "Jenni, EMF 2026", license: "CC-BY-SA-4.0", sourceUrl: "https://media.ccc.de/v/x" });
  assert.equal(
    line,
    "Clip from Jenni, EMF 2026 (https://media.ccc.de/v/x). Licensed under CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/. Cut, reframed and captioned from the original. This clip is shared under CC BY-SA 4.0 too.",
  );
  assert.doesNotMatch(line, /[—–]/, "no dashes");
  assert.equal(attributionLine({}), null);
});

test("captionWithCredit appends the line only when there is something to credit", () => {
  assert.equal(captionWithCredit("Watch this.", {}), "Watch this.");
  assert.match(captionWithCredit("Watch this.", { credit: "Jenni", license: "by" }), /^Watch this\.\n\nClip from Jenni\. Licensed under CC BY 4\.0/);
});

test("licenseCheck blocks ND and warns on NC", () => {
  assert.equal(licenseCheck("CC-BY-SA-4.0").ok, true);
  assert.equal(licenseCheck("CC-BY-NC-ND-4.0").ok, false);
  assert.equal(licenseCheck("CC-BY-NC-4.0").warnings.length, 1);
});
