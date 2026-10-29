// Why a clip is worth posting, first; the judge's critique or trim tip ("watch") behind a tap.
// lead false: the why is already on the slate, so only the critique is shown here.
export default function Why({ clip, lead = true }) {
  const why = clip.why || clip.reason;
  if (!why) return null;
  return (
    <>
      {lead && <p className="slate-reason">{why}</p>}
      {clip.watch && (
        <details className="watch">
          <summary>Watch for</summary>
          <p>{clip.watch}</p>
        </details>
      )}
    </>
  );
}
