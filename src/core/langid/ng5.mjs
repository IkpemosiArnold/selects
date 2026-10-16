// olaverse/lid-lite-5: a TF-IDF and logistic-regression text classifier for the five
// main languages of Nigeria (English, Hausa, Igbo, Nigerian Pidgin, Yoruba). The weights
// are one JSON file (1.1 MB, Apache-2.0), so it runs in plain JavaScript. This follows
// the reference implementation in the olaverse library (LIDLite5.predict_scores).

/** Lowercase words and word bigrams, as the reference tokenizer (Python's \b\w+\b). */
export function ng5Features(text) {
  const words = String(text).toLowerCase().trim().match(/[\p{L}\p{N}_]+/gu) || [];
  const feats = [...words];
  for (let i = 0; i < words.length - 1; i++) feats.push(`${words[i]} ${words[i + 1]}`);
  return feats;
}

/**
 * Probabilities for each class: { eng, hau, ibo, pcm, yor } (summing to 1), or null for
 * empty text. model: the parsed lid-lite-5.json ({ classes, intercept, features }).
 */
export function ng5Predict(model, text) {
  const feats = ng5Features(text);
  if (!feats.length) return null;
  const counts = new Map();
  for (const f of feats) counts.set(f, (counts.get(f) || 0) + 1);
  const tfidf = [];
  for (const [f, c] of counts) {
    const ft = model.features[f];
    if (ft) tfidf.push([ft, (1 + Math.log(c)) * ft.idf]);
  }
  const scores = [...model.intercept];
  if (tfidf.length) {
    const norm = Math.sqrt(tfidf.reduce((a, [, v]) => a + v * v, 0)) || 1;
    for (const [ft, v] of tfidf) for (let i = 0; i < scores.length; i++) scores[i] += (v / norm) * ft.weights[i];
  }
  const max = Math.max(...scores);
  const exp = scores.map((s) => Math.exp(s - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  const out = {};
  model.classes.forEach((c, i) => (out[c] = +(exp[i] / sum).toFixed(4)));
  out.matched = tfidf.length; // how many of the text's words and bigrams the model knows
  return out;
}
