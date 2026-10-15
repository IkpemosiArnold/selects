// Local HTTP API, Server-Sent Events and media (with Range) for the review app.
// Standard library only. Binds to 127.0.0.1: nothing here is meant to leave the laptop.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, ollamaModels, ollamaUrl, selectsHome, whisperBin, whisperModel } from "../core/config.mjs";
import { measuredSpeeds } from "../core/judge.mjs";
import { createJob, isRunning, jobDir, jobEvents, listJobs, loadJob, loadWords, updateCandidate } from "../core/job.mjs";
import { drainQueue, enqueue, queueState } from "../core/queue.mjs";
import { diskFreeGb } from "../core/util.mjs";

export const DEFAULT_PORT = 4317;
const WEB_DIST = path.join(REPO, "web/dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".srt": "application/x-subrip; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

class HttpError extends Error {
  constructor(status, message, hint) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

/** Only local pages (the Vite dev server, or this server) may call the API from a browser. */
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
  }
  return !origin || res.hasHeader("Access-Control-Allow-Origin");
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req, limit = 1e6) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, "Request body is too large.");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
}

/** Stream a file, honouring a single HTTP Range (what video elements ask for). */
function sendFile(req, res, file, { cache = "no-cache" } = {}) {
  let st;
  try {
    st = fs.statSync(file);
    if (!st.isFile()) throw new Error();
  } catch {
    throw new HttpError(404, "File not found.");
  }
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const base = { "content-type": type, "accept-ranges": "bytes", "cache-control": cache, "last-modified": st.mtime.toUTCString() };
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start;
    let end;
    if (m && (m[1] || m[2])) {
      if (m[1] === "") {
        // suffix range: the last n bytes
        start = Math.max(0, st.size - Number(m[2]));
        end = st.size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      }
    }
    if (start == null || start > end || start >= st.size) {
      res.writeHead(416, { ...base, "content-range": `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...base, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...base, "content-length": st.size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

function getJob(id) {
  if (!/^j_[0-9a-z_]+$/i.test(id)) throw new HttpError(404, `No job called ${id}.`);
  try {
    return loadJob(id);
  } catch {
    throw new HttpError(404, `No job called ${id}.`);
  }
}

/** Server-Sent Events for one job. Sends the current job first, then every event. */
function sse(req, res, id) {
  const job = getJob(id);
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  res.write("retry: 2000\n\n");
  send("job", job);
  const onEvent = ({ type, data }) => send(type, data);
  jobEvents.on(id, onEvent);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => {
    clearInterval(ping);
    jobEvents.off(id, onEvent);
  });
}

async function health() {
  const wb = whisperBin();
  const whisper = (path.isAbsolute(wb) ? fs.existsSync(wb) : true) && fs.existsSync(whisperModel());
  let ollama = false;
  try {
    const r = await fetch(`${ollamaUrl()}/api/version`, { signal: AbortSignal.timeout(2000) });
    ollama = r.ok;
  } catch {}
  const models = (await ollamaModels()).map((m) => m.name);
  fs.mkdirSync(selectsHome(), { recursive: true });
  return { ok: whisper && ollama, whisper, ollama, models, diskFreeGb: diskFreeGb(selectsHome()) };
}

async function models() {
  const speeds = measuredSpeeds();
  return (await ollamaModels()).map((m) => ({ ...m, measuredSecPerCandidate: speeds[m.name]?.secPerCandidate ?? null }));
}

function serveStatic(req, res, urlPath) {
  if (!fs.existsSync(WEB_DIST)) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Selects API is running. The web app is not built yet: run `npm run build` in web/.\n");
  }
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, "");
  const file = path.resolve(WEB_DIST, rel);
  if (!file.startsWith(WEB_DIST)) throw new HttpError(403, "Forbidden.");
  if (rel && fs.existsSync(file) && fs.statSync(file).isFile()) {
    return sendFile(req, res, file, { cache: /\/assets\//.test(file) ? "public, max-age=31536000, immutable" : "no-cache" });
  }
  return sendFile(req, res, path.join(WEB_DIST, "index.html")); // single-page app fallback
}

async function route(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const m = (re) => p.match(re);
  const method = req.method;
  let r;

  if (method === "OPTIONS") {
    res.writeHead(cors(req, res) ? 204 : 403);
    return res.end();
  }
  if (!cors(req, res) && method !== "GET" && method !== "HEAD") throw new HttpError(403, "Requests from other sites are not allowed.");

  if (p === "/api/health" && method === "GET") return sendJson(res, 200, await health());
  if (p === "/api/models" && method === "GET") return sendJson(res, 200, await models());
  if (p === "/api/queue" && method === "GET") return sendJson(res, 200, queueState());

  if (p === "/api/jobs" && method === "GET") return sendJson(res, 200, listJobs());
  if (p === "/api/jobs" && method === "POST") {
    const body = await readBody(req);
    if (!body.path || typeof body.path !== "string") throw new HttpError(400, "Send { path } with the full path of a local video file.");
    let job;
    try {
      job = createJob(body.path, body.settings || {});
    } catch (e) {
      throw new HttpError(400, e.message, e.hint);
    }
    enqueue({ jobId: job.id });
    drainQueue();
    return sendJson(res, 201, job);
  }
  if ((r = m(/^\/api\/jobs\/([^/]+)$/)) && method === "GET") return sendJson(res, 200, getJob(r[1]));
  if ((r = m(/^\/api\/jobs\/([^/]+)\/events$/)) && method === "GET") return sse(req, res, r[1]);
  if ((r = m(/^\/api\/jobs\/([^/]+)\/words$/)) && method === "GET") {
    getJob(r[1]);
    return sendJson(res, 200, loadWords(r[1]));
  }
  if ((r = m(/^\/api\/jobs\/([^/]+)\/candidates\/([^/]+)$/)) && method === "PATCH") {
    getJob(r[1]);
    const body = await readBody(req);
    try {
      return sendJson(res, 200, updateCandidate(r[1], r[2], body));
    } catch (e) {
      throw new HttpError(e.status || 400, e.message);
    }
  }
  if ((r = m(/^\/api\/jobs\/([^/]+)\/render$/)) && method === "POST") {
    const job = getJob(r[1]);
    const body = await readBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : undefined;
    const n = job.candidates.filter((c) => (ids ? ids.includes(c.id) : c.status === "approved")).length;
    if (!n) throw new HttpError(400, "Approve at least one clip first. Nothing is rendered until you approve it.");
    if (body.preset && !["shorts", "preview"].includes(body.preset)) throw new HttpError(400, "preset must be shorts or preview.");
    enqueue({ jobId: job.id, kind: "render", ids, preset: body.preset });
    drainQueue();
    return sendJson(res, 202, { queued: true, clips: n, queue: queueState() });
  }
  if ((r = m(/^\/api\/jobs\/([^/]+)\/resume$/)) && method === "POST") {
    const job = getJob(r[1]);
    if (isRunning(job.id)) return sendJson(res, 202, { queued: false, running: true });
    enqueue({ jobId: job.id, kind: "analyze" });
    drainQueue();
    return sendJson(res, 202, { queued: true, queue: queueState() });
  }

  if ((r = m(/^\/media\/([^/]+)\/source$/)) && (method === "GET" || method === "HEAD")) return sendFile(req, res, getJob(r[1]).source.path);
  if ((r = m(/^\/media\/([^/]+)\/thumbs\/(\d+)(?:\.jpg)?$/)) && (method === "GET" || method === "HEAD")) {
    getJob(r[1]);
    return sendFile(req, res, path.join(jobDir(r[1]), "thumbs", `strip-${String(+r[2]).padStart(4, "0")}.jpg`), { cache: "public, max-age=3600" });
  }
  if ((r = m(/^\/media\/([^/]+)\/clips\/([A-Za-z0-9_]+)(?:\.mp4)?$/)) && (method === "GET" || method === "HEAD")) {
    getJob(r[1]);
    const preview = url.searchParams.get("preset") === "preview";
    return sendFile(req, res, path.join(jobDir(r[1]), "clips", `${r[2]}${preview ? ".preview" : ""}.mp4`));
  }
  if (p.startsWith("/api/") || p.startsWith("/media/")) throw new HttpError(404, `Nothing at ${method} ${p}.`);
  if (method === "GET" || method === "HEAD") return serveStatic(req, res, p);
  throw new HttpError(405, "Method not allowed.");
}

export function createServer() {
  return http.createServer((req, res) => {
    route(req, res).catch((e) => {
      const status = e.status || 500;
      if (res.headersSent) return res.end();
      sendJson(res, status, { error: e.message || "Server error.", hint: e.hint || (status === 500 ? "Check the terminal running `selects serve`." : undefined) });
      if (status === 500) console.error(e);
    });
  });
}

/** Start the server, and pick up any queue left from an earlier run. */
export function startServer({ port = Number(process.env.PORT) || DEFAULT_PORT, host = "127.0.0.1", quiet = false } = {}) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", (e) => {
      if (e.code === "EADDRINUSE") e.hint = `Port ${port} is busy. Try selects serve --port ${port + 1}`;
      reject(e);
    });
    server.listen(port, host, () => {
      if (!quiet) console.log(`Selects is running at http://${host}:${server.address().port}  (Ctrl+C to stop)`);
      if (queueState().items.length) drainQueue();
      resolve(server);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((e) => {
    console.error(e.message);
    if (e.hint) console.error(e.hint);
    process.exit(1);
  });
}
