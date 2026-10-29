// The taste labels on the desktop and in the CLI: one local JSON file, never uploaded.
// Default ~/.selects/taste/labels.json; `--labels <file>` (job setting `labels`) points a job
// at another file, which it then both learns from and adds to.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectsHome } from "./config.mjs";
import { labelForStatus, labelRecord, tasteStatus, trainTaste, upsertLabel } from "./taste.mjs";
import { readJson, writeJsonAtomic } from "./util.mjs";

/** The labels file for a job's settings (or the default one). */
export function labelsFile(settings = null) {
  const p = settings?.labels;
  if (p) return path.resolve(String(p).replace(/^~(?=$|\/)/, os.homedir()));
  return path.join(selectsHome(), "taste", "labels.json");
}

/** The answers in a labels file ([] when it does not exist). Takes { labels: [...] } or a bare array. */
export function readLabels(file) {
  const j = readJson(file, null);
  const list = Array.isArray(j) ? j : Array.isArray(j?.labels) ? j.labels : [];
  return list.filter((x) => x && typeof x.k === "string" && x.f && (x.label === "post" || x.label === "skip"));
}

export function writeLabels(file, labels) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, { v: 1, note: "Selects taste labels: Post or Skip per clip, with the numbers each clip was ranked on. No words, no audio. Delete this file to forget them.", labels });
}

/**
 * Record a review decision: approved is a Post, skipped a Skip, proposed takes the answer
 * back. Returns the new status summary. Never throws (a decision must not fail on this).
 */
export function recordDecision(file, jobId, c, status, { by = "review" } = {}) {
  try {
    const label = labelForStatus(status);
    const labels = readLabels(file);
    const next = upsertLabel(labels, label ? labelRecord(jobId, c, label, { by }) : { k: `${jobId}:${c.id}`, label: null });
    writeLabels(file, next);
    return tasteStatus(next);
  } catch {
    return null;
  }
}

/** A clip saved or shared after rendering counts as a Post. */
export const recordPosted = (file, jobId, c) => recordDecision(file, jobId, c, "approved", { by: "download" });

/** Forget every answer in the file. */
export function resetLabels(file) {
  if (fs.existsSync(file)) fs.rmSync(file);
  return tasteStatus([]);
}

/** The fitted model for a labels file. */
export const tasteModel = (file) => trainTaste(readLabels(file));
