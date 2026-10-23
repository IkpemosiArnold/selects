// Model downloads for the page (the judge models, the language check), run in a worker:
// only a worker can write OPFS on every browser (sync access handles; Safari before 26 has no
// createWritable in the page), so the page's large downloads resume after a drop or a reload
// everywhere, not only where the page can write. Messages: { id, type: "download" | "info" |
// "reset", url, expect }. Replies: { id, type: "progress" | "done" | "error", ... }.
import { memoryStore, opfsStore, resumableDownload } from "./download.js";

let storeP = null;
const store = () => (storeP ??= opfsStore().then((s) => s || memoryStore()));

self.onmessage = async ({ data: m }) => {
  const post = (x) => self.postMessage({ id: m.id, ...x });
  try {
    const s = await store();
    if (m.type === "download") {
      let last = 0;
      const blob = await resumableDownload(m.url, {
        store: s,
        expect: m.expect || null,
        onProgress: (p) => {
          const now = performance.now();
          if (p.loaded < p.total && now - last < 250) return;
          last = now;
          post({ type: "progress", loaded: p.loaded, total: p.total, cached: !!p.cached });
        },
        onNote: (n) => post({ type: "note", ...n }),
      });
      post({ type: "done", result: blob, persistent: s.kind === "opfs" });
    } else if (m.type === "info") {
      const { bytes, meta } = await s.info(m.url);
      post({ type: "done", result: { done: !!(meta?.done && meta.size === bytes), bytes, size: meta?.size ?? null } });
    } else if (m.type === "reset") {
      await s.reset(m.url);
      post({ type: "done", result: true });
    }
  } catch (e) {
    post({ type: "error", name: String(e?.name || "Error"), message: String(e?.message || e), kind: e?.kind || null, status: e?.status || null, loaded: e?.loaded ?? null, total: e?.total ?? null });
  }
};
