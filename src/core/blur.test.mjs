import assert from "node:assert/strict";
import { test } from "node:test";
import { blurBoxes, blurFilter, parseRegion } from "./blur.mjs";

test("parseRegion reads x,y,w,h with an optional time range", () => {
  assert.deepEqual(parseRegion("0.6,0.05,0.35,0.12"), { x: 0.6, y: 0.05, w: 0.35, h: 0.12, start: null, end: null });
  assert.deepEqual(parseRegion("0.1,0.1,0.2,0.2@12.5-30"), { x: 0.1, y: 0.1, w: 0.2, h: 0.2, start: 12.5, end: 30 });
  assert.equal(parseRegion("0.9,0,0.5,0.5").w.toFixed(2), "0.10", "clamped to the frame");
  assert.throws(() => parseRegion("1,2,3"), /blur region/);
  assert.throws(() => parseRegion("0.5,0.5,1.5,0.1"), /outside the frame/);
});

test("blurBoxes shifts regions into render time and drops ones outside it", () => {
  const blur = { regions: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, start: null, end: null }, { x: 0, y: 0, w: 0.1, h: 0.1, start: 105, end: 110 }, { x: 0, y: 0, w: 0.1, h: 0.1, start: 10, end: 20 }] };
  const boxes = blurBoxes(blur, { offset: 100, duration: 30 });
  assert.equal(boxes.length, 2);
  assert.deepEqual([boxes[0].start, boxes[0].end], [0, 30]);
  assert.deepEqual([boxes[1].start, boxes[1].end], [5, 10]);
});

test("blurBoxes turns face tracks into timed boxes for the chosen mode", () => {
  const tracks = [
    { id: "f_01", main: true, start: 0, end: 10, boxes: [{ t: 0, x: 0.4, y: 0.2, w: 0.2, h: 0.15 }, { t: 10, x: 0.4, y: 0.2, w: 0.2, h: 0.15 }] },
    { id: "f_02", main: false, start: 2, end: 4, boxes: [{ t: 2, x: 0.1, y: 0.6, w: 0.1, h: 0.08 }, { t: 4, x: 0.1, y: 0.6, w: 0.1, h: 0.08 }] },
  ];
  const others = blurBoxes({ faces: { mode: "others" } }, { tracks, offset: 1, duration: 20 });
  assert.ok(others.length >= 1 && others.every((b) => b.track === "f_02"));
  assert.ok(others[0].start >= 0.6 && others[0].start <= 1.01, "times are relative to the render start");
  assert.equal(blurBoxes({ faces: { mode: "all" } }, { tracks, duration: 20 }).filter((b) => b.track === "f_01").length >= 1, true);
  assert.deepEqual(blurBoxes(null, {}), []);
});

test("blurFilter builds a split, crop, boxblur and overlay chain", () => {
  assert.equal(blurFilter([], { W: 1080, H: 1920 }), "");
  const g = blurFilter(
    [
      { x: 0.1, y: 0.1, w: 0.2, h: 0.1, start: 0, end: 30 },
      { x: 0.95, y: 0.95, w: 0.2, h: 0.2, start: 5, end: 7.5 },
    ],
    { W: 1080, H: 1920, inLabel: "v0", outLabel: "v1", duration: 30 },
  );
  assert.match(g, /^\[v0\]split=3\[bb0\]\[bk0\]\[bk1\];/);
  assert.match(g, /\[bk0\]crop=216:192:108:192,boxblur=luma_radius=\d+/);
  assert.ok(!/overlay=108:192:enable/.test(g), "a whole-clip box needs no enable");
  assert.match(g, /enable='between\(t,5\.000,7\.500\)'\[v1\]$/);
  // the second box is clamped inside the frame (even sizes, x + w <= W)
  const m = g.match(/\[bk1\]crop=(\d+):(\d+):(\d+):(\d+)/);
  const [w, h, x, y] = m.slice(1).map(Number);
  assert.ok(x + w <= 1080 && y + h <= 1920 && w % 2 === 0 && h % 2 === 0);
  // boxblur radii fit the box (luma <= half, chroma <= a quarter of the short side)
  for (const mm of g.matchAll(/crop=(\d+):(\d+):\d+:\d+,boxblur=luma_radius=(\d+):luma_power=3:chroma_radius=(\d+)/g)) {
    const [bw, bh, lr, cr] = mm.slice(1).map(Number);
    assert.ok(lr <= Math.min(bw, bh) / 2 - 1 && cr <= Math.min(bw, bh) / 4 - 1);
  }
});
