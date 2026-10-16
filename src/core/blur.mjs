// Privacy blur as an ffmpeg filter graph: crop each region, blur it hard, and lay it back
// over the picture only while it is needed. Works on any ffmpeg (no extra filters).
import { trackSegments, tracksToBlur } from "./faces.mjs";

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Parse a CLI region "x,y,w,h" or "x,y,w,h@start-end" (normalised 0..1, times in seconds).
 */
export function parseRegion(s) {
  const m = String(s).trim().match(/^([\d.]+),([\d.]+),([\d.]+),([\d.]+)(?:@([\d.]*)-([\d.]*))?$/);
  if (!m) throw Object.assign(new Error(`Could not read the blur region "${s}".`), { hint: "Use x,y,w,h as fractions of the frame, for example 0.6,0.05,0.35,0.12, optionally followed by @start-end in seconds." });
  const [x, y, w, h] = m.slice(1, 5).map(Number);
  if ([x, y, w, h].some((v) => v < 0 || v > 1) || w <= 0 || h <= 0) throw Object.assign(new Error(`Blur region "${s}" is outside the frame.`), { hint: "x, y, w and h are fractions between 0 and 1." });
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y), start: m[5] ? +m[5] : null, end: m[6] ? +m[6] : null };
}

/**
 * Every box to blur in a render, in the render's own time (0 = the first frame rendered).
 * blur: { faces: { mode, tracks }, regions: [{ x, y, w, h, start, end }] } (source seconds)
 * tracks: face tracks from faces.json (source seconds). offset: the source time of frame 0.
 */
export function blurBoxes(blur, { tracks = [], offset = 0, duration = Infinity } = {}) {
  if (!blur) return [];
  const out = [];
  for (const r of blur.regions || []) {
    const a = Math.max(0, (r.start ?? -Infinity) - offset);
    const z = Math.min(duration, (r.end ?? Infinity) - offset);
    if (z <= a) continue;
    out.push({ x: r.x, y: r.y, w: r.w, h: r.h, start: a, end: z, kind: "region" });
  }
  for (const tr of tracksToBlur(tracks, blur.faces)) {
    for (const s of trackSegments(tr, { from: offset, to: offset + duration })) {
      out.push({ x: s.x, y: s.y, w: s.w, h: s.h, start: +Math.max(0, s.start - offset).toFixed(3), end: +Math.min(duration, s.end - offset).toFixed(3), kind: "face", track: tr.id });
    }
  }
  return out.filter((b) => b.end > b.start);
}

/**
 * Build the filter graph text for blurring boxes on a W x H stream.
 * Returns "" when there is nothing to blur, otherwise a chain from [inLabel] to [outLabel]:
 *   [in]split=n+1[bb0][bk0]...; [bk0]crop=...,boxblur=...[bz0]; [bb0][bz0]overlay=x:y:enable='...'[bb1] ...
 * Whole-clip boxes (start 0, end >= duration) get no enable expression.
 */
export function blurFilter(boxes, { W, H, inLabel = "pre", outLabel = "blurred", duration = Infinity, strength = 1 } = {}) {
  if (!boxes?.length) return "";
  const parts = [];
  const n = boxes.length;
  parts.push(`[${inLabel}]split=${n + 1}[bb0]${boxes.map((_, i) => `[bk${i}]`).join("")}`);
  boxes.forEach((b, i) => {
    let w = even(b.w * W);
    let h = even(b.h * H);
    w = Math.min(w, W - (W % 2));
    h = Math.min(h, H - (H % 2));
    const x = Math.min(even(b.x * W), W - w);
    const y = Math.min(even(b.y * H), H - h);
    // boxblur limits: the luma radius must fit half the box, chroma (half size in 4:2:0) a quarter
    const lr = Math.max(1, Math.min(Math.round(Math.min(w, h) * 0.18 * strength), Math.floor(Math.min(w, h) / 2) - 1));
    const cr = Math.max(1, Math.min(Math.round(lr / 2), Math.floor(Math.min(w, h) / 4) - 1));
    const whole = b.start <= 0.001 && b.end >= duration - 0.001;
    const enable = whole ? "" : `:enable='between(t,${b.start.toFixed(3)},${b.end.toFixed(3)})'`;
    parts.push(`[bk${i}]crop=${w}:${h}:${x}:${y},boxblur=luma_radius=${lr}:luma_power=3:chroma_radius=${cr}:chroma_power=3${enable}[bz${i}]`);
    parts.push(`[bb${i}][bz${i}]overlay=${x}:${y}${enable}${i === n - 1 ? `[${outLabel}]` : `[bb${i + 1}]`}`);
  });
  return parts.join(";");
}
