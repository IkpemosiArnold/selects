// The browser adapter: the same methods as the HTTP client in web/src/lib/api.js, served by
// the in-browser engine instead of the local server. The React UI can use either:
//
//   import { createBrowserApi } from "../../src/browser/api.js";
//   const api = createBrowserApi();            // Private mode: everything in this tab
//   api.setMode("smart", { key });             // Smart mode with the user's own key
//   api.setMode("smart", { proxyUrl });        // Smart mode through server-proxy
//   api.setMode("light");                      // Light mode: audio transcribed by the free
//                                              // hosted whisper, judged as in Smart mode
//   api.setMode("light", { groqKey });         // Light mode with the person's own free Groq key
//
// Differences from the HTTP client are listed in src/browser/adapter.md.
import { Engine } from "./engine.js";
import { geminiKeyBackend, privateBackend, proxyBackend } from "./llm.js";
import { HF, MODELS, SMART_MODELS, speechModel } from "./models.js";
import { runtimes } from "./devices.js";
import { COPY } from "./copy.js";
import { enableNotifications, KEEP_OPEN, registerApp } from "./device.js";
import { groqKeySender, proxySender, remoteTranscriber } from "./transcribers.js";
import { isIos, measureDownlink, speechModelCached, suggestMode, wakeProxy } from "./light.js";

const KEY_STORE = "selects.geminiKey"; // sessionStorage only: gone when the tab closes
const GROQ_STORE = "selects.groqKey"; // Light mode's own-key option, also sessionStorage only

/**
 * A fingerprint of a credential, so client caches can tell one key from another without
 * keeping or logging the key itself (53-bit cyrb53; not a security measure, an identity).
 */
