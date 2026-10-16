// Text language ID on whisper's decoded samples. Two open models that fail differently
// from whisper's audio detector, because they only see the words:
//   lid-lite-608 (olaverse, fastText, 37 MB, Apache-2.0): 608 languages, run with the
//     WebAssembly build of fastText (npm fasttext.wasm.js), so no Python and no compiler.
//   lid-lite-5 (olaverse, TF-IDF and logistic regression, 1.1 MB JSON, Apache-2.0): English,
//     Hausa, Igbo, Nigerian Pidgin and Yoruba, in plain JavaScript (ng5.mjs).
// The fastText model takes about 225 MB of memory, so it runs in a short-lived child
// process: `node textlid.mjs <in.json>` prints the results as JSON.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { langidDir } from "../config.mjs";
import { run } from "../util.mjs";
import { iso3Of, toWhisperCode } from "./codes.mjs";
import { ng5Predict } from "./ng5.mjs";

const SELF = fileURLToPath(import.meta.url);

/** Where each text model should be, and whether it is there. */
export function textLidModels(dir = langidDir()) {
  const m608 = path.join(dir, "lid-lite-608", "model.ftz");
  const ng5 = path.join(dir, "lid-lite-5", "lid-lite-5.json");
  return { lid608: fs.existsSync(m608) ? m608 : null, ng5: fs.existsSync(ng5) ? ng5 : null };
}

/**
 * Read lid-lite-608's raw top-k into a verdict. Labels with no whisper language (and the
 * noise class) are dropped and the rest renormalised: the text came out of whisper, so it
 * is in one of whisper's languages. Nigerian Pidgin keeps its own label but maps to "en".
 * pairs: [[prob, "__label__eng_Latn"], ...]
 */
export function read608(pairs) {
  const kept = pairs.map(([p, l]) => ({ label: String(l).replace(/^__label__/, ""), p })).filter((x) => toWhisperCode(x.label));
  const sum = kept.reduce((a, x) => a + x.p, 0);
  if (!kept.length || sum <= 0) return null;
  const top = kept.slice(0, 3).map((x) => ({ label: x.label, p: +(x.p / sum).toFixed(3) }));
  const best = kept[0];
  const pcm = kept.find((x) => iso3Of(x.label) === "pcm");
  return { label: best.label, code: toWhisperCode(best.label), p: +(best.p / sum).toFixed(3), pcm: pcm ? +(pcm.p / sum).toFixed(3) : 0, top };
}

/** Run both text models on each text, in this process. Returns [{ lid608, ng5 }]. */
export async function identifyTextsHere(texts, { dir = langidDir() } = {}) {
  const models = textLidModels(dir);
  let ft = null;
  if (models.lid608) {
    try {
      const { getFastTextClass, getFastTextModule } = await import("fasttext.wasm.js");
      const FastText = await getFastTextClass({ getFastTextModule });
      ft = await new FastText().loadModel(pathToFileURL(models.lid608).href);
    } catch {
      ft = null; // package or model unusable: the signal is simply absent
    }
  }
  const ng5 = models.ng5 ? JSON.parse(fs.readFileSync(models.ng5, "utf8")) : null;
  return texts.map((t) => {
    const text = String(t || "").replace(/\s+/g, " ").trim(); // fastText reads one line
    if (!text) return { lid608: null, ng5: null };
    let lid608 = null;
    if (ft) {
      const v = ft.predict(text, 60, 0);
      const pairs = [];
      for (let i = 0; i < v.size(); i++) pairs.push(v.get(i));
      v.delete?.();
      lid608 = read608(pairs);
    }
    return { lid608, ng5: ng5 ? ng5Predict(ng5, text) : null };
  });
}

/**
 * Identify the language of each text in a child process. Returns { results, sec, models }
 * where models names the text models that were found. Never throws: when the models are
 * missing or the child fails, results are nulls and `error` says why.
 */
export async function identifyTexts(texts, { dir = langidDir(), tmpDir, signal } = {}) {
  const t0 = Date.now();
  const models = textLidModels(dir);
  const empty = texts.map(() => ({ lid608: null, ng5: null }));
  if (!models.lid608 && !models.ng5) return { results: empty, sec: 0, models: [], error: `no text language models in ${dir}` };
  const names = [models.lid608 && "lid-lite-608", models.ng5 && "lid-lite-5"].filter(Boolean);
  const inFile = path.join(tmpDir || dir, `textlid-${process.pid}-${Date.now()}.json`);
  try {
    fs.mkdirSync(path.dirname(inFile), { recursive: true });
    fs.writeFileSync(inFile, JSON.stringify({ texts, dir }));
    const r = await run(process.execPath, [SELF, inFile], { signal });
    return { results: JSON.parse(r.stdout), sec: +((Date.now() - t0) / 1000).toFixed(1), models: names };
  } catch (e) {
    if (e.name === "AbortError") throw e;
    return { results: empty, sec: +((Date.now() - t0) / 1000).toFixed(1), models: [], error: e.message };
  } finally {
    fs.rmSync(inFile, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const { texts, dir } = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  process.stdout.write(JSON.stringify(await identifyTextsHere(texts, { dir })));
}
