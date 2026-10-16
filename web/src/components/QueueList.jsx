import { aboutMinutes, plural, tc } from "../lib/time.js";
import { estimateJob, clock } from "../lib/estimate.js";
import { MiddleTruncate } from "../App.jsx";

const KEY = { probing: "probe", transcribing: "transcribe", candidates: "candidates", judging: "judge", rendering: "render" };

// Seconds left for one queue item, from measured rates only. null = unknown.
function itemEstimate(item, job, rates, models, running) {
  const judgeN = job?.settings?.judgeN ?? 8;
  const model = job?.settings?.model;
  if (item.kind === "render") {
    const n = item.ids?.length ?? job?.approvedCount ?? 0;
    const e = estimateJob({ clips: n }, rates, models).render;
    return { sec: e, what: `Render ${plural(n, "clip")}`, parts: e != null ? null : "render speed not timed yet" };
  }
  const est = estimateJob({ duration: job?.source?.duration, judgeN, model }, rates, models);
  if (running && job) {
    const k = KEY[job.stage];
    const st = job.stages?.[k];
    if (k === "transcribe" && st?.etaSec != null) return { sec: est.judge != null ? st.etaSec + est.judge : null, what: "Find clips", now: `Transcribing, ${Math.round((st.progress || 0) * 100)}%` };
    if (k === "judge" && st?.etaSec != null) return { sec: st.etaSec, what: "Find clips", now: "Gemma is choosing" };
  }
  const sec = est.transcribe != null && est.judge != null ? est.transcribe + est.judge : null;
  let parts = null;
  if (sec == null) {
    if (!job?.source?.duration && est.judge != null) parts = `Gemma takes about ${Math.round(est.judge / 60)} min, and transcribing depends on the length`;
    else parts = "not timed yet";
  }
  return { sec, what: "Find clips", parts };
}

export default function QueueList({ queue, jobs, rates, models }) {
  if (!queue || !queue.items?.length) return null;
  const byId = Object.fromEntries(jobs.map((j) => [j.id, j]));
  let acc = 0;
  let known = true;
  return (
    <section className="queue" aria-labelledby="queue-h">
      <div className="queue-head">
        <h2 id="queue-h" className="h-18">Overnight queue</h2>
        <p className="dim">One video at a time. You can close the laptop lid, and each video carries on from its last finished step.</p>
      </div>
      <ol className="queue-list">
        {queue.items.map((item, i) => {
          const job = byId[item.jobId];
          const running = queue.running && queue.running.jobId === item.jobId && queue.running.kind === item.kind;
          const e = itemEstimate(item, job, rates, models, running);
          if (e.sec != null && known) acc += e.sec;
          else known = false;
          const finish = known ? clock(acc) : null;
          return (
            <li key={item.jobId + item.kind} className={"q-row" + (running ? " is-running" : "")}>
              <span className="q-state mono">{running ? "Now" : i === (queue.running ? 1 : 0) ? "Next" : "Then"}</span>
              <a className="q-name" href={`#/job/${item.jobId}`} title={job?.source?.path}>
                <MiddleTruncate text={job?.source?.name || item.jobId} />
              </a>
              <span className="q-what">
                {e.what}
                {job?.source?.duration ? <span className="mono dim"> {tc(job.source.duration)}</span> : null}
                {e.now ? <span className="dim">. {e.now}</span> : null}
              </span>
              <span className="q-eta">
                {e.sec != null ? (
                  <>
                    {aboutMinutes(e.sec)}
                    {finish && <span className="mono dim"> done by {finish}</span>}
                  </>
                ) : (
                  <span className="dim">{e.parts}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="queue-foot dim">
        {rates?.samples
          ? `Times come from ${plural(rates.samples, "earlier video")} on this laptop.`
          : "Times show once this laptop has finished a video. Selects does not guess them."}
      </p>
    </section>
  );
}
