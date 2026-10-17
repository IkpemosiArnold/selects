// Faithful cuts (notes/CONTRACTS.md, "Faithful cuts"): when the check says a
// cut may change what the speaker meant ("check" or "misleading"), one plain
// line sits on the card, with the fix when there is one. It never blocks
// Approve and it is not an alarm: it is Gemma's note, in the model's blue.

/** The note to show for a clip, or null when the cut is faithful, settled or not checked. */
export function faithOf(c) {
  const f = c?.faithful;
  if (!f || !f.note || f.accepted || f.applied) return null;
  if (f.verdict !== "check" && f.verdict !== "misleading") return null;
  // a trim that already covers the fix settles it, as the core does
  const fx = f.fix;
  if (fx && (fx.start == null || c.start <= fx.start + 0.05) && (fx.end == null || c.end >= fx.end - 0.05)) return null;
  return f;
}

/** What taking the fix does, in words: only the edges that move. */
export function fixLabel(c, fx) {
  if (!fx) return null;
  const later = fx.end != null && fx.end > c.end + 0.05;
  const earlier = fx.start != null && fx.start < c.start - 0.05;
  if (later && earlier) return "Include the sentences around it";
  if (earlier) return "Include the sentence before";
  if (later) return "Include the next sentence";
  return "Use the suggested cut";
}

export default function FaithNote({ clip, onFix, onKeep }) {
  const f = faithOf(clip);
  if (!f) return null;
  return (
    <div className={"faith is-" + f.verdict} role="note" aria-label="About this cut">
      <svg className="faith-mark" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="4" cy="12" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="12" cy="12" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5.6 10.4L11 2.5M10.4 10.4L5 2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <p className="faith-text">{f.note}</p>
      <div className="faith-acts">
        {f.fix && (
          <button type="button" className="faith-fix" onClick={() => onFix(f)}>
            {fixLabel(clip, f.fix)}
          </button>
        )}
        {f.verdict === "misleading" && onKeep && (
          <button type="button" className="faith-keep" onClick={() => onKeep(f)}>
            Keep the cut
          </button>
        )}
      </div>
    </div>
  );
}
