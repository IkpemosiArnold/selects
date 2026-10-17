// Thin test page for the browser engine. Puppeteer drives it through window.selectsDemo.
import { createBrowserApi } from "./api.js";
import { MODELS, size } from "./models.js";
import { cachedFetch } from "./cache.js";
import { judgeShortlist, listwiseRound } from "./judge.js";
import { privateBackend } from "./llm.js";

const $ = (id) => document.getElementById(id);
const api = createBrowserApi();
const t0 = performance.now();
const log = [];
const say = (s) => {
  const line = `${((performance.now() - t0) / 1000).toFixed(1).padStart(7)} s  ${s}`;
  log.push(line);
  $("log").textContent = log.slice(-400).join("\n");
  console.log("[selects]", line);
};
const state = { job: null, candidates: [], stageTimes: {}, renders: {}, done: false, error: null, events: [] };
window.selectsDemo = { api, state, log, judgeOnly, start, renderApproved, approveTop, prefetch, openSaved, listSaved: () => api.listSaved() };

/** Download a judge model into this browser's cache without running anything (for tests). */
async function prefetch(which) {
  const m = MODELS[which];
  let last = -1;
  const t = performance.now();
  const res = await cachedFetch(m.url, { expectedBytes: m.bytes, onProgress: (p) => {
    const b = Math.floor((10 * p.loaded) / Math.max(1, p.total));
    if (b !== last) { last = b; say(`prefetch ${which}: ${Math.round(p.loaded / 1e6)} of ${Math.round(p.total / 1e6)} MB${p.cached ? " (cached)" : ""}`); }
  } });
  await res.body?.cancel();
  return { sec: +((performance.now() - t) / 1000).toFixed(1) };
}

$("tagline").textContent = `${api.copy.tagline} ${api.keepOpenLine}`;
api.registerApp();
const showSaved = async () => {
  const list = await api.listSaved();
  $("saved").innerHTML = list.length ? list.map((s) => `<div class="row">${s.name} (${(s.size / 1e6).toFixed(1)} MB), ${s.finished ? "clips found" : `stopped before ${s.from}`} <button data-key="${s.key}">Open</button></div>`).join("") : '<span class="muted">none</span>';
  $("saved").querySelectorAll("button").forEach((b) => (b.onclick = () => openSaved(b.dataset.key)));
};
showSaved();
const showMode = () => {
  const m = $("mode").value;
  $("smartRow").hidden = m !== "smart";
  $("modeLine").textContent = m === "smart" ? api.copy.smartMode.line : api.copy.privateMode.line;
};
$("mode").onchange = showMode;
showMode();

(async () => {
  const d = await api.downloads();
  $("caps").textContent = JSON.stringify(d.caps, null, 1) + "\n\n" + api.copy.downloadsIntro + "\n" + d.items.map((i) => `  ${i.label}: ${size(i.bytes)} (${i.licence}), cached in ${i.cache}`).join("\n") + (d.caps.webgpu ? "" : `\n\n${api.copy.noWebgpu}`);
})();

function drawCands() {
  const rows = state.candidates.map((c) => `<tr><td>${c.rank ?? ""}</td><td>${c.start.toFixed(1)} to ${c.end.toFixed(1)}</td><td>${c.scores ? Object.values(c.scores).join(" ") : ""}</td><td>${c.total ?? c.pre}</td><td>${(c.hook || "").slice(0, 90)}<br><span class="muted">${c.reason || ""}</span></td><td><button data-id="${c.id}">${c.status === "approved" ? "approved" : "approve"}</button></td></tr>`);
  $("cands").innerHTML = `<tr><th>#</th><th>time</th><th>scores</th><th>total</th><th>hook and reason</th><th></th></tr>${rows.join("")}`;
  $("cands").querySelectorAll("button").forEach((b) => (b.onclick = async () => {
    await api.patchCandidate(state.job.id, b.dataset.id, { status: "approved" });
  }));
}

async function start({ file = $("file").files[0], mode = $("mode").value, prefer = $("prefer").value, key = $("key").value || null, proxyUrl = $("proxy").value || null, smartModel = $("smartModel").value || null, judgeN = +$("judgeN").value || 8, k = 3, listwise = true, asrDevice = "auto" } = {}) {
  if (!file) return say("choose a video first");
  api.preferBackend(prefer);
  api.setMode(mode, mode === "smart" ? { key, proxyUrl, model: smartModel } : {});
  state.done = false;
  state.error = null;
  const job = await api.createJob(file, { judgeN, k, listwise, asrDevice, credit: "test", license: "CC-BY-SA-4.0" });
  say(`job ${job.id}: ${file.name}, ${(file.size / 1e6).toFixed(1)} MB, mode ${mode}, judge ${prefer}${job.resumed ? `, resumed from ${job.resumed.from}` : ""}`);
  return follow(job);
}

