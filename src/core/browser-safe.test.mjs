// The modules the browser build (src/browser) imports must load without Node: no node:
// builtins and no native packages anywhere in their import graph.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BROWSER_SAFE = [
  "sentences.mjs", "nonspeech.mjs", "candidates.mjs", "rank.mjs", "cues.mjs", "layout.mjs",
  "judge-core.mjs", "kit-core.mjs", "format.mjs", "attribution.mjs", "langid/ng5.mjs", "langid/cues.mjs",
];

function graph(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(/^\s*(?:import|export)[^"'`]*?from\s+["']([^"']+)["']/gm)) {
    const spec = m[1];
    if (!spec.startsWith(".")) {
      seen.add(`bare:${spec}`);
      continue;
    }
    graph(path.resolve(path.dirname(file), spec), seen);
  }
  return seen;
}

test("browser-safe core modules import nothing from Node", () => {
  for (const f of BROWSER_SAFE) {
    const bare = [...graph(path.join(here, f))].filter((x) => x.startsWith("bare:"));
    assert.deepEqual(bare, [], `${f} pulls in ${bare.join(", ")}`);
  }
});
