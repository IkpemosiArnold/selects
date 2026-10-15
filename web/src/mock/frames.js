// Procedural stand-ins for video frames in mock mode: a conference stage with a
// speaker and a projected slide. Returns SVG data URLs (320 x 180, 16:9).

const SLIDES = ["title", "diagram", "timeline", "code", "code", "boxes", "numbers", "list"];

function slide(kind, x, y, w, h) {
  const bg = kind === "code" ? "#1b2330" : "#eef1ef";
  const ink = kind === "code" ? "#9fb3c8" : "#2b3138";
  let body = "";
  const L = (lx, ly, lw, c = ink, o = 1) =>
    `<rect x="${x + lx}" y="${y + ly}" width="${lw}" height="${h * 0.045}" rx="1" fill="${c}" opacity="${o}"/>`;
  if (kind === "title") {
    body = L(w * 0.1, h * 0.36, w * 0.7) + L(w * 0.1, h * 0.48, w * 0.5) + L(w * 0.1, h * 0.7, w * 0.3, "#2f5fd0", 0.8);
  } else if (kind === "code") {
    const cols = ["#c792ea", "#82aaff", "#c3e88d", "#f2be22", "#9fb3c8"];
    for (let i = 0; i < 9; i++) body += L(w * (0.08 + (i % 3) * 0.04), h * (0.12 + i * 0.085), w * (0.25 + ((i * 37) % 40) / 100), cols[i % 5], 0.85);
  } else if (kind === "diagram") {
    for (let i = 0; i < 3; i++) {
      body += `<rect x="${x + w * (0.07 + i * 0.31)}" y="${y + h * 0.38}" width="${w * 0.24}" height="${h * 0.26}" rx="2" fill="none" stroke="${ink}" stroke-width="1.4"/>`;
      if (i < 2) body += `<rect x="${x + w * (0.31 + i * 0.31)}" y="${y + h * 0.5}" width="${w * 0.07}" height="1.2" fill="${ink}"/>`;
    }
    body += L(w * 0.07, h * 0.14, w * 0.5);
  } else if (kind === "timeline") {
    body += `<rect x="${x + w * 0.08}" y="${y + h * 0.55}" width="${w * 0.84}" height="1.4" fill="${ink}"/>`;
    for (let i = 0; i < 5; i++) body += `<circle cx="${x + w * (0.12 + i * 0.19)}" cy="${y + h * 0.55}" r="${h * 0.035}" fill="${i === 3 ? "#c8402f" : ink}"/>` + L(w * (0.07 + i * 0.19), h * 0.66, w * 0.12, ink, 0.6);
    body += L(w * 0.08, h * 0.14, w * 0.42);
  } else if (kind === "boxes") {
    ["#2b3138", "#2b3138", "#2f5fd0"].forEach((c, i) => {
      body += `<rect x="${x + w * (0.08 + i * 0.3)}" y="${y + h * 0.32}" width="${w * 0.24}" height="${h * 0.4}" rx="2" fill="${c}" opacity="${i === 2 ? 0.9 : 0.15}"/>`;
    });
  } else if (kind === "numbers") {
    body += `<text x="${x + w * 0.08}" y="${y + h * 0.62}" font-family="Georgia, serif" font-size="${h * 0.34}" fill="${ink}">-90%</text>` + L(w * 0.08, h * 0.76, w * 0.5, ink, 0.6);
  } else {
    for (let i = 0; i < 4; i++) body += `<circle cx="${x + w * 0.1}" cy="${y + h * (0.27 + i * 0.16)}" r="1.6" fill="${ink}"/>` + L(w * 0.15, h * (0.25 + i * 0.16), w * (0.4 + ((i * 23) % 30) / 100));
  }
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${bg}"/>${body}`;
}

function speaker(cx, base, s) {
  // Shoulders, neck, head, hair. Plain shapes, no likeness.
  return `
  <path d="M${cx - 34 * s} ${base} C ${cx - 33 * s} ${base - 30 * s}, ${cx - 20 * s} ${base - 40 * s}, ${cx} ${base - 41 * s} C ${cx + 20 * s} ${base - 40 * s}, ${cx + 33 * s} ${base - 30 * s}, ${cx + 34 * s} ${base} Z" fill="#2d4f58"/>
  <path d="M${cx - 7 * s} ${base - 41 * s} L${cx} ${base - 30 * s} L${cx + 7 * s} ${base - 41 * s} Z" fill="#d9dfdc"/>
  <rect x="${cx - 5 * s}" y="${base - 50 * s}" width="${10 * s}" height="${10 * s}" fill="#7a4a2f"/>
  <ellipse cx="${cx}" cy="${base - 62 * s}" rx="${12.5 * s}" ry="${15 * s}" fill="#8a5636"/>
  <path d="M${cx - 13 * s} ${base - 64 * s} C ${cx - 14 * s} ${base - 82 * s}, ${cx + 14 * s} ${base - 84 * s}, ${cx + 13 * s} ${base - 64 * s} C ${cx + 9 * s} ${base - 74 * s}, ${cx - 9 * s} ${base - 74 * s}, ${cx - 13 * s} ${base - 64 * s} Z" fill="#1f1714"/>`;
}

const memo = new Map();

export function frameSvg(index, total = 60) {
  const key = index + "/" + total;
  if (memo.has(key)) return memo.get(key);
  const k = Math.floor((index / total) * SLIDES.length);
  const kind = SLIDES[Math.min(SLIDES.length - 1, k)];
  const shot = index % 7 === 3 || index % 11 === 5 ? "close" : index % 9 === 6 ? "slide" : "wide";
  let inner;
  if (shot === "slide") {
    inner = `<rect width="320" height="180" fill="#0d0f12"/>` + slide(kind, 18, 10, 284, 160);
  } else if (shot === "close") {
    inner = `<defs><radialGradient id="g" cx="0.5" cy="0.35" r="0.8"><stop offset="0" stop-color="#3a4048"/><stop offset="1" stop-color="#14171b"/></radialGradient></defs>
      <rect width="320" height="180" fill="url(#g)"/>
      <circle cx="60" cy="50" r="18" fill="#f2be22" opacity="0.08"/><circle cx="270" cy="40" r="26" fill="#6e95f0" opacity="0.08"/>
      ${speaker(160 + ((index * 7) % 9) - 4, 196, 2.2)}`;
  } else {
    inner = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#262b31"/><stop offset="1" stop-color="#121417"/></linearGradient></defs>
      <rect width="320" height="180" fill="url(#g)"/>
      ${slide(kind, 186, 22, 118, 70)}
      <rect x="0" y="146" width="320" height="34" fill="#0c0e10"/>
      ${speaker(150 + ((index * 5) % 11) - 5, 150, 1.05)}
      <path d="M126 118 L174 118 L170 150 L130 150 Z" fill="#3b3330"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180">${inner}</svg>`;
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  memo.set(key, url);
  return url;
}
