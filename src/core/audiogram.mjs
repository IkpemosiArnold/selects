// Audiograms: how an audio-only clip becomes a 9:16 video. A background (one of six
// characters drawn here in code, or the person's own image), a level meter and the
// character's mouth driven by the clip's real audio, and the same captions as any clip.
// No Node imports: the desktop render (render.mjs, @napi-rs/canvas and ffmpeg) and the
// browser render (render-clip.js, OffscreenCanvas and WebCodecs) both paint with these,
// and the review card previews with them, so all three look the same.
//
// Everything is drawn in a 1080 x 1920 space and scaled, so the preview card, the 720 x 1280
// draft and the final 1080 x 1920 clip share one layout.

export const AUDIOGRAM_FPS = 30;
const BASE_W = 1080;
const BASE_H = 1920;

/**
 * Where things sit, in 1080 x 1920 space. The character lives in the upper middle, clear of
 * the top 8% (platform headers). The meter sits just above the caption box (whose bottom is
 * at 82% of the height, clear of the bottom 18% kept for platform buttons) and stays inside
 * x 140 to 940, clear of the right-hand action buttons. The "band" is the strip the desktop
 * render repaints every frame (the mouth and the meter); everything else is still.
 */
export const AUDIOGRAM_LAYOUT = {
  meter: { x: 140, w: 800, cy: 1075, maxHalf: 62, minHalf: 5, barW: 10, pitch: 20, barSec: 0.1 },
  band: { y: 680, h: 480 },
  horizon: 985,
};

/** The dark "ground" every preset ends in, so white captions with a dark outline stay readable. */
function ground(ctx, top, a, b) {
  const g = ctx.createLinearGradient(0, top, 0, BASE_H);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  ctx.fillStyle = g;
  ctx.fillRect(0, top, BASE_W, BASE_H - top);
}

function vgrad(ctx, stops, y0 = 0, y1 = BASE_H) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

function circle(ctx, x, y, r, fill) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

function ellipse(ctx, x, y, rx, ry, fill, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.lineTo(x + w - k, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + k);
  ctx.lineTo(x + w, y + h - k);
  ctx.quadraticCurveTo(x + w, y + h, x + w - k, y + h);
  ctx.lineTo(x + k, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - k);
  ctx.lineTo(x, y + k);
  ctx.quadraticCurveTo(x, y, x + k, y);
  ctx.closePath();
}

/** A small seeded random, so the stars and dots land in the same places every time. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** Closed happy eyes (upward arcs), as on a smiling face. */
function happyEyes(ctx, y, dx, color, r = 30, width = 12) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  for (const x of [540 - dx, 540 + dx]) {
    ctx.beginPath();
    ctx.arc(x, y + r * 0.45, r, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  }
}

/** Round open eyes with a glint. */
function roundEyes(ctx, y, dx, { r = 30, iris = "#1d2126", glint = "#ffffff", white = null, whiteR = 0 } = {}) {
  for (const x of [540 - dx, 540 + dx]) {
    if (white) circle(ctx, x, y, whiteR, white);
    circle(ctx, x, y, r, iris);
    circle(ctx, x + r * 0.32, y - r * 0.34, r * 0.3, glint);
  }
}

function cheeks(ctx, y, dx, color, r = 36) {
  ctx.globalAlpha = 0.55;
  circle(ctx, 540 - dx, y, r, color);
  circle(ctx, 540 + dx, y, r, color);
  ctx.globalAlpha = 1;
}

/**
 * The presets. Each draws its whole scene in 1080 x 1920 space, and names where its mouth is
 * (the mouth moves with the audio, so it is drawn per frame, not here) and its colours.
 * Original characters, drawn with a few flat shapes each: cheap on a phone.
 */
