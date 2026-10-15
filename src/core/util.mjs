// Small shared helpers: process spawning, atomic JSON, hashing, time formatting.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
      if (keepOutput) stderr = (stderr + s).slice(-20000);
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
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
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

/** 761.4 -> "12:41" (or "1:02:41" past an hour). */
export function tc(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? `${h}:` : "") + `${mm}:${String(s).padStart(2, "0")}`;
}

/** 761.42 -> "00:12:41,420" for SRT. */
export function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(r).padStart(3, "0")}`;
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

export function slugify(s, max = 48) {
  return (
    String(s)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "clip"
  );
}
