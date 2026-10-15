import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const core = process.env.SELECTS_CORE || "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
  server: {
    proxy: {
      "/api": { target: core, changeOrigin: false },
      "/media": { target: core, changeOrigin: false },
    },
  },
  preview: {
    proxy: {
      "/api": { target: core, changeOrigin: false },
      "/media": { target: core, changeOrigin: false },
    },
  },
});