export const AUDIOGRAM_PRESETS = [
  {
    id: "sunny",
    label: "Sunny",
    swatch: "#f2be22",
    mouth: { x: 540, y: 790, w: 118, fill: "#6b2a1a", tongue: "#e8735a", line: "#6b2a1a" },
    draw(ctx) {
      ctx.fillStyle = vgrad(ctx, [[0, "#ffe4b0"], [0.5, "#f8ae62"]], 0, AUDIOGRAM_LAYOUT.horizon);
      ctx.fillRect(0, 0, BASE_W, BASE_H);
      // soft rays behind the face
      ctx.save();
      ctx.translate(540, 680);
      ctx.fillStyle = "rgba(255, 246, 220, 0.55)";
      for (let i = 0; i < 12; i++) {
        ctx.rotate((Math.PI * 2) / 12);
        roundRect(ctx, -22, -400, 44, 120, 22);
        ctx.fill();
      }
      ctx.restore();
      ground(ctx, AUDIOGRAM_LAYOUT.horizon, "#5a2a1e", "#22110c");
      // a hill line on the horizon
      ctx.beginPath();
      ctx.moveTo(0, AUDIOGRAM_LAYOUT.horizon + 10);
      ctx.quadraticCurveTo(540, AUDIOGRAM_LAYOUT.horizon - 70, 1080, AUDIOGRAM_LAYOUT.horizon + 10);
      ctx.lineTo(1080, AUDIOGRAM_LAYOUT.horizon + 40);
      ctx.lineTo(0, AUDIOGRAM_LAYOUT.horizon + 40);
      ctx.fillStyle = "#5a2a1e";
      ctx.fill();
      const g = ctx.createRadialGradient(480, 600, 40, 540, 680, 250);
      g.addColorStop(0, "#ffe27a");
      g.addColorStop(1, "#f2be22");
      circle(ctx, 540, 680, 238, g);
      happyEyes(ctx, 655, 88, "#6b2a1a", 32, 13);
      cheeks(ctx, 745, 128, "#ef7d4f", 38);
    },
  },
  {
    id: "moon",
    label: "Moon",
    swatch: "#2a3a78",
    mouth: { x: 540, y: 780, w: 96, fill: "#3e3152", tongue: "#c9758a", line: "#4a3d60" },
    draw(ctx) {
      ctx.fillStyle = vgrad(ctx, [[0, "#26346e"], [1, "#121a3d"]], 0, AUDIOGRAM_LAYOUT.horizon);
      ctx.fillRect(0, 0, BASE_W, BASE_H);
      const rnd = seeded(7);
      for (let i = 0; i < 46; i++) {
        const x = rnd() * 1080;
        const y = 130 + rnd() * 820;
        if (Math.hypot(x - 540, y - 670) < 290) continue;
        ctx.globalAlpha = 0.35 + rnd() * 0.6;
        circle(ctx, x, y, 2 + rnd() * 4, "#fff6d8");
      }
      ctx.globalAlpha = 1;
      // a glow, then the moon's face
      const glow = ctx.createRadialGradient(540, 670, 200, 540, 670, 360);
      glow.addColorStop(0, "rgba(255, 244, 214, 0.28)");
      glow.addColorStop(1, "rgba(255, 244, 214, 0)");
      circle(ctx, 540, 670, 360, glow);
      circle(ctx, 540, 670, 228, "#f3ecd6");
      ctx.globalAlpha = 0.6;
      circle(ctx, 430, 560, 34, "#ddd2b4");
      circle(ctx, 655, 590, 22, "#ddd2b4");
      circle(ctx, 640, 845, 28, "#ddd2b4");
      circle(ctx, 420, 830, 18, "#ddd2b4");
      ctx.globalAlpha = 1;
      // sleepy eyes: downward arcs
      ctx.strokeStyle = "#4a3d60";
      ctx.lineWidth = 12;
      ctx.lineCap = "round";
      for (const x of [458, 622]) {
        ctx.beginPath();
        ctx.arc(x, 650, 30, Math.PI * 0.15, Math.PI * 0.85);
        ctx.stroke();
      }
      cheeks(ctx, 730, 120, "#e99aa8", 32);
      ground(ctx, AUDIOGRAM_LAYOUT.horizon, "#0d1430", "#070a1a");
      ctx.beginPath();
      ctx.moveTo(0, AUDIOGRAM_LAYOUT.horizon + 30);
      ctx.quadraticCurveTo(260, AUDIOGRAM_LAYOUT.horizon - 60, 560, AUDIOGRAM_LAYOUT.horizon + 10);
      ctx.quadraticCurveTo(840, AUDIOGRAM_LAYOUT.horizon - 50, 1080, AUDIOGRAM_LAYOUT.horizon);
      ctx.lineTo(1080, AUDIOGRAM_LAYOUT.horizon + 60);
      ctx.lineTo(0, AUDIOGRAM_LAYOUT.horizon + 60);
      ctx.fillStyle = "#0d1430";
      ctx.fill();
    },
  },
  {
    id: "cat",
    label: "Cat",
    swatch: "#2c7a7b",
    mouth: { x: 540, y: 818, w: 78, fill: "#5b2a1f", tongue: "#f08a8a", line: "#5b2a1f" },
    draw(ctx) {
      ctx.fillStyle = vgrad(ctx, [[0, "#3a9293"], [1, "#256b6c"]], 0, AUDIOGRAM_LAYOUT.horizon);
      ctx.fillRect(0, 0, BASE_W, BASE_H);
      ctx.fillStyle = "rgba(255, 255, 255, 0.07)";
      for (let y = 120; y < 980; y += 120) for (let x = (y / 120) % 2 ? 60 : 120; x < 1080; x += 120) circle(ctx, x, y, 14, "rgba(255, 255, 255, 0.07)");
      ground(ctx, AUDIOGRAM_LAYOUT.horizon, "#133f40", "#0a2223");
      // ears
      const ear = (dir) => {
        ctx.beginPath();
        ctx.moveTo(540 + dir * 120, 520);
        ctx.quadraticCurveTo(540 + dir * 230, 360, 540 + dir * 250, 380);
        ctx.quadraticCurveTo(540 + dir * 280, 520, 540 + dir * 250, 600);
        ctx.closePath();
        ctx.fillStyle = "#f4a259";
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(540 + dir * 150, 530);
        ctx.quadraticCurveTo(540 + dir * 225, 420, 540 + dir * 238, 430);
        ctx.quadraticCurveTo(540 + dir * 255, 520, 540 + dir * 232, 580);
        ctx.closePath();
        ctx.fillStyle = "#f7c6a3";
        ctx.fill();
      };
      ear(-1);
      ear(1);
      ellipse(ctx, 540, 700, 268, 222, "#f4a259");
      // forehead stripes
      ctx.strokeStyle = "#d9823a";
      ctx.lineWidth = 16;
      ctx.lineCap = "round";
      for (const [x, h] of [[500, 70], [540, 90], [580, 70]]) {
        ctx.beginPath();
        ctx.moveTo(x, 490);
        ctx.lineTo(x, 490 + h);
        ctx.stroke();
      }
      ellipse(ctx, 540, 790, 120, 78, "#fbe3cf");
      roundEyes(ctx, 680, 108, { r: 34 });
      // nose and whiskers
      ctx.beginPath();
      ctx.moveTo(522, 760);
      ctx.lineTo(558, 760);
      ctx.lineTo(540, 782);
      ctx.closePath();
      ctx.fillStyle = "#e46f7a";
      ctx.fill();
      ctx.strokeStyle = "rgba(91, 42, 31, 0.55)";
      ctx.lineWidth = 6;
      for (const dir of [-1, 1]) {
        for (const dy of [-14, 12]) {
          ctx.beginPath();
          ctx.moveTo(540 + dir * 130, 790 + dy);
          ctx.lineTo(540 + dir * 250, 780 + dy * 2.2);
          ctx.stroke();
        }
      }
      cheeks(ctx, 770, 170, "#ef8a6b", 30);
    },
  },
  {
    id: "robot",
    label: "Robot",
    swatch: "#2f5fd0",
    mouth: { x: 540, y: 792, w: 130, fill: "#7ef0c2", tongue: null, line: "#7ef0c2" },
    draw(ctx) {
      ctx.fillStyle = vgrad(ctx, [[0, "#3c6fe0"], [1, "#24479f"]], 0, AUDIOGRAM_LAYOUT.horizon);
      ctx.fillRect(0, 0, BASE_W, BASE_H);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
      ctx.lineWidth = 2;
      for (let x = 0; x <= 1080; x += 90) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, AUDIOGRAM_LAYOUT.horizon);
        ctx.stroke();
      }
      for (let y = 0; y <= AUDIOGRAM_LAYOUT.horizon; y += 90) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(1080, y);
        ctx.stroke();
      }
      ground(ctx, AUDIOGRAM_LAYOUT.horizon, "#132658", "#0a142f");
      // antenna
      ctx.strokeStyle = "#a9b2b7";
      ctx.lineWidth = 14;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(540, 480);
      ctx.lineTo(540, 390);
      ctx.stroke();
      circle(ctx, 540, 378, 30, "#f2be22");
      // ears, head and screen
      roundRect(ctx, 270, 620, 50, 140, 20);
      ctx.fillStyle = "#a9b2b7";
      ctx.fill();
      roundRect(ctx, 760, 620, 50, 140, 20);
      ctx.fill();
      roundRect(ctx, 300, 470, 480, 430, 80);
      ctx.fillStyle = "#e8edeb";
      ctx.fill();
      roundRect(ctx, 350, 545, 380, 300, 56);
      ctx.fillStyle = "#1d2126";
      ctx.fill();
      for (const x of [460, 620]) {
        roundRect(ctx, x - 26, 630, 52, 70, 24);
        ctx.fillStyle = "#7ef0c2";
        ctx.fill();
      }
      // bolts
      for (const [x, y] of [[340, 510], [740, 510], [340, 860], [740, 860]]) circle(ctx, x, y, 10, "#a9b2b7");
    },
  },
  {
    id: "cactus",
    label: "Cactus",
    swatch: "#e07a5f",
    mouth: { x: 540, y: 738, w: 70, fill: "#2f3d2a", tongue: "#e8735a", line: "#2f3d2a" },
    draw(ctx) {
      ctx.fillStyle = vgrad(ctx, [[0, "#f7cf98"], [0.6, "#ea8f6a"], [1, "#b8525a"]], 0, AUDIOGRAM_LAYOUT.horizon);
      ctx.fillRect(0, 0, BASE_W, BASE_H);
      circle(ctx, 820, 330, 110, "rgba(255, 240, 200, 0.75)");
      ground(ctx, AUDIOGRAM_LAYOUT.horizon, "#4a2232", "#1f0e16");
      ctx.beginPath();
      ctx.moveTo(0, AUDIOGRAM_LAYOUT.horizon - 20);
      ctx.quadraticCurveTo(300, AUDIOGRAM_LAYOUT.horizon - 90, 620, AUDIOGRAM_LAYOUT.horizon - 10);
      ctx.quadraticCurveTo(880, AUDIOGRAM_LAYOUT.horizon + 30, 1080, AUDIOGRAM_LAYOUT.horizon - 40);
      ctx.lineTo(1080, AUDIOGRAM_LAYOUT.horizon + 40);
      ctx.lineTo(0, AUDIOGRAM_LAYOUT.horizon + 40);
      ctx.fillStyle = "#4a2232";
      ctx.fill();
      const green = "#5da271";
      // arms
      ctx.strokeStyle = green;
      ctx.lineCap = "round";
      ctx.lineWidth = 92;
      ctx.beginPath();
      ctx.moveTo(445, 760);
      ctx.lineTo(330, 760);
      ctx.lineTo(330, 600);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(635, 700);
      ctx.lineTo(752, 700);
      ctx.lineTo(752, 560);
      ctx.stroke();
      // body
      roundRect(ctx, 420, 440, 240, 560, 120);
      ctx.fillStyle = green;
      ctx.fill();
      ctx.strokeStyle = "rgba(47, 61, 42, 0.25)";
      ctx.lineWidth = 8;
      for (const x of [480, 600]) {
        ctx.beginPath();
        ctx.moveTo(x, 520);
        ctx.lineTo(x, 960);
        ctx.stroke();
      }
      // a flower on top
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        circle(ctx, 540 + Math.cos(a) * 26, 440 + Math.sin(a) * 26, 22, "#f2be22");
      }
      circle(ctx, 540, 440, 16, "#e07a5f");
      roundEyes(ctx, 650, 52, { r: 20, iris: "#2f3d2a" });
      cheeks(ctx, 700, 82, "#f08a6b", 20);
    },
  },
  {
    id: "frog",
    label: "Frog",
    swatch: "#7bc47f",
    mouth: { x: 540, y: 842, w: 172, fill: "#4a2a2a", tongue: "#f08a8a", line: "#2f5a35" },
    draw(ctx) {
      ctx.fillStyle = vgrad(ctx, [[0, "#c9e4c5"], [1, "#7fb894"]], 0, AUDIOGRAM_LAYOUT.horizon);
      ctx.fillRect(0, 0, BASE_W, BASE_H);
      ground(ctx, AUDIOGRAM_LAYOUT.horizon - 40, "#1f4a40", "#0b201b");
      // lily pads on the water
      for (const [x, y, r] of [[160, 1040, 90], [930, 1010, 70]]) {
        ellipse(ctx, x, y, r, r * 0.34, "#3f7d55");
      }
      // eye bumps, head
      const skin = "#7bc47f";
      circle(ctx, 430, 610, 92, skin);
      circle(ctx, 650, 610, 92, skin);
      ellipse(ctx, 540, 790, 320, 200, skin);
      ellipse(ctx, 540, 860, 220, 110, "#a6dba6");
      roundEyes(ctx, 600, 110, { r: 36, white: "#ffffff", whiteR: 62 });
      // nostrils
      circle(ctx, 515, 745, 8, "#2f5a35");
      circle(ctx, 565, 745, 8, "#2f5a35");
      cheeks(ctx, 810, 220, "#f19a9a", 34);
    },
  },
];

