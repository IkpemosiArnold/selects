// Faithful cuts, the pure parts (no Node imports, so the browser build shares them): does a
// clip still say what the speaker meant? A cheap rule check on the sentence after the clip
// and the words inside it, the model's messages and schema, reading its answer, the fix (grow
// the clip to the nearby sentence boundary) and the ranking rule (a misleading cut drops to
// the bottom until the person accepts it or applies the fix).
import { splitPrompt, tidyReason } from "./judge-core.mjs";
import { snapTrim, toSentences } from "./sentences.mjs";
import { byRank } from "./rank.mjs";

export const FAITHFUL_VERDICTS = ["faithful", "check", "misleading"];
export const FAITHFUL_ISSUES = ["turn", "quote", "sarcasm", "qualifier", "reference"];
const EXTENDS = ["none", "before", "after", "both"];
const AFTER = ["agrees", "adds", "limits", "reverses", "unrelated"];

// The sentence right after the clip turns the point around.
const TURN_NEXT = /^(but|however|although|though|yet|except|still|that said|having said that|and yet|on the other hand|then again|nevertheless|nonetheless|whereas|in reality|the (truth|reality|problem|catch|irony) is|(and |but )?(that'?s|this is|it'?s|that is) (just |simply |definitely |actually |really )?(not (true|right|the case|how|what)|wrong|a myth|nonsense|rubbish|false))\b/i;
// The clip itself ends on a line that sets up a turn ("that's what they say", "or so I thought").
const TURN_SETUP = /\b(that'?s what (they|people|everyone) (say|said|think|thought|tell you)|or so (they say|i thought|we thought|it seems)|in theory|supposedly|on paper|at least that'?s the idea)\W*$/i;
// The sentence after the clip limits the claim inside it.
const QUALIFIER_NEXT = /^(unless|only (if|when|for)|but only|at least|provided|as long as|in (some|most|many|certain) cases|for (some|most|many) (people|of us)|not (always|for everyone|in every case)|that'?s (only|not always)|to be fair|mind you|within reason|up to a point|with (one|some|a few) exceptions?)\b/i;
// The speaker reports someone else's view.
const QUOTE_IN = /\b(they (say|said|tell you|told (me|us)|think|believe|claim)|people (say|said|think|thought|believe|tell you|will tell you|assume)|some (people )?(argue|say|claim|think|believe)|(many|most|a lot of) people (think|believe|say|assume)|everyone (says|thinks|told me)|you('ll| will)? (often )?hear( people say)?|we('re| are| were| get) (always |often )?told|it('s| is) (often |commonly )?said|the (common|conventional|received) wisdom|the (popular|usual|standard) (view|idea|belief|line)|critics (say|argue)|the argument (is|goes)|according to|the myth (is|that)|so the story goes|i used to (think|believe))\b/i;
// Phrases that are usually ironic.
const SARCASM_IN = /\b(yeah,? right|oh,? sure|oh,? great|said no one|what could (possibly )?go wrong|because that('s| is| has) (worked|going|gone) (out )?so well)\b/i;
// The clip opens on a word that points back.
const REF_START = /^["'(]*(this|that|these|those|he|she|they|him|her|them)\b/i;

const firstWords = (s, n = 4) => String(s || "").trim().split(/\s+/).slice(0, n).join(" ");

/**
 * The cheap pre-check. Returns [{ issue, cue }]: what the rules noticed, in plain words.
 * before / after are the sentences around the clip (strings or null).
 */
export function faithfulHints({ text, before = null, after = null }) {
  const out = [];
  const t = String(text || "").trim();
  const sents = t.split(/(?<=[.!?]["')\]]?)\s+/);
  const first = sents[0] || "";
  const last = sents[sents.length - 1] || "";
  if (after && TURN_NEXT.test(after.trim())) out.push({ issue: "turn", cue: `the next sentence starts with "${firstWords(after, 3)}"` });
  else if (TURN_SETUP.test(last)) out.push({ issue: "turn", cue: `the clip ends on "${last.trim().split(/\s+/).slice(-5).join(" ")}"` });
  if (after && !out.some((h) => h.issue === "turn") && QUALIFIER_NEXT.test(after.trim())) out.push({ issue: "qualifier", cue: `the next sentence starts with "${firstWords(after, 3)}"` });
  const q = t.match(QUOTE_IN);
  if (q) out.push({ issue: "quote", cue: `the clip says "${q[0]}"` });
  const s = t.match(SARCASM_IN);
  if (s) out.push({ issue: "sarcasm", cue: `the clip says "${s[0]}"` });
  if (before && REF_START.test(first)) out.push({ issue: "reference", cue: `the clip opens with "${firstWords(first, 3)}"` });
  return out;
}

/**
 * The sentences around a clip: the one ending at or before its start and the one starting at
 * or after its end. A very short neighbour ("But." "Not really.") brings the next one along.
 * Returns { before: { s, e, text } | null, after: ... | null }.
 */
export function contextFor(sentences, c, { minWords = 6 } = {}) {
  const eps = 0.05;
  let bi = -1;
  let ai = -1;
  for (let i = 0; i < sentences.length; i++) {
    if (sentences[i].e <= c.start + eps) bi = i;
    if (ai < 0 && sentences[i].s >= c.end - eps) ai = i;
  }
  const words = (x) => x.text.trim().split(/\s+/).length;
  const join = (a) => (a.length ? { s: a[0].s, e: a[a.length - 1].e, text: a.map((x) => x.text).join(" ") } : null);
  const before = [];
  if (bi >= 0) {
    before.unshift(sentences[bi]);
    if (words(sentences[bi]) < minWords && bi > 0) before.unshift(sentences[bi - 1]);
  }
  const after = [];
  if (ai >= 0) {
    after.push(sentences[ai]);
    if (words(sentences[ai]) < minWords && ai + 1 < sentences.length) after.push(sentences[ai + 1]);
  }
  return { before: join(before), after: join(after) };
}

// The model answers a few narrow questions about the clip; a written rule (faithfulRule)
// turns the answers into the verdict. Asked for a verdict straight away, Gemma 3 4B called
// every test clip "misleading" (first prompt) or "check" (second prompt); narrow questions are
// easier for a small model, and the rule can be read and tested.
export const FAITHFUL_SCHEMA = {
  type: "object",
  properties: {
    last_point: { type: "string", maxLength: 140 },
    after: { type: "string", enum: AFTER },
    whose_view: { type: "string", enum: ["own", "others"] },
    sarcastic: { type: "string", enum: ["no", "yes"] },
    needs_before: { type: "string", enum: ["no", "yes"] },
    note: { type: "string", maxLength: 160 },
  },
  required: ["last_point", "after", "whose_view", "sarcastic", "needs_before", "note"],
};

/**
 * The written rule: the model's answers count only where the words back them up. Gemma 3 4B
 * answered "others" (someone else's view) and "needs the sentence before" for most clips, so
 * those two need the matching rule hint ("people say", a pointing word at the start). In order:
 *   turn: the model says the next sentence reverses the point, or the rules saw a turn
 *     ("But ...") and the model says it reverses or limits it: misleading. Either one alone: check.
 *   quote: someone else's view, with a rule hint: misleading when a turn follows, else check.
 *   sarcasm (the model says so), a limit just after the clip, a backed reference: check.
 */
export function faithfulRule(a, hints = []) {
  const has = (k) => hints.some((h) => h.issue === k);
  const reverses = a.after === "reverses";
  const turnNext = reverses || (has("turn") && a.after === "limits");
  if (has("turn") && turnNext) return { verdict: "misleading", issue: "turn" };
  if (has("quote") && a.whose_view === "others") return { verdict: turnNext || has("turn") ? "misleading" : "check", issue: "quote" };
  if (reverses || has("turn")) return { verdict: "check", issue: "turn" };
  if (a.sarcastic === "yes") return { verdict: "check", issue: "sarcasm" };
  if (a.after === "limits" || has("qualifier")) return { verdict: "check", issue: "qualifier" };
  if (has("quote")) return { verdict: "check", issue: "quote" };
  if (has("reference") && a.needs_before === "yes") return { verdict: "check", issue: "reference" };
  return { verdict: "faithful", issue: null };
}

/** The hint line the model gets, or "" when the rules noticed nothing. */
export function hintLine(hints) {
  if (!hints?.length) return "";
  return `A quick rule check noticed: ${hints.map((h) => `${h.cue} (possible ${h.issue})`).join("; ")}. Decide for yourself whether it changes the meaning.`;
}

/** The faithful check's chat messages, from the split prompts/faithful.md. */
export function faithfulMessages(prompt, { text, before, after, hints }) {
  const user = prompt.user
    .replace("{{before}}", before ? before.trim() : "(the clip starts at the beginning of the video)")
    .replace("{{text}}", String(text).trim())
    .replace("{{after}}", after ? after.trim() : "(the clip runs to the end of the video)")
    .replace("{{hints}}", hintLine(hints))
    .replace(/\n{3,}/g, "\n\n");
  return [
    { role: "system", content: prompt.system },
    { role: "user", content: user },
  ];
}

export const faithfulPrompt = (md) => splitPrompt(md, "prompts/faithful.md");

const DEFAULT_NOTES = {
  turn: "The speaker turns the point right after the clip ends, so the clip may say the opposite of what they meant.",
  quote: "The speaker may be describing someone else's view here, not their own.",
  sarcasm: "This may be sarcastic, and the setup that shows it is outside the clip.",
  qualifier: "A condition that limits this claim comes just after the clip.",
  reference: "The clip points to something said just before it.",
};

/**
 * Read the model's answer (parsed object or raw, maybe cut-off text) into
 * { verdict, issue, extend, note }, or null when there is no verdict in it.
 */
export function readFaithful(answer, hints = []) {
  let d = answer && typeof answer === "object" ? answer : null;
  if (!d) {
    const s = String(answer ?? "");
    const pick = (k) => s.match(new RegExp(`"${k}"\\s*:\\s*"([^"]*)`))?.[1] ?? null;
    d = Object.fromEntries(["issue", "verdict", "extend", "note", "last_point", "after", "whose_view", "sarcastic", "needs_before"].map((k) => [k, pick(k)]));
  }
  const low = (x) => String(x ?? "").toLowerCase().trim();
  let verdict = low(d.verdict);
  let issue = low(d.issue);
  let answers = null;
  if (!FAITHFUL_VERDICTS.includes(verdict)) {
    // the question form: the rule decides
    if (!AFTER.includes(low(d.after))) return null;
    answers = { after: low(d.after), whose_view: low(d.whose_view) === "others" ? "others" : "own", sarcastic: low(d.sarcastic) === "yes" ? "yes" : "no", needs_before: low(d.needs_before) === "yes" ? "yes" : "no" };
    ({ verdict, issue } = faithfulRule(answers, hints));
  }
  if (!FAITHFUL_ISSUES.includes(issue)) issue = null;
  let extend = low(d.extend || "none");
  if (!EXTENDS.includes(extend)) extend = "none";
  const out = { verdict, issue, extend, note: d.note ? tidyReason(d.note) : "" };
  // the schema caps text at 140 characters, which can cut the last word: drop it
  const clean = (x) => {
    let t = String(x || "").replace(/\s*[\u2014\u2013]\s*/g, ", ").replace(/\s+/g, " ").trim();
    if (t.length >= 95 && !/[.!?]$/.test(t)) t = t.replace(/\s+\S*$/, "").replace(/[,;:]$/, "");
    return t;
  };
  if (answers) out.answers = { lastPoint: clean(d.last_point), ...answers };
  if (d.clip_says || d.speaker_means) out.reading = { clip: clean(d.clip_says), speaker: clean(d.speaker_means) };
  return out;
}

/** A sentence, shortened to about 18 words, in quotes. */
const quoteOf = (t, n = 18) => {
  const ws = String(t || "").trim().split(/\s+/);
  return `"${ws.slice(0, n).join(" ")}${ws.length > n ? " ..." : ""}"`;
};

/** A plain note that quotes the words outside the clip that change its meaning, or null. */
export function evidenceNote(issue, { before, after, hints = [] } = {}) {
  const a = after?.text ?? after;
  const b = before?.text ?? before;
  const cue = (k) => hints.find((h) => h.issue === k)?.cue;
  if (issue === "turn" && a) return `Right after the clip, the speaker says ${quoteOf(a)}`;
  if (issue === "quote") {
    const said = cue("quote")?.replace(/^the clip says /, "") ?? null;
    if (said && a && hints.some((h) => h.issue === "turn")) return `The clip ends on what others think (${said}), and the speaker answers it next: ${quoteOf(a)}`;
    if (said) return `The speaker may be describing what others think (${said}), not their own view.`;
  }
  if (issue === "qualifier" && a) return `Right after the clip, the speaker adds ${quoteOf(a)}`;
  if (issue === "reference" && b) return `The clip points back to the sentence before it: ${quoteOf(b)}`;
  return null;
}

/** Which side to grow when the model gave no direction: a turn or a limit comes after, setup before. */
export function defaultExtend(issue, { before, after } = {}) {
  if (issue === "turn" || issue === "qualifier") return after ? "after" : "none";
  if (issue === "quote") return after ? "after" : before ? "before" : "none";
  if (issue === "sarcasm" || issue === "reference") return before ? "before" : "none";
  return "none";
}

/**
 * The suggested fix: grow the clip to the sentence boundary that resolves the issue, snapped
 * with snapTrim. Returns { start?, end? } (only the edges that move) or null when nothing
 * moves or the clip would grow past maxLen (default: 1.5 x the job's longest clip).
 */
export function faithfulFix(c, { extend, before, after, words, sentences, maxLen = 90 }) {
  if (!extend || extend === "none") return null;
  let start = c.start;
  let end = c.end;
  if ((extend === "before" || extend === "both") && before) start = before.s;
  if ((extend === "after" || extend === "both") && after) end = after.e;
  if (start === c.start && end === c.end) return null;
  if (words?.length) ({ start, end } = snapTrim(words, start, end, sentences ? { sentences } : {}));
  if (end - start > maxLen + 1e-6) return null;
  const fix = {};
  if (Math.abs(start - c.start) > 1e-3) fix.start = +start.toFixed(3);
  if (Math.abs(end - c.end) > 1e-3) fix.end = +end.toFixed(3);
  return Object.keys(fix).length ? fix : null;
}

/**
 * One candidate's faithful field from the rules and (when there was one) the model's answer.
 * Rules alone never call a clip misleading: a hint is a "check", no hint is "faithful".
 */
export function faithfulResult(c, { hints = [], answer = null, before = null, after = null, words = null, sentences = null, maxLen = 90, error = null } = {}) {
  let verdict;
  let issue;
  let extend;
  let note;
  let by;
  let reading = null;
  let answers = null;
  if (answer) {
    by = "model";
    ({ verdict, issue, extend, note } = answer);
    reading = answer.reading ?? null;
    answers = answer.answers ?? null;
    if (verdict === "faithful") {
      issue = null;
      extend = "none";
    } else if (!issue) issue = hints[0]?.issue ?? null;
  } else {
    by = "rules";
    issue = hints[0]?.issue ?? null;
    verdict = issue ? "check" : "faithful";
    extend = "none";
    note = issue ? `${hints[0].cue[0].toUpperCase()}${hints[0].cue.slice(1)}: check the clip still says what the speaker meant.` : "";
  }
  if (verdict !== "faithful" && (!extend || extend === "none")) extend = defaultExtend(issue, { before, after });
  // For a problem, the note quotes the words that show it, so the person can judge for
  // themselves; the model's own sentence about what the speaker means is kept as `meaning`.
  let meaning = null;
  if (verdict !== "faithful") {
    const ev = evidenceNote(issue, { before, after, hints });
    if (ev) {
      if (note && by === "model") meaning = note;
      note = ev;
    }
  }
  if (verdict !== "faithful" && !note) note = DEFAULT_NOTES[issue] || "Check the clip still says what the speaker meant.";
  const fix = verdict === "faithful" ? null : faithfulFix(c, { extend, before, after, words, sentences, maxLen });
  return {
    verdict,
    issue: issue ?? null,
    note: note || "The clip keeps what the speaker meant.",
    fix,
    by,
    hints: hints.map((h) => h.issue),
    ...(meaning ? { meaning } : {}),
    ...(reading ? { reading } : {}),
    ...(answers ? { answers } : {}),
    ...(error ? { error } : {}),
  };
}

/** True when a clip should sit below the others: misleading, not accepted, fix not applied. */
export const isDemoted = (c) => c?.faithful?.verdict === "misleading" && !c.faithful.accepted && !c.faithful.applied;

/**
 * Order ranked candidates for the person: misleading cuts drop below the rest (keeping their
 * order among themselves), everything else keeps the order rank() gives. Sets rank 1..n and
 * `demoted` on the ones that moved down. Does not mutate the input.
 */
export function orderByFaithful(cands) {
  return cands
    .map((c, i) => ({ c, i }))
    // the same order as rank() (the head-to-head order, then total, the pre-score and the
    // earlier start), with misleading cuts moved to the end
    .sort((a, b) => (isDemoted(a.c) ? 1 : 0) - (isDemoted(b.c) ? 1 : 0) || byRank({ ...a.c, start: a.c.start ?? 0 }, { ...b.c, start: b.c.start ?? 0 }) || a.i - b.i)
    .map(({ c }, i) => {
      const out = { ...c, rank: i + 1 };
      if (isDemoted(c)) out.demoted = true;
      else delete out.demoted;
      return out;
    });
}

/** Sentences for the context lookups, from words (speech only). */
export const sentencesFor = (words) => toSentences(words);
