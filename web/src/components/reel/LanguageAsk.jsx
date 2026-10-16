// The language decision as one question a person can answer by ear: "Is
// this video in English?" The card plays ten seconds with whisper's own
// captions (unsure words in grey). If the words match what you hear, it is.
//
// Shown only when the language ensemble asked (job.language.question), when
// the transcript gate stopped the run, or when the person opens it to change
// the language. Yes confirms (nothing is transcribed again) or, after a stop,
// listens again in English with the model that copes better with accents.
// No offers the ensemble's runner-ups first, then any language.
import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api.js";
import { tc, aboutMinutes } from "../../lib/time.js";
import { usePlayer } from "../../lib/player.js";
import { useReducedMotion } from "../../lib/hooks.js";
import { LANGUAGES, languageName } from "../../lib/languages.js";
import { flatWords, useCues } from "../../lib/useCues.js";
import { Masthead } from "../../App.jsx";
import Card from "./Card.jsx";

// Measured on the build laptop (notes/timings.md): small.en at about 1.8x real time.
const SMALL_EN_SPEED = 1.8;

function signalSentence(s, used) {
  const name = s.verdict ? languageName(s.verdict) : null;
  const sure = s.p != null && s.kind === "audio" ? ` (${Math.round(s.p * 100)}% sure)` : "";
  const ruled = s.refuted ? " It was ruled out." : "";
  switch (s.id) {
    case "whisper-detect":
      return name ? `The first quick listen heard ${name}${sure}.${ruled}` : null;
    case "whisper-decode":
      return name ? `Short samples written out in each likely language made the most sense in ${name}${s.p < 1 ? ", but only just" : ""}.${ruled}` : null;
    case "text-608":
      return name ? `Reading those words, a language checker said ${name}.` : `A language checker found nothing to change the answer.`;
    case "text-ng5":
      return name ? `A checker for Nigerian languages said ${name}.` : null;
    default:
      return name ? `${s.id} says ${name}.` : null;
  }
}

/** The stretch where whisper was least sure, as the ten seconds to listen to. */
function worstStretch(words, lowP) {
  if (!words.length) return null;
  let best = null;
  for (let i = 0; i < words.length; i += 3) {
    let n = 0, j = i;
    while (j < words.length && words[j].s < words[i].s + 10) {
      if (words[j].p < lowP) n++;
      j++;
    }
    if (!best || n > best.n) best = { s: words[i].s, n };
  }
  // all sure: listen a little way in, past any intro
  if (!best.n) {
    const w = words.find((x) => x.s >= words[words.length - 1].e * 0.15) || words[0];
    return { s: w.s, n: 0 };
  }
  return best;
}

