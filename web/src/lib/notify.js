// "Notify me when it's done": a system notification when a job is ready to
// review, sent only when the person asked for it and the tab is in the
// background. Works the same against the local server and the in-browser engine.
import { useEffect, useRef, useState } from "react";

const KEY = (id) => `selects-notify-${id}`;

export function notifySupported() {
  return typeof Notification !== "undefined";
}

/** Whether the person asked to be told about this job, and a way to ask. */
export function useNotifyOptIn(jobId) {
  const read = () => {
    try {
      return notifySupported() && Notification.permission === "granted" && localStorage.getItem(KEY(jobId)) === "1";
    } catch {
      return false;
    }
  };
  const [on, setOn] = useState(read);
  const [denied, setDenied] = useState(() => notifySupported() && Notification.permission === "denied");
  const toggle = async () => {
    if (!notifySupported()) return;
    if (on) {
      try { localStorage.removeItem(KEY(jobId)); } catch {}
      setOn(false);
      return;
    }
    let p = Notification.permission;
    if (p === "default") p = await Notification.requestPermission();
    if (p !== "granted") {
      setDenied(true);
      return;
    }
    try { localStorage.setItem(KEY(jobId), "1"); } catch {}
    setOn(true);
  };
  return { on, denied, toggle, supported: notifySupported() };
}

/** Fires once when the job leaves the working stages, if the person opted in. */
export function useDoneNotice(job) {
  const last = useRef(job?.stage);
  useEffect(() => {
    if (!job) return;
    const was = last.current;
    last.current = job.stage;
    const working = ["queued", "probing", "language", "transcribing", "candidates", "judging", "rendering"];
    if (!working.includes(was) || working.includes(job.stage)) return;
    let wanted = false;
    try { wanted = localStorage.getItem(KEY(job.id)) === "1"; } catch {}
    if (!wanted || !notifySupported() || Notification.permission !== "granted" || !document.hidden) return;
    const name = job.source?.name || "Your video";
    const n = job.candidates?.length || 0;
    const body =
      job.stage === "error"
        ? `${name} stopped. Open Selects to see why.`
        : was === "rendering"
        ? `${name}: your clips are rendered.`
        : job.settings?.mode === "caption"
        ? `${name}: the captions are ready to check.`
        : `${name}: ${n === 1 ? "1 clip is" : `${n} clips are`} ready to check.`;
    try {
      const note = new Notification("Selects", { body, tag: job.id });
      note.onclick = () => {
        window.focus();
        note.close();
      };
    } catch {}
    try { localStorage.removeItem(KEY(job.id)); } catch {}
  }, [job?.stage]); // eslint-disable-line react-hooks/exhaustive-deps
}
