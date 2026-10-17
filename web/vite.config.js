// One React app, two engines (src/lib/api.js):
//   npm run build        server engine, talks to `selects serve`        -> web/dist
//   npm run build:web    browser engine, the hosted Selects Web         -> ../dist-web
// The browser build needs cross-origin isolation (multithreaded WebAssembly), so dev and
// preview send the same two headers the host sends (render.yaml, public/_headers), and it
// ships the engine's PWA files (manifest, icons, service worker) from src/browser/public.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));
const engineDir = path.resolve(here, "../src/browser");
const core = process.env.SELECTS_CORE || "http://127.0.0.1:4317";
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

// Copies src/browser/public (manifest, icons, sw.js, _headers) next to the build, and links
// the manifest from index.html. Only for the browser engine.
function browserShell() {
  let outDir;
  return {
    name: "selects-browser-shell",
    configResolved(c) {
      outDir = c.build.outDir;
    },
    transformIndexHtml(html) {
      return html.replace("</head>", '    <link rel="manifest" href="/manifest.webmanifest" />\n    <link rel="apple-touch-icon" href="/icons/icon-192.png" />\n  </head>');
    },
    closeBundle() {
      const from = path.join(engineDir, "public");
      if (!fs.existsSync(from)) return;
      fs.cpSync(from, outDir, { recursive: true });
      // the engine's files point at its test page; the hosted app is index.html
      const man = path.join(outDir, "manifest.webmanifest");
      if (fs.existsSync(man)) {
        const m = JSON.parse(fs.readFileSync(man, "utf8"));
        m.start_url = "./";
        m.description = "Turn a long video into short, captioned clips, in your browser.";
        fs.writeFileSync(man, JSON.stringify(m, null, 2));
      }
      const sw = path.join(outDir, "sw.js");
      if (fs.existsSync(sw)) fs.writeFileSync(sw, fs.readFileSync(sw, "utf8").replaceAll("./demo.html", "./index.html"));
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, here, "VITE_"), ...process.env };
  const browser = env.VITE_ENGINE === "browser";
  const proxy = {
    "/api": { target: core, changeOrigin: false },
    "/media": { target: core, changeOrigin: false },
  };
  return {
    plugins: [react(), ...(browser ? [browserShell()] : [])],
    build: {
      outDir: browser ? path.resolve(here, "../dist-web") : "dist",
      emptyOutDir: true,
      assetsInlineLimit: 0,
      target: "es2022",
      chunkSizeWarningLimit: 4000,
    },
    worker: { format: "es" },
    // the app reuses pure helpers from src/core, and the browser engine lives in src/browser
    server: { fs: { allow: [".."] }, ...(browser ? { headers: isolation } : { proxy }) },
    preview: browser ? { headers: isolation } : { proxy },
    optimizeDeps: browser ? { exclude: ["@huggingface/transformers", "@wllama/wllama", "@mediapipe/tasks-genai"] } : {},
  };
});
