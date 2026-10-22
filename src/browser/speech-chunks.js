// Light mode's audio pieces: where to cut 16 kHz mono speech before it is compressed and sent
// to be transcribed. Pure functions, tested in Node (speech-chunks.test.mjs).
//
// - Each piece is one stretch of contiguous audio with a known start, so word times are exact
//   after adding the start back (no time warping, unlike gluing speech together).
// - Pieces end at the quietest 50 ms near their limit, so a word is never cut in two.
// - The first piece is short (30 s) so the first words come back quickly; later pieces are
//   longer (up to 2 minutes) to keep the number of requests down.
// - Speech regions from a voice activity detector can be passed in: long stretches without
//   speech are then never sent. Without a detector, speechRegions() is a cautious stand-in
//   that only drops long, near-silent stretches.

export const FRAME_SEC = 0.05;

/** Loudness of each 50 ms frame, in dBFS. */
export function frameDb(pcm, rate = 16000) {
  const n = Math.round(rate * FRAME_SEC);
  const out = new Float32Array(Math.ceil(pcm.length / n));
  for (let f = 0; f < out.length; f++) {
    let s = 0;
    const end = Math.min(pcm.length, (f + 1) * n);
    for (let k = f * n; k < end; k++) s += pcm[k] * pcm[k];
    out[f] = 10 * Math.log10(s / Math.max(1, end - f * n) + 1e-12);
  }
  return out;
}

/**
 * Speech regions [[startSec, endSec], ...] by a cautious loudness rule: a stretch counts as
 * silence only when it stays below the floor for at least minSilenceSec. The floor is relative
 * to the recording (35 dB under its loud frames, and never above -45 dBFS), so a quietly
 * recorded speaker is not dropped. Regions are padded by padSec on both sides.
 */
export function speechRegions(pcm, rate = 16000, { minSilenceSec = 2, padSec = 0.3 } = {}) {
  const db = frameDb(pcm, rate);
  if (!db.length) return [];
  const sorted = Float32Array.from(db).sort();
  const loud = sorted[Math.floor(sorted.length * 0.95)];
  const floor = Math.min(-45, loud - 35);
  const total = pcm.length / rate;
  const minFrames = Math.round(minSilenceSec / FRAME_SEC);
  const out = [];
  let start = null;
  let quiet = 0;
  for (let f = 0; f <= db.length; f++) {
    const speech = f < db.length && db[f] >= floor;
    if (speech) {
      if (start == null) start = f;
      quiet = 0;
    } else if (start != null) {
      quiet++;
      if (quiet >= minFrames || f === db.length) {
        out.push([Math.max(0, start * FRAME_SEC - padSec), Math.min(total, (f - quiet + 1) * FRAME_SEC + padSec)]);
        start = null;
        quiet = 0;
      }
    }
  }
  return out;
}

/** The quietest 50 ms frame in [from, to) samples, as a cut point in samples. */
function quietest(db, rate, from, to) {
  const n = Math.round(rate * FRAME_SEC);
  let best = to;
  let bestDb = Infinity;
  for (let f = Math.ceil(from / n); (f + 1) * n <= to; f++) {
    if (db[f] < bestDb) {
      bestDb = db[f];
      best = f * n + Math.round(n / 2);
    }
  }
  return best;
}

/**
 * The pieces to send: [{ start, end }] in samples, in order. regions: speech regions in
 * seconds (from a VAD or speechRegions), or null for all of it. Regions closer than joinSec
 * are sent as one piece (the gap is short; dropping it saves little and costs a request).
 */
export function planChunks(pcm, rate = 16000, { regions = null, firstSec = 30, maxSec = 120, searchSec = 8, joinSec = 3, db = null } = {}) {
  const len = pcm.length;
  if (!len) return [];
  const loud = db || frameDb(pcm, rate);
  const spans = [];
  for (const [a, b] of (regions || [[0, len / rate]]).map(([a, b]) => [Math.max(0, Math.floor(a * rate)), Math.min(len, Math.ceil(b * rate))]).filter(([a, b]) => b > a)) {
    const last = spans[spans.length - 1];
    if (last && a - last[1] <= joinSec * rate) last[1] = Math.max(last[1], b);
    else spans.push([a, b]);
  }
  const out = [];
  for (const [a, b] of spans) {
    let pos = a;
    while (pos < b) {
      const limit = (out.length ? maxSec : firstSec) * rate;
      if (b - pos <= limit) {
        out.push({ start: pos, end: b });
        break;
      }
      const hard = pos + limit;
      // the cut: the quietest moment in the last searchSec (the first piece searches its last third)
      const search = Math.min(searchSec * rate, Math.floor(limit / 3));
      const cut = quietest(loud, rate, hard - search, hard);
      out.push({ start: pos, end: cut });
      pos = cut;
    }
  }
  return out;
}

/**
 * Run pieces with up to `concurrency` in flight and hand the results back strictly in order
 * (so the transcript streams from the start). run(piece, i) -> Promise<result>;
 * onResult(result, i) is called in order. Stops at the first failure, reporting how far the
 * in-order results reached ({ error, done }), so a fallback can carry on from there.
 */
export async function inOrder(pieces, run, { concurrency = 2, onResult, signal } = {}) {
  const results = new Array(pieces.length);
  const settled = new Array(pieces.length).fill(false);
  let next = 0;
  let delivered = 0;
  let failure = null;
  // one delivery at a time, so two pieces finishing together are still handed back in order
  let chain = Promise.resolve();
  const deliver = () =>
    (chain = chain.then(async () => {
      while (delivered < pieces.length && settled[delivered]) {
        await onResult?.(results[delivered], delivered);
        delivered++;
      }
    }));
  const worker = async () => {
    while (!failure && next < pieces.length) {
      if (signal?.aborted) throw Object.assign(new Error("Stopped before it finished."), { name: "AbortError" });
      const i = next++;
      try {
        results[i] = await run(pieces[i], i);
        settled[i] = true;
        await deliver();
      } catch (e) {
        failure ??= { error: e, index: i };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, pieces.length)) }, worker));
  await deliver();
  return { done: delivered, error: failure?.error ?? null };
}
