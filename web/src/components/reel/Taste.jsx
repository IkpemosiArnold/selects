// Taste: Selects learns what this person posts from their Post and Skip answers
// (src/core/taste.mjs). One quiet line says how many answers it has; what it does and a way
// to forget them sit behind a tap. The answers stay on this device, as numbers only.
import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.js";
import { tasteLine } from "../../../../src/core/taste.mjs";

/** The answers so far ({ n, posts, skips, active, weight, need }), and a refresh after each one. */
export function useTaste() {
  const [taste, setTaste] = useState(null);
  const refresh = useCallback(() => {
    if (!api.taste) return;
    api.taste().then(setTaste).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);
  const reset = useCallback(async () => {
    if (!api.resetTaste) return;
    setTaste(await api.resetTaste());
  }, []);
  return { taste, refresh, reset };
}

/** The short form, for a row with little room: "Learning from your 12 picks" or "3 picks so far". */
export function tasteShort(s) {
  if (!s?.n) return null;
  return s.active ? tasteLine(s) : `${s.n} pick${s.n === 1 ? "" : "s"} so far`;
}

/** The line with what it means and a way to forget the answers (behind a tap on the phone). */
export function TasteNote({ taste, onReset, heading = true }) {
  const [sure, setSure] = useState(false);
  const line = tasteLine(taste);
  return (
    <div className="taste-note">
      {heading && <h3 className="why-h">Your taste</h3>}
      <p>{line ? `${line}.` : "Post or Skip each clip. Selects learns what you post."}</p>
      <p className="taste-small">Your answers stay on this device, as numbers only. They change the order once there are 8, with both kinds.</p>
      {taste?.n > 0 && onReset &&
        (sure ? (
          <p className="taste-small">
            <button type="button" className="linkish inline" onClick={() => onReset().finally(() => setSure(false))}>Forget all {taste.n}</button>{" "}
            <button type="button" className="linkish inline" onClick={() => setSure(false)}>Keep them</button>
          </p>
        ) : (
          <button type="button" className="linkish inline taste-small" onClick={() => setSure(true)}>Forget my picks</button>
        ))}
    </div>
  );
}
