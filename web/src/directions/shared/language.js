// The language and transcript-quality decision, reduced to one plain question.
//
// Whatever the numbers say, the person only has to answer one thing they can
// know by ear: is this video in English? Yes re-listens in English with the
// model that copes better with accents; No asks which language, then re-listens
// in that one. Everything else (whisper's guess, the confidence figures, the
// words it could not make out) is evidence, shown on request or in place.
import { useEffect, useState } from "react";
import { LANGUAGES, languageName } from "../../lib/languages.js";

// Measured on this laptop (notes/timings.md): small.en runs at about 1.86x real
// time, multilingual base at about 3x. Rounded down to stay honest.
const SPEED = { "small.en": 1.8, base: 2.8, small: 1.2 };

function minutes(sec) {
  if (!Number.isFinite(sec)) return null;
  const m = Math.max(1, Math.round(sec / 60));
  return m === 1 ? "about a minute" : `about ${m} minutes`;
}

export function languageQuestion(job, words = []) {
  const lang = job?.language || {};
  const q = job?.transcriptQuality || {};
  const used = lang.used || job?.settings?.language || "en";
  const detected = lang.detected || null;
  const dur = job?.source?.duration || 0;
  const low = words.length ? words.filter((w) => w.p < 0.5).length / words.length : q.lowShare ?? 0;
  const share = q.lowShare ?? low;
  const inTen = Math.min(9, Math.max(1, Math.round(share * 10)));
  const yesModel = q.suggest?.asrModel || "small.en";

  // Whose language did Selects listen in, and why: in words, not numbers.
  const heardAs = languageName(used);
  const guess = detected && detected.code !== "en" ? languageName(detected.code) : null;
  const evidence = guess
    ? `Selects listened in ${heardAs}, because whisper's quick guess said so. It could not make out about ${inTen} in every 10 words.`
    : `Selects listened in ${heardAs}. It could not make out about ${inTen} in every 10 words.`;

  // Choices for "No": whisper's guess first, then the languages this project's
  // users speak most, then everything else in a list.
  const first = [];
  for (const c of [used !== "en" ? used : null, detected?.code !== "en" ? detected?.code : null, "yo", "ig", "ha", "fr"]) {
    if (c && !first.includes(c)) first.push(c);
  }
  const quick = first.slice(0, 4).map((code) => ({ code, name: languageName(code), guess: code === detected?.code }));
  const rest = LANGUAGES.filter(([c]) => c !== "en" && !first.slice(0, 4).includes(c)).map(([code, name]) => ({ code, name }));

  // The stretch with the most unsure words: the best ten seconds to listen to.
  let sample = null;
  if (words.length) {
    let best = -1;
    for (let i = 0; i < words.length; i += 4) {
      let n = 0, j = i;
      while (j < words.length && words[j].s < words[i].s + 12) {
        if (words[j].p < 0.5) n++;
        j++;
      }
      if (n > best) {
        best = n;
        sample = { s: words[i].s, e: words[Math.max(i, j - 1)].e, i0: i, i1: j - 1, unsure: n };
      }
    }
  }

  return {
    question: "Is this video in English?",
    used,
    heardAs,
    guess,
    inTen,
    share,
    evidence,
    yes: {
      body: { language: "en", asrModel: yesModel },
      label: "Yes, it's English",
      after: `Selects listens again in English with the model that copes better with accents. ${cap(minutes(dur / SPEED["small.en"]) || "A few minutes")} on this laptop.`,
    },
    no: {
      label: "No, another language",
      after: "Pick the language. Selects listens again in it.",
    },
    quick,
    rest,
    sample,
    anyway: "Use this transcript anyway",
    anywayAfter: "The clips will be guesses.",
    verdict: q.verdict || null,
    numbers: q.meanP != null ? `Mean word confidence ${q.meanP.toFixed(2)}; ${Math.round(share * 100)}% of ${q.words ?? words.length} words below 0.5.` : null,
  };
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// The answer flow, shared so each direction only designs the look.
// step: "ask" -> "pick" (after No) -> "done" (an answer was given)
export function useLanguageAnswer() {
  const [step, setStep] = useState("ask");
  const [answer, setAnswer] = useState(null);
  const yes = (body) => {
    setAnswer({ ...body, name: "English" });
    setStep("done");
  };
  const no = () => setStep("pick");
  const pick = (code) => {
    setAnswer({ language: code, asrModel: "auto", name: languageName(code) });
    setStep("done");
  };
  const back = () => {
    setStep("ask");
    setAnswer(null);
  };
  return { step, answer, yes, no, pick, back };
}

export function useTicker(active, ms = 1000) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return n;
}
