// The clapperboard: a black slate with the take written on it in chalk: why the clip is
// worth posting first, then its opening line.
// Its clap stick is the one orchestrated motion in Selects: it snaps shut
// when a clip is marked Post. Everything else on the page stays still.
import { forwardRef } from "react";
import { tc } from "../../lib/time.js";
import { rubricFor } from "./util.js";
import Why from "./Why.jsx";

function Pips({ n }) {
  return (
    <span className="pips" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((k) => (
        <i key={k} className={k <= n ? "on" : ""} />
      ))}
    </span>
  );
}

const Slate = forwardRef(function Slate({ clip, line, total, onLineClick }, stickRef) {
  const dur = Math.round(clip.end - clip.start);
  const status = clip.status;
  const long = line.length > 90 ? " is-long" : line.length > 54 ? " is-mid" : "";
  // why the clip is worth posting leads; the clip's opening line follows it
  const why = clip.why || clip.reason || null;
  return (
    <section className={"slate is-" + status} aria-label={`Slate for clip ${clip.rank ?? ""}`}>
      <div className="slate-clap" aria-hidden="true">
        <div className="slate-stick" ref={stickRef} />
        <div className="slate-hinge" />
        <div className="slate-stick slate-stick-base" />
      </div>
      <div className="slate-board">
        <dl className="slate-fields">
          <div>
            <dt>Clip</dt>
            <dd>
              {clip.rank ?? "+"}
              <small> of {total}</small>
            </dd>
          </div>
          <div className={clip.trimmed ? "is-mine" : ""}>
            <dt>In</dt>
            <dd>{tc(clip.start)}</dd>
          </div>
          <div className={clip.trimmed ? "is-mine" : ""}>
            <dt>Out</dt>
            <dd>{tc(clip.end)}</dd>
          </div>
          <div className={clip.trimmed ? "is-mine" : ""}>
            <dt>Length</dt>
            <dd>
              {dur}
              <small> s</small>
            </dd>
          </div>
        </dl>
        {why && <p className="slate-lead">{why}</p>}
        <button type="button" className={"slate-line" + (why ? " is-quote" : long)} onClick={onLineClick} title="Open the script to trim, T">
          {line}
        </button>
        {status !== "proposed" && (
          <p className={"slate-mark is-" + status}>{status === "approved" ? "Post" : "Skip"}</p>
        )}
      </div>
      {clip.reason && (
        <div className="slate-why">
          <Why clip={clip} lead={false} />
          {clip.scores && (
            <dl className="rubric">
              {rubricFor(clip.scores).map(([k, l]) => (
                <div key={k}>
                  <dt>{l}</dt>
                  <dd>
                    <Pips n={clip.scores[k]} />
                    <span className="rubric-n">{clip.scores[k]}</span>
                    <span className="sr-only"> of 5</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
      {!clip.reason && <p className="slate-reason is-yours">{clip.trimmed ? "Trimmed by you." : "Made by you."}</p>}
    </section>
  );
});

export default Slate;
