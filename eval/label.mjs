#!/usr/bin/env node
// Human labelling helper. Opens a local page where you mark your own best 5 moments in each
// eval video. Labels are written into eval/datasets/manifest.json with source: "human".
//
//   node eval/label.mjs            then open http://127.0.0.1:4318
//
// Keys: Space play/pause, J back 5 s, L forward 5 s, I mark in, O mark out, A add moment,
// 1/2/3 playback speed. Click a transcript line to jump there.
// Label blind: do not look at YouTube's "Most Replayed" graph or any model output first.
import http from "node:http";
import { createReadStream, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EVAL = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(EVAL, "datasets", "manifest.json");
const CACHE = join(EVAL, "cache");
const PORT = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 4318);

const readManifest = () => JSON.parse(readFileSync(MANIFEST, "utf8"));
function writeManifest(m) {
  const tmp = MANIFEST + ".tmp";
  writeFileSync(tmp, JSON.stringify(m, null, 2) + "\n");
  renameSync(tmp, MANIFEST);
}
const mediaPath = (item) => (item.videoPath && existsSync(resolve(EVAL, "..", item.videoPath)) ? resolve(EVAL, "..", item.videoPath) : resolve(EVAL, "..", item.localPath));
const TYPES = { ".mp4": "video/mp4", ".webm": "video/webm", ".m4a": "audio/mp4", ".opus": "audio/ogg", ".mp3": "audio/mpeg" };

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function serveFile(req, res, file) {
  const size = statSync(file).size;
  const type = TYPES[extname(file)] || "application/octet-stream";
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (!m) {
    res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" });
    return createReadStream(file).pipe(res);
  }
  const start = m[1] ? Number(m[1]) : size - Number(m[2]);
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
  createReadStream(file, { start, end }).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, PAGE, "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/videos") {
      return send(res, 200, readManifest().map((v) => ({
        id: v.id, title: v.title, duration: v.duration, hasMedia: existsSync(mediaPath(v)),
        isVideo: /\.(mp4|webm)$/.test(mediaPath(v)) && !!v.videoPath,
        human: (v.labels || []).filter((l) => l.source === "human"),
      })));
    }
    const item = parts[2] ? readManifest().find((v) => v.id === parts[2]) : null;
    if (req.method === "GET" && parts[0] === "media" && parts[1]) {
      const v = readManifest().find((x) => x.id === parts[1]);
      if (!v || !existsSync(mediaPath(v))) return send(res, 404, { error: "media not downloaded" });
      return serveFile(req, res, mediaPath(v));
    }
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "words" && item) {
      const f = join(CACHE, item.id, "words.json");
      return send(res, 200, existsSync(f) ? readFileSync(f, "utf8") : "[]");
    }
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "labels" && item) {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const { labels } = JSON.parse(body || "{}");
        if (!Array.isArray(labels)) return send(res, 400, { error: "labels must be an array" });
        const clean = labels
          .map((l) => ({ start: Number(l.start), end: Number(l.end), source: "human", weight: 1, ...(l.note ? { note: String(l.note).slice(0, 200) } : {}), labeller: "arnold", labelledAt: new Date().toISOString() }))
          .filter((l) => Number.isFinite(l.start) && Number.isFinite(l.end) && l.end > l.start);
        const m = readManifest();
        const v = m.find((x) => x.id === item.id);
        v.labels = [...(v.labels || []).filter((l) => l.source !== "human"), ...clean];
        writeManifest(m);
        send(res, 200, { ok: true, saved: clean.length });
      });
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`Label your best 5 moments: http://127.0.0.1:${PORT}`));

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Selects labeller</title>
<style>
:root{--bg:#fafaf7;--fg:#1d1d1b;--mute:#6b6b66;--line:#e2e1da;--mark:#F2BE22;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#eceae4;--mute:#9a988f;--line:#33322e;--card:#1f1e1b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}
h1{font-size:18px;margin:0 0 4px} p{color:var(--mute);margin:4px 0 12px}
select,button{font:inherit;padding:6px 10px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;cursor:pointer}
button.primary{background:var(--mark);border-color:var(--mark);color:#1d1d1b;font-weight:600}
video,audio{width:100%;margin:10px 0;max-height:420px;background:#000}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.t{font-variant-numeric:tabular-nums}
#moments li{margin:4px 0} #moments button{padding:2px 8px;margin-left:8px}
#tx{height:300px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--card);margin-top:12px}
#tx span{cursor:pointer} #tx span:hover{background:var(--line)} #tx span.now{background:var(--mark);color:#1d1d1b}
.warn{color:#b3541e} kbd{border:1px solid var(--line);border-radius:4px;padding:0 4px;font-size:12px}
</style></head><body><main>
<h1>Mark your best 5 moments</h1>
<p>Pick the 5 stretches (20 to 60 s each) you would post as shorts. Label blind: do not look at YouTube's Most Replayed graph or Selects' picks first.
Keys: <kbd>Space</kbd> play, <kbd>J</kbd>/<kbd>L</kbd> 5 s, <kbd>I</kbd> in, <kbd>O</kbd> out, <kbd>A</kbd> add, <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> speed.</p>
<div class="row"><select id="pick"></select><span id="status" class="t"></span></div>
<div id="player"></div>
<div class="row"><span class="t">Now <b id="now">0:00</b></span><span class="t">In <b id="in">-</b></span><span class="t">Out <b id="out">-</b></span>
<button id="bin">Mark in (I)</button><button id="bout">Mark out (O)</button><button id="badd" class="primary">Add moment (A)</button><span id="lenmsg"></span></div>
<ol id="moments"></ol>
<div class="row"><button id="save" class="primary">Save labels</button><span id="saved"></span></div>
<div id="tx"></div>
</main><script>
let videos=[],cur=null,media=null,marks={in:null,out:null},moments=[],sentences=[];
const $=(id)=>document.getElementById(id);
const fmt=(s)=>s==null?"-":Math.floor(s/60)+":"+String(Math.floor(s%60)).padStart(2,"0");
async function load(){videos=await (await fetch("/api/videos")).json();
 $("pick").innerHTML=videos.map(v=>'<option value="'+v.id+'">'+(v.human.length?"[done] ":"")+v.title.replace(/</g,"&lt;")+" ("+fmt(v.duration)+")"+(v.hasMedia?"":" [no media]")+"</option>").join("");
 $("pick").onchange=()=>open($("pick").value); if(videos.length)open(videos[0].id);}
async function open(id){cur=videos.find(v=>v.id===id);marks={in:null,out:null};moments=cur.human.map(l=>({start:l.start,end:l.end,note:l.note||""}));
 $("player").innerHTML=cur.hasMedia?(cur.isVideo?'<video id="m" controls preload="metadata" src="/media/'+id+'"></video>':'<audio id="m" controls preload="metadata" src="/media/'+id+'"></audio>'):'<p class="warn">Media not downloaded for this video.</p>';
 media=$("m"); if(media)media.ontimeupdate=tick; render();
 const words=await (await fetch("/api/words/"+id)).json(); sentences=[];let s=null;
 for(const w of words){if(!s)s={s:w.s,e:w.e,text:""};s.text+=w.w;s.e=w.e;if(/[.?!]$/.test(w.w.trim())){sentences.push(s);s=null}}if(s)sentences.push(s);
 $("tx").innerHTML=sentences.length?sentences.map((x,i)=>'<span data-i="'+i+'">'+x.text.replace(/</g,"&lt;")+" </span>").join(""):'<p>No transcript cached yet. It appears after the eval runner transcribes this video.</p>';}
$("tx").onclick=(e)=>{const i=e.target.dataset&&e.target.dataset.i;if(i!=null&&media){media.currentTime=sentences[i].s;media.play()}};
let lastHi=-1;function tick(){$("now").textContent=fmt(media.currentTime);const t=media.currentTime;const i=sentences.findIndex(x=>x.s<=t&&t<x.e);if(i!==lastHi){const o=document.querySelector("#tx .now");if(o)o.classList.remove("now");const n=document.querySelector('#tx [data-i="'+i+'"]');if(n){n.classList.add("now")}lastHi=i}}
function render(){$("in").textContent=fmt(marks.in);$("out").textContent=fmt(marks.out);
 const len=marks.in!=null&&marks.out!=null?marks.out-marks.in:null;$("lenmsg").innerHTML=len==null?"":(len<20||len>60?'<span class="warn">'+Math.round(len)+" s (aim for 20 to 60)</span>":Math.round(len)+" s");
 $("moments").innerHTML=moments.sort((a,b)=>a.start-b.start).map((m,i)=>'<li class="t">'+fmt(m.start)+" to "+fmt(m.end)+" ("+Math.round(m.end-m.start)+' s) <button data-play="'+i+'">play</button><button data-del="'+i+'">remove</button></li>').join("");
 $("status").textContent=moments.length+" of 5 marked";}
$("moments").onclick=(e)=>{const d=e.target.dataset;if(d.del!=null){moments.splice(+d.del,1);render()}if(d.play!=null&&media){media.currentTime=moments[+d.play].start;media.play()}};
const mark=(k)=>{if(media){marks[k]=Math.round(media.currentTime*10)/10;render()}};
function add(){if(marks.in==null||marks.out==null||marks.out<=marks.in){alert("Mark in and out first (out after in).");return}moments.push({start:marks.in,end:marks.out});marks={in:null,out:null};render()}
$("bin").onclick=()=>mark("in");$("bout").onclick=()=>mark("out");$("badd").onclick=add;
$("save").onclick=async()=>{const r=await (await fetch("/api/labels/"+cur.id,{method:"POST",body:JSON.stringify({labels:moments})})).json();$("saved").textContent=r.ok?"Saved "+r.saved+" moments":"Error: "+r.error;cur.human=moments.slice()};
document.onkeydown=(e)=>{if(e.target.tagName==="SELECT"||!media)return;const k=e.key.toLowerCase();
 if(k===" "){e.preventDefault();media.paused?media.play():media.pause()}else if(k==="j")media.currentTime-=5;else if(k==="l")media.currentTime+=5;
 else if(k==="i")mark("in");else if(k==="o")mark("out");else if(k==="a")add();else if(k==="1")media.playbackRate=1;else if(k==="2")media.playbackRate=1.5;else if(k==="3")media.playbackRate=2;};
load();
</script></body></html>`;
