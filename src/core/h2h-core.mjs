// Head-to-head ranking, with no Node imports (the desktop, the browser and the eval share it).
//
// Why: the judge scores each clip on its own, 1 to 5. On a long conversation those scores
// saturate (14 of 36 judged clips got the top "moment" score in one test), so the order at the
// top of the list was decided by the first-stage score, not by the model. Comparing two clips
// is easier than placing one on an absolute scale, so after the absolute judge (the gate), the
// best `n` distinct clips play a short Swiss tournament of pairs ("which would you post
// first?") and a Bradley-Terry fit of the results orders them.
//
//   - Pairs: each round pairs clips of similar current strength that have not met (Swiss), so
//     every call compares near-equals, where an answer carries the most information.
//   - Position bias: a model tends to prefer the clip it reads first (or second). With
//     orders "both", every pair is asked in both orders; with "alternate", each pair once,
//     with each clip shown first about as often as second. Either way the fit has a term for
//     the first position (h), so a model that always answers "A" moves no clip.
//   - The fit: P(first beats second) = sigmoid(s_first - s_second + h), maximised with a
//     Gaussian prior (sd PRIOR_SD) on every s and on h, by Newton's method. The prior keeps an
//     unbeaten clip finite and pulls clips with few games toward the middle.
//   - The budget: at most maxCalls calls; a round is only started for the pairs that fit.

import { clipExcerpt } from "./judge-core.mjs";

/**
 * Defaults per runtime. Smart mode (Gemma 4 26B through the Gemini API, paced under the
 * proxy's 20 calls a minute): the top 20, 6 rounds of 10 pairs in both orders, 120 calls, about
 * 6 to 7 minutes. On the device (Gemma 3 4B, 40 to 100 s a call on a 2017 laptop): the top 8,
 * 3 rounds of 4 pairs asked once each, 12 calls.
 */
export const H2H_DEFAULTS = {
  smart: { n: 20, rounds: 6, orders: "both", maxCalls: 150 },
  device: { n: 8, rounds: 3, orders: "alternate", maxCalls: 12 },
};
/**
 * Whether a job runs the head-to-head round (settings.h2h), in place of the one-call listwise
 * round. Off unless asked for: see H2H_DEFAULT_ON.
 */
export const H2H_DEFAULT_ON = false;
export const h2hOn = (settings = {}) => (settings.h2h ?? H2H_DEFAULT_ON) === true;

/** Output budget for one pair answer: a letter and a 12-word reason. */
export const PAIR_MAX_TOKENS = 60;
/** Words of each clip the pair prompt shows (its opening and ending past this). */
export const PAIR_WORDS = 120;
/** The prior's standard deviation on every strength and on the first-position term (logit scale). */
export const PRIOR_SD = 1;

export const PAIR_SCHEMA = {
  type: "object",
  properties: {
    first: { type: "string", enum: ["A", "B"] },
    why: { type: "string", maxLength: 100 },
  },
  required: ["first", "why"],
};

/** The pair prompt's chat messages: clip A is shown first. */
export function pairMessages(prompt, a, b) {
  const block = (l, c) => `Clip ${l} (${Math.round(c.end - c.start)} s):\n${clipExcerpt(c, PAIR_WORDS)}`;
  return [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user.replace("{{a}}", block("A", a)).replace("{{b}}", block("B", b)) },
  ];
}

/**
 * Read a pair answer (parsed JSON or raw text) -> { first: "A"|"B", why } or null when no
 * clear choice can be read. Accepts {"first": "B"}, "Clip B", a bare "b", and the same under
 * the keys winner, choice, clip or answer.
 */
