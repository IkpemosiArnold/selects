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
 * 16 kHz audio that grows while it is decoded: append(block) as blocks arrive, finish() at
 * the end. wait(n) resolves when at least n samples (or everything) are there. The buffer is
 * sized from the duration once, so it is never copied while it grows.
 */
export function growingPcm(expectedSamples) {
  let buf = new Float32Array(Math.max(1, Math.ceil(expectedSamples * 1.01) + 16000));
  let length = 0;
  let done = false;
  let waiters = [];
  const wake = () => {
    const ready = waiters.filter((w) => done || length >= w.n);
    waiters = waiters.filter((w) => !ready.includes(w));
    for (const w of ready) w.resolve();
  };
  return {
    get length() {
      return length;
    },
    get done() {
      return done;
    },
    /** The audio so far (a view, not a copy). */
    get pcm() {
      return buf.subarray(0, length);
    },
    append(block) {
      if (length + block.length > buf.length) {
        const bigger = new Float32Array(Math.ceil((length + block.length) * 1.25));
        bigger.set(buf.subarray(0, length));
        buf = bigger;
      }
      buf.set(block, length);
      length += block.length;
      wake();
    },
    finish() {
      done = true;
      wake();
    },
    wait(n) {
      return done || length >= n ? Promise.resolve() : new Promise((resolve) => waiters.push({ n, resolve }));
    },
  };
}

/** Trim a piece to the speech in it (padded), or null when it has none. Offsets stay exact. */
export function trimToSpeech(pcm, piece, rate = 16000) {
  const regions = speechRegions(pcm.subarray(piece.start, piece.end), rate);
  if (!regions.length) return null;
  return { start: piece.start + Math.floor(regions[0][0] * rate), end: Math.min(piece.end, piece.start + Math.ceil(regions[regions.length - 1][1] * rate)) };
}

/**
 * Pieces of growing audio as soon as each can be cut: a short first piece, then pieces of up
 * to maxSec, each ending at the quietest 50 ms near its limit, each trimmed to its speech
 * (a piece of silence is not sent). An async generator of { start, end } in samples.
 */
export async function* progressivePieces(audio, rate = 16000, { firstSec = 30, maxSec = 120, searchSec = 8, trim = true } = {}) {
  let pos = 0;
  let first = true;
  for (;;) {
    const limit = (first ? firstSec : maxSec) * rate;
    await audio.wait(pos + limit + 1);
    const pcm = audio.pcm;
    let end;
    if (pcm.length - pos <= limit) {
      if (!audio.done) continue;
      end = pcm.length;
    } else {
      const hard = pos + limit;
      const search = Math.min(searchSec * rate, Math.floor(limit / 3));
      const db = frameDb(pcm.subarray(hard - search, hard), rate);
      let best = db.length - 1;
      for (let f = 0; f < db.length; f++) if (db[f] < db[best]) best = f;
      end = hard - search + best * Math.round(rate * FRAME_SEC) + Math.round((rate * FRAME_SEC) / 2);
    }
    if (end > pos) {
      const piece = trim ? trimToSpeech(pcm, { start: pos, end }, rate) : { start: pos, end };
      if (piece && piece.end > piece.start) {
        yield piece;
        first = false;
      }
    }
    pos = end;
    if (pos >= audio.length && audio.done) return;
  }
}

/**
 * Run pieces with up to `concurrency` in flight and hand the results back strictly in order
 * (so the transcript streams from the start). pieces: an array or an (async) iterable, so
 * pieces can be cut while the audio is still being read. run(piece, i) -> Promise<result>;
 * onResult(result, i) is called in order. Stops at the first failure, reporting how far the
 * in-order results reached ({ error, done }), so a fallback can carry on from there.
 */
export async function inOrder(pieces, run, { concurrency = 2, onResult, signal } = {}) {
  const it = (pieces[Symbol.asyncIterator] || pieces[Symbol.iterator]).call(pieces);
  const results = new Map();
  let taken = 0;
  let delivered = 0;
  let failure = null;
  let exhausted = false;
  // one pull at a time, so pieces are numbered in order
  let pulling = Promise.resolve();
  const pull = () =>
    (pulling = pulling.then(async () => {
      if (exhausted || failure) return null;
      const n = await it.next();
      if (n.done) {
        exhausted = true;
        return null;
      }
      return { piece: n.value, i: taken++ };
    }));
  // one delivery at a time, so two pieces finishing together are still handed back in order
  let chain = Promise.resolve();
  const deliver = () =>
    (chain = chain.then(async () => {
      // pieces before a failure are still handed back when they arrive; none after it
      while (results.has(delivered) && (!failure || delivered < failure.index)) {
        await onResult?.(results.get(delivered), delivered);
        results.delete(delivered);
        delivered++;
      }
    }));
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error("Stopped before it finished."), { name: "AbortError" });
      const next = await pull();
      if (!next) return;
      try {
        results.set(next.i, await run(next.piece, next.i));
        await deliver();
      } catch (e) {
        if (!failure || next.i < failure.index) failure = { error: e, index: next.i };
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  await deliver();
  if (failure) await it.return?.();
  return { done: delivered, error: failure?.error ?? null };
}
