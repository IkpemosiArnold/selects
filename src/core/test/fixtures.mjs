// Shared test helpers: build Word[] from plain text at a steady speaking pace.

/**
 * words("Hello there. How are you?", { start: 10, wps: 2.5, gaps: { 2: 1.5 } })
 * gaps maps a word index to extra silence inserted before that word.
 */
export function words(text, { start = 0, wps = 2.5, gaps = {} } = {}) {
  const out = [];
  let t = start;
  const step = 1 / wps;
  text
    .split(/\s+/)
    .filter(Boolean)
    .forEach((w, i) => {
      t += gaps[i] || 0;
      out.push({ w, s: +t.toFixed(3), e: +(t + step * 0.8).toFixed(3), p: 0.9 });
      t += step;
    });
  return out;
}

/** A long talk-like transcript: n sentences of about 8 words each. */
export function talk(n, { opener = (i) => `Point ${i} is that`, wps = 2.5 } = {}) {
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(`${opener(i)} we tried something new and it worked.`);
  return words(parts.join(" "), { wps });
}