export const AUDIOGRAM_DEFAULT = "sunny";
export const presetById = (id) => AUDIOGRAM_PRESETS.find((p) => p.id === id) || null;

/**
 * The job's audiogram choice, normalised: { bg: preset id | "cover", cover?: string }.
 * Unknown values fall back to the default preset.
 */
export function audiogramSettings(settings) {
  const a = settings?.audiogram || {};
  if (a.bg === "cover" && a.cover) return { bg: "cover", cover: a.cover, ...(a.focus ? { focus: a.focus } : {}) };
  return { bg: presetById(a.bg) ? a.bg : AUDIOGRAM_DEFAULT };
}

/** True when a source has no picture to show, so clips are rendered as audiograms. */
export const isAudioOnly = (source) => !!source && source.hasVideo === false;

/** Paint a preset's still scene onto a W x H (9:16) context. */
export function paintPreset(ctx, id, W, H) {
  const p = presetById(id) || presetById(AUDIOGRAM_DEFAULT);
  ctx.save();
  ctx.scale(W / BASE_W, H / BASE_H);
  p.draw(ctx);
  ctx.restore();
}

/**
 * How an uploaded image fills 9:16. A portrait image (up to 3:4) is cropped to cover the
 * frame around a focal point (default: centred, a little above the middle, where faces
 * usually are). A square or landscape image (podcast cover art, a photo) is shown whole, as a
 * card in the upper part of the frame over a blurred, darkened copy of itself, as the video
 * "fit" reframe does. Returns the rectangles to draw, in W x H pixels.
 */
