// Honest time estimates, from what this laptop actually measured: finished
// stages of earlier jobs, and the per-model judge speed the server records.
// When nothing has been measured, functions return null and the UI says so.

const wall = (st) =>
  st?.status === "done" && st.startedAt && st.endedAt ? (Date.parse(st.endedAt) - Date.parse(st.startedAt)) / 1000 : null;

function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Rates measured on this laptop, from job summaries. */
export function measuredRates(jobs = []) {
  const rtf = [], judge = [], render = [];
  for (const j of jobs) {
    const d = j.source?.duration;
    const t = wall(j.stages?.transcribe);
    if (d && t > 5) rtf.push(d / t);
    const g = wall(j.stages?.judge);
    if (g > 5) judge.push(g / (j.settings?.judgeN || 8));
    const r = wall(j.stages?.render);
    const n = j.approvedCount ?? j.candidates?.filter((c) => c.render?.status === "done").length;
    if (r > 5 && n) render.push(r / n);
  }
  return { rtf: median(rtf), judgePerMoment: median(judge), renderPerClip: median(render), samples: rtf.length };
}

/** Seconds per stage for one job, or null where nothing was measured. */
export function estimateJob({ duration, judgeN = 8, model, clips = 0 }, rates, models = []) {
  const perMoment = models.find((m) => m.name === model)?.measuredSecPerCandidate ?? rates?.judgePerMoment ?? null;
  const transcribe = duration && rates?.rtf ? duration / rates.rtf : null;
  const judge = perMoment ? perMoment * judgeN : null;
  const render = clips && rates?.renderPerClip ? clips * rates.renderPerClip : null;
  return { transcribe, judge, render, perMoment };
}

export function clock(secFromNow) {
  if (secFromNow == null) return null;
  const d = new Date(Date.now() + secFromNow * 1000);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
