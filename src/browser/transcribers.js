// Speech to text behind one interface, so where it runs (this device, the Selects proxy, or a
// hosted whisper with the person's own free key) can change without touching the engine.
//
//   transcriber = {
//     id, model, where: "device" | "remote", label,
//     prepare({ onProgress, onWaking })          load the model or wake the server
//     transcribe(pcm, { rate, onChunk, signal, from })
//       -> { words: [{ w, s, e }], wallSec, bytes, pieces, codec, doneSec }
//   }
//   onChunk({ words, processed, i, n, bytes, wallSec }) arrives in order, so the transcript
//   streams from the start. `from` (seconds) skips audio already transcribed.
//
// Remote transcribers send speech-only audio pieces (speech-chunks.js), compressed on the
// device (encode.js); the video never leaves. A remote failure carries .doneSec (how far the
// transcript got) and .busy (the shared free quota is used up), so the engine can carry on
// from there on the device or with the person's own key.
import { cleanWords, wordsFromVerbose } from "../core/asr-words.mjs";
import { encodeSpeech, speechCodec } from "./encode.js";
import { inOrder, planChunks, speechRegions } from "./speech-chunks.js";

const secs = (t0) => +((performance.now() - t0) / 1000).toFixed(1);

/** Whisper in this tab (asr.js): the Private and Smart mode path, behind the same interface. */
export function deviceTranscriber({ device = "auto", model } = {}) {
  let asr = null;
  return {
    id: "device",
    model,
    where: "device",
    label: "whisper on this device",
    async prepare({ onProgress } = {}) {
      asr ??= await import("./asr.js");
      return asr.loadAsr({ device, onDownload: onProgress });
    },
    async transcribe(pcm, { rate = 16000, onChunk, signal, from = 0 } = {}) {
      asr ??= await import("./asr.js");
      const start = Math.floor(from * rate);
      const res = await asr.transcribePcm(start ? pcm.subarray(start) : pcm, {
        rate,
        signal,
        onChunk: (m) => onChunk?.({ ...m, words: cleanWords(m.words, { offset: from }), processed: m.processed + from }),
      });
      return { ...res, words: cleanWords(res.words, { offset: from }), doneSec: pcm.length / rate };
    },
  };
}

/** Send one encoded piece to the Selects proxy. Resolves { words, duration, model }. */
export function proxySender(url) {
  const base = url.replace(/\/+$/, "");
  return {
    id: "proxy",
    async wake() {
      const r = await fetch(`${base}/healthz`, { credentials: "omit", cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.light === false) throw Object.assign(new Error("Light mode is not set up on the Selects server."), { status: 503, busy: true });
      return j;
    },
    async send(piece, { signal } = {}) {
      let r;
      try {
        r = await fetch(`${base}/transcribe`, { method: "POST", headers: { "content-type": piece.mime }, body: piece.blob, credentials: "omit", signal });
      } catch (e) {
        if (signal?.aborted) throw e;
        throw Object.assign(new Error("Could not reach the Selects server."), { status: 0, transient: true });
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(j.error || `Server ${r.status}`), { status: r.status, hint: j.hint, scope: j.scope, retrySec: j.retrySec ?? null, transient: r.status === 0 || r.status >= 500, busy: r.status === 429 || r.status === 503 });
      return j;
    },
  };
}

/**
 * Send one encoded piece straight to Groq with the person's own free key (kept in this tab,
 * sent only to Groq, which allows calls from web pages). Same answer shape as the proxy.
 */
export function groqKeySender(key, { model = "whisper-large-v3", base = "https://api.groq.com/openai/v1" } = {}) {
  return {
    id: "groq-key",
    async wake() {},
    async send(piece, { signal } = {}) {
      const form = new FormData();
      form.append("file", piece.blob, `audio.${piece.ext}`);
      form.append("model", model);
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      form.append("timestamp_granularities[]", "segment");
      form.append("language", "en");
      form.append("temperature", "0");
      let r;
      try {
        r = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, credentials: "omit", signal });
      } catch (e) {
        if (signal?.aborted) throw e;
        throw Object.assign(new Error("Could not reach Groq."), { status: 0, transient: true });
      }
      const j = await r.json().catch(() => ({}));
      if (r.status === 401) throw Object.assign(new Error("Groq did not accept this key."), { status: 401, hint: "Check the key on console.groq.com, or use the free shared transcriber.", badKey: true });
      if (!r.ok) throw Object.assign(new Error(j.error?.message || `Groq ${r.status}`), { status: r.status, busy: r.status === 429, transient: r.status >= 500, retrySec: Number(r.headers.get("retry-after")) || null, hint: r.status === 429 ? "Your free Groq quota is used up for now." : null });
      const words = wordsFromVerbose(j);
      if (!words) throw Object.assign(new Error("Groq gave no word times."), { status: 502 });
      return { words, duration: j.duration ?? null, model };
    },
  };
}

