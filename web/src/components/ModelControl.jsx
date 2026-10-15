import { useId } from "react";
import { aboutMinutes } from "../lib/time.js";

// Faster to Smarter: one control that picks the local model and says what it
// costs on this laptop, measured, rather than a generic label.
const MOMENTS_PER_SEC = 148 / 1864; // candidate windows per second of video, from real runs

export function estimateFor(model, duration) {
  if (!model?.measuredSecPerCandidate) return null;
  return model.measuredSecPerCandidate * Math.max(1, Math.round((duration || 1800) * MOMENTS_PER_SEC));
}

export default function ModelControl({ models, value, onChange, duration }) {
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
  const est = estimateFor(m, duration);
  const span = duration ? "for this video" : "for 30 minutes of video";
  const timeText = est
    ? `${aboutMinutes(est)[0].toUpperCase() + aboutMinutes(est).slice(1)} ${span}, measured on this laptop.`
    : "Not measured on this laptop yet. The first run will time it.";
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
          aria-valuetext={`${m.name}, ${est ? aboutMinutes(est) : "not measured yet"}`}
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
      <p className="mc-meta mono dim">
        {m.sizeGb != null ? `${m.sizeGb} GB` : ""}
        {m.measuredSecPerCandidate ? `   ${m.measuredSecPerCandidate} s per moment` : ""}
      </p>
    </div>
  );
}
