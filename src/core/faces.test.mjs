import assert from "node:assert/strict";
import { test } from "node:test";
import { boxAt, boxIou, padBox, trackFaces, trackSegments, tracksToBlur } from "./faces.mjs";

// two people: a big speaker in the middle, a small face drifting right that leaves at 3 s
const frames = [];
for (let i = 0; i <= 20; i++) {
  const t = i * 0.25;
  const faces = [{ x: 0.35, y: 0.2, w: 0.3, h: 0.2, c: 0.99 }];
  if (t <= 3) faces.push({ x: 0.05 + t * 0.02, y: 0.6, w: 0.1, h: 0.07, c: 0.9 });
  if (i === 7) faces.push({ x: 0.8, y: 0.9, w: 0.05, h: 0.04, c: 0.9 }); // a one-frame false positive
  if (i === 10) faces.splice(0, 1); // the detector misses the speaker once
  frames.push({ t, faces: i % 2 ? faces.slice().reverse() : faces });
}

test("IoU of boxes", () => {
  assert.equal(boxIou({ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 1, h: 1 }), 1);
  assert.equal(boxIou({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }), 0);
});

test("detections link into tracks, noise is dropped, the speaker is main", () => {
  const tracks = trackFaces(frames);
  assert.equal(tracks.length, 2);
  const main = tracks.find((t) => t.main);
  assert.equal(main.boxes.length, 20, "one missed frame does not split the track");
  assert.equal(main.start, 0);
  assert.equal(main.end, 5);
  const other = tracks.find((t) => !t.main);
  assert.equal(other.end, 3);
  assert.deepEqual(tracks.map((t) => t.id).sort(), ["f_01", "f_02"]);
});

test("a gap longer than maxGap starts a new track", () => {
  const fr = [0, 0.25, 0.5, 3, 3.25, 3.5].map((t) => ({ t, faces: [{ x: 0.4, y: 0.4, w: 0.2, h: 0.2, c: 1 }] }));
  assert.equal(trackFaces(fr, { maxGap: 1.5 }).length, 2);
  assert.equal(trackFaces(fr, { maxGap: 5 }).length, 1);
});

test("boxAt interpolates between detections and holds briefly past the ends", () => {
  const tr = { boxes: [{ t: 0, x: 0, y: 0, w: 0.2, h: 0.2 }, { t: 1, x: 0.2, y: 0.4, w: 0.2, h: 0.2 }] };
  const b = boxAt(tr, 0.5);
  assert.ok(Math.abs(b.x - 0.1) < 1e-9 && Math.abs(b.y - 0.2) < 1e-9);
  assert.deepEqual(boxAt(tr, 1.2), { x: 0.2, y: 0.4, w: 0.2, h: 0.2 });
  assert.equal(boxAt(tr, 2), null);
  assert.equal(boxAt(tr, -0.5), null);
});

test("tracksToBlur: all, others (keeps the main speaker), chosen, off", () => {
  const tracks = trackFaces(frames);
  assert.equal(tracksToBlur(tracks, { mode: "all" }).length, 2);
  const others = tracksToBlur(tracks, { mode: "others" });
  assert.equal(others.length, 1);
  assert.equal(others[0].main, false);
  assert.deepEqual(tracksToBlur(tracks, { mode: "chosen", tracks: [tracks[0].id] }).map((t) => t.id), [tracks[0].id]);
  assert.equal(tracksToBlur(tracks, { mode: "off" }).length, 0);
  assert.equal(tracksToBlur(tracks, null).length, 0);
});

test("track segments cover the face over time, padded and merged", () => {
  const still = trackFaces(frames).find((t) => t.main);
  const segs = trackSegments(still, { step: 1 });
  assert.equal(segs.length, 1, "a still face becomes one box");
  assert.ok(segs[0].x < 0.35 && segs[0].x + segs[0].w > 0.65);
  const mover = { start: 0, end: 4, boxes: [0, 1, 2, 3, 4].map((t) => ({ t, x: 0.1 * t, y: 0.4, w: 0.1, h: 0.1 })) };
  const ms = trackSegments(mover, { step: 1, from: 1, to: 3 });
  assert.ok(ms.length >= 2, "a moving face gets several boxes");
  assert.ok(ms[0].start >= 1 && ms[ms.length - 1].end <= 3);
  const p = padBox({ x: 0, y: 0.9, w: 0.2, h: 0.2 });
  assert.ok(p.x >= 0 && p.y + p.h <= 1);
});
