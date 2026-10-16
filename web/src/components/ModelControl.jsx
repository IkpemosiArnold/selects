import { useId } from "react";
import { aboutMinutes } from "../lib/time.js";

// Faster to Smarter: one control that picks the local model and says what it
// costs on this laptop. Only measured figures are shown; anything the server
// has not measured is labelled "not measured yet".
export default function ModelControl({ models, value, onChange, judgeN = 8, rates }) {
  const id = useId();
  if (!models?.length) {
    return (
      <div className="model-control is-empty">
        <p className="label">Model</p>
        <p className="dim">No local model found yet. Pull one with <code>ollama pull gemma3:4b</code>, then reload.</p>
      </div>
    );
  }
  const sorted = [...models].sort((a, b) => (a.sizeGb ?? 0) - (b.sizeGb ?? 0));
  const idx = Math.max(0, sorted.findIndex((m) => m.name === value));
  const m = sorted[idx];
  const per = m.measuredSecPerCandidate;
  const est = per ? per * judgeN : null;
  const cap = (x) => x[0].toUpperCase() + x.slice(1);
  const timeText = est
    ? `${cap(aboutMinutes(est))} to judge ${judgeN} moments, at ${Math.round(per)} s each on this laptop.`
    : "Judge speed not measured yet on this laptop. The first run will time it.";
  const rtfText = rates?.rtf ? `Transcription runs at ${rates.rtf.toFixed(2)}x real time here.` : "Transcription speed not measured yet.";
  return (
    <div className="model-control">
      <div className="mc-head">
        <label htmlFor={id} className="label">Judge model</label>
        <span className="mc-name mono">{m.name}</span>
      </div>
      <div className="mc-ends" aria-hidden="true">
        <span>Faster</span>
        <span>Smarter</span>
      </div>
      <div className="mc-track" style={{ "--stops": sorted.length }}>
        <input
          id={id}
          type="range"
          min={0}
          max={sorted.length - 1}
          step={1}
          value={idx}
          disabled={sorted.length < 2}
          aria-valuetext={`${m.name}, ${est ? aboutMinutes(est) + " to judge" : "not measured yet"}`}
          onChange={(e) => onChange(sorted[Number(e.target.value)].name)}
        />
        <div className="mc-stops" aria-hidden="true">
          {sorted.map((s, i) => (
            <span key={s.name} className={i === idx ? "on" : ""} style={{ left: sorted.length > 1 ? `${(i / (sorted.length - 1)) * 100}%` : "0%" }} />
          ))}
        </div>
      </div>
      {sorted.length <= 3 && (
        <div className="mc-names mono" aria-hidden="true">
          {sorted.map((s, i) => (
            <button
              key={s.name}
              type="button"
              tabIndex={-1}
              className={i === idx ? "on" : ""}
              style={{ left: sorted.length > 1 ? `${(i / (sorted.length - 1)) * 100}%` : "0%" }}
              onClick={() => onChange(s.name)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <p className={"mc-time" + (est ? "" : " dim")}>{timeText}</p>
      <p className="mc-time dim">{rtfText}</p>
      <p className="mc-meta mono dim">{m.sizeGb != null ? `${m.sizeGb} GB` : ""}</p>
    </div>
  );
}