export function coverPlan(iw, ih, W, H, { focus = { x: 0.5, y: 0.4 } } = {}) {
  const aspect = iw / ih;
  const coverRect = () => {
    const f = Math.max(W / iw, H / ih);
    const dw = iw * f;
    const dh = ih * f;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const x = clamp(W / 2 - focus.x * dw, W - dw, 0);
    const y = clamp(H / 2 - focus.y * dh, H - dh, 0);
    return { x, y, w: dw, h: dh };
  };
  if (aspect <= 0.75) return { mode: "cover", image: coverRect() };
  const s = W / BASE_W;
  const box = { w: 860 * s, h: 800 * s, cx: W / 2, cy: 575 * s };
  const f = Math.min(box.w / iw, box.h / ih);
  const w = iw * f;
  const h = ih * f;
  return { mode: "card", backdrop: coverRect(), card: { x: box.cx - w / 2, y: box.cy - h / 2, w, h, r: 36 * s } };
}

/**
 * Paint an uploaded image as the background. makeCanvas(w, h) returns a scratch canvas
 * (OffscreenCanvas in the browser, @napi-rs/canvas on the desktop) for the cheap blur: the
 * image drawn tiny and scaled back up, which needs no canvas filter (Safari has none).
 */
export function paintCover(ctx, img, W, H, { focus, makeCanvas } = {}) {
  const iw = img.width;
  const ih = img.height;
  const plan = coverPlan(iw, ih, W, H, { focus });
  ctx.fillStyle = "#1d2126";
  ctx.fillRect(0, 0, W, H);
  if (plan.mode === "cover") {
    const r = plan.image;
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
  } else {
    const r = plan.backdrop;
    const tw = Math.max(8, Math.round(W / 24));
    const th = Math.max(8, Math.round(H / 24));
    const tiny = makeCanvas?.(tw, th);
    if (tiny) {
      const t = tiny.getContext("2d");
      t.drawImage(img, (r.x * tw) / W, (r.y * th) / H, (r.w * tw) / W, (r.h * th) / H);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tiny, 0, 0, W, H);
    } else ctx.drawImage(img, r.x, r.y, r.w, r.h);
    ctx.fillStyle = "rgba(16, 18, 21, 0.45)";
    ctx.fillRect(0, 0, W, H);
    const c = plan.card;
    ctx.save();
    roundRect(ctx, c.x, c.y, c.w, c.h, c.r);
    ctx.clip();
    ctx.drawImage(img, c.x, c.y, c.w, c.h);
    ctx.restore();
  }
  // the caption zone is darkened, whatever the image, so the captions stay readable
  const s = H / BASE_H;
  const g = ctx.createLinearGradient(0, 940 * s, 0, H);
  g.addColorStop(0, "rgba(10, 12, 14, 0)");
  g.addColorStop(0.2, "rgba(10, 12, 14, 0.62)");
  g.addColorStop(1, "rgba(10, 12, 14, 0.82)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 940 * s, W, H - 940 * s);
  return plan;
}

