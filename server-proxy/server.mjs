// Selects Smart mode proxy: one endpoint that judges clip text with Gemma through the
// Gemini API, using the project's key, so visitors without a key can try Smart mode.
//
// It accepts only the judge, listwise and posting-kit task shapes (clip text and times,
// size-limited), builds the prompt itself from src/core/prompts (so it cannot be used as a
// general chatbot), rate limits per IP and overall, and never logs or stores clip text.
//
// Abuse and capacity policy (README, "The Smart mode proxy: limits"). CORS is not
// authentication: ALLOWED_ORIGINS only stops other web pages from calling the proxy from a
// visitor's browser; curl can send any Origin. The limits are what protect the shared key:
//   1. ingress, per client IP, on every POST before the body is read: cheap, so a flood of
//      junk is refused without reading it (LIMITS.ingressPerIp*)
//   2. the body cap (LIMITS.bodyBytes) and the strict task check: 413 or 400, and neither
//      spends any model quota
//   3. only then the model quota, per client IP and for everyone (LIMITS.perIp*, global*),
//      charged together and only when all of them have room
// At capacity the proxy answers 429 with retry-after and says whether it is this visitor's
// limit or everyone's; the page then keeps that clip's first-stage score or, when the
// on-device model is already saved, judges it on the device. Nothing is queued.
//
//   GEMINI_API_KEY   required: a Google AI Studio key
//   GEMMA_MODEL      default gemma-4-26b-a4b-it (falls back through GEMMA_FALLBACKS when a model is not served)
//   ALLOWED_ORIGINS  comma-separated origins allowed to call it (the static site's URL); no wildcard
//   TRUST_PROXY_HOPS how many proxies in front of us append to X-Forwarded-For (default 3 on
//                    Render, where RENDER is set: client, Cloudflare edge, Render; else 0: use
//                    the socket address)
//   PORT             default 8787
//
// Run: node server-proxy/server.mjs     Health: GET /healthz     Task: POST /v1/task
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { geminiGenerate, GEMINI_BASE } from "../src/core/gemini.mjs";
import { MADE_FOR } from "../src/core/madefor.mjs";
import { buildTask, checkTaskShape, slimTask } from "../src/core/tasks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS = Object.fromEntries(["judge", "listwise", "kit", "faithful"].map((k) => [k, fs.readFileSync(path.join(here, "../src/core/prompts", `${k}.md`), "utf8")]));

export const LIMITS = {
  // 1. ingress: every task request from one client IP, valid or not, before its body is read
  ingressPerIpPerMinute: 60,
  ingressPerIpPerDay: 2000,
  // 3. the model quota, charged only after the body passed the checks
  perIpPerMinute: 20, // a full Selects run is 8 judge calls, 1 listwise call and a kit per rendered clip
  perIpPerDay: 300,
  globalPerMinute: 25, // the free Gemma quota is about 30 requests a minute per key
  globalPerDay: 12000, // and about 14,400 a day
  // 2. the body cap: a judge task is a few KB of clip text
  bodyBytes: 16 * 1024,
};

/** How many X-Forwarded-For hops to trust: TRUST_PROXY_HOPS, else 3 on Render (measured 21 Oct 2026), else 0. */
export function defaultTrustHops(env = process.env) {
  if (env.TRUST_PROXY_HOPS != null && env.TRUST_PROXY_HOPS !== "") return Number(env.TRUST_PROXY_HOPS);
  return env.RENDER ? 3 : 0;
}

/**
 * Fixed-window counters. allow(key, limit, windowMs) -> { ok, retrySec } charges one;
 * allowAll([[key, limit, windowMs], ...]) charges every counter only when all have room, so
 * a request refused by the global limit does not also use up the caller's own.
 */
export function makeLimiter(now = () => Date.now()) {
  const buckets = new Map();
  const bucket = (key, windowMs, t) => {
    let b = buckets.get(key);
    if (!b || t - b.start >= windowMs) {
      b = { start: t, n: 0 };
      buckets.set(key, b);
    }
    return b;
  };
  return {
    allow(key, limit, windowMs) {
      return this.allowAll([[key, limit, windowMs]]);
    },
    allowAll(list) {
      const t = now();
      const bs = list.map(([key, limit, windowMs]) => ({ b: bucket(key, windowMs, t), key, limit, windowMs }));
      const full = bs.find(({ b, limit }) => b.n >= limit);
      if (full) return { ok: false, key: full.key, retrySec: Math.ceil((full.b.start + full.windowMs - t) / 1000) };
      for (const { b } of bs) b.n++;
      return { ok: true, retrySec: 0 };
    },
    sweep() {
      const t = now();
      for (const [k, b] of buckets) if (t - b.start > 86400000) buckets.delete(k);
    },
  };
}

