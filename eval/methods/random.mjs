// "random": a seeded chance baseline. Draws scores uniformly at random for the same candidate
// windows every other method sees, so window lengths and boundaries are identical; only the
// choice is random. The runner averages it over many seeds to report the chance level.
import { rng } from "../metrics.mjs";

export function randomScore(candidates, seed = 1) {
  const r = rng(seed);
  return candidates.map((c) => ({ ...c, total: r() }));
}
