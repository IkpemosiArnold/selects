// Clip rendering off the main thread, so the page stays responsive while frames encode.
import { loadFonts, renderClip } from "./render-clip.js";

let fonts = null;

self.onmessage = async (ev) => {
  const { id, job, fontUrls } = ev.data;
  try {
    fonts ??= loadFonts(fontUrls);
    await fonts;
    const r = await renderClip({ ...job, onProgress: (p) => self.postMessage({ id, type: "progress", ...p }) });
    self.postMessage({ id, type: "done", result: r }, [r.mp4]);
  } catch (e) {
    self.postMessage({ id, type: "error", message: String(e?.message || e), hint: e?.hint || null });
  }
};
