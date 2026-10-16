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
        <p className="label">Gemma's model</p>
        <p className="dim">There is no Gemma model on this laptop yet. Download one with <code>ollama pull gemma3:4b</code>, then reload.</p>
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
    ? `${cap(aboutMinutes(est))} for Gemma to read ${judgeN} moments on this laptop, ${Math.round(per)} s each.`
    : "Selects has not timed this model on this laptop yet. Your first job will.";
  const rtfText = rates?.rtf
    ? `Transcribing a 10-minute video takes ${aboutMinutes(600 / rates.rtf)} here.`
    : "Selects has not timed transcribing on this laptop yet.";
  return (
    <div className="model-control">
      <div className="mc-head">
        <label htmlFor={id} className="label">Gemma's model</label>
        <span className="mc-name mono">{m.name}</span>
      </div>
      <div className="mc-ends" aria-hidden="true">
        <span>Faster</span>
        <span>Better picks</span>
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
          aria-valuetext={`${m.name}, ${est ? aboutMinutes(est) + " to read the moments" : "not timed yet"}`}
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
      {m.sizeGb != null && <p className="mc-meta dim">Uses {m.sizeGb} GB of disk.</p>}
    </div>
  );
}
