// Selects Smart mode proxy: one endpoint that judges clip text with Gemma through the
// Gemini API, using the project's key, so visitors without a key can try Smart mode.
//
// It accepts only the judge, listwise and posting-kit task shapes (clip text and times,
// size-limited), builds the prompt itself from src/core/prompts (so it cannot be used as a
// general chatbot), rate limits per IP and overall, and never logs or stores clip text.
//
//   GEMINI_API_KEY   required: a Google AI Studio key
//   GEMMA_MODEL      default gemma-4-26b-a4b-it (falls back through GEMMA_FALLBACKS when a model is not served)
//   ALLOWED_ORIGINS  comma-separated origins allowed to call it (the static site's URL)
//   PORT             default 8787
//
// Run: node server-proxy/server.mjs     Health: GET /healthz     Task: POST /v1/task
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { geminiGenerate, GEMINI_BASE } from "../src/core/gemini.mjs";
import { buildTask, checkTaskShape, slimTask } from "../src/core/tasks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS = Object.fromEntries(["judge", "listwise", "kit"].map((k) => [k, fs.readFileSync(path.join(here, "../src/core/prompts", `${k}.md`), "utf8")]));

export const LIMITS = {
  perIpPerMinute: 20, // a full Selects run is 8 judge calls, 1 listwise call and a kit per rendered clip
  perIpPerDay: 300,
  globalPerMinute: 25, // the free Gemma quota is about 30 requests a minute per key
  globalPerDay: 12000, // and about 14,400 a day
  bodyBytes: 16 * 1024,
};

/** A fixed-window counter: allow(key, limit, windowMs) -> { ok, retrySec }. */
export function makeLimiter(now = () => Date.now()) {
  const buckets = new Map();
  return {
    allow(key, limit, windowMs) {
      const t = now();
      let b = buckets.get(key);
      if (!b || t - b.start >= windowMs) {
        b = { start: t, n: 0 };
        buckets.set(key, b);
      }
      if (b.n >= limit) return { ok: false, retrySec: Math.ceil((b.start + windowMs - t) / 1000) };
      b.n++;
      return { ok: true, retrySec: 0 };
    },
    sweep() {
      const t = now();
      for (const [k, b] of buckets) if (t - b.start > 86400000) buckets.delete(k);
    },
  };
}

const clientIp = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";

export function createProxy({
  key = process.env.GEMINI_API_KEY,
  model = process.env.GEMMA_MODEL || "gemma-4-26b-a4b-it",
  fallbacks = (process.env.GEMMA_FALLBACKS || "gemma-4-31b-it").split(",").map((s) => s.trim()).filter(Boolean),
  origins = (process.env.ALLOWED_ORIGINS || "http://localhost:4319,http://localhost:5173,http://127.0.0.1:4319").split(",").map((s) => s.trim()).filter(Boolean),
  base = process.env.GEMINI_BASE || GEMINI_BASE,
  limits = LIMITS,
  limiter = makeLimiter(),
  timeoutMs = Number(process.env.GEMMA_TIMEOUT_MS || 25000), // per call, then one retry (src/core/gemini.mjs)
  log = (line) => console.log(line),
} = {}) {
  let features = {};
  let current = model;
  const counts = { ok: 0, refused: 0, limited: 0, failed: 0 };
  setInterval(() => limiter.sweep(), 3600000).unref?.();

  const send = (res, status, body, origin) => {
    const headers = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (origin) Object.assign(headers, { "access-control-allow-origin": origin, vary: "Origin" });
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };

  return http.createServer(async (req, res) => {
    const t0 = Date.now();
    const reqOrigin = req.headers.origin || "";
    const origin = origins.includes("*") ? "*" : origins.includes(reqOrigin) ? reqOrigin : null;
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") {
      res.writeHead(origin ? 204 : 403, origin ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400", vary: "Origin" } : {});
      return res.end();
    }
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/")) {
      return send(res, 200, { ok: !!key, model: current, limits: { perIpPerMinute: limits.perIpPerMinute, globalPerMinute: limits.globalPerMinute }, counts }, origin);
    }
    if (req.method !== "POST" || url.pathname !== "/v1/task") return send(res, 404, { error: "Not found." }, origin);
    if (reqOrigin && !origin) {
      counts.refused++;
      return send(res, 403, { error: "This origin may not use the proxy." }, null);
    }
    if (!key) return send(res, 503, { error: "The proxy has no API key.", hint: "Set GEMINI_API_KEY on the server, or use your own key in Smart mode." }, origin);

    const ip = clientIp(req);
    for (const [k, lim, win] of [[`m:${ip}`, limits.perIpPerMinute, 60000], [`d:${ip}`, limits.perIpPerDay, 86400000], ["gm", limits.globalPerMinute, 60000], ["gd", limits.globalPerDay, 86400000]]) {
      const a = limiter.allow(k, lim, win);
      if (!a.ok) {
        counts.limited++;
        res.setHeader("retry-after", String(a.retrySec));
        return send(res, 429, { error: "Too many requests.", hint: `Smart mode is busy. Try again in ${a.retrySec} s, use your own free key, or switch to Private mode.`, retrySec: a.retrySec }, origin);
      }
    }

    let raw = "";
    let tooBig = false;
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > limits.bodyBytes) {
        tooBig = true;
        break;
      }
    }
    let task = null;
    try {
      task = tooBig ? null : JSON.parse(raw);
    } catch {}
    const bad = tooBig ? "body too large" : checkTaskShape(task);
    if (bad) {
      counts.refused++;
      return send(res, 400, { error: `Refused: ${bad}.`, hint: "The proxy only judges Selects clips." }, origin);
    }
    const { messages, schema, maxTokens } = buildTask(slimTask(task), PROMPTS);
    const tryModels = [current, ...fallbacks.filter((m) => m !== current)];
    for (const m of tryModels) {
      try {
        const r = await geminiGenerate({ key, model: m, messages, schema, maxTokens: Math.max(256, maxTokens * 3), temperature: 0.2, features, base, timeoutMs });
        features = r.features;
        current = m;
        counts.ok++;
        // no clip text in the log: kind, model, timing and token counts only
        log(JSON.stringify({ at: new Date().toISOString(), kind: task.kind, model: m, ms: Date.now() - t0, promptTokens: r.promptTokens, outTokens: r.outTokens }));
        return send(res, 200, { text: r.text, model: m, promptTokens: r.promptTokens, outTokens: r.outTokens, finish: r.finish }, origin);
      } catch (e) {
        if (e.status === 404 && !e.transient && m !== tryModels[tryModels.length - 1]) continue;
        counts.failed++;
        log(JSON.stringify({ at: new Date().toISOString(), kind: task.kind, model: m, ms: Date.now() - t0, error: e.status || "network" }));
        // 504 for a timeout: the page then judges that clip on the device instead
        return send(res, e.status === 429 ? 429 : e.status === 0 ? 504 : 502, { error: e.status === 429 ? "The free Gemma quota is used up for now." : e.status === 0 ? "Gemma did not answer in time." : "Gemma did not answer.", hint: e.hint || "Try again in a minute, or switch to Private mode.", transient: !!e.transient }, origin);
      }
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  createProxy().listen(port, () => console.log(`selects proxy on :${port}, model ${process.env.GEMMA_MODEL || "gemma-4-26b-a4b-it"}, key ${process.env.GEMINI_API_KEY ? "set" : "MISSING"}`));
}
