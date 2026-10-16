import assert from "node:assert/strict";
import { test } from "node:test";
import { applyProfile } from "./profiles.mjs";

test("a profile fills unset settings and remembers its language", () => {
  const profiles = { Grandma: { language: "en", asrModel: "small.en" } };
  const s = applyProfile({ profile: "Grandma", asrModel: "medium.en-q5_0" }, profiles);
  assert.equal(s.language, "en");
  assert.equal(s.asrModel, "medium.en-q5_0", "explicit settings win");
  assert.equal(s.rememberedLanguage, "en");
  assert.deepEqual(applyProfile({ k: 3 }, profiles), { k: 3 });
  assert.throws(() => applyProfile({ profile: "Nobody" }, profiles), /No profile/);
});