export default function LanguageAsk({ job, words, manual, onRetranscribed, onClose }) {
  const player = usePlayer();
  const reduce = useReducedMotion();
  const caps = useCues(job.id, words);
  const capWords = useMemo(() => flatWords(caps.cues), [caps.cues]);
  const lang = job.language || {};
  const ens = lang.ensemble || null;
  const q = lang.question || null;
  const tq = job.transcriptQuality || null;
  const used = lang.used || job.settings?.language || "en";
  const usedName = languageName(used === "auto" ? "en" : used);
  const stopped = job.stage === "error" && tq?.verdict === "unreliable";
  const [step, setStep] = useState("ask"); // ask | pick | sent
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [numbers, setNumbers] = useState(false);
  const [sent, setSent] = useState(null);

  const sample = useMemo(() => worstStretch(capWords, caps.lowP), [capWords, caps.lowP]);
  const dur = job.source?.duration || 0;
  const s0 = sample?.s ?? 0;
  const clip = { id: "sample", start: s0, end: Math.min(dur || s0 + 10, s0 + 10), render: { reframe: "fit" } };

  useEffect(() => {
    player.setWindow(clip.start, clip.end, { seek: true });
    if (!reduce) player.play();
  }, [clip.start]); // eslint-disable-line react-hooks/exhaustive-deps

  // The evidence, in words. Whisper's numbers sit behind "The numbers".
  const lines = useMemo(() => {
    const out = [];
    for (const s of ens?.signals || []) {
      const l = signalSentence(s, used);
      if (l) out.push(l);
    }
    if (!out.length && lang.detected && lang.detected.code !== used) out.push(`The first quick listen heard ${languageName(lang.detected.code)}.`);
    return out;
  }, [ens, lang.detected, used]);
  const unsureInTen = tq?.lowShare != null ? Math.min(9, Math.max(0, Math.round(tq.lowShare * 10))) : null;
  const lede = stopped
    ? `Selects stopped before finding clips, because it could not make out about ${unsureInTen ?? "half"} in every 10 words.`
    : ens?.confidence != null
    ? `Selects is ${Math.round(ens.confidence * 100)}% sure it's ${languageName(ens.language)}, but its checks did not all agree.`
    : `Selects listened in ${usedName}.`;

  // Other languages to offer: the ensemble's runner-ups first, then the most common here.
  const quick = useMemo(() => {
    const ranked = Object.entries(ens?.scores || {}).sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const order = [...(q?.choices || []), ...ranked, ...(lang.compared || []).map((c) => c.code), lang.detected?.code, "yo", "ha", "fr", "en"];
    const out = [];
    for (const c of order) if (c && c !== used && c !== "auto" && !out.includes(c)) out.push(c);
    return out.slice(0, 4).map((code) => ({ code, name: languageName(code), evidence: ranked.includes(code) || q?.choices?.includes(code) }));
  }, [ens, q, lang, used]);
  const rest = LANGUAGES.filter(([c]) => c !== used && !quick.some((x) => x.code === c));

  const retranscribe = async (body, name) => {
    setBusy(true);
    setErr(null);
    try {
      await api.setLanguage(job.id, body);
      setSent(name);
      setStep("sent");
      onRetranscribed?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const yes = async () => {
    if (q && !stopped) {
      setBusy(true);
      setErr(null);
      try {
        await api.setLanguage(job.id, { language: used, confirm: true });
        onClose?.(true);
      } catch (e) {
        setErr(e.message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (manual && !stopped) {
      onClose?.(false);
      return;
    }
    retranscribe({ language: used === "auto" ? "en" : used, asrModel: tq?.suggest?.asrModel || (used === "en" ? "small.en" : "auto") }, usedName);
  };
  const choose = (code) => retranscribe({ language: code }, languageName(code));
  const anyway = async () => {
    if (stopped) {
      setBusy(true);
      try {
        await api.resume(job.id, { force: true });
        onRetranscribed?.();
      } catch (e) {
        setErr(e.message);
      } finally {
        setBusy(false);
      }
    } else onClose?.(false);
  };

  useEffect(() => {
    const on = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || busy) return;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName)) return;
      const k = e.key.toLowerCase();
      if (step === "ask") {
        if (k === "y") {
          e.preventDefault();
          yes();
        } else if (k === "n") {
          e.preventDefault();
          setStep("pick");
        }
      } else if (step === "pick") {
        const n = Number(k);
        if (n >= 1 && n <= quick.length) {
          e.preventDefault();
          choose(quick[n - 1].code);
        } else if (k === "escape") setStep("ask");
      }
      if (k === " " && e.target?.tagName !== "BUTTON") {
        e.preventDefault();
        player.toggle();
      }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  });

  const yesAfter = q && !stopped
    ? "Keep the transcript as it is."
    : manual && !stopped
    ? "Keep the transcript as it is."
    : `Listen again in ${usedName}${used === "en" ? ", with the model that copes better with accents" : ""}. ${dur ? `${aboutMinutes(dur / SMALL_EN_SPEED).replace(/^./, (c) => c.toUpperCase())} on this laptop.` : ""}`;

  return (
    <div className="reel is-ask">
      <Masthead job={job}>
        <span className="mast-note">{stopped ? "Stopped before finding clips" : "One question first"}</span>
      </Masthead>
      <main className="reel-stage">
        <section className="ask" aria-labelledby="ask-q">
          {step === "sent" ? (
            <div role="status">
              <h1 id="ask-q" className="ask-q">Listening again in {sent}.</h1>
              <p className="ask-why">Selects makes the transcript, the captions and the clips again. You can close this tab, and the progress shows here when you come back.</p>
            </div>
          ) : (
            <>
              <h1 id="ask-q" className="ask-q">Is this video in {usedName}?</h1>
              <p className="ask-why">Play these ten seconds. If the captions match what you hear, the answer is yes.</p>
            </>
          )}
        </section>
        {step !== "sent" && (
          <section className="ask-more" aria-label="Why Selects is asking">
              <h2 className="why-h">Why Selects is asking</h2>
              <p className="ask-lede">{lede}</p>
              {lines.length > 0 && (
                <ul className="ask-evidence">
                  {lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              )}
              <button type="button" className="linkish" aria-expanded={numbers} onClick={() => setNumbers((v) => !v)}>
                {numbers ? "Hide the numbers" : "Show the numbers"}
              </button>
              {numbers && (
                <dl className="ask-numbers mono">
                  {ens?.scores &&
                    Object.entries(ens.scores)
                      .sort((a, b) => b[1] - a[1])
                      .map(([c, v]) => (
                        <div key={c}>
                          <dt>Vote for {languageName(c)}</dt>
                          <dd>{v.toFixed(2)}</dd>
                        </div>
                      ))}
                  {(ens?.signals || []).map((s) => (
                    <div key={s.id}>
                      <dt>{s.id}</dt>
                      <dd>
                        {s.verdict || "no opinion"}
                        {s.p != null ? `, p ${s.p}` : ""}, weight {s.weight}
                        {s.refuted ? ", ruled out" : ""}
                      </dd>
                    </div>
                  ))}
                  {tq && (
                    <div>
                      <dt>Word confidence</dt>
                      <dd>
                        mean {tq.meanP?.toFixed(2)}, {Math.round((tq.lowShare || 0) * 100)}% under {caps.lowP}
                      </dd>
                    </div>
                  )}
                </dl>
              )}
          </section>
        )}

        <div className={"deck is-ask" + (step === "sent" ? " is-dim" : "")}>
          <div className="card">
            <Card job={job} clip={clip} player={player} cues={caps.cues} lowP={caps.lowP} label="Ten seconds with the captions Selects wrote">
              <span className="card-tag mono">
                {tc(clip.start)} to {tc(clip.end)}
              </span>
            </Card>
          </div>
        </div>

        <div className="reel-right">
        <section className="controls" aria-label="Answer">
          {step === "ask" && (
            <>
              <button type="button" className="decide is-approve" onClick={yes} disabled={busy}>
                <span className="keycap" aria-hidden="true">Y</span>
                <span className="decide-text">
                  <b>Yes, it's {usedName}</b>
                  <small>{yesAfter}</small>
                </span>
              </button>
              <button type="button" className="decide" onClick={() => setStep("pick")} disabled={busy}>
                <span className="keycap" aria-hidden="true">N</span>
                <span className="decide-text">
                  <b>No</b>
                  <small>Pick the right language</small>
                </span>
              </button>
              <p className="ask-anyway">
                <button type="button" className="linkish" onClick={anyway} disabled={busy}>
                  {stopped ? "Use this transcript anyway" : manual ? "Back" : "Decide later"}
                </button>{" "}
                {stopped ? "Gemma's picks will be guesses." : manual ? "" : "Selects uses " + usedName + " until you answer."}
              </p>
            </>
          )}
          {step === "pick" && (
            <>
              <h2 className="ask-which">Which language?</h2>
              {quick.map((l, i) => (
                <button key={l.code} type="button" className="decide is-lang" onClick={() => choose(l.code)} disabled={busy} autoFocus={i === 0}>
                  <span className="keycap" aria-hidden="true">{i + 1}</span>
                  <span className="decide-text">
                    <b>{l.name}</b>
                    {l.evidence && <small>Selects heard some {l.name}</small>}
                  </span>
                </button>
              ))}
              <label className="ask-other">
                <span>Another language</span>
                <select className="input select" defaultValue="" onChange={(e) => e.target.value && choose(e.target.value)} disabled={busy}>
                  <option value="" disabled>
                    Choose
                  </option>
                  {rest.map(([c, n]) => (
                    <option key={c} value={c}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="linkish" onClick={() => setStep("ask")}>
                <kbd>Esc</kbd> Back
              </button>
            </>
          )}
          {err && (
            <p className="field-error" role="alert">
              {err}
            </p>
          )}
        </section>
        </div>
      </main>
    </div>
  );
}
