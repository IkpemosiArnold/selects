// Render layout with no Node imports: presets, caption sizes and line breaks, drawing a
// caption on any 2D canvas context, the working size, and the crop-or-fit decision from
// motion. render.mjs (ffmpeg and @napi-rs/canvas) and the browser build (src/browser,
// WebCodecs and OffscreenCanvas) both use these, so a clip looks the same from either.
import { chunkWords, STYLES } from "./cues.mjs";

export const PRESETS = {
  shorts: {
    width: 1080,
    height: 1920,
    crf: 20,
    x264: "veryfast",
    audioBitrate: "160k",
    lufs: -14,
    fps: 30, // 50 and 60 fps sources are halved: half the frames to decode, scale and encode
    padStart: 0.08, // seconds of air before the first word
    padEnd: 0.35, // and after the last, so the last word is not clipped
    caption: {
      fontSize: 84,
      maxWidth: 920, // keeps 80 px side margins
      boxHeight: 400, // caption image height
      // bottom edge of the caption image: clear of the bottom 18% kept for platform UI
      bottomLimit: 0.82,
      fill: "#FFFFFF",
      highlight: "#F2BE22",
      stroke: "rgba(0,0,0,0.92)",
      strokeWidth: 13,
      maxWords: 4,
      maxChars: 22,
    },
  },
};

/** Scale a 1080-wide preset's caption sizes by f. */
function scaledCaption(c, f) {
  return { ...c, fontSize: Math.round(c.fontSize * f), maxWidth: Math.round(c.maxWidth * f), boxHeight: Math.round(c.boxHeight * f), strokeWidth: Math.max(4, Math.round(c.strokeWidth * f)) };
}

// A fast draft for checking a cut before the slow final render: 720x1280, x264 ultrafast.
PRESETS.preview = {
  ...PRESETS.shorts,
  width: 720,
  height: 1280,
  crf: 26,
  x264: "ultrafast",
  audioBitrate: "128k",
  caption: scaledCaption(PRESETS.shorts.caption, 720 / 1080),
};

// Caption mode: the whole video at its own aspect, never larger than 1080 on the short side.
PRESETS.full = { ...PRESETS.shorts, maxShort: 1080, maxLong: 1920, crf: 21 };

/**
 * Caption drawing options for an output of W x H in a style ("bold" or "subtitle").
 * Bold is the short-form look; subtitle is two smaller lines low in the frame.
 */
export function captionOptions(W, H, style = "bold") {
  const base = PRESETS.shorts.caption;
  const portrait = H > W;
  if (style === "subtitle") {
    const fontSize = Math.round(Math.min(W, H) * 0.05);
    return { ...base, fontSize, maxWidth: Math.round(W * 0.86), boxHeight: Math.round(fontSize * 3.3), bottomLimit: portrait ? 0.8 : 0.95, strokeWidth: Math.max(4, Math.round(fontSize * 0.16)), highlight: base.fill, maxWords: STYLES.subtitle.maxWords, maxChars: STYLES.subtitle.maxChars, style };
  }
  const f = Math.min(W / 1080, (H / 1080) * 0.75);
  return { ...scaledCaption(base, f), maxWidth: Math.round(Math.min(base.maxWidth * f, W * 0.86)), bottomLimit: portrait ? 0.82 : 0.92, style: "bold" };
}

/** Words inside [start, end], shifted so the clip starts at 0. */
export function clipWords(words, start, end, offset = start) {
  return words
    .filter((w) => (w.s + w.e) / 2 >= start && (w.s + w.e) / 2 <= end)
    .map((w) => ({ ...w, s: +Math.max(0, w.s - offset).toFixed(3), e: +Math.max(0, w.e - offset).toFixed(3) }));
}

/** Group words into on-screen captions of 2 to 4 words (the bold style). */
export function captionChunks(words, { maxWords = 4, maxChars = 22, pause = 0.5 } = {}) {
  return chunkWords(words, { maxWords, maxChars, pause, commaMin: 2 });
}

/** Caption display text: drop trailing commas and full stops (keep ? and !). */
export const display = (w) => w.replace(/[,.;:]+$/, "");

/**
 * Lay a caption out: one line if it fits (shrinking the font by up to 15%), otherwise two
 * lines split where they are closest to equal width, so no single word is left hanging.
 * measure(text, size) returns a width in pixels. Returns { size, lines: [[{i, t, tw}]] }.
 */
export function layoutCaption(texts, c, measure) {
  const widths = (s) => texts.map((t) => measure(t, s));
  const lineW = (ws, s) => ws.reduce((a, b) => a + b, 0) + measure(" ", s) * Math.max(0, ws.length - 1);
  const asLines = (ws, cut) => [texts.slice(0, cut), texts.slice(cut)].filter((l) => l.length).map((l, li) => l.map((t, k) => ({ i: li === 0 ? k : cut + k, t, tw: ws[li === 0 ? k : cut + k] })));
  for (let s = c.fontSize; s >= Math.round(c.fontSize * 0.85); s -= 2) {
    const ws = widths(s);
    if (lineW(ws, s) <= c.maxWidth) return { size: s, lines: asLines(ws, texts.length) };
  }
  const floor = Math.min(40, Math.round(c.fontSize * 0.6));
  for (let s = c.fontSize; s >= floor; s -= Math.max(2, Math.round(c.fontSize / 20))) {
    const ws = widths(s);
    let best = null;
    for (let cut = 1; cut < texts.length; cut++) {
      const w = Math.max(lineW(ws.slice(0, cut), s), lineW(ws.slice(cut), s));
      if (!best || w < best.w) best = { cut, w };
    }
    if (best && best.w <= c.maxWidth) return { size: s, lines: asLines(ws, best.cut) };
    if (!best && lineW(ws, s) <= c.maxWidth) return { size: s, lines: asLines(ws, texts.length) };
  }
  return { size: floor, lines: asLines(widths(floor), texts.length) };
}

