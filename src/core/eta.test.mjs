import assert from "node:assert/strict";
import { test } from "node:test";
import { countDown, leftText, rateTracker } from "./eta.mjs";

test("the estimate follows the recent rate, not the average since the start", () => {
  let t = 0;
  const eta = rateTracker(3000, { now: () => t });
  let done = 0;
  // ten slow pieces (30 s of audio in 90 s), then the machine speeds up 3 times
  for (let i = 0; i < 10; i++) {
    t += 90000;
    done += 30;
    eta.update(done);
  }
  let e;
  for (let i = 0; i < 6; i++) {
    t += 30000;
    done += 30;
    e = eta.update(done);
  }
  const left = 3000 - done;
  const average = left / (done / (t / 1000));
  assert.ok(Math.abs(e.etaSec - left) / left < 0.15, `recent: ${e.etaSec} s for ${left} s of audio at 1x`);
  assert.ok(average > 1.8 * e.etaSec, "the average since the start would still be far too high");
  assert.equal(e.steady, true);
});

test("an unsteady rate gives a range", () => {
  let t = 0;
  const eta = rateTracker(1000, { now: () => t });
  [[30, 30], [90, 30], [20, 30], [120, 30]].reduce((done, [sec, d]) => {
    t += sec * 1000;
    eta.update(done + d);
    return done + d;
  }, 0);
  const e = eta.estimate();
  assert.equal(e.steady, false);
  assert.ok(e.lowSec < e.etaSec && e.etaSec < e.highSec);
  assert.match(leftText(e.etaSec, e.lowSec, e.highSec), /^about \d+ to \d+ (minutes|hours) left$/);
  assert.equal(leftText(600), "about 10 minutes left");
  assert.equal(leftText(600, 590, 640), "about 10 minutes left", "a narrow range is one number");
});

test("countDown moves every second between updates and stops at zero", () => {
  assert.equal(countDown(120, 0), 120);
  assert.equal(countDown(120, 30.4), 90);
  assert.equal(countDown(120, 500), 0);
  assert.equal(countDown(null, 5), null);
});
