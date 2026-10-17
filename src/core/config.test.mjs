// config(): env first, then the user's config file, then per-user defaults and the PATH.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { config, findOnPath, modelsDir, selectsHome, whisperBin, whisperModel } from "./config.mjs";

const KEYS = ["SELECTS_DATA_DIR", "SELECTS_CONFIG", "SELECTS_HOME", "SELECTS_MODELS_DIR", "SELECTS_WHISPER_MODEL", "SELECTS_WHISPER_BIN", "SELECTS_HWACCEL", "PATH"];

function withEnv(env, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) if (k !== "PATH") delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  }
}

test("defaults live in the per-user data dir, never in a fixed machine path", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "selects-cfg-"));
  withEnv({ SELECTS_DATA_DIR: data, SELECTS_HOME: path.join(data, "home"), PATH: "" }, () => {
    const c = config();
    assert.equal(c.configFile, path.join(data, "config.json"));
    assert.equal(c.modelsDir, path.join(data, "models"));
    assert.equal(c.whisperModel, path.join(data, "models", "ggml-base.en.bin"));
    assert.equal(c.whisperBin, "whisper-cli", "not on the PATH: the bare name, so the error says what is missing");
    assert.equal(c.langidDir, path.join(data, "models", "langid"));
    assert.ok(Object.isFrozen(c));
    for (const v of Object.values(c)) assert.ok(!/road-to-\d+k|video-weekend/.test(String(v)), String(v));
    assert.ok(c.home.startsWith(data));
  });
});

test("env beats the config file, which beats the defaults", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "selects-cfg-"));
  fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ whisperBin: "/opt/w/whisper-cli", modelsDir: "~/m", home: "/srv/selects", hwaccel: "0" }));
  withEnv({ SELECTS_DATA_DIR: data }, () => {
    assert.equal(whisperBin(), "/opt/w/whisper-cli");
    assert.equal(modelsDir(), path.join(os.homedir(), "m"), "~ expands");
    assert.equal(selectsHome(), "/srv/selects");
    assert.equal(config().hwaccel, false);
    process.env.SELECTS_WHISPER_BIN = "/env/whisper-cli";
    process.env.SELECTS_HOME = "/env/home";
    assert.equal(whisperBin(), "/env/whisper-cli");
    assert.equal(selectsHome(), "/env/home");
  });
  // only a model path set: the models folder follows it (older setups)
  withEnv({ SELECTS_DATA_DIR: data, SELECTS_CONFIG: path.join(data, "none.json"), SELECTS_WHISPER_MODEL: "/x/models/ggml-small.en.bin" }, () => {
    assert.equal(modelsDir(), "/x/models");
    assert.equal(whisperModel(), "/x/models/ggml-small.en.bin");
  });
});

test("programs are found on the PATH", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selects-bin-"));
  const exe = path.join(dir, "whisper-cli");
  fs.writeFileSync(exe, "#!/bin/sh\n");
  fs.chmodSync(exe, 0o755);
  withEnv({ SELECTS_DATA_DIR: dir, PATH: dir }, () => {
    assert.equal(findOnPath("whisper-cli"), exe);
    assert.equal(config().whisperBin, exe);
    assert.equal(findOnPath("no-such-program-here"), null);
  });
});