/**
 * A remote transcriber: plan the pieces, compress each on the device, send up to
 * `concurrency` at a time, and hand the words back in order with their times put back on
 * the recording's clock. One retry per piece for a network or server error.
 *   sender: proxySender(url) or groqKeySender(key)
 *   encode, plan, regions: injectable for tests
 */
export function remoteTranscriber({ sender, model = "whisper-large-v3", concurrency = 2, encode = encodeSpeech, codec = speechCodec, plan = planChunks, regions = speechRegions, retryMs = 1500 } = {}) {
  let wakeP = null;
  return {
    id: `remote:${sender.id}`,
    model,
    where: "remote",
    label: sender.id === "groq-key" ? "whisper on Groq, with your key" : "the free Selects transcriber",
    /** Wake the server (a free host sleeps when idle). onWaking(sec) while it takes longer than a second. */
    async prepare({ onWaking } = {}) {
      const t0 = performance.now();
      const timer = setInterval(() => onWaking?.(Math.round((performance.now() - t0) / 1000)), 1000);
      try {
        wakeP ??= (async () => {
          for (let i = 0; ; i++) {
            try {
              return await sender.wake();
            } catch (e) {
              if (e.busy || (performance.now() - t0) / 1000 > 90) throw e;
              await new Promise((r) => setTimeout(r, 3000));
            }
          }
        })().catch((e) => {
          wakeP = null;
          throw e;
        });
        await wakeP;
        return { wakeSec: secs(t0) };
      } finally {
        clearInterval(timer);
      }
    },
    async transcribe(pcm, { rate = 16000, onChunk, signal, from = 0 } = {}) {
      const t0 = performance.now();
      const c = await codec();
      const startAt = Math.floor(from * rate);
      const body = startAt ? pcm.subarray(startAt) : pcm;
      const pieces = plan(body, rate, { regions: regions ? regions(body, rate) : null, ...(c.maxSec ? { firstSec: Math.min(30, c.maxSec), maxSec: c.maxSec } : {}) });
      const words = [];
      let bytes = 0;
      let doneSec = from;
      const send = async (p) => {
        const piece = await encode(body.subarray(p.start, p.end), { rate, codec: c });
        for (let attempt = 0; ; attempt++) {
          try {
            const res = await sender.send(piece, { signal });
            return { ...res, bytes: piece.bytes, piece: p };
          } catch (e) {
            if (attempt >= 1 || !e.transient || signal?.aborted) throw e;
            await new Promise((r) => setTimeout(r, retryMs));
          }
        }
      };
      const out = await inOrder(pieces, send, {
        concurrency,
        signal,
        onResult: (res, i) => {
          const offset = from + res.piece.start / rate;
          const ws = cleanWords(res.words, { offset, prevEnd: words.length ? words[words.length - 1].e : 0 });
          words.push(...ws);
          bytes += res.bytes;
          doneSec = from + res.piece.end / rate;
          onChunk?.({ words: ws, processed: doneSec, i, n: pieces.length, bytes, wallSec: secs(t0) });
        },
      });
      if (out.error) {
        // how far the in-order transcript got: everything before it is kept
        const e = out.error;
        e.doneSec = out.done ? doneSec : from;
        e.words = words;
        throw e;
      }
      return { words, wallSec: secs(t0), bytes, pieces: pieces.length, codec: c.codec, doneSec: pcm.length / rate };
    },
  };
}