/**
 * The rate-limit key. X-Forwarded-For is a list the client starts: anyone can send
 * "X-Forwarded-For: 1.2.3.4", and a proxy that appends (Render's does not strip what the
 * client sent) turns that into "1.2.3.4, <real ip>". The left-most entry is therefore the
 * client's choice and must never be the key. Each trusted proxy appends exactly one entry,
 * so with `hops` trusted proxies the real client is the hops-th entry from the right. With no
 * proxy in front (hops 0, local runs and tests) the TCP peer address is the only truth.
 * Check after a deploy: `curl -H 'X-Forwarded-For: 1.2.3.4' <proxy>/healthz` must report
 * your own address in "you", not 1.2.3.4. If it reports an internal address (Render added
 * more than one hop after you), raise TRUST_PROXY_HOPS by the number of extra entries.
 * Never lower it to read the left-most entry.
 */
export function clientIp(req, hops = 0) {
  if (hops > 0) {
    const xs = String(req.headers["x-forwarded-for"] || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (xs.length >= hops) return xs[xs.length - hops];
  }
  return req.socket.remoteAddress || "unknown";
}

const KINDS = new Set(["judge", "judgeBatch", "listwise", "kit", "faithful"]);
const TOP_KEYS = new Set(["kind", "candidate", "candidates", "top", "before", "after", "hints", "madeFor", "model"]);
const isObj = (x) => x != null && typeof x === "object" && !Array.isArray(x);
const shortStr = (x, n) => typeof x === "string" && x.length <= n;

/**
 * Strict shape check on top of checkTaskShape (src/core/tasks.mjs): a plain object with only
 * the keys a Selects task uses, a known kind, a known madeFor, and short string fields.
 * Returns a reason, or null when the task is fine.
 */
export function strictTaskShape(task) {
  if (!isObj(task)) return "body must be a JSON object";
  for (const k of Object.keys(task)) if (!TOP_KEYS.has(k)) return `unknown field ${k.slice(0, 40)}`;
  if (!KINDS.has(task.kind)) return "kind must be judge, judgeBatch, listwise, kit or faithful";
  if (task.madeFor != null && !(typeof task.madeFor === "string" && Object.hasOwn(MADE_FOR, task.madeFor))) return `madeFor must be one of ${Object.keys(MADE_FOR).join(", ")}`;
  if (task.model != null && !(typeof task.model === "string" && /^[\w.:-]{1,64}$/.test(task.model))) return "model must be a model name";
  const clips = [task.candidate, ...(Array.isArray(task.candidates) ? task.candidates : []), ...(Array.isArray(task.top) ? task.top : [])].filter((c) => c !== undefined);
  for (const c of clips) {
    if (!isObj(c)) return "each clip must be an object";
    if (c.hook != null && !shortStr(c.hook, 3000)) return "hook must be text (at most 3000 characters)";
  }
  if (task.hints != null) {
    if (!Array.isArray(task.hints) || task.hints.length > 10) return "hints must be a list of at most 10";
    if (!task.hints.every((h) => isObj(h) && shortStr(h.issue, 60) && shortStr(h.cue, 400))) return "each hint must be { issue, cue } as short text";
  }
  return checkTaskShape(task);
}

/** The body as one Buffer (so a UTF-8 character split across chunks stays whole), capped. */
function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > cap) return resolve({ tooBig: true });
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > cap) {
        done = true;
        req.pause();
        return resolve({ tooBig: true });
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve({ buf: Buffer.concat(chunks) });
    });
    req.on("error", (e) => (done ? null : ((done = true), reject(e))));
  });
}