/**
 * Paint one caption (its words, one highlighted) onto a 2D context of opts.width x
 * caption.boxHeight. Works with @napi-rs/canvas and the browser's (Offscreen)Canvas.
 * families: font family names in fallback order.
 */
export function paintCaption(ctx, chunkWords, highlightIdx, { width, caption: c, families }) {
  const stack = families.map((f) => `"${f}"`).join(", ");
  const font = (s) => `bold ${s}px ${stack}`;
  const texts = chunkWords.map((w) => (c.style === "subtitle" ? w.w : display(w.w)));
  const { size, lines } = layoutCaption(texts, c, (t, s) => {
    ctx.font = font(s);
    return ctx.measureText(t).width;
  });
  ctx.font = font(size);
  const space = ctx.measureText(" ").width;
  const lineH = size * 1.18;
  const totalH = lineH * lines.length;
  let y = c.style === "subtitle" ? c.boxHeight - totalH + lineH / 2 - size * 0.25 : (c.boxHeight - totalH) / 2 + lineH / 2;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  for (const line of lines) {
    const lw = line.reduce((a, x) => a + x.tw, 0) + space * (line.length - 1);
    let x = (width - lw) / 2;
    for (const part of line) {
      ctx.lineWidth = c.strokeWidth;
      ctx.strokeStyle = c.stroke;
      ctx.strokeText(part.t, x, y);
      ctx.fillStyle = part.i === highlightIdx ? c.highlight : c.fill;
      ctx.fillText(part.t, x, y);
      x += part.tw + space;
    }
    y += lineH;
  }
}

/** Where the caption image sits: its top edge, so its bottom stays above the platform UI. */
export const captionTop = (H, c) => Math.round(H * c.bottomLimit - c.boxHeight);

/** Fit an upright w x h inside maxShort x maxLong (by orientation), never upscaling; even sizes. */
export function workingSize(w, h, { maxShort = 1080, maxLong = 1920 } = {}) {
  const portrait = h > w;
  const [bw, bh] = portrait ? [maxShort, maxLong] : [maxLong, maxShort];
  const f = Math.min(1, bw / w, bh / h);
  const ev = (n) => Math.max(2, Math.round((n * f) / 2) * 2);
  return { w: ev(w), h: ev(h) };
}

/**
 * The crop-or-fit decision that needs no pixels: "scale" when the source is already about
 * 9:16, "fit" when it is not landscape. null means "look at the motion" (reframeFromMotion).
 */
export function reframeByShape(dispW, dispH) {
  if (dispW && dispH && dispW / dispH <= 0.6) return { mode: "scale", centreShare: null, why: "source is already portrait" };
  if (!dispW || !dispH || dispW / dispH < 1.2) return { mode: "fit", centreShare: null, why: "source is not landscape" };
  return null;
}

/** The tiny grayscale frame size the motion check reads (64 wide). */
export function motionSize(dispW, dispH) {
  const W = 64;
  return { W, H: Math.max(8, Math.round((W * dispH) / dispW / 2) * 2) };
}

/**
 * Centre crop when the motion in the clip sits in the centre band a 9:16 crop would keep,
 * otherwise "fit" (the whole frame over a blurred copy of itself).
 * raw: n grayscale frames of W x H bytes, back to back.
 */
export function reframeFromMotion(raw, W, H, dispW, dispH) {
  const frameSize = W * H;
  const n = Math.floor(raw.length / frameSize);
  if (n < 3) return { mode: "fit", centreShare: null, why: "too few frames" };
  const col = new Float64Array(W);
  for (let f = 1; f < n; f++) {
    const a = (f - 1) * frameSize;
    const b = f * frameSize;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) col[x] += Math.abs(raw[b + y * W + x] - raw[a + y * W + x]);
  }
  const total = col.reduce((p, v) => p + v, 0);
  const band = (dispH * 9) / 16 / dispW; // fraction of width a centre crop keeps
  const x0 = Math.floor(((1 - band) / 2) * W);
  const x1 = Math.ceil(((1 + band) / 2) * W);
  let centre = 0;
  for (let x = x0; x < x1; x++) centre += col[x];
  const meanMotion = total / ((n - 1) * frameSize);
  const centreShare = total > 0 ? centre / total : 0;
  // crop only when there is real motion (a person moving) and most of it is in the band
  const mode = meanMotion > 1.5 && centreShare >= 0.6 ? "crop" : "fit";
  return { mode, centreShare: +centreShare.toFixed(2), meanMotion: +meanMotion.toFixed(2) };
}
