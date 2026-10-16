// Faithful cuts: when the check says a cut may change what the speaker meant
// ("check" or "misleading"), one plain line sits on the card, with the fix
// when there is one. It never blocks approval and it is not an alarm: it is
// Gemma's note, in the model's blue, as quiet as the reason on the slate.

/** The note to show for a clip, or null when the cut is faithful (or not checked). */
export function faithOf(c) {
  const f = c?.faithful;
  if (!f || !f.note || (f.verdict !== "check" && f.verdict !== "misleading")) return null;
  // once the clip covers the fix, the note has been dealt with
  const fx = f.fix;
  if (fx && (fx.start == null || c.start <= fx.start + 0.05) && (fx.end == null || c.end >= fx.end - 0.05)) return null;
  return f;
}

export default function FaithNote({ clip, onFix }) {
  const f = faithOf(clip);
  if (!f) return null;
  const fixLabel = f.fix ? f.fix.label || (f.fix.end != null && f.fix.end > clip.end ? "Include the next sentence" : f.fix.start != null && f.fix.start < clip.start ? "Include the sentence before" : "Use the suggested cut") : null;
  return (
    <div className={"faith is-" + f.verdict} role="note" aria-label="About this cut">
      <svg className="faith-mark" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="4" cy="12" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="12" cy="12" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5.6 10.4L11 2.5M10.4 10.4L5 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <p className="faith-text">{f.note}</p>
      {f.fix && (
        <button type="button" className="faith-fix" onClick={() => onFix(f.fix)}>
          {fixLabel}
        </button>
      )}
    </div>
  );
}