export function createProxy({
  key = process.env.GEMINI_API_KEY,
  model = process.env.GEMMA_MODEL || "gemma-4-26b-a4b-it",
  fallbacks = (process.env.GEMMA_FALLBACKS || "gemma-4-31b-it").split(",").map((s) => s.trim()).filter(Boolean),
  origins = (process.env.ALLOWED_ORIGINS || "http://localhost:4319,http://localhost:5173,http://127.0.0.1:4319").split(",").map((s) => s.trim().replace(/\/$/, "")).filter((s) => s && s !== "*"),
  trustProxyHops = defaultTrustHops(),
  base = process.env.GEMINI_BASE || GEMINI_BASE,
  limits: given = LIMITS,
  limiter = makeLimiter(),
  timeoutMs = Number(process.env.GEMMA_TIMEOUT_MS || 25000), // per call, then one retry (src/core/gemini.mjs)
  log = (line) => console.log(line),
} = {}) {
  const limits = { ...LIMITS, ...given };
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

  // one bad request must never take the service down: any error becomes a 500
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      counts.failed++;
      // the error's code or name only: a message can quote the request
      log(JSON.stringify({ at: new Date().toISOString(), error: String(e?.code || e?.name || "Error").slice(0, 40) }));
      if (!res.headersSent) send(res, 500, { error: "The proxy failed on this request.", hint: "Try again, or switch to Private mode." }, null);
      else res.end();
    });
  });
  return server;

  async function handle(req, res) {
    const t0 = Date.now();
    const reqOrigin = req.headers.origin || "";
    const origin = origins.includes(reqOrigin) ? reqOrigin : null;
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") {
      res.writeHead(origin ? 204 : 403, origin ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400", vary: "Origin" } : {});
      return res.end();
    }
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/")) {
      // "you" is the caller's own rate-limit key, so a deploy can check that a spoofed
      // X-Forwarded-For does not change it
      return send(res, 200, { ok: !!key, model: current, limits, counts, you: clientIp(req, trustProxyHops) }, origin);
    }
    if (req.method !== "POST" || url.pathname !== "/v1/task") return send(res, 404, { error: "Not found." }, origin);
    if (reqOrigin && !origin) {
      counts.refused++;
      return send(res, 403, { error: "This origin may not use the proxy." }, null);
    }
    if (!key) return send(res, 503, { error: "The proxy has no API key.", hint: "Set GEMINI_API_KEY on the server, or use your own key in Smart mode." }, origin);

    const ip = clientIp(req, trustProxyHops);
    const limited = (a, scope) => {
      counts.limited++;
      res.setHeader("retry-after", String(a.retrySec));
      if (scope === "ingress") {
        res.on("finish", () => req.destroy()); // the body is never read
        res.setHeader("connection", "close");
      }
      const hint = scope === "global"
        ? `Smart mode is at capacity for everyone right now. Try again in ${a.retrySec} s, use your own free key, or switch to Private mode.`
        : `Too many requests from this connection. Try again in ${a.retrySec} s, use your own free key, or switch to Private mode.`;
      return send(res, 429, { error: "Too many requests.", hint, retrySec: a.retrySec, scope }, origin);
    };
    // 1. the cheap ingress limit, before the body is read
    const gate = limiter.allowAll([[`im:${ip}`, limits.ingressPerIpPerMinute, 60000], [`id:${ip}`, limits.ingressPerIpPerDay, 86400000]]);
    if (!gate.ok) return limited(gate, "ingress");

    // 2. the body cap and the strict task check: neither spends model quota
    const body = await readBody(req, limits.bodyBytes);
    if (body.tooBig) {
      counts.refused++;
      res.on("finish", () => req.destroy());
      res.setHeader("connection", "close");
      return send(res, 413, { error: "Refused: body too large.", hint: "The proxy only judges Selects clips." }, origin);
    }
    let task = null;
    try {
      task = JSON.parse(body.buf.toString("utf8"));
    } catch {}
    const bad = strictTaskShape(task);
    if (bad) {
      counts.refused++;
      return send(res, 400, { error: `Refused: ${bad}.`, hint: "The proxy only judges Selects clips." }, origin);
    }
    // 3. the scarce model quota, per IP and for everyone, charged together only for a valid task
    const quota = limiter.allowAll([[`m:${ip}`, limits.perIpPerMinute, 60000], [`d:${ip}`, limits.perIpPerDay, 86400000], ["gm", limits.globalPerMinute, 60000], ["gd", limits.globalPerDay, 86400000]]);
    if (!quota.ok) return limited(quota, quota.key.startsWith("g") ? "global" : "ip");

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
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  createProxy().listen(port, () => console.log(`selects proxy on :${port}, model ${process.env.GEMMA_MODEL || "gemma-4-26b-a4b-it"}, key ${process.env.GEMINI_API_KEY ? "set" : "MISSING"}`));
}
