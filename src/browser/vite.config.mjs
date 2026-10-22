// Selects Web: a static build of the in-browser engine and its test page.
//   npm run build  -> ../../dist-web (deploy that folder as a static site)
// Multithreaded WebAssembly (wllama, ONNX Runtime) needs cross-origin isolation, so the dev
// and preview servers send the same two headers the host must send (see public/_headers
// and render.yaml). "require-corp" (not "credentialless", which Safari ignores): model
// downloads are CORS fetches, which it allows.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  root: here,
  base: "./",
  publicDir: path.join(here, "public"),
  build: {
    outDir: path.resolve(here, "../../dist-engine"), // the engine test page; the hosted site is web/ (npm --prefix web run build:web -> dist-web)
    emptyOutDir: true,
    target: "es2022",
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { index: path.join(here, "index.html"), demo: path.join(here, "demo.html") } },
  },
  worker: { format: "es" },
  server: { headers: isolation, fs: { allow: [path.resolve(here, "../..")] } },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ["@huggingface/transformers", "@wllama/wllama", "@mediapipe/tasks-genai"] },
});