async function openSaved(key, file = $("file").files[0] || null) {
  state.done = false;
  state.error = null;
  const job = await api.openSaved(key, file);
  say(`opened saved job ${job.id} (${job.source.name}), resuming from ${job.resumed?.from}${job.resumed?.withFile ? "" : ", without the video"}`);
  return follow(job);
}

function follow(job) {
  state.job = job;
  let lastNote = "";
  api.events(job.id, (type, data) => {
    state.events.push({ t: +((performance.now() - t0) / 1000).toFixed(1), type, name: data?.name, note: data?.note });
    if (type === "stage") {
      $("stage").textContent = data.stage;
      if (data.state?.status === "done") {
        state.stageTimes[data.name] = { started: data.state.startedAt, ended: data.state.endedAt, note: data.state.note };
        say(`stage ${data.name} done: ${data.state.note}`);
      } else if (data.state?.status === "running") say(`stage ${data.name} started`);
      if (data.stage === "ready") {
        state.done = true;
        $("render").disabled = false;
        say("ready");
      }
    } else if (type === "progress") {
      $("bar").style.width = `${Math.round((data.progress || 0) * 100)}%`;
      // downloads: one line per 10%; other notes when they change
      const key = data.download ? `${data.name}:dl:${Math.floor((10 * data.download.loaded) / Math.max(1, data.download.total))}` : `${data.name}:${data.note}`;
      if (data.note && key !== lastNote) say(`${data.name}: ${data.note}`);
      lastNote = key;
    } else if (type === "words") {
      state.wordCount = (state.wordCount || 0) + data.length;
    } else if (type === "candidates") {
      state.candidates = data.candidates;
      drawCands();
      if (data.ranked) say(`ranked: ${data.candidates.map((c) => `${c.rank}. ${c.start.toFixed(0)}-${c.end.toFixed(0)} s total ${c.total}`).join("; ")}`);
    } else if (type === "render") {
      state.renders[`${data.id}:${data.preset}`] = data;
      if (data.status === "done") {
        say(`rendered ${data.id} (${data.preset}) in ${data.wallSec} s, ${data.frames} frames, ${(data.bytes / 1e6).toFixed(1)} MB, ${data.reframe?.mode}`);
        const v = document.createElement("video");
        v.controls = true;
        v.src = data.path;
        $("out").append(v);
      } else if (data.status === "error") say(`render ${data.id} failed: ${data.message}`);
    } else if (type === "error") {
      state.error = data;
      say(`error in ${data.stage}: ${data.message} ${data.hint || ""}`);
    }
  });
  return job.id;
}

async function approveTop(n = 1) {
  const job = await api.getJob(state.job.id);
  for (const c of job.candidates.slice(0, n)) await api.patchCandidate(job.id, c.id, { status: "approved" });
  return job.candidates.slice(0, n).map((c) => c.id);
}

async function renderApproved(preset = $("preset").value) {
  return api.render(state.job.id, null, preset);
}

$("notify").onclick = async () => say(`notifications ${(await api.enableNotifications()) ? "on" : "not allowed"}`);
$("start").onclick = () => start().catch((e) => say(`error: ${e.message}`));
$("render").onclick = () => renderApproved().catch((e) => say(`error: ${e.message}`));

/** Judge a given shortlist on this device (for comparing judges on the same windows). */
async function judgeOnly(cands, prefer = "auto", { listwise = true } = {}) {
  const llm = await privateBackend({ prefer });
  const t0 = performance.now();
  await llm.load({ onProgress: () => {} });
  const loadSec = +((performance.now() - t0) / 1000).toFixed(1);
  const jr = await judgeShortlist(cands, llm, { onProgress: (p) => say(`judgeOnly: ${p.note}`) });
  const lw = listwise ? await listwiseRound(jr.judged.filter((c) => c.scores), llm).catch((e) => ({ error: e.message })) : null;
  return { backend: llm.id, loadSec, calls: jr.calls, judged: jr.judged.map((c) => ({ id: c.id, scores: c.scores, judgeTotal: c.judgeTotal, reason: c.reason })), listwise: lw && { order: lw.order, sec: lw.sec, error: lw.error } };
}
