// Import this (dynamically, before the engine) to load src/browser modules in Node tests:
//   await import("./test-env.mjs"); const { Engine } = await import("./engine.js");
// It registers test-hooks.mjs for Vite's ?raw and ?url imports and gives Node the few
// browser globals the engine reads at call time. Tests only.
import { register } from "node:module";
import { availableParallelism } from "node:os";

register("./test-hooks.mjs", import.meta.url);
globalThis.self ??= globalThis;
globalThis.location ??= new URL("http://localhost/");
// Node 21 and later have a global navigator; Node 20 (still in the CI matrix, and allowed by
// "engines") does not, and tests that fake a GPU or a connection define properties on it.
// Give Node 20 the same small navigator the later versions have.
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, "navigator", {
    value: { hardwareConcurrency: availableParallelism(), language: "en-US", platform: process.platform, userAgent: `Node.js/${process.versions.node.split(".")[0]}` },
    configurable: true,
    writable: true,
  });
}
