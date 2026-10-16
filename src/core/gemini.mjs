// Gemma through Google's Gemini API (Smart mode), without Node imports: the browser calls
// it with the user's own key, and server-proxy calls it with the project's key. Only the
// task's messages are sent: the transcript text of a shortlisted clip, never audio or video.
//
// Gemma on the Gemini API does not support every Gemini feature on every model (JSON mode,
// system instructions and thinking settings have differed between Gemma 3 and Gemma 4), so
// a request that is refused for a feature is retried once without it, and the answer is
// read with the same tolerant parser the in-browser models use.

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** The request body for messages [{ role: "system" | "user", content }]. */
export function geminiBody(messages, { schema, maxTokens = 256, temperature = 0.2, features = {} } = {}) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const user = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n\n");
  const useSystem = features.system !== false && system;
  const body = {
    contents: [{ role: "user", parts: [{ text: useSystem || !system ? user : `${system}\n\n${user}` }] }],
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (useSystem) body.systemInstruction = { parts: [{ text: system }] };
  if (features.json !== false && schema) {
    body.generationConfig.responseMimeType = "application/json";
    body.generationConfig.responseSchema = toGeminiSchema(schema);
  }
  if (features.thinking !== false) body.generationConfig.thinkingConfig = { thinkingLevel: "minimal" };
  return body;
}

/** JSON Schema -> the OpenAPI subset the Gemini API takes (no minimum/maximum on integers there, enums as strings). */
export function toGeminiSchema(s) {
  if (!s || typeof s !== "object") return s;
  const out = {};
  if (s.type) out.type = String(s.type).toUpperCase();
  if (s.enum) out.enum = s.enum.map(String);
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.propertyOrdering = Object.keys(s.properties);
  }
  if (s.required) out.required = s.required;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.minItems != null) out.minItems = String(s.minItems);
  if (s.maxItems != null) out.maxItems = String(s.maxItems);
  return out;
}

/** The answer's text (thought parts left out) and token counts. */
export function readGemini(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  const u = json?.usageMetadata || {};
  return { text, finish: json?.candidates?.[0]?.finishReason ?? null, promptTokens: u.promptTokenCount ?? null, outTokens: u.candidatesTokenCount ?? null, thoughtTokens: u.thoughtsTokenCount ?? null };
}

/** Which feature a 400 error message complains about, or null. */
export function refusedFeature(message) {
  const m = String(message || "").toLowerCase();
  if (/json mode|response_?mime|response_?schema|responseschema|responsemimetype/.test(m)) return "json";
  if (/system.?instruction|developer instruction/.test(m)) return "system";
  if (/thinking/.test(m)) return "thinking";
  return null;
}

/**
 * One generateContent call. fetchImpl defaults to the global fetch. Returns
 * { text, finish, promptTokens, outTokens, wallSec, features } where features says what
 * the model accepted, so the caller can reuse it. Throws an Error with .status and .hint.
 */
export async function geminiGenerate({ key, model, messages, schema, maxTokens, temperature, features = {}, fetchImpl = globalThis.fetch, signal, base = GEMINI_BASE }) {
  const feats = { ...features };
  const t0 = Date.now();
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetchImpl(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(geminiBody(messages, { schema, maxTokens, temperature, features: feats })),
      signal,
    });
    const body = await res.text();
    let json = null;
    try {
      json = JSON.parse(body);
    } catch {}
    if (res.ok) return { ...readGemini(json), wallSec: +((Date.now() - t0) / 1000).toFixed(2), features: feats };
    const message = json?.error?.message || body.slice(0, 200) || `HTTP ${res.status}`;
    const feature = res.status === 400 ? refusedFeature(message) : null;
    if (feature && feats[feature] !== false) {
      feats[feature] = false;
      continue;
    }
    const err = new Error(`Gemini API ${res.status}: ${message}`);
    err.status = res.status;
    err.hint =
      res.status === 429
        ? "The free Gemma quota is used up for now (about 30 requests a minute). Wait a minute, or switch to Private mode."
        : res.status === 400 && /api key/i.test(message)
          ? "The API key was not accepted. Paste a key from Google AI Studio (aistudio.google.com/apikey)."
          : res.status === 403
            ? "This key cannot use the Gemini API. Check it in Google AI Studio."
            : res.status === 404
              ? `The model ${model} is not served right now. Try another Gemma model.`
              : "Try again in a minute, or switch to Private mode.";
    throw err;
  }
  throw Object.assign(new Error("The Gemini API refused every request shape."), { hint: "Switch to Private mode." });
}
