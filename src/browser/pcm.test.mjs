// Long videos in the tab: quiet cuts on the loudness grid, the segment store (OPFS or
// memory) reading a range across segments, and the honest limit for phones.
import assert from "node:assert/strict";
import test from "node:test";
import { isMobile, longVideoNote, pcmStore, quietCut, RATE } from "./pcm.js";

/** A minimal OPFS: directories and files held in Maps, files as Blobs. */
function fakeStorage() {
  const dir = () => {
    const kids = new Map();
    return {
      async getDirectoryHandle(name, { create } = {}) {
        if (!kids.has(name)) {
          if (!create) throw new Error("NotFoundError");
          kids.set(name, dir());
        }
        return kids.get(name);
      },
      async getFileHandle(name, { create } = {}) {
        if (!kids.has(name)) {
          if (!create) throw new Error("NotFoundError");
          kids.set(name, { blob: new Blob([]) });
        }
        const f = kids.get(name);
        return {
          async createWritable() {
            const parts = [];
            return { write: async (d) => parts.push(d), close: async () => (f.blob = new Blob(parts)) };
          },
          getFile: async () => f.blob,
        };
      },
      async removeEntry(name) {
        kids.delete(name);
      },
    };
  };
  const root = dir();
  return { getDirectory: async () => root };
}

/** Segment i holds the value i + 1 in every sample, so a read shows where it came from. */
function segment(i, start, sec) {
  return { index: i, start, end: start + sec, pcm: new Float32Array(Math.round(sec * RATE)).fill(i + 1) };
}

for (const kind of ["opfs", "memory"]) {
  test(`pcmStore (${kind}) reads a range that spans two segments`, async () => {
    const store = pcmStore({ storage: kind === "opfs" ? fakeStorage() : undefined });
    const segs = [segment(0, 0, 600), segment(1, 600, 600.5)];
    for (const s of segs) await store.put("k", s.index, s.pcm);
    assert.equal(store.kind, kind);
    const r = await store.range("k", segs, 598, 602);
    assert.equal(r.length, 4 * RATE);
    assert.equal(r[0], 1);
    assert.equal(r[2 * RATE - 1], 1);
    assert.equal(r[2 * RATE], 2);
    assert.equal(r[r.length - 1], 2);
    await store.drop("k");
    const gone = await store.range("k", segs, 598, 602);
    assert.equal(gone[0], 0, "dropped segments read as silence");
  });
}

test("quietCut ends a segment at the quietest half second on the global grid", () => {
  const start = 600; // the segment starts 10 minutes in
  const pcm = new Float32Array(610 * RATE).map((_, i) => Math.sin(i / 7) * 0.5);
  // silence from 1197.5 s to 1198.0 s of the video (597.5 s into the segment)
  pcm.fill(0, 597.5 * RATE, 598 * RATE);
  const cut = quietCut(pcm, start);
  assert.equal(cut / RATE + start, 1197.5);
  assert.equal(cut % (RATE / 2), 0, "on the 0.5 s grid, so loudness tracks join exactly");
});

test("the honest limit: phones over 30 minutes are told to use a laptop", () => {
  assert.match(longVideoNote(31 * 60, { mobile: true }), /^For videos over about 30 minutes, use Selects on a laptop\./);
  assert.equal(longVideoNote(29 * 60, { mobile: true }), null);
  assert.equal(longVideoNote(50 * 60, { mobile: false }), null);
  assert.match(longVideoNote(2 * 3600, { mobile: false }), /10 minutes at a time/);
  for (const n of [longVideoNote(31 * 60, { mobile: true }), longVideoNote(7200, { mobile: false })]) assert.doesNotMatch(n, /—/);
  assert.equal(isMobile({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }), true);
  assert.equal(isMobile({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 5 }), true, "iPad asks for the desktop site");
  assert.equal(isMobile({ userAgentData: { mobile: false }, userAgent: "x" }), false);
});
