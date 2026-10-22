// Where the work runs, for the hosted Selects Web (the browser engine). Private keeps
// everything in this tab; Smart sends the words of the shortlisted moments to Google's
// free Gemma API, with the person's own key or through the Selects proxy. The copy says
// exactly what leaves the device, and what downloads the first time.
import { useEffect, useState } from "react";
import { api, readEngineMode, saveEngineMode } from "../lib/api.js";

export const PRIVATE_LINE = "Everything runs in this tab. Nothing leaves your device.";
export const SMART_LINE = "The words from the shortlisted moments go to Google's free Gemma API, which may use them to improve its products. Your video never leaves your device.";
export const LIGHT_LINE = "Light mode sends your audio, not your video, to be transcribed.";
export const LAPTOP_LINE = "On a laptop, Selects can also blur faces and handle long videos.";

const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

/** The judge's name without the role in brackets: "Gemma 4 E2B (judge, WebGPU)" reads "Gemma 4 E2B". */
const plainLabel = (l) => String(l || "").replace(/\s*\(.*?\)\s*/g, " ").replace(/,\s*Q\d\w*/i, "").trim();

export function useEngine() {
  const [mode, setModeState] = useState(() => api.getMode?.() || { mode: "private" });
  const [dl, setDl] = useState(null);
  const [suggested, setSuggested] = useState(null);
  useEffect(() => {
    let alive = true;
    api.downloads?.().then((d) => alive && setDl(d)).catch(() => alive && setDl({ items: [], caps: null }));
    // Until the person picks a mode themselves: Light when the speech model is not in this
    // browser and Light can run, else Private. Asked twice: at once, then again when the proxy
    // has answered (a free server can take a minute to wake) with a speed probe on Safari
    const apply = (s) => {
      if (!alive || !s) return;
      setSuggested(s);
      if (readEngineMode()) return;
      const cur = api.getMode().mode;
      if (s.mode !== cur) setModeState(api.setMode(s.mode));
      else setModeState(api.getMode());
    };
    api.suggestMode?.().then(apply).then(() => api.suggestMode({ wait: true, probe: true })).then(apply).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const setMode = (next, opts) => {
    const m = api.setMode(next, opts);
    saveEngineMode(next);
    setModeState(m);
  };
  return { mode, setMode, downloads: dl, suggested };
}

export default function EnginePanel({ engine }) {
  const { mode, setMode, downloads, suggested } = engine;
  const smart = mode.mode === "smart";
  const light = mode.mode === "light";
  const [key, setKey] = useState("");
  const [groq, setGroq] = useState("");
  const caps = downloads?.caps;
  const judge = downloads?.items?.find((i) => i.id === "gemma4" || i.id === "gemma3");
  const whisper = downloads?.items?.find((i) => i.id === "whisper");
  const noRoute = smart && !mode.hasKey && !mode.proxyUrl;
  const useKey = () => {
    if (key.trim()) setMode("smart", { key: key.trim() });
    setKey("");
  };

  return (
    <fieldset className="engine">
      <legend className="field-label">Where Gemma runs</legend>
      <div className="seg seg-light seg-wide" role="radiogroup" aria-label="Where Gemma runs">
        {[["private", "Private"], ["light", "Light"], ["smart", "Smart"]].map(([m, l]) => (
          <button key={m} type="button" role="radio" aria-checked={mode.mode === m} className={"seg-btn" + (mode.mode === m ? " is-on" : "")} onClick={() => setMode(m)}>
            {l}
          </button>
        ))}
      </div>
      <p className="engine-line">{smart ? SMART_LINE : light ? LIGHT_LINE : PRIVATE_LINE}</p>

      {light ? (
        <div className="engine-smart">
          {mode.lightShared === false && !mode.hasGroqKey && (
            <p className="field-error" role="note">The free shared transcriber is not switched on yet, so Light mode needs your own free Groq key for now. Or use Private.</p>
          )}
          {suggested?.mode === "light" && suggested.reasons?.length > 0 && (
            <p className="field-hint">Chosen because {suggested.reasons.join(" and ")}. Private mode is one tap away.</p>
          )}
          <p className="field-hint">About half a megabyte of audio for a 4-minute video, instead of downloading a speech model. The words of the shortlisted moments then go to Google's free Gemma API, as in Smart mode.</p>
          {mode.hasGroqKey ? (
            <p className="field-hint">
              Using your Groq key, kept in this tab only.{" "}
              <button type="button" className="linkish inline" onClick={() => setMode("light", { groqKey: null })}>
                Forget the key
              </button>
            </p>
          ) : (
            <div className="engine-key">
              <label className="field">
                <span className="field-label">Your own free Groq key (optional)</span>
                <input
                  className="input mono"
                  type="password"
                  value={groq}
                  onChange={(e) => setGroq(e.target.value)}
                  placeholder="Paste a key from console.groq.com"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="done"
                />
              </label>
              <button className="btn" type="button" disabled={!groq.trim()} onClick={() => { setMode("light", { groqKey: groq.trim() }); setGroq(""); }}>Use this key</button>
              <p className="field-hint">{mode.lightShared === false ? "Make one free at console.groq.com, no card needed. It stays in this tab and goes only to Groq." : "Without a key, Selects uses its free shared transcriber, which does not keep the audio or the words. Your key stays in this tab and goes only to Groq."}</p>
            </div>
          )}
        </div>
      ) : smart ? (
        <div className="engine-smart">
          {mode.hasKey ? (
            <p className="field-hint">
              Using your Gemini key, kept in this tab only.{" "}
              <button type="button" className="linkish inline" onClick={() => setMode("smart", { key: null })}>
                Forget the key
              </button>
            </p>
          ) : (
            <div className="engine-key">
              <label className="field">
                <span className="field-label">Your own Gemini API key (optional)</span>
                <input
                  className="input mono"
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      useKey();
                    }
                  }}
                  placeholder="Paste a key from Google AI Studio"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="done"
                />
              </label>
              <button className="btn" type="button" disabled={!key.trim()} onClick={useKey}>Use this key</button>
              <p className="field-hint">
                {mode.proxyUrl
                  ? "Without a key, Selects uses its own key through a small server that does not keep the words. Your key stays in this tab and goes only to Google."
                  : "Your key stays in this tab and goes only to Google."}
              </p>
            </div>
          )}
          {noRoute && <p className="field-error" role="alert">Smart mode needs a Gemini key here. Paste one, or switch to Private.</p>}
          {whisper && <p className="field-hint">The first time, this browser downloads the speech model ({whisper.label.replace(/\s*\(.*\)/, "")}, {gb(whisper.bytes)}{whisper.size === "tiny" ? ", the smaller one for phones" : ""}) once.</p>}
        </div>
      ) : (
        downloads && (
          <div className="engine-private">
            {!judge && downloads.runtimes?.inTabJudge === false && (
              <p className="engine-dl">On this device, Private mode ranks clips without Gemma, which is too big for a phone's browser. Smart mode adds Gemma's judgment.</p>
            )}
            {judge && (
              <p className="engine-dl">
                <b>{plainLabel(judge.label)}, {gb(judge.bytes)}</b>, downloads once{whisper ? `, with the speech model (${plainLabel(whisper.label)}, ${gb(whisper.bytes)}${whisper.size === "tiny" ? ", the smaller one for phones" : ""})` : ""}.
              </p>
            )}
            {suggested?.estSec != null && !/already/.test(suggested.reasons?.[0] || "") && (
              <p className="field-hint">The speech model takes about {Math.max(1, Math.round(suggested.estSec / 60))} min to download on this connection{suggested.mbps ? ` (about ${suggested.mbps} Mbps)` : ""}.</p>
            )}
            <p className="field-hint">
              {caps?.webgpu
                ? "This browser can use the graphics chip (WebGPU), so Gemma runs there."
                : "This browser has no WebGPU, so Gemma 3 1B runs on the processor. It is smaller and slower."}
            </p>
          </div>
        )
      )}
      {caps && (!caps.crossOriginIsolated || !caps.webcodecs) && (
        <p className="field-error" role="alert">
          {!caps.webcodecs ? "This browser cannot read video in the page. Use a recent Chrome or Edge." : "This page is not isolated, so the models will run slowly. Reload it, or try Chrome or Edge."}
        </p>
      )}
    </fieldset>
  );
}
