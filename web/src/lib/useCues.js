// The job's caption cues (captions.json): what every render burns in. The
// reel plays them over the clip, and the trim view edits words through the
// same PUT the caption review uses, so a fix shows up everywhere.
import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { cuesFromWords } from "./burn.js";

export function useCues(jobId, words, version = 0) {
  const [state, setState] = useState({ cues: null, lowP: 0.5, edited: false, error: null });
  const [bump, setBump] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .getCaptions(jobId)
      .then((c) => alive && c?.cues && setState({ cues: c.cues, lowP: c.lowP ?? 0.5, edited: !!c.edited, error: null }))
      .catch((e) => alive && setState((s) => ({ ...s, error: e })));
    return () => {
      alive = false;
    };
  }, [jobId, version, bump]);

  // Before captions.json exists (or in demo data), chunk the words the way the render would.
  const cues = state.cues || (words?.length ? cuesFromWords(words) : []);

  // Replace the text of one word, keeping every other cue as it is.
  const editWord = useCallback(
    async (ci, wi, text) => {
      const list = state.cues;
      if (!list?.[ci]) throw new Error("The captions are still loading.");
      const next = list.map((c, i) => {
        if (i !== ci) return { s: c.s, e: c.e, text: c.text };
        const toks = (c.words?.length ? c.words.map((w) => w.w) : c.text.split(/\s+/)).slice();
        toks[wi] = text.trim();
        return { s: c.s, e: c.e, text: toks.filter(Boolean).join(" ") };
      });
      const res = await api.putCaptions(jobId, next);
      if (res?.cues) setState({ cues: res.cues, lowP: res.lowP ?? state.lowP, edited: true, error: null });
      else setBump((b) => b + 1);
    },
    [jobId, state.cues, state.lowP]
  );

  return { cues, lowP: state.lowP, edited: state.edited, loaded: !!state.cues, editWord, reload: () => setBump((b) => b + 1) };
}

/** Every caption word in time order, each knowing its cue and its place in it. */
export function flatWords(cues) {
  const out = [];
  cues.forEach((c, ci) => (c.words || []).forEach((w, wi) => out.push({ ...w, ci, wi })));
  return out;
}