/**
 * The clip's loudness, one value per video frame (0..1), from its real samples: RMS over each
 * 1/fps seconds, in dB, mapped so ordinary speech fills the meter (its 95th percentile is the
 * top, 36 dB below that is the bottom). mono: Float32Array at `rate`.
 * Returns { fps, v: Float32Array, mouth: Float32Array } where mouth is v with a quick attack
 * and a slower release, so the mouth does not flicker shut between syllables.
 */
export function audioEnvelope(mono, rate, { fps = AUDIOGRAM_FPS, frames } = {}) {
  const per = rate / fps;
  const n = frames ?? Math.max(1, Math.ceil(mono.length / per));
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * per);
    const b = Math.min(mono.length, Math.floor((i + 1) * per));
    let sum = 0;
    for (let k = a; k < b; k++) sum += mono[k] * mono[k];
    db[i] = b > a ? 20 * Math.log10(Math.sqrt(sum / (b - a)) + 1e-9) : -120;
  }
  return envelopeFromDb(db, fps);
}

/** The second half of audioEnvelope, for callers that measured dB per frame themselves (streaming). */
export function envelopeFromDb(db, fps = AUDIOGRAM_FPS) {
  const n = db.length;
  const loud = Array.from(db).filter((d) => d > -60).sort((a, b) => a - b);
  const top = loud.length ? Math.max(-40, loud[Math.min(loud.length - 1, Math.floor(loud.length * 0.95))]) : -20;
  const bottom = top - 36;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = Math.min(1, Math.max(0, (db[i] - bottom) / (top - bottom)));
  const mouth = new Float32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const x = v[i] < 0.28 ? 0 : (v[i] - 0.28) / 0.72;
    m = x > m ? m + (x - m) * 0.75 : m * 0.72 + x * 0.28;
    mouth[i] = m;
  }
  return { fps, v, mouth };
}

