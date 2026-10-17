// Small shared helpers: process spawning, atomic JSON, hashing, time formatting.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// time and name formatting live in format.mjs (no Node imports, so the browser build can use them)
export { slugify, srtTime, tc } from "./format.mjs";

/**
 * Run a command. Calls onStdout/onStderr with each chunk as it arrives.
 * Resolves { code, stdout, stderr }; rejects on non-zero exit unless allowFail.
 */
export function run(cmd, args, { onStdout, onStderr, signal, allowFail = false, keepOutput = true, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], signal, cwd });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      if (keepOutput) stdout += s;
      onStdout?.(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      // the tail is always kept: it is what the error message quotes ("No space left on device")
      stderr = (stderr + s).slice(keepOutput ? -20000 : -4000);
      onStderr?.(s);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || allowFail) resolve({ code, stdout, stderr });
      else {
        const err = new Error(`${path.basename(cmd)} exited with code ${code}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
        err.code = code;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

/** Write JSON atomically: write a temp file next to the target, then rename. */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
  } catch (e) {
    // a full disk leaves a half-written temp file; the target keeps its last good version
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Append one JSON line to a log file, creating its folder first. */
export function appendJsonLine(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(data) + "\n");
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

export function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}

/** Free disk space in GB for the volume holding dir. */
export function diskFreeGb(dir) {
  try {
    const st = fs.statfsSync(dir);
    return +((st.bavail * st.bsize) / 1e9).toFixed(1);
  } catch {
    return null;
  }
}
