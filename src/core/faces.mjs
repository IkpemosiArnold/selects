// Face tracks from per-frame detections (tools/faces, Apple Vision), for privacy blur.
// Detection runs at a few frames per second; this file links boxes into tracks with
// IoU matching, fills the gaps by interpolation, and picks the main speaker.
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./config.mjs";
import { readJson, run, writeJsonAtomic } from "./util.mjs";

export function boxIou(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

const centreDist = (a, b) => Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));

/**
 * Link detections into tracks.
 * frames: [{ t, faces: [{ x, y, w, h, c }] }] in time order, boxes normalised (top-left origin).
 * A detection joins the open track whose last box overlaps it most (IoU >= minIou), or whose
 * centre is within one face width when the face moved fast. A track closes after maxGap
 * seconds without a match. Tracks seen fewer than minHits times are dropped as noise.
 * Returns [{ id, start, end, boxes, hits, area, share, main }], main speaker first.
 */
export function trackFaces(frames, { minIou = 0.2, maxGap = 1.5, minHits = 3, minConf = 0.5 } = {}) {
  const open = [];
  const closed = [];
  for (const f of frames) {
    for (let i = open.length - 1; i >= 0; i--) {
      if (f.t - open[i].end > maxGap) closed.push(...open.splice(i, 1));
    }
    const dets = (f.faces || []).filter((d) => (d.c ?? 1) >= minConf);
    // all candidate pairs, best first (greedy assignment)
    const pairs = [];
    dets.forEach((d, di) =>
      open.forEach((tr, ti) => {
        const last = tr.boxes[tr.boxes.length - 1];
        const iou = boxIou(d, last);
        const near = centreDist(d, last) < Math.max(d.w, last.w);
        if (iou >= minIou || near) pairs.push({ di, ti, score: iou + (near ? 0.1 : 0) });
      }),
    );
    pairs.sort((a, b) => b.score - a.score);
    const usedD = new Set();
    const usedT = new Set();
    for (const p of pairs) {
      if (usedD.has(p.di) || usedT.has(p.ti)) continue;
      usedD.add(p.di);
      usedT.add(p.ti);
      const tr = open[p.ti];
      const d = dets[p.di];
      tr.boxes.push({ t: f.t, x: d.x, y: d.y, w: d.w, h: d.h });
      tr.end = f.t;
    }
    dets.forEach((d, di) => {
      if (!usedD.has(di)) open.push({ start: f.t, end: f.t, boxes: [{ t: f.t, x: d.x, y: d.y, w: d.w, h: d.h }] });
    });
  }
  closed.push(...open);
  const total = frames.length || 1;
  const span = frames.length ? frames[frames.length - 1].t - frames[0].t || 1 : 1;
  const tracks = closed
    .filter((tr) => tr.boxes.length >= Math.min(minHits, total))
    .map((tr) => {
      const area = tr.boxes.reduce((a, b) => a + b.w * b.h, 0) / tr.boxes.length;
      return { start: tr.start, end: tr.end, boxes: tr.boxes, hits: tr.boxes.length, area: +area.toFixed(4), share: +Math.min(1, (tr.end - tr.start) / span).toFixed(3) };
    });
  // main speaker: big and present for most of the video
  const weight = (tr) => tr.area * (tr.hits / total);
  tracks.sort((a, b) => weight(b) - weight(a));
  tracks.forEach((tr, i) => {
    tr.main = i === 0;
  });
  // stable ids in order of first appearance
  [...tracks].sort((a, b) => a.start - b.start).forEach((tr, i) => (tr.id = `f_${String(i + 1).padStart(2, "0")}`));
  return tracks;
}

/**
 * The box of a track at time t: linear between detections, held for `hold` seconds past
 * either end, null outside.
 */
export function boxAt(track, t, { hold = 0.3 } = {}) {
  const b = track.boxes;
  if (!b.length || t < b[0].t - hold || t > b[b.length - 1].t + hold) return null;
  if (t <= b[0].t) return { x: b[0].x, y: b[0].y, w: b[0].w, h: b[0].h };
  for (let i = 1; i < b.length; i++) {
    if (t <= b[i].t) {
      const a = b[i - 1];
      const z = b[i];
      const f = z.t > a.t ? (t - a.t) / (z.t - a.t) : 0;
      const lerp = (k) => a[k] + (z[k] - a[k]) * f;
      return { x: lerp("x"), y: lerp("y"), w: lerp("w"), h: lerp("h") };
    }
  }
  const l = b[b.length - 1];
  return { x: l.x, y: l.y, w: l.w, h: l.h };
}

