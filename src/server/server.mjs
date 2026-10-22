// Local HTTP API, Server-Sent Events and media (with Range) for the review app.
// Standard library only. Binds to 127.0.0.1: nothing here is meant to leave the laptop.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, asrModels, ollamaModels, ollamaUrl, selectsHome, whisperBin, whisperModel } from "../core/config.mjs";
import { measuredSpeeds } from "../core/judge.mjs";
import { editCaptions, loadCaptions, resetCaptions, toSrt, toVtt } from "../core/captions.mjs";
import { approveTop, confirmLanguage, createJob, detectJobFaces, refreshStale, isRunning, jobDir, jobEvents, listJobs, loadJob, loadWords, resetTranscript, retryKit, saveJob, updateCandidate, updateJobSettings } from "../core/job.mjs";
import { LOW_P } from "../core/quality.mjs";
import { loadProfiles } from "../core/profiles.mjs";
import { hwaccelArgs } from "../core/render.mjs";
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
  ".vtt": "text/vtt; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

class HttpError extends Error {
  constructor(status, message, hint) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

/**
 * DNS rebinding guard. A hostile page can point its own domain at 127.0.0.1, and its
 * requests then reach this server as same-origin GETs with no Origin header. The browser
 * still sends the attacker's name in Host, so only loopback names are served. The port must
 * be ours, or a local front end that proxies to us without rewriting Host (Vite dev 5173 and
 * preview 4173; SELECTS_DEV_PORTS overrides the list).
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
function devPorts() {
  return new Set(String(process.env.SELECTS_DEV_PORTS ?? "5173,4173").split(",").map((s) => Number(s.trim())).filter(Boolean));
}
export function hostAllowed(host, port) {
  const m = /^(\[[^\]]+\]|[^:\[\]]+)(?::(\d+))?$/.exec(String(host || ""));
  if (!m || !LOOPBACK.has(m[1].toLowerCase())) return false;
  const p = Number(m[2] || 80);
  return p === port || devPorts().has(p);
}

/** Decode a URL path, or 400. Rejects ".." segments (also when encoded) and NUL bytes. */
function safeDecode(s) {
  let out;
  try {
    out = decodeURIComponent(s);
  } catch {
    throw new HttpError(400, "The address has a broken escape (%).");
  }
  if (out.includes("\0") || out.split(/[\\/]/).includes("..")) throw new HttpError(400, "The address is not allowed.");
  return out;
}

/** file must sit inside dir (after resolving). */
function inside(dir, file) {
  const root = path.resolve(dir);
  const f = path.resolve(root, file);
  if (f !== root && !f.startsWith(root + path.sep)) throw new HttpError(404, "File not found.");
  return f;
}

/** Only local pages (the Vite dev server, or this server) may call the API from a browser. */
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, OPTIONS");
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

/** Run a command and collect binary stdout. */
function runBinary(cmd, args) {
  return new Promise((resolve) => {
    import("node:child_process").then(({ spawn }) => {
      const p = spawn(cmd, args);
      const bufs = [];
      p.stdout.on("data", (d) => bufs.push(d));
      p.on("close", () => resolve(Buffer.concat(bufs)));
      p.on("error", () => resolve(Buffer.alloc(0)));
    });
  });
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

/**
 * Find a dropped file by name and exact size in the usual places (browsers hide the folder
 * of a dropped file). Bounded: a few folders, four levels deep, at most 8,000 entries each.
 */
async function locate(name, size) {
  const home = os.homedir();
  const roots = [path.join(selectsHome(), "media"), process.cwd(), path.join(home, "Movies"), path.join(home, "Downloads"), path.join(home, "Desktop"), path.join(home, "Documents")];
  let visited = 0;
  const seen = new Set();
  async function walk(dir, depth) {
    if (depth > 4 || visited > 8000 || seen.has(dir)) return null;
    seen.add(dir);
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      visited++;
      if (e.isFile() && e.name === name) {
        const f = path.join(dir, e.name);
        try {
          if ((await fs.promises.stat(f)).size === size) return f;
        } catch {}
      }
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules" || e.name === "Library") continue;
      const hit = await walk(path.join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const r of roots) {
    visited = 0;
    const hit = await walk(r, 0);
    if (hit) return hit;
  }
  return null;
}

function serveStatic(req, res, urlPath) {
  if (!fs.existsSync(WEB_DIST)) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Selects API is running. The web app is not built yet: run `npm run build` in web/.\n");
  }
  const rel = safeDecode(urlPath).replace(/^\/+/, "");
  const file = path.resolve(WEB_DIST, rel);
  if (file !== WEB_DIST && !file.startsWith(WEB_DIST + path.sep)) throw new HttpError(404, "File not found.");
  if (rel && fs.existsSync(file) && fs.statSync(file).isFile()) {
    return sendFile(req, res, file, { cache: /\/assets\//.test(file) ? "public, max-age=31536000, immutable" : "no-cache" });
  }
  return sendFile(req, res, path.join(WEB_DIST, "index.html")); // single-page app fallback
}

async function route(req, res) {
  if (!hostAllowed(req.headers.host, req.socket.localPort)) throw new HttpError(421, "This address is not served here.", "Open Selects at http://127.0.0.1 or http://localhost on its own port.");
  // the raw path, before URL parsing folds "%2e%2e" and "/../" away
  safeDecode(String(req.url || "/").split("?")[0]);
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    throw new HttpError(400, "The address is not valid.");
  }
  const p = url.pathname;
  if (p.startsWith("/media/")) res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
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
  if (p === "/api/profiles" && method === "GET") return sendJson(res, 200, loadProfiles());
  if (p === "/api/asr-models" && method === "GET") return sendJson(res, 200, asrModels().map(({ path: _p, ...m }) => m));
  if (p === "/api/locate" && method === "GET") {
    const name = url.searchParams.get("name");
    const size = Number(url.searchParams.get("size"));
    if (!name || !Number.isFinite(size)) throw new HttpError(400, "Send name and size.");
    if (name.length > 255 || /[\\/\0]/.test(name) || name === "." || name === "..") throw new HttpError(400, "name is a file name, not a path.");
    const found = await locate(name, size);
    if (!found) throw new HttpError(404, `Could not find ${name} in the usual folders.`, "Type the full path instead.");
    return sendJson(res, 200, { path: found });
  }

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
  if ((r = m(/^\/api\/jobs\/([^/]+)$/)) && method === "PATCH") {
    getJob(r[1]);
    const body = await readBody(req);
    try {
      return sendJson(res, 200, updateJobSettings(r[1], body.settings || {}));
    } catch (e) {
      throw new HttpError(e.status || 400, e.message, e.hint);
    }
  }
  if ((r = m(/^\/api\/jobs\/([^/]+)\/events$/)) && method === "GET") return sse(req, res, r[1]);
  if ((r = m(/^\/api\/jobs\/([^/]+)\/words$/)) && method === "GET") {
    getJob(r[1]);
    return sendJson(res, 200, loadWords(r[1]));
  }
  if ((r = m(/^\/api\/jobs\/([^/]+)\/candidates\/([^/]+)\/kit$/)) && method === "GET") {
    // The posting kit for one rendered clip, with absolute paths for "copy path".
    const job = getJob(r[1]);
    const c = job.candidates.find((x) => x.id === r[2]);
    if (!c) throw new HttpError(404, `No clip called ${r[2]} in this job.`);
    let kit = null;
    try {
      kit = c.render?.kit ? JSON.parse(fs.readFileSync(inside(jobDir(job.id), c.render.kit), "utf8")) : null;
    } catch {}
    if (!kit && c.render?.status === "done" && ["pending", "running"].includes(c.render.kitStatus)) throw new HttpError(404, "This clip's title and caption are still being written.", "The clip itself is ready to play and save.");
    if (!kit) throw new HttpError(404, "This clip has no posting kit yet.", "Render it first. The kit is written after the video.");
    const abs = (f) => (f ? (path.isAbsolute(f) ? f : path.join(jobDir(job.id), f)) : null);
    return sendJson(res, 200, { ...kit, file: abs(c.render.path), srtFile: abs(c.render.srt) });
  }
  if ((r = m(/^\/api\/jobs\/([^/]+)\/candidates\/([^/]+)\/kit$/)) && method === "POST") {
    // write the posting kit again (after it failed, or for a new suggestion); progress comes as render events
    const job = getJob(r[1]);
    const c = job.candidates.find((x) => x.id === r[2]);
    if (!c) throw new HttpError(404, `No clip called ${r[2]} in this job.`);
    if (c.render?.status !== "done") throw new HttpError(409, "This clip has not been rendered yet.", "Render the clip first.");
    if (isRunning(job.id)) throw new HttpError(409, "This job is still rendering.", "Try the kit again when the render queue is done.");
    retryKit(job.id, c.id).catch(() => {}); // the outcome is in render.kitStatus and the render events
    return sendJson(res, 202, { queued: true, id: c.id });
  }
  if ((r = m(/^\/api\/jobs\/([^/]+)\/candidates\/([^/]+)$/)) && method === "PATCH") {
    getJob(r[1]);
    const body = await readBody(req);
    try {
      return sendJson(res, 200, updateCandidate(r[1], r[2], body));
    } catch (e) {
      throw new HttpError(e.status || 400, e.message, e.hint);
    }
  }
  if ((r = m(/^\/api\/jobs\/([^/]+)\/captions(\.srt|\.vtt)?$/)) && method === "GET") {
    const job = getJob(r[1]);
    if (job.stages.transcribe?.status !== "done") throw new HttpError(404, "There are no captions yet.", "Wait for the transcript to finish.");
    const caps = loadCaptions(jobDir(job.id));
    if (r[2]) {
      const body = r[2] === ".srt" ? toSrt(caps.cues) : toVtt(caps.cues);
      const name = `${path.parse(job.source.name).name}${r[2]}`;
      res.writeHead(200, { "content-type": MIME[r[2]], "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`, "cache-control": "no-store" });
      return res.end(body);
    }
    return sendJson(res, 200, { ...caps, lowP: LOW_P });
  }
  if ((r = m(/^\/api\/jobs\/([^/]+)\/captions$/)) && method === "PUT") {
    const job = getJob(r[1]);
    const body = await readBody(req, 8e6);
    if (!Array.isArray(body.cues)) throw new HttpError(400, "Send { cues: [{ s, e, text }] }, the whole list in order.");
    const caps = editCaptions(jobDir(job.id), body.cues);
    // rendered clips and outputs no longer match the captions
    saveJob(refreshStale(loadJob(job.id)));
    jobEvents.emit(job.id, { type: "captions", data: { cues: caps.cues.length, edited: true } });
    return sendJson(res, 200, { ...caps, lowP: LOW_P });
  }
  if ((r = m(/^\/api\/jobs\/([^/]+)\/captions\/reset$/)) && method === "POST") {
    const job = getJob(r[1]);
    const caps = resetCaptions(jobDir(job.id), { style: loadCaptions(jobDir(job.id)).style });
    saveJob(refreshStale(loadJob(job.id)));
    return sendJson(res, 200, { ...caps, lowP: LOW_P });
  }
  if ((r = m(/^\/api\/jobs\/([^/]+)\/language$/)) && method === "POST") {
    const job = getJob(r[1]);
    const body = await readBody(req);
    if (!body.language || !/^(auto|[a-z]{2,3})$/.test(body.language)) throw new HttpError(400, "Send { language } as an ISO code such as en or yo, or auto.");
    if (body.asrModel != null && !/^[\w.-]+$/.test(body.asrModel)) throw new HttpError(400, "asrModel is a model name such as small.en.");
    if (body.accent != null && !["auto", "ng", "none"].includes(body.accent)) throw new HttpError(400, "accent is auto, ng or none.");
    if (body.confirm === true) {
      // "Yes, the speaker is using English": keep the transcript, clear the question
      try {
        return sendJson(res, 200, confirmLanguage(job.id, body.language));
      } catch (e) {
        throw new HttpError(e.status || 400, e.message, e.hint);
      }
    }
    try {
      resetTranscript(job.id, { language: body.language, asrModel: body.asrModel || undefined, accent: body.accent || undefined });
    } catch (e) {
      throw new HttpError(e.status || 400, e.message, e.hint);
    }
    enqueue({ jobId: job.id, kind: "analyze" });
    drainQueue();
    return sendJson(res, 202, { queued: true, queue: queueState() });
  }
  if ((r = m(/^\/api\/jobs\/([^/]+)\/faces$/)) && method === "GET") {
    const job = getJob(r[1]);
    const f = path.join(jobDir(job.id), "faces.json");
    if (!fs.existsSync(f)) throw new HttpError(404, "Faces have not been detected for this video yet.", "POST to this address to detect them (macOS only).");
    return sendFile(req, res, f);
  }
  if ((r = m(/^\/api\/jobs\/([^/]+)\/faces$/)) && method === "POST") {
    const job = getJob(r[1]);
    const body = await readBody(req);
    detectJobFaces(job.id, { force: !!body.force }).catch(() => {}); // the result goes out as a faces event
    return sendJson(res, 202, { started: true });
  }
  if ((r = m(/^\/api\/jobs\/([^/]+)\/render$/)) && method === "POST" && getJob(r[1]).settings.mode === "caption") {
    const job = getJob(r[1]);
    if (job.stages.transcribe?.status !== "done") throw new HttpError(400, "The video has not been transcribed yet.", "Wait for the transcript, review the captions, then render.");
    enqueue({ jobId: job.id, kind: "render" });
    drainQueue();
    return sendJson(res, 202, { queued: true, queue: queueState() });
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
  if ((r = m(/^\/api\/jobs\/([^/]+)\/approve$/)) && method === "POST") {
    // approve the best N clips in one go, and optionally queue their render
    const job = getJob(r[1]);
    const body = await readBody(req);
    if (job.settings.mode === "caption") throw new HttpError(400, "Caption jobs have no clips to approve.");
    if (body.preset && !["shorts", "preview"].includes(body.preset)) throw new HttpError(400, "preset must be shorts or preview.");
    let updated;
    try {
      updated = approveTop(job.id, body.top, { includeWeak: body.includeWeak !== false });
    } catch (e) {
      throw new HttpError(e.status || 400, e.message, "Send { top: 10 } to approve the 10 best clips, and render: true to render them.");
    }
    const approved = updated.candidates.filter((c) => c.status === "approved").length;
    if (body.render && approved) {
      enqueue({ jobId: job.id, kind: "render", preset: body.preset });
      drainQueue();
    }
    return sendJson(res, body.render ? 202 : 200, { approved, candidates: updated.candidates, ...(body.render ? { queue: queueState() } : {}) });
  }
  if ((r = m(/^\/api\/jobs\/([^/]+)\/resume$/)) && method === "POST") {
    const job = getJob(r[1]);
    if (isRunning(job.id)) return sendJson(res, 202, { queued: false, running: true });
    const body = await readBody(req);
    if (body.force) {
      // judge an unreliable transcript anyway
      const j = loadJob(job.id);
      j.settings.qualityGate = false;
      saveJob(j);
    }
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
  if ((r = m(/^\/media\/([^/]+)\/output$/)) && (method === "GET" || method === "HEAD")) {
    const job = getJob(r[1]);
    if (!job.output?.path) throw new HttpError(404, "The captioned video has not been rendered yet.");
    return sendFile(req, res, inside(jobDir(job.id), job.output.path));
  }
  if ((r = m(/^\/media\/([^/]+)\/frame$/)) && (method === "GET" || method === "HEAD")) {
    const job = getJob(r[1]);
    const t = Math.max(0, Math.min(Number(url.searchParams.get("t")) || 0, (job.source.duration || 1) - 0.05));
    // one upright frame, long side 960 px (for drawing blur regions)
    const out = await runBinary("ffmpeg", ["-v", "error", ...hwaccelArgs(job.source), "-ss", String(t), "-i", job.source.path, "-frames:v", "1", "-vf", "scale='if(gt(iw,ih),960,-2)':'if(gt(iw,ih),-2,960)'", "-f", "image2", "-c:v", "mjpeg", "-q:v", "4", "pipe:1"]);
    if (!out.length) throw new HttpError(500, "Could not read a frame at that time.");
    res.writeHead(200, { "content-type": "image/jpeg", "content-length": out.length, "cache-control": "private, max-age=3600" });
    return res.end(method === "HEAD" ? undefined : out);
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
