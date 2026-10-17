#!/usr/bin/env node
// Blind preference test. Shows two clips from the same video side by side (transcript and
// audio), in random order, with the method hidden, and asks "Which would you rather post?"
//
//   node eval/prefer.mjs            this computer only: http://127.0.0.1:4319
//   node eval/prefer.mjs --share    phones on the same Wi-Fi too; the link carries a random token
//
// Pairs come from eval/results/prefer-pairs.json (built by run-eval-v2.mjs). Answers are
// appended to eval/results/prefer-ratings.jsonl as { rater, pair, choice: "A"|"B"|"neither", ms, at }.
import http from "node:http";
import { appendFileSync, createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const EVAL = dirname(fileURLToPath(import.meta.url));
const PAIRS = join(EVAL, "results", "prefer-pairs.json");
const RATINGS = join(EVAL, "results", "prefer-ratings.jsonl");
const AUDIO = join(EVAL, "media", "prefer");
const args = process.argv.slice(2);
const SHARE = args.includes("--share");
const PORT = Number(args.includes("--port") ? args[args.indexOf("--port") + 1] : 4319);
const TOKEN = SHARE ? randomBytes(9).toString("base64url") : null;

if (!existsSync(PAIRS)) {
  console.error("No pairs yet: run node eval/run-eval-v2.mjs first (it writes eval/results/prefer-pairs.json).");
  process.exit(1);
}
const pairs = JSON.parse(readFileSync(PAIRS, "utf8"));
// what the page may see: never the method, never which side is Selects
const publicPairs = pairs.map((p) => ({ id: p.id, title: p.title, A: { text: p.A.text, sec: Math.round(p.A.end - p.A.start) }, B: { text: p.B.text, sec: Math.round(p.B.end - p.B.start) } }));

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function serveAudio(req, res, file) {
  const size = statSync(file).size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (!m) {
    res.writeHead(200, { "content-type": "audio/mp4", "content-length": size, "accept-ranges": "bytes" });
    return createReadStream(file).pipe(res);
  }
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  res.writeHead(206, { "content-type": "audio/mp4", "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
  createReadStream(file, { start, end }).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (TOKEN && url.searchParams.get("t") !== TOKEN) return send(res, 403, "This link needs its token. Ask for the full link.", "text/plain");
  try {
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, PAGE, "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/pairs") return send(res, 200, publicPairs);
    const am = /^\/audio\/(p\d+)-(A|B)$/.exec(url.pathname);
    if (req.method === "GET" && am) {
      const f = join(AUDIO, `${am[1]}-${am[2]}.m4a`);
      return existsSync(f) ? serveAudio(req, res, f) : send(res, 404, { error: "no audio" });
    }
    if (req.method === "POST" && url.pathname === "/api/rate") {
      let body = "";
      req.on("data", (d) => { body += d; if (body.length > 4000) req.destroy(); });
      req.on("end", () => {
        let r;
        try { r = JSON.parse(body); } catch { return send(res, 400, { error: "bad json" }); }
        const rater = String(r.rater || "").trim().slice(0, 40);
        if (!rater || !pairs.some((p) => p.id === r.pair) || !["A", "B", "neither"].includes(r.choice)) return send(res, 400, { error: "need rater, pair and choice" });
        appendFileSync(RATINGS, JSON.stringify({ rater, pair: r.pair, choice: r.choice, ms: Number(r.ms) || null, at: new Date().toISOString() }) + "\n");
        send(res, 200, { ok: true });
      });
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

const host = SHARE ? "0.0.0.0" : "127.0.0.1";
server.listen(PORT, host, () => {
  const q = TOKEN ? `/?t=${TOKEN}` : "/";
  console.log(`Preference test (${pairs.length} pairs). Open:`);
  console.log(`  http://127.0.0.1:${PORT}${q}`);
  if (SHARE) for (const list of Object.values(networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && !a.internal) console.log(`  http://${a.address}:${PORT}${q}   (phones on the same Wi-Fi)`);
  console.log("Answers go to eval/results/prefer-ratings.jsonl. Press Ctrl+C to stop.");
});

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Which clip would you post?</title>
<style>
:root{--bg:#fafaf7;--fg:#1d1d1b;--mute:#66655f;--line:#e2e1da;--card:#fff;--mark:#F2BE22}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#eceae4;--mute:#a19f96;--line:#33322e;--card:#1f1e1b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:1000px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0 0 6px}p{margin:6px 0 12px;color:var(--mute)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media (max-width:720px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}
.card h2{font-size:16px;margin:0 0 8px}.quote{max-height:260px;overflow:auto;white-space:pre-wrap;font-size:15px}
audio{width:100%;margin:8px 0}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
button{font:inherit;padding:12px 18px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;min-height:48px;flex:1}
button.pick{background:var(--mark);border-color:var(--mark);color:#1d1d1b;font-weight:600}
input{font:inherit;padding:10px;border-radius:8px;border:1px solid var(--line);width:100%;max-width:320px;background:var(--card);color:var(--fg)}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.muted{color:var(--mute);font-size:14px}
</style></head><body><main>
<div id="start">
<h1>Which clip would you rather post?</h1>
<p>You will see two short clips from the same talk or interview. Read them or listen (each is 20 to 60 seconds; you do not need to play both to the end). Pick the one you would rather post as a short, or "Neither" if both are weak. There are no right answers, and you can stop at any time. It takes about 10 minutes.</p>
<p><label>Your first name or initials<br><input id="name" autocomplete="given-name"></label></p>
<div class="row" style="max-width:320px"><button class="pick" id="go">Start</button></div>
</div>
<div id="test" hidden>
<div class="top"><h1 id="title"></h1><span class="muted" id="count"></span></div>
<div class="grid">
<div class="card"><h2>Clip A <span class="muted" id="secA"></span></h2><audio id="audA" controls preload="none"></audio><div class="quote" id="txtA"></div></div>
<div class="card"><h2>Clip B <span class="muted" id="secB"></span></h2><audio id="audB" controls preload="none"></audio><div class="quote" id="txtB"></div></div>
</div>
<div class="row"><button class="pick" data-c="A">Post A</button><button class="pick" data-c="B">Post B</button><button data-c="neither">Neither</button></div>
</div>
<div id="done" hidden><h1>Thank you</h1><p>That is all of them. You can close this page.</p></div>
</main><script>
const q = location.search;
const $ = (id) => document.getElementById(id);
let pairs = [], i = 0, shown = 0, rater = "";
try { rater = localStorage.getItem("prefer-rater") || ""; } catch {}
$("name").value = rater;
function shuffle(a){ for(let k=a.length-1;k>0;k--){ const j=Math.floor(Math.random()*(k+1)); [a[k],a[j]]=[a[j],a[k]]; } return a; }
async function begin(){
  rater = $("name").value.trim(); if(!rater){ $("name").focus(); return; }
  try { localStorage.setItem("prefer-rater", rater); } catch {}
  pairs = shuffle(await (await fetch("/api/pairs" + q)).json());
  let done = []; try { done = JSON.parse(localStorage.getItem("prefer-done-" + rater) || "[]"); } catch {}
  pairs = pairs.filter((p) => !done.includes(p.id));
  $("start").hidden = true; $("test").hidden = false; show();
}
function show(){
  if(i >= pairs.length){ $("test").hidden = true; $("done").hidden = false; return; }
  const p = pairs[i];
  $("title").textContent = p.title; $("count").textContent = (i + 1) + " of " + pairs.length;
  for (const s of ["A","B"]) { $("txt"+s).textContent = p[s].text; $("sec"+s).textContent = "(" + p[s].sec + " s)"; const a = $("aud"+s); a.pause(); a.src = "/audio/" + p.id + "-" + s + q; }
  shown = Date.now(); window.scrollTo(0, 0);
}
async function choose(c){
  const p = pairs[i];
  await fetch("/api/rate" + q, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rater, pair: p.id, choice: c, ms: Date.now() - shown }) });
  try { const k = "prefer-done-" + rater; const d = JSON.parse(localStorage.getItem(k) || "[]"); d.push(p.id); localStorage.setItem(k, JSON.stringify(d)); } catch {}
  i++; show();
}
$("go").onclick = begin;
document.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => choose(b.dataset.c)));
$("audA").onplay = () => $("audB").pause(); $("audB").onplay = () => $("audA").pause();
</script></body></html>`;