/** Streaming dB per frame: push Float32 mono chunks, read .db at the end. */
export function dbMeter(rate, fps = AUDIOGRAM_FPS) {
  const per = rate / fps;
  const out = [];
  let sum = 0;
  let count = 0;
  let next = per;
  let seen = 0;
  return {
    push(chunk) {
      for (let k = 0; k < chunk.length; k++) {
        sum += chunk[k] * chunk[k];
        count++;
        seen++;
        if (seen >= next) {
          out.push(20 * Math.log10(Math.sqrt(sum / count) + 1e-9));
          sum = 0;
          count = 0;
          next += per;
        }
      }
    },
    finish() {
      if (count) out.push(20 * Math.log10(Math.sqrt(sum / count) + 1e-9));
      return Float32Array.from(out);
    },
  };
}

const at = (arr, i) => (i >= 0 && i < arr.length ? arr[i] : 0);

/**
 * Paint the moving parts for clip time t: the meter (a scrolling strip of bars, one per 0.1
 * s of the clip's loudness, centred on now; what has been said is marker yellow, what is
 * coming is pale) and, for a preset, the mouth. Draws in W x H frame pixels with the frame's
 * top at y = -offsetY (the desktop paints only the band, so it passes the band's top).
 */
export function paintMoving(ctx, { env, t, W, H, bg, offsetY = 0, highlight = "#F2BE22" }) {
  const s = W / BASE_W;
  ctx.save();
  ctx.translate(0, -offsetY);
  ctx.scale(s, H / BASE_H);
  const preset = presetById(bg);
  if (preset?.mouth) paintMouth(ctx, preset.mouth, env ? at(env.mouth, Math.floor(t * env.fps)) : 0);
  paintMeter(ctx, env, t, highlight);
  ctx.restore();
}

