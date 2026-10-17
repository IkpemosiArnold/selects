// The review app's timeline strip with many clips on a long video: markers that would
// touch go on lanes, rank numbers and times are shown only where they fit.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CH, MIN_W, fitLabels, packLanes, tickTimes } from "../../web/src/components/reel/marks.js";
import { tc } from "../../web/src/lib/time.js";

// 50 clips of 20 to 60 s over 2 hours, some a second apart, as the judge picks them.
function many(n = 50, dur = 7316) {
  const out = [];
  let t = 10;
  for (let i = 0; i < n; i++) {
    const len = 20 + ((i * 37) % 41);
    t += i % 3 === 0 ? 1 : (dur - 20 - n * 40) / (n * 0.67);
    out.push({ id: "c" + i, rank: ((i * 7) % n) + 1, start: t, end: t + len });
    t += len;
  }
  return out;
}

const px = (c, dur, width) => [(c.start / dur) * width, (c.start / dur) * width + Math.max(MIN_W, ((c.end - c.start) / dur) * width)];

test("markers on one lane never touch, at laptop and phone widths", () => {
  const dur = 7316;
  const cands = many(50, dur);
  for (const width of [1392, 358]) {
    const { lanes, lane } = packLanes(cands, dur, width);
    assert.ok(lanes >= 2 && lanes <= 3, `lanes ${lanes}`);
    assert.equal(Object.keys(lane).length, 50);
    for (let l = 0; l < lanes; l++) {
      const row = cands.filter((c) => lane[c.id] === l).map((c) => px(c, dur, width)).sort((a, b) => a[0] - b[0]);
      const touching = row.slice(1).filter((b, i) => b[0] < row[i][1] + 2).length;
      // only when three lanes are not enough may two share
      if (lanes < 3) assert.equal(touching, 0, `lane ${l} at ${width}px`);
    }
  }
});

test("a few clips far apart stay on one lane", () => {
  const cands = [
    { id: "a", start: 10, end: 40 },
    { id: "b", start: 300, end: 350 },
    { id: "c", start: 900, end: 930 },
  ];
  const { lanes, lane } = packLanes(cands, 1838, 1392);
  assert.equal(lanes, 1);
  assert.deepEqual(Object.values(lane), [0, 0, 0]);
});

test("rank numbers that are shown never overlap, and the current clip's is always shown", () => {
  const dur = 7316;
  const cands = many(50, dur);
  for (const width of [1392, 358]) {
    const cur = cands[17].id;
    const shown = fitLabels(cands, dur, width, cur);
    assert.ok(cur in shown);
    const boxes = Object.entries(shown).map(([id, x]) => [x, x + String(cands.find((c) => c.id === id).rank).length * CH]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i][0] >= boxes[i - 1][1], `overlap at ${width}px`);
    for (const [a, b] of boxes) assert.ok(a >= 0 && b <= width + 0.01);
  }
  // on a laptop there is room for most of them
  assert.ok(Object.keys(fitLabels(cands, dur, 1392, null)).length >= 25);
});

test("time labels under the strip have room at every width", () => {
  for (const dur of [362.4, 1838, 3849, 7316]) {
    for (const width of [1392, 900, 358]) {
      const ts = tickTimes(dur, width);
      assert.equal(ts[0], 0);
      const boxes = ts.map((t) => {
        const w = tc(t).length * CH;
        const x = (t / dur) * width;
        return t === 0 ? [0, w] : [x - w / 2, x + w / 2];
      });
      boxes.push([width - tc(dur).length * CH, width]);
      for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i][0] >= boxes[i - 1][1] + 8, `${dur}s at ${width}px: ${tc(ts[i - 1] ?? 0)} and the next`);
    }
  }
  // never denser than the strip was before it measured itself
  assert.deepEqual(tickTimes(1838, 1392), [0, 300, 600, 900, 1200, 1500]);
});
