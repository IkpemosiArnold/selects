// A stand-in for the Gemini API's generateContent, for tests and for trying Smart mode
// without a key: GEMINI_BASE=http://127.0.0.1:8788/v1beta node server-proxy/server.mjs
// It answers each Selects task with valid JSON whose scores come from the clip text's
// length (not a judgement), and refuses JSON mode the way Gemma 3 did, to exercise the retry.
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function createMockGemini({ refuseJson = true, log = () => {} } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const key = req.headers["x-goog-api-key"];
    const model = decodeURIComponent((req.url.match(/models\/([^:]+):generateContent/) || [])[1] || "");
    seen.push({ model, key, body });
    log(`${req.method} ${req.url}`);
    const reply = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-goog-api-key", "access-control-allow-methods": "POST" });
      return res.end();
    }
    if (!key || key === "bad") return reply(400, { error: { message: "API key not valid. Please pass a valid API key." } });
    if (model === "missing-model") return reply(404, { error: { message: `models/${model} is not found` } });
    if (refuseJson && body.generationConfig?.responseMimeType) return reply(400, { error: { message: `JSON mode is not enabled for models/${model}` } });
    const text = body.contents?.[0]?.parts?.[0]?.text || "";
    let answer;
    if (/Order every clip/.test(text)) {
      const letters = [...text.matchAll(/^Clip ([A-Z]) \(/gm)].map((m) => m[1]);
      answer = { ranking: letters.reverse().map((l) => ({ clip: l, reason: `Clip ${l} lands its point.` })) };
    } else if (/Sentence before the clip:/.test(text)) {
      answer = { clip_says: "Strength training is safe.", speaker_means: "Strength training is safe.", verdict: "faithful", issue: "none", extend: "none", note: "The clip keeps what the speaker meant." };
    } else if (/posting kit/i.test(text)) {
      answer = { title: "A clear point from the talk", caption: "One idea, said plainly.", hashtags: ["talks", "ideas", "learning"] };
    } else {
      const n = text.length;
      const s = (k) => 1 + ((n * k) % 5);
      answer = { hook: s(7), standalone: s(11), payoff: s(13), clarity: s(17), reason: "Opens on a claim and resolves it." };
    }
    reply(200, { candidates: [{ content: { parts: [{ text: "```json\n" + JSON.stringify(answer) + "\n```" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: Math.round(text.length / 4), candidatesTokenCount: 40 } });
  });
  return { server, seen };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8788);
  createMockGemini({ log: (l) => console.log(l) }).server.listen(port, () => console.log(`mock Gemini API on http://127.0.0.1:${port}/v1beta`));
}