export function credentialId(secret) {
  if (!secret) return null;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < secret.length; i++) {
    const c = secret.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `k${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

const wrap = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    const err = new Error([e.message, e.hint].filter(Boolean).join(" "));
    err.status = e.status || 500;
    err.hint = e.hint || null;
    throw err;
  }
};

/** What this browser can do, for choosing runtimes and for honest UI copy. */
export async function capabilities() {
  let webgpu = false;
  let adapterInfo = null;
  try {
    const a = navigator.gpu && (await navigator.gpu.requestAdapter());
    webgpu = !!a;
    adapterInfo = a?.info ? { vendor: a.info.vendor, architecture: a.info.architecture } : null;
  } catch {}
  let h264 = false;
  try {
    h264 = !!(await VideoEncoder.isConfigSupported({ codec: "avc1.640028", width: 1080, height: 1920, bitrate: 6e6, framerate: 30 })).supported;
  } catch {}
  return {
    webgpu,
    adapterInfo,
    crossOriginIsolated: !!self.crossOriginIsolated,
    threads: navigator.hardwareConcurrency || null,
    deviceMemoryGb: navigator.deviceMemory || null,
    webcodecs: typeof VideoEncoder !== "undefined" && typeof VideoDecoder !== "undefined",
    h264Encode: h264,
    cacheStorage: typeof caches !== "undefined",
  };
}

// the deployed proxy's URL, set at build time (render.yaml: VITE_SELECTS_PROXY_URL)
const BUILT_PROXY = import.meta.env?.VITE_SELECTS_PROXY_URL || null;

export function createBrowserApi({ mode = "private", smart = {}, prefer = "auto", deps = {} } = {}) {
  // the judge backends (llm.js); tests pass stand-ins
  const make = { geminiKeyBackend, privateBackend, proxyBackend, ...deps };
  let state = { mode, smart: { proxyUrl: BUILT_PROXY, ...smart }, prefer };
  // wake the free proxy while the person picks a file (it sleeps when idle); never awaited here
  const woke = state.smart.proxyUrl && typeof window !== "undefined" ? wakeProxy(state.smart.proxyUrl) : Promise.resolve({ ok: false, light: false });
  // whether the free shared transcriber is switched on (the proxy has a key): null until it answers
  let shared = null;
  woke.then((w) => (shared = !!w.light));
  let probe = null;

  const savedKey = () => {
    try {
      return sessionStorage.getItem(KEY_STORE);
    } catch {
      return null;
    }
  };
  const savedGroq = () => {
    try {
      return sessionStorage.getItem(GROQ_STORE);
    } catch {
      return null;
    }
  };

  const currentKey = () => state.smart.key || savedKey();
  const currentGroq = () => state.smart.groqKey || savedGroq();

  /**
   * The choices a job runs with, frozen when it starts (engine.js keeps it on the job): the
   * privacy mode, the judge's route and model, and which keys (by fingerprint, never the key).
   * Switching mode, or adding, replacing or forgetting a key, affects only jobs started after.
   */
  function profile() {
    return Object.freeze({
      mode: state.mode,
      prefer: state.prefer,
      proxyUrl: state.smart.proxyUrl || null,
      model: state.smart.model || null,
      geminiKeyId: credentialId(currentKey()),
      groqKeyId: credentialId(currentGroq()),
    });
  }

  /** The key a job started with, if it is still the one in this tab; a removed or replaced key is never swapped for another. */
  const keyFor = (wantedId, current, what) => {
    if (!wantedId) return null;
    if (credentialId(current) === wantedId) return current;
    throw Object.assign(new Error(`The ${what} this job started with was removed or replaced.`), { hint: `Start the video again to use the ${what} you have now, or switch to Private mode.` });
  };

  // clients, one per profile and credential (a Map, so jobs on different profiles never swap each other's)
  const transcribers = new Map();
  const backends = new Map();

  /** Light mode's transcriber for a job's profile (its own Groq key, else the proxy), or null for whisper on this device. */
  async function getTranscriber(p = profile()) {
    if (p.mode !== "light") return null;
    const groq = keyFor(p.groqKeyId, currentGroq(), "Groq key");
    const k = JSON.stringify([p.groqKeyId || "proxy", p.proxyUrl]);
    if (transcribers.has(k)) return transcribers.get(k).client;
    let t;
    if (groq) t = remoteTranscriber({ sender: groqKeySender(groq, { credential: p.groqKeyId }) });
    else if (p.proxyUrl) t = remoteTranscriber({ sender: proxySender(p.proxyUrl) });
    else return null;
    transcribers.set(k, { client: t, keyId: p.groqKeyId });
    return t;
  }

  /** The judge for a job's profile: Private on the device; Smart and Light through Google, with the job's own key or the proxy. */
  async function getJudge(p = profile()) {
    const k = JSON.stringify([p.mode === "private" ? "private" : "google", p.prefer, p.proxyUrl, p.model, p.geminiKeyId]);
    if (backends.has(k)) return backends.get(k).client;
    let b;
    // Light mode judges as Smart mode does (the text of the shortlist, never audio or video)
    if (p.mode === "smart" || p.mode === "light") {
      const key = keyFor(p.geminiKeyId, currentKey(), "Gemini key");
      if (key) b = make.geminiKeyBackend({ key, model: p.model || SMART_MODELS[0] });
      else if (p.proxyUrl) b = make.proxyBackend({ url: p.proxyUrl, model: p.model || null });
      else throw Object.assign(new Error("Smart mode needs a Gemini API key or a proxy address."), { hint: "Paste a free key from Google AI Studio, or switch to Private mode." });
    } else {
      b = await make.privateBackend({ prefer: p.prefer });
    }
    backends.set(k, { client: b, keyId: p.geminiKeyId });
    return b;
  }

  /** Drop every client built with a key that is no longer the one in this tab, so no old key stays in memory. */
  const dropClients = () => {
    const gemini = credentialId(currentKey());
    const groq = credentialId(currentGroq());
    for (const [k, v] of backends) if (v.keyId && v.keyId !== gemini) backends.delete(k);
    for (const [k, v] of transcribers) if (v.keyId && v.keyId !== groq) transcribers.delete(k);
  };

  const engine = new Engine({ getProfile: profile, getJudge, getFallback: (p = profile()) => make.privateBackend({ prefer: p.prefer }), getTranscriber, ...(deps.engine || {}) });

  return {
    mock: false,
    browser: true,
    engine,
    copy: COPY,

    /** "private" (default: the video, audio and transcript stay in this tab), "light" or "smart". */
    setMode(next, opts = {}) {
      const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v != null && v !== ""));
      state = { ...state, mode: next, smart: { ...state.smart, ...given } };
      if (opts.groqKey) {
        try {
          sessionStorage.setItem(GROQ_STORE, opts.groqKey);
        } catch {}
        dropClients();
      }
      if (opts.groqKey === null) {
        // forget it everywhere: in memory, in the tab's storage, and the client built with it
        delete state.smart.groqKey;
        dropClients();
        try {
          sessionStorage.removeItem(GROQ_STORE);
        } catch {}
      }
      if (opts.key) {
        try {
          sessionStorage.setItem(KEY_STORE, opts.key);
        } catch {}
        dropClients();
      }
      if (opts.key === null) {
        delete state.smart.key;
        dropClients();
        try {
          sessionStorage.removeItem(KEY_STORE);
        } catch {}
      }
      return this.getMode();
    },
    getMode: () => ({ mode: state.mode, hasKey: !!(state.smart.key || savedKey()), hasGroqKey: !!(state.smart.groqKey || savedGroq()), lightShared: shared, proxyUrl: state.smart.proxyUrl || null, model: state.smart.model || null, prefer: state.prefer }),
    /**
     * Which mode to suggest (light.js suggestMode): Private when the speech model is already
     * in this browser; otherwise Light whenever it can run (the free shared transcriber is on,
     * or the person gave their own free Groq key). wait: wait for the proxy to answer (a free
     * server can take a minute to wake) instead of 4 s; probe: where the browser reports no
     * speed (Safari), time a 1 MB download of the speech model to say how long Private takes.
     */
    async suggestMode({ wait = false, probe: doProbe = false } = {}) {
      const rt = await runtimes({ prefer: state.prefer });
      // the speech model this device would use in Private mode (tiny.en on phones), in the resumable download store
      const w = speechModel(rt.speech);
      const [cached, woken] = await Promise.all([speechModelCached(w, rt.asr), wait ? woke : Promise.race([woke, new Promise((r) => setTimeout(() => r(null), 4000))])]);
      const own = !!(state.smart.groqKey || savedGroq());
      const sharedOn = woken ? !!woken.light : null;
      const connection = globalThis.navigator?.connection || null;
      let probeMbps = null;
      if (doProbe && !connection && cached !== true) probeMbps = await (probe ??= measureDownlink(`${HF}/${w.id}/resolve/main/onnx/encoder_model.onnx`));
      // unknown (the proxy is still waking) counts as on; a "busy" stop says so honestly if not
      const lightAvailable = own || (!!state.smart.proxyUrl && sharedOn !== false);
      return { ...suggestMode({ connection, probeMbps, ios: isIos(), asrCached: cached, asrBytes: w.bytes[rt.asr], lightAvailable }), shared: sharedOn, own };
    },
    preferBackend(p) {
      state = { ...state, prefer: p };
    },
    capabilities,

    /** What Private mode will download on this browser, before anything is fetched. */
    async downloads() {
      // the same choice the engine makes when it runs (devices.js), so the sizes shown are the sizes fetched
      const [caps, rt] = await Promise.all([capabilities(), runtimes({ prefer: state.prefer })]);
      const judgeId = rt.judge === "gemma4-webgpu" ? "gemma4" : "gemma3";
      const judge = MODELS[judgeId];
      // whisper's size is chosen for the device (tiny.en on iPhones and small-memory devices)
      const w = speechModel(rt.speech);
      return {
        runtimes: rt,
        items: [
          { id: "whisper", label: w.label, bytes: w.bytes[rt.asr], device: rt.asr, size: rt.speech, licence: w.licence, source: w.source, cache: w.cache },
          // phones and small-memory devices never download the in-tab judge (devices.js, inTabJudgeFits)
          ...(rt.inTabJudge ? [{ id: judgeId, label: judge.label, bytes: judge.bytes, licence: judge.licence, source: judge.source, cache: judge.cache }] : []),
          { id: "ng5", label: MODELS.ng5.label, bytes: MODELS.ng5.bytes, licence: MODELS.ng5.licence, source: MODELS.ng5.source, cache: MODELS.ng5.cache },
        ],
        caps,
      };
    },

    health: () => wrap(async () => ({ ok: true, browser: true, whisper: true, ollama: false, models: [(await getJudge()).model], diskFreeGb: null })),
    models: () => wrap(async () => {
      const b = await getJudge();
      return [{ name: b.model, sizeGb: b.bytes ? +(b.bytes / 1e9).toFixed(2) : null, measuredSecPerCandidate: null, where: b.where }];
    }),
    listJobs: () => wrap(() => engine.listJobs()),
    getJob: (id) => wrap(() => engine.getJob(id)),
    getWords: (id) => wrap(() => engine.getWords(id)),
    /** Takes a File (from a file input or a drop), not a path. */
    /** Takes a File. If this device has worked on the same file before, its saved job resumes. */
    createJob: (file, settings) => wrap(() => engine.createJob(file, settings)),
    // Resume (phones freeze background tabs, so Selects saves after every stage instead)
    listSaved: () => wrap(() => engine.listSaved()),
    openSaved: (key, file) => wrap(() => engine.openSaved(key, file)),
    attachFile: (id, file) => wrap(() => engine.attachFile(id, file)),
    forgetSaved: (key) => wrap(() => engine.forgetSaved(key)),
    enableNotifications,
    registerApp,
    keepOpenLine: KEEP_OPEN,
    patchCandidate: (id, cid, body) => wrap(() => engine.patchCandidate(id, cid, body)),
    patchJob: (id, settings) => wrap(() => engine.patchJob(id, settings)),
    // Audiograms (a file with no picture): the person's background image, kept on this device
    setCover: (id, file) => wrap(() => engine.setCover(id, file)),
    coverUrl: (id) => {
      try {
        return engine.coverUrl(id);
      } catch {
        return null;
      }
    },
    levels: (id, start, end) => wrap(() => engine.levels(id, start, end)),
    getKit: (id, cid) => wrap(() => engine.getKit(id, cid)),
    /** When Smart mode is not answering (job.error.code "smart_unavailable"): "retry", "preliminary" or "download". */
    chooseJudge: (id, choice) => wrap(() => engine.chooseJudge(id, choice)),
    /** Write a rendered clip's title and caption again; progress comes as render events (kitStatus). */
    retryKit: (id, cid) => wrap(async () => {
      engine.retryKit(id, cid);
      return { queued: true, id: cid };
    }),
    queue: async () => ({ running: null, items: [] }),
    render: (id, ids, preset) => wrap(async () => {
      const job = engine.getJob(id);
      const targets = ids?.length ? ids : job.candidates.filter((c) => c.status === "approved").map((c) => c.id);
      if (!targets.length) throw Object.assign(new Error("No clips to render."), { status: 400, hint: "Approve at least one clip first." });
      engine.render(id, { ids: targets, preset: preset || "shorts" }).catch(() => {});
      return { queued: true, clips: targets };
    }),
    resume: () => wrap(async () => {
      throw Object.assign(new Error("A browser job cannot be resumed after the page reloads."), { status: 501, hint: "Choose the video again. Models are cached, so it starts faster the second time." });
    }),
    getCaptions: (id) => wrap(() => engine.getCaptions(id)),
    putCaptions: (id, cues) => wrap(() => engine.putCaptions(id, cues)),
    resetCaptions: (id) => wrap(() => engine.resetCaptions(id)),
    captionsFileUrl: (id, ext) => engine.captionsFile(id, ext),
    events(id, onEvent) {
      // like the server's SSE stream: the full Job first, then named events
      queueMicrotask(() => {
        try {
          onEvent("job", engine.getJob(id));
        } catch {}
      });
      return engine.on(id, onEvent);
    },
    thumbUrl: (id, n) => engine.thumbUrl(id, n),
    sourceUrl: (id) => engine.sourceUrl(id),
    clipUrl: (id, cid, preset) => engine.clipUrl(id, cid, preset),

    // Desktop-only features: they need ffmpeg, Apple Vision or models not in the browser build.
    asrModels: async () => {
      const w = speechModel((await runtimes()).speech);
      return [{ name: w.id.includes("tiny") ? "tiny.en" : "base.en", sizeMb: Math.round(w.bytes.wasm / 1e6), english: true }];
    },
    setLanguage: () => wrap(async () => { throw Object.assign(new Error(COPY.desktopOnly.language), { status: 501 }); }),
    detectFaces: () => wrap(async () => { throw Object.assign(new Error(COPY.desktopOnly.faces), { status: 501 }); }),
    getFaces: () => wrap(async () => { throw Object.assign(new Error(COPY.desktopOnly.faces), { status: 404 }); }),
    locate: async () => null,
    outputUrl: () => null,
    frameUrl: () => null,
  };
}