function paintMeter(ctx, env, t, highlight) {
  const M = AUDIOGRAM_LAYOUT.meter;
  const cx = M.x + M.w / 2;
  const half = M.w / 2;
  const perBar = M.barSec;
  const framesPerBar = env ? Math.max(1, Math.round(perBar * env.fps)) : 3;
  const first = Math.floor((t - (half / M.pitch) * perBar) / perBar) - 1;
  const last = Math.ceil((t + (half / M.pitch) * perBar) / perBar) + 1;
  ctx.lineCap = "round";
  ctx.lineWidth = M.barW;
  for (let k = first; k <= last; k++) {
    const bt = (k + 0.5) * perBar; // the bar's centre time
    const x = cx + ((bt - t) / perBar) * M.pitch;
    const d = Math.abs(x - cx) / half;
    if (d > 1) continue;
    let v = 0;
    if (env && bt >= 0) {
      const f0 = k * framesPerBar;
      for (let f = f0; f < f0 + framesPerBar; f++) v = Math.max(v, at(env.v, f));
    }
    const hh = M.minHalf + (M.maxHalf - M.minHalf) * Math.pow(v, 0.85);
    const played = bt <= t;
    // the strip fades out towards its ends
    const fade = 1 - 0.85 * Math.pow(d, 3);
    ctx.globalAlpha = (played ? 1 : 0.5) * fade;
    ctx.strokeStyle = played ? highlight : "#ffffff";
    ctx.beginPath();
    ctx.moveTo(x, M.cy - hh);
    ctx.lineTo(x, M.cy + hh);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** The mouth: a small smile when quiet, opening with the voice. open 0..1. */
export function paintMouth(ctx, m, open) {
  const o = Math.max(0, Math.min(1, open));
  if (o < 0.06) {
    ctx.strokeStyle = m.line;
    ctx.lineWidth = Math.max(8, m.w * 0.09);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(m.x, m.y - m.w * 0.42, m.w * 0.5, Math.PI * 0.28, Math.PI * 0.72);
    ctx.stroke();
    return;
  }
  const w = m.w * (0.78 + 0.22 * o);
  const h = m.w * (0.16 + 0.5 * o);
  ctx.save();
  ctx.beginPath();
  // flat-ish top lip, round bottom: a friendly open mouth
  ctx.moveTo(m.x - w / 2, m.y - h * 0.3);
  ctx.quadraticCurveTo(m.x, m.y - h * 0.48, m.x + w / 2, m.y - h * 0.3);
  ctx.quadraticCurveTo(m.x + w / 2, m.y + h * 0.7, m.x, m.y + h * 0.7);
  ctx.quadraticCurveTo(m.x - w / 2, m.y + h * 0.7, m.x - w / 2, m.y - h * 0.3);
  ctx.closePath();
  ctx.fillStyle = m.fill;
  ctx.fill();
  if (m.tongue && o > 0.25) {
    ctx.clip();
    ellipse(ctx, m.x, m.y + h * 0.62, w * 0.3, h * 0.34, m.tongue);
  }
  ctx.restore();
}
