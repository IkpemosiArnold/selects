// Timecode formatting. Editors read mm:ss; tenths only where precision matters.
const pad = (n, w = 2) => String(n).padStart(w, "0");

export function tc(sec, { tenths = false } = {}) {
  if (sec == null || !Number.isFinite(sec)) return "--:--";
  const neg = sec < 0;
  sec = Math.abs(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = tenths ? Math.floor((sec % 60) * 10) / 10 : Math.floor(sec % 60);
  const ss = tenths ? s.toFixed(1).padStart(4, "0") : pad(s);
  return (neg ? "-" : "") + (h ? `${h}:${pad(m)}:${ss}` : `${pad(m)}:${ss}`);
}

export function secs(n) {
  return `${Math.round(n)} s`;
}

export function aboutMinutes(sec) {
  if (sec == null || !Number.isFinite(sec)) return null;
  if (sec < 50) return "less than a minute";
  const m = Math.round(sec / 60);
  if (m < 90) return m === 1 ? "about 1 minute" : `about ${m} minutes`;
  const h = Math.round((sec / 3600) * 10) / 10;
  return `about ${h} hours`;
}

export function plural(n, one, many = one + "s") {
  return `${n} ${n === 1 ? one : many}`;
}
