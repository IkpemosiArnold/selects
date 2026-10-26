// Why a clip is worth posting, first; the judge's critique or trim tip ("watch") behind a tap.
export default function Why({ clip }) {
  const why = clip.why || clip.reason;
  if (!why) return null;
  return (
    <>
      <p className="slate-reason">{why}</p>
      {clip.watch && (
        <details className="watch">
          <summary>Watch for</summary>
          <p>{clip.watch}</p>
        </details>
      )}
    </>
  );
}
