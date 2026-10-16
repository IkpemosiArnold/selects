import { memo, useMemo } from "react";
import { tc, secs } from "../lib/time.js";
import { wordsIn } from "../lib/sentences.js";
import { usePlayerTime } from "../lib/player.js";

const RUBRIC = [
  ["hook", "Hook"],
  ["standalone", "Stands alone"],
  ["payoff", "Payoff"],
  ["clarity", "Clarity"],
];

function Score({ label, value }) {
  const v = Math.max(0, Math.min(5, Math.round(value ?? 0)));
  return (
    <div className="score">
      <dt>{label}</dt>
      <dd>
        <span className="pips" aria-hidden="true">
          {[1, 2, 3, 4, 5].map((i) => (
            <span key={i} className={i <= v ? "pip on" : "pip"} />
          ))}
        </span>
        <span className="mono score-n">{value ?? "?"}</span>
        <span className="sr-only"> out of 5</span>
      </dd>
    </div>
  );
}

// How a clip earned its rank, as the core computes it: the rubric total
// (judgeTotal), a cheap pre-score from the transcript and audio, blended
// 0.7 and 0.3, then a listwise final round over the top few.
function RankLedger({ c, settings = {} }) {
  const legacy = c.judgeTotal == null && c.total != null;
  const listOn = settings.listwise !== false && !legacy;
  const listN = settings.listN ?? 4;
  if (c.judgeTotal == null && c.pre == null && c.total == null) return null;
  const n = (v) => (v == null ? "not recorded" : v.toFixed(2));
  const cells = [
    ["Model", n(c.judgeTotal), "The rubric above, weighted: hook 35%, stands alone 30%, payoff 20%, clarity 15%."],
    ["Pre-score", n(c.pre), "Measured without a model: hook phrases, questions, numbers, pace, pauses and loudness."],
  ];
  if (listOn) cells.push(["Final round", c.listRank != null ? `${c.listRank} of ${listN}` : `outside the top ${listN}`, `The top ${listN} are shown to the model side by side and put in order.`]);
  cells.push(["Ranked by", n(c.total), null]);
  return (
    <div className="ledger">
      <dl className="ledger-row" aria-label="How this clip was ranked">
        {cells.map(([k, v, why]) => (
          <div key={k} className="ledger-cell" title={why || undefined}>
            <dt>{k}</dt>
            <dd className="mono">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="ledger-note">
        {legacy
          ? "This job was ranked before the pre-score blend and the final round were added, so only the total is on record."
          : `70% model and 30% pre-score${listOn ? `, then the top ${listN} compared side by side` : ""}.`}
        {c.listReason && (
          <>
            {" "}In that round: <q className="ledger-quote">{c.listReason}</q>
          </>
        )}
      </p>
    </div>
  );
}

// The transcript of the window, with in and out marks, plus a sentence or two
// of context either side that you can click to extend the clip to.
const Transcript = memo(function Transcript({ words, sentences, candidate, player, onExtend, onSeek }) {
  const t = usePlayerTime(player);
  const data = useMemo(() => {
    const inside = wordsIn(words, candidate.start - 0.01, candidate.end + 0.01).filter(
      (i) => words[i].s >= candidate.start - 0.05 && words[i].e <= candidate.end + 0.05
    );
    const before = sentences.filter((s) => s.e <= candidate.start + 0.05).slice(-2);
    const after = sentences.filter((s) => s.s >= candidate.end - 0.05).slice(0, 2);
    return { inside, before, after };
  }, [words, sentences, candidate.start, candidate.end]);

  const moved = player.playing || t > candidate.start + 0.15;
  const sentText = (s) => words.slice(s.i0, s.i1 + 1).map((w) => w.w).join(" ");
  const mine = candidate.trimmed;

  return (
    <div className="transcript">
      {data.before.map((s, k) => (
        <button key={"b" + s.i0} type="button" className="ctx" onClick={() => onExtend({ start: s.s })} title={`Start the clip here, at ${tc(s.s, { tenths: true })}`}>
          {sentText(s)}
          {k === data.before.length - 1 && <span className="ctx-hint"> Start here</span>}
        </button>
      ))}
      <span className={"mark mark-in mono" + (mine ? " is-mine" : "")}>In {tc(candidate.start, { tenths: true })}</span>
      <p className="tx-clip">
        {data.inside.map((i) => {
          const w = words[i];
          const on = moved && t >= w.s && t < (words[i + 1]?.s ?? w.e);
          return (
            <span key={i} className={on ? "tw is-on" : "tw"} onClick={() => onSeek(w.s)}>
              {w.w}{" "}
            </span>
          );
        })}
        {data.inside.length === 0 && <span className="dim">{candidate.text}</span>}
      </p>
      <span className={"mark mark-out mono" + (mine ? " is-mine" : "")}>Out {tc(candidate.end, { tenths: true })}</span>
      {data.after.map((s, k) => (
        <button key={"a" + s.i0} type="button" className="ctx" onClick={() => onExtend({ end: s.e })} title={`End the clip here, at ${tc(s.e, { tenths: true })}`}>
          {sentText(s)}
          {k === 0 && <span className="ctx-hint"> End after this</span>}
        </button>
      ))}
    </div>
  );
});

export default function Detail({ job, candidate, total, words, sentences, player, onDecide, onExtend, onPrev, onNext, busy, extra }) {
  if (!candidate) {
    return (
      <aside className="detail is-empty">
        <h2 className="h-24">No clips to review</h2>
        <p className="lede">
          The model did not find a moment that starts and ends on a full sentence within the length you asked for. Try a wider length range, or a smarter model.
        </p>
        <a className="btn" href="#/">Start a new job</a>
      </aside>
    );
  }
  const c = candidate;
  const len = c.end - c.start;
  const hookLen = (c.hook || "").length;
  const slateSize = hookLen > 110 ? "is-long" : hookLen > 64 ? "is-mid" : "";
  const status = c.status;

  return (
    <aside className="detail" aria-label={`Clip ${c.rank ?? ""}`}>
      <div className="detail-head">
        <p className="dh-meta mono">
          <span className="dh-rank">
            {c.rank != null ? (
              <>
                {c.rank}<span className="dim"> of {total}</span>
              </>
            ) : (
              <span className="dim">Not ranked</span>
            )}
          </span>
          <span>
            {tc(c.start)} <span className="dim">to</span> {tc(c.end)}
          </span>
          <span className={len < (job.settings?.minLen ?? 0) || len > (job.settings?.maxLen ?? 1e9) ? "is-off" : ""}>{secs(len)}</span>
        </p>
        <p className="dh-status">
          {status === "approved" && <span className="tag tag-yes">Approved</span>}
          {status === "skipped" && <span className="tag tag-no">Skipped</span>}
          {c.trimmed && <span className="tag tag-mine">Trimmed by you</span>}
        </p>
        <div className="dh-nav">
          <button type="button" className="btn btn-icon" onClick={onPrev} aria-label="Previous clip, K">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>
          </button>
          <button type="button" className="btn btn-icon" onClick={onNext} aria-label="Next clip, J">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>
          </button>
        </div>
      </div>

      <blockquote className={"slate " + slateSize + (status === "skipped" ? " is-cut" : "")}>
        <p>{c.hook || c.text?.slice(0, 120)}</p>
      </blockquote>

      {RUBRIC.some(([k]) => c.scores?.[k] != null) ? (
        <dl className="scores" aria-label="Rubric scores from the model">
          {RUBRIC.map(([k, label]) => (
            <Score key={k} label={label} value={c.scores?.[k]} />
          ))}
        </dl>
      ) : (
        <p className="dim">Not scored yet. The model has not judged this moment.</p>
      )}
      <RankLedger c={c} settings={job.settings} />

      <div className="reason">
        <p className="reason-by mono">Why {job.settings?.model || "the model"} picked it</p>
        <p className="reason-text">{c.reason || "The model did not give a reason for this one."}</p>
      </div>

      <Transcript words={words} sentences={sentences} candidate={c} player={player} onExtend={onExtend} onSeek={(t) => player.seek(t)} />

      {extra}

      <div className="decide">
        {status === "approved" ? (
          <>
            <button type="button" className="btn btn-approved" aria-pressed="true" onClick={() => onDecide("proposed")} disabled={busy}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
              Approved
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => onDecide("proposed")} disabled={busy}>Undo</button>
            <button type="button" className="btn btn-quiet" onClick={onNext}>Next clip <kbd>J</kbd></button>
          </>
        ) : status === "skipped" ? (
          <>
            <p className="skipped-note">Skipped. It will not be rendered.</p>
            <button type="button" className="btn btn-quiet" onClick={() => onDecide("proposed")} disabled={busy}>Undo</button>
            <button type="button" className="btn btn-quiet" onClick={onNext}>Next clip <kbd>J</kbd></button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary" onClick={() => onDecide("approved")} disabled={busy}>
              Approve clip <kbd>A</kbd>
            </button>
            <button type="button" className="btn" onClick={() => onDecide("skipped")} disabled={busy}>
              Skip <kbd>S</kbd>
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
