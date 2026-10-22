// Safari before 26 has no WebCodecs AudioDecoder, so Selects cannot read any video's sound
// there: the page says so plainly at the first step instead of failing later.
import assert from "node:assert/strict";
import { test } from "node:test";
import { audioDecodeUnsupported } from "./media.js";

const OLD_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";

test("an iPhone without an audio decoder is told to update iOS", () => {
  const e = audioDecodeUnsupported({ navigator: { userAgent: OLD_IPHONE, maxTouchPoints: 5 } });
  assert.match(e.message, /iPhone's Safari is too old/);
  assert.match(e.hint, /iOS 26/);
  assert.doesNotMatch(e.message + e.hint, /—/);
});

test("another browser without one is told to update the browser", () => {
  assert.match(audioDecodeUnsupported({ navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0" } }).message, /too old to read/);
});

test("a browser with an audio decoder passes", () => {
  assert.equal(audioDecodeUnsupported({ AudioDecoder: class {}, navigator: { userAgent: OLD_IPHONE } }), null);
});