export function parsePairAnswer(answer) {
  const pick = (v) => {
    const m = String(v ?? "").trim().match(/^(?:clip\s*)?([AB])\b/i);
    return m ? m[1].toUpperCase() : null;
  };
  let first = null;
  let why = "";
  if (answer && typeof answer === "object") {
    for (const k of ["first", "winner", "choice", "clip", "answer"]) {
      first = pick(answer[k]);
      if (first) break;
    }
    why = typeof answer.why === "string" ? answer.why : typeof answer.reason === "string" ? answer.reason : "";
  } else if (typeof answer === "string") {
    const t = answer.replace(/```(?:json)?/gi, "");
    const m = t.match(/"(?:first|winner|choice|clip|answer)"\s*:\s*"(?:clip\s*)?([AB])\b/i) || t.match(/^\s*(?:clip\s*)?([AB])\b/i);
    first = m ? m[1].toUpperCase() : null;
    const w = t.match(/"(?:why|reason)"\s*:\s*"((?:[^"\\]|\\.)*)/);
    why = w ? w[1].replace(/\\"/g, '"') : "";
  }
  if (!first) return null;
  return { first, why: String(why).replace(/\s+/g, " ").trim() };
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * Bradley-Terry with a first-position term, fitted by Newton's method on the posterior.
 * games: [{ first: index, second: index, y }] with y = 1 when the first-shown clip won, 0 when
 * the second won (0.5 counts as half a win each). Returns { s: number[], h, iters }.
 * @param {number} n number of items
 * @param {{first:number, second:number, y:number}[]} games
 * @param {{priorSd?:number, bias?:boolean, maxIter?:number}} [opts] bias false fixes h at 0
 */
export function fitBradleyTerry(n, games, { priorSd = PRIOR_SD, bias = true, maxIter = 50 } = {}) {
  const m = n + (bias ? 1 : 0); // the last parameter is h
  const theta = new Array(m).fill(0);
  const lam = 1 / (priorSd * priorSd);
  let it = 0;
  for (; it < maxIter; it++) {
    const g = theta.map((t) => -lam * t);
    const H = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => (i === j ? lam : 0))); // negative Hessian
    for (const { first: i, second: j, y } of games) {
      const p = sigmoid(theta[i] - theta[j] + (bias ? theta[n] : 0));
      const r = y - p;
      const w = p * (1 - p);
      const idx = bias ? [[i, 1], [j, -1], [n, 1]] : [[i, 1], [j, -1]];
      for (const [a, sa] of idx) {
        g[a] += sa * r;
        for (const [b, sb] of idx) H[a][b] += sa * sb * w;
      }
    }
    const step = solve(H, g);
    let max = 0;
    for (let k = 0; k < m; k++) {
      theta[k] += step[k];
      max = Math.max(max, Math.abs(step[k]));
    }
    if (max < 1e-9) break;
  }
  return { s: theta.slice(0, n), h: bias ? theta[n] : 0, iters: it + 1 };
}

/** Solve A x = b for a small symmetric positive definite A (Gaussian elimination, partial pivoting). */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * One Swiss round: pair every item with a near neighbour in strength that it has not met.
 * A depth-first search takes the strongest unpaired item and tries partners from the nearest
 * down, so the round pairs everyone when that is possible (a greedy walk can strand the last
 * few with only rematches left); one item sits out when the count is odd, and more only when
 * no full pairing exists or the search runs past its step limit (then the greedy walk is used).
 * @param {number[]} order item indexes, strongest first
 * @param {Set<string>} met "i|j" keys (i < j) of pairs that have already played
 * @returns {[number, number][]}
 */
export function swissPairs(order, met, { maxSteps = 20000 } = {}) {
  let steps = 0;
  const search = (free, byes) => {
    if (free.length === 0) return [];
    if (++steps > maxSteps) return null;
    const [a, ...rest] = free;
    for (let k = 0; k < rest.length; k++) {
      const b = rest[k];
      if (met.has(pairKey(a, b))) continue;
      const tail = search([...rest.slice(0, k), ...rest.slice(k + 1)], byes);
      if (tail) return [[a, b], ...tail];
      if (steps > maxSteps) return null;
    }
    // a sits out, if a bye is left (the weakest items are tried as partners first, so a bye
    // falls to an item that has met everyone near it)
    if (byes > 0) return search(rest, byes - 1);
    return null;
  };
  const full = search(order, order.length % 2);
  if (full) return full;
  // no full pairing (or too many steps): the greedy walk
  const free = order.slice();
  const pairs = [];
  while (free.length > 1) {
    const a = free.shift();
    const k = free.findIndex((b) => !met.has(pairKey(a, b)));
    if (k < 0) continue; // a has met everyone left: a bye
    const [b] = free.splice(k, 1);
    pairs.push([a, b]);
  }
  return pairs;
}

export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * A pair call reads two clips, so it costs more than a judge call: about 1.6 times on a CPU,
 * where reading the prompt is most of the time (two excerpts of up to 120 words each, against
 * one clip and the rubric).
 */
export const PAIR_COST = 1.6;

/** Seconds the round should take at `secPerCall` seconds per judge call (null when unknown). */
export function h2hEstimateSec(o, secPerCall) {
  return secPerCall > 0 ? Math.round(h2hCalls(o) * secPerCall * PAIR_COST) : null;
}

/** How many calls a tournament of n clips makes at most. */
export function h2hCalls({ n, rounds, orders = "both", maxCalls = Infinity }) {
  const pair = orders === "both" ? 2 : 1;
  const per = Math.floor(Math.max(0, n) / 2) * pair;
  return Math.min(Math.floor(maxCalls / pair) * pair, per * Math.max(0, Math.min(rounds, n - 1)));
}

/**
 * Run the tournament. `items` are the clips in their absolute order (best first): that order
 * seeds the first round and breaks ties at the end. `ask(first, second)` resolves to
 * { first: "A"|"B", why } (A is the clip shown first) or throws; a failed or unreadable
 * answer is left out of the fit.
 * @returns {Promise<{order:number[], s:number[], h:number, games:object[], calls:number,
 *   failed:number, rounds:number, consistency:number|null, wins:number[], losses:number[], why:string[]}>}
 */
export async function tournament(items, ask, { rounds = 6, orders = "both", maxCalls = 150, concurrency = 1, signal, onProgress, onGame } = {}) {
  const n = items.length;
  const games = [];
  const met = new Set();
  const firsts = new Array(n).fill(0);
  const seconds = new Array(n).fill(0);
  const why = new Array(n).fill(null);
  const planned = h2hCalls({ n, rounds, orders, maxCalls });
  let calls = 0;
  let failed = 0;
  let played = 0;
  let fit = { s: new Array(n).fill(0), h: 0 };
  // current order: by strength, ties by the absolute order (the index)
  const ordered = () => items.map((_, i) => i).sort((a, b) => fit.s[b] - fit.s[a] || a - b);
  for (let r = 0; r < rounds && n > 1; r++) {
    if (signal?.aborted) throw signal.reason ?? Object.assign(new Error("Stopped before it finished."), { name: "AbortError" });
    const per = orders === "both" ? 2 : 1;
    const pairs = swissPairs(r === 0 ? items.map((_, i) => i) : ordered(), met).slice(0, Math.floor((maxCalls - calls) / per));
    if (!pairs.length) break;
    const jobs = [];
    for (const [a, b] of pairs) {
      met.add(pairKey(a, b));
      if (orders === "both") jobs.push([a, b], [b, a]);
      else {
        // the clip shown first less often goes first; on a tie, alternate by round
        const aFirst = firsts[a] - seconds[a] < firsts[b] - seconds[b] || (firsts[a] - seconds[a] === firsts[b] - seconds[b] && (r + a + b) % 2 === 0);
        jobs.push(aFirst ? [a, b] : [b, a]);
      }
    }
    for (const [f, s] of jobs) {
      firsts[f]++;
      seconds[s]++;
    }
    const lanes = Math.max(1, Math.min(concurrency, jobs.length));
    await Promise.all(Array.from({ length: lanes }, async () => {
      while (jobs.length) {
        const [f, s] = jobs.shift();
        if (signal?.aborted) return;
        calls++;
        let ans = null;
        try {
          ans = await ask(items[f], items[s]);
        } catch (e) {
          if (e?.name === "AbortError") throw e;
          ans = null;
        }
        if (ans?.first === "A" || ans?.first === "B") {
          const y = ans.first === "A" ? 1 : 0;
          const g = { round: r + 1, first: f, second: s, y, why: ans.why || "" };
          games.push(g);
          const w = y ? f : s;
          if (g.why) why[w] = g.why;
          onGame?.(g);
        } else failed++;
        onProgress?.({ done: calls, total: planned, progress: planned ? Math.min(1, calls / planned) : 1 });
      }
    }));
    if (signal?.aborted) throw signal.reason ?? Object.assign(new Error("Stopped before it finished."), { name: "AbortError" });
    played = r + 1;
    fit = fitBradleyTerry(n, games);
  }
  const wins = new Array(n).fill(0);
  const losses = new Array(n).fill(0);
  for (const g of games) {
    const [w, l] = g.y ? [g.first, g.second] : [g.second, g.first];
    wins[w]++;
    losses[l]++;
  }
  // with both orders: how often the two answers for one pair agreed
  let agree = 0;
  let both = 0;
  const byPair = new Map();
  for (const g of games) {
    const k = `${g.round}:${pairKey(g.first, g.second)}`;
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(g);
  }
  for (const gs of byPair.values()) {
    if (gs.length !== 2) continue;
    both++;
    const winner = (g) => (g.y ? g.first : g.second);
    if (winner(gs[0]) === winner(gs[1])) agree++;
  }
  return { order: ordered(), s: fit.s, h: fit.h, games, calls, failed, rounds: played, consistency: both ? +(agree / both).toFixed(3) : null, wins, losses, why };
}

/**
 * Put the tournament's order on the candidates: each clip that played gets h2hRank (1 is
 * best), h2hScore (its strength), h2hRecord ("4-2") and h2hWhy (the reason from a win).
 * rank.mjs puts clips with an h2hRank first, in that order; `total` is not changed, so the
 * quality bar still reads the absolute judge.
 * @param {object[]} candidates every judged candidate
 * @param {object[]} top the clips that played, in the order given to tournament()
 */
export function applyH2H(candidates, top, result) {
  const info = new Map();
  result.order.forEach((i, pos) => {
    info.set(top[i].id, { h2hRank: pos + 1, h2hScore: +result.s[i].toFixed(3), h2hRecord: `${result.wins[i]}-${result.losses[i]}`, h2hWhy: result.why[i] || null });
  });
  return candidates.map((c) => {
    const { h2hRank, h2hScore, h2hRecord, h2hWhy, ...rest } = c; // a re-run replaces the last round
    return info.has(c.id) ? { ...rest, ...info.get(c.id) } : rest;
  });
}

/** A short summary for the job: what was compared, how many calls, and the order. */
export function h2hSummary(top, result, { orders, sec = null } = {}) {
  return {
    clips: top.length,
    rounds: result.rounds,
    orders,
    calls: result.calls,
    failed: result.failed,
    firstBias: +result.h.toFixed(3),
    consistency: result.consistency,
    order: result.order.map((i) => top[i].id),
    ...(sec != null ? { sec } : {}),
  };
}
