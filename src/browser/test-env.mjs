// Import this (dynamically, before the engine) to load src/browser modules in Node tests:
//   await import("./test-env.mjs"); const { Engine } = await import("./engine.js");
// It registers test-hooks.mjs for Vite's ?raw and ?url imports and gives Node the few
// browser globals the engine reads at call time. Tests only.
import { register } from "node:module";

register("./test-hooks.mjs", import.meta.url);
globalThis.self ??= globalThis;
globalThis.location ??= new URL("http://localhost/");
