// Approve the best clips in one go (POST /api/jobs/:id/approve), for a long video
// with many clips. Clips the person skipped stay skipped.
import { useId, useState } from "react";
import "./many.css";

export default function TopN({ open, onApprove }) {
  const id = useId();
  const [n, setN] = useState(() => Math.min(10, open));
  const [busy, setBusy] = useState(false);
  if (open < 1) return null;
  const count = Math.max(1, Math.min(open, Math.floor(Number(n)) || 1));
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onApprove(count);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="topn" onSubmit={submit}>
      <label htmlFor={id}>Approve the best</label>
      <input id={id} className="input num" type="number" inputMode="numeric" min={1} max={open} value={n} onChange={(e) => setN(e.target.value)} />
      <button type="submit" className="btn btn-chip" disabled={busy}>
        Approve {count}
      </button>
      <small>Clips you skipped stay skipped.</small>
    </form>
  );
}