/** Which tracks to blur for a faces mode: "all", "others" (all but the main speaker), "chosen". */
export function tracksToBlur(tracks, faces) {
  const mode = faces?.mode || "off";
  if (mode === "all") return tracks;
  if (mode === "others") return tracks.filter((t) => !t.main);
  if (mode === "chosen") return tracks.filter((t) => (faces.tracks || []).includes(t.id));
  return [];
}

/**
 * Turn a track into fixed boxes over short time steps (the union of the interpolated box
 * over each step, padded so hair and chin are covered), clipped to [from, to].
 * Neighbouring steps whose boxes barely differ are merged, which keeps the ffmpeg graph small.
 * Returns [{ start, end, x, y, w, h }] in the same time base as the track.
 */
export function trackSegments(track, { from = -Infinity, to = Infinity, step = 1, pad = 0.25, hold = 0.3 } = {}) {
  const s0 = Math.max(from, track.start - hold);
  const s1 = Math.min(to, track.end + hold);
  const segs = [];
  for (let a = s0; a < s1 - 1e-6; a += step) {
    const z = Math.min(s1, a + step);
    let box = null;
    for (let k = 0; k <= 4; k++) {
      const b = boxAt(track, a + ((z - a) * k) / 4, { hold });
      if (!b) continue;
      box = box ? unionBox(box, b) : b;
    }
    if (!box) continue;
    segs.push({ start: +a.toFixed(3), end: +z.toFixed(3), ...padBox(box, pad) });
  }
  return mergeSegments(segs);
}

function unionBox(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Grow a face box: pad x on each side, more above (hair) and below (chin), clamped to the frame. */
export function padBox(b, pad = 0.25) {
  const x = Math.max(0, b.x - b.w * pad);
  const y = Math.max(0, b.y - b.h * pad * 1.4);
  const x1 = Math.min(1, b.x + b.w * (1 + pad));
  const y1 = Math.min(1, b.y + b.h * (1 + pad * 1.2));
  return { x: +x.toFixed(4), y: +y.toFixed(4), w: +(x1 - x).toFixed(4), h: +(y1 - y).toFixed(4) };
}

function mergeSegments(segs, { grow = 1.25 } = {}) {
  const out = [];
  for (const s of segs) {
    const p = out[out.length - 1];
    if (p && Math.abs(s.start - p.end) < 1e-3) {
      const u = unionBox(p, s);
      // merge when the union is not much bigger than either box
      if (u.w * u.h <= grow * Math.max(p.w * p.h, s.w * s.h)) {
        Object.assign(p, { end: s.end, x: +u.x.toFixed(4), y: +u.y.toFixed(4), w: +u.w.toFixed(4), h: +u.h.toFixed(4) });
        continue;
      }
    }
    out.push({ ...s });
  }
  return out;
}

// ---- running the detector ----------------------------------------------------------

export const FACES_BIN = process.env.SELECTS_FACES_BIN || path.join(REPO, "tools/faces/faces");

export function facesAvailable() {
  return process.platform === "darwin" && fs.existsSync(FACES_BIN);
}

/**
 * Detect and track faces for a whole job (cached in faces-raw.json and faces.json).
 * macOS only. Returns the faces.json object.
 */
export async function detectFaces(videoPath, dir, { fps = 4, signal, onProgress, force = false } = {}) {
  const out = path.join(dir, "faces.json");
  if (!force && fs.existsSync(out)) return readJson(out);
  if (!facesAvailable()) {
    const err = new Error(process.platform === "darwin" ? "The face detector is not built." : "Automatic face blur needs macOS (Apple Vision).");
    err.hint = process.platform === "darwin" ? "Run sh tools/faces/build.sh in the selects folder." : "Draw blur regions by hand instead (--blur-region x,y,w,h).";
    throw err;
  }
  const rawFile = path.join(dir, "faces-raw.json");
  const t0 = Date.now();
  if (force || !fs.existsSync(rawFile)) {
    await run(FACES_BIN, [videoPath, "--fps", String(fps), "--out", rawFile + ".part"], {
      signal,
      onStderr: (s) => {
        const m = s.match(/progress (\d+)\/(\d+)/g);
        if (m) {
          const [d, n] = m[m.length - 1].split(" ")[1].split("/").map(Number);
          onProgress?.({ progress: n ? d / n : 0 });
        }
      },
    });
    fs.renameSync(rawFile + ".part", rawFile);
  }
  const raw = readJson(rawFile);
  const tracks = trackFaces(raw.frames || []);
  const res = { fps: raw.fps, width: raw.width, height: raw.height, duration: raw.duration ?? null, sec: +((Date.now() - t0) / 1000).toFixed(1), tracks };
  writeJsonAtomic(out, res);
  return res;
}
