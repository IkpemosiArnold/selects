// A stand-in for an OpenAI-compatible whisper API (Groq's /openai/v1/audio/transcriptions),
// for tests and for trying Light mode without a key:
//   PORT=8789 node server-proxy/mock-whisper.mjs
//   ASR_PROVIDER=openai-compatible ASR_BASE=http://127.0.0.1:8789/openai/v1 ASR_API_KEY=test node server-proxy/server.mjs
// Like Groq, its word entries have no punctuation and the text has it.
//
// With MOCK_TRANSCRIPT (a JSON file of [{ w, s, e }] for a whole recording) and MOCK_SOURCE
// (that recording's audio), it answers each piece with the real words of the stretch it came
// from: the piece is decoded with ffmpeg and found in the recording by its loudness envelope.
// MOCK_SPEED (default 189, Groq's published speed factor for whisper-large-v3) sets how long
// it takes, so timing runs are realistic without a key. Used for notes/timings.md, "Light mode".
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FRAME = 800; // 50 ms at 16 kHz

function decode16k(file) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], { maxBuffer: 1 << 30 });
  return new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);
}

function envelope(pcm) {
  const out = new Float32Array(Math.floor(pcm.length / FRAME));
  for (let f = 0; f < out.length; f++) {
    let s = 0;
    for (let k = f * FRAME; k < (f + 1) * FRAME; k++) s += pcm[k] * pcm[k];
    out[f] = Math.log10(1 + s / FRAME);
  }
  return out;
}

/** Where a piece's envelope best matches the recording's (seconds), by mean absolute difference. */
export function locate(piece, whole) {
  let best = 0;
  let bestD = Infinity;
  const n = Math.min(piece.length, 600); // 30 s is plenty to place it
  for (let o = 0; o + n <= whole.length; o++) {
    let d = 0;
    for (let i = 0; i < n && d < bestD * n; i++) d += Math.abs(piece[i] - whole[o + i]);
    d /= n;
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return (best * FRAME) / 16000;
}

const bare = (w) => w.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");

export function createMockWhisper({ transcript = null, source = null, speed = 189, log = () => {} } = {}) {
  const seen = [];
  const whole = source ? envelope(decode16k(source)) : null;
  const server = http.createServer(async (req, res) => {
    const reply = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== "POST" || !req.url.endsWith("/audio/transcriptions")) return reply(404, { error: { message: "not found" } });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const form = await new Request("http://x", { method: "POST", headers: req.headers, body: Buffer.concat(chunks) }).formData();
    const file = form.get("file");
    const buf = Buffer.from(await file.arrayBuffer());
    const fields = Object.fromEntries([...form.entries()].filter(([k]) => k !== "file").map(([k]) => [k, form.getAll(k).join(",")]));
    seen.push({ auth: req.headers.authorization, name: file.name, type: file.type, bytes: buf.length, fields });
    log(`transcribe ${buf.length} bytes`);
    if (!transcript) {
      // canned: two words, no punctuation on the words, punctuation in the text
      return reply(200, { text: "Hello, world.", duration: 1.2, segments: [{ start: 0, end: 1.2, text: " Hello, world." }], words: [{ word: "Hello", start: 0.1, end: 0.5 }, { word: "world", start: 0.6, end: 1.1 }] });
    }
    const tmp = path.join(os.tmpdir(), `mock-whisper-${process.pid}-${seen.length}.${(file.name || "a.ogg").split(".").pop()}`);
    fs.writeFileSync(tmp, buf);
    let pcm;
    try {
      pcm = decode16k(tmp);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    const dur = pcm.length / 16000;
    const at = locate(envelope(pcm), whole);
    const ws = transcript.filter((w) => w.s >= at - 0.05 && w.e <= at + dur + 0.05);
    await new Promise((r) => setTimeout(r, 300 + (dur * 1000) / speed));
    reply(200, {
      text: ws.map((w) => w.w).join(" "),
      duration: +dur.toFixed(2),
      segments: [{ start: 0, end: dur, text: ws.map((w) => w.w).join(" ") }],
      words: ws.map((w) => ({ word: bare(w.w), start: +Math.max(0, w.s - at).toFixed(3), end: +Math.max(0, w.e - at).toFixed(3) })).filter((w) => w.word),
    });
  });
  return { server, seen };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8789);
  const transcript = process.env.MOCK_TRANSCRIPT ? JSON.parse(fs.readFileSync(process.env.MOCK_TRANSCRIPT, "utf8")) : null;
  const { server } = createMockWhisper({ transcript, source: process.env.MOCK_SOURCE || null, speed: Number(process.env.MOCK_SPEED || 189), log: (l) => console.log(l) });
  server.listen(port, () => console.log(`mock whisper on :${port}${transcript ? `, ${transcript.length} words` : ", canned"}`));
}
