import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { postingKit } from "./kit.mjs";

const clip = { id: "c_0003", start: 10, end: 40, text: "Strength comes back slowly. Show up every week.", hook: "Strength comes back slowly." };

test("postingKit logs its call, creating a missing cacheDir first", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "selects-kit-"));
  const dir = path.join(root, "job", "not-made-yet");
  try {
    const request = async () => ({ data: { title: "Strength comes back slowly", caption: "Why showing up beats intensity.", hashtags: ["strength", "training", "habits"] }, stats: { wallSec: 2, outTokens: 30 } });
    const k = await postingKit(clip, { model: "m", request, cacheDir: dir });
    assert.equal(k.title, "Strength comes back slowly");
    const line = JSON.parse(fs.readFileSync(path.join(dir, "judge-calls.jsonl"), "utf8").trim());
    assert.equal(line.kind, "kit");
    assert.equal(line.id, "c_0003");
    assert.equal(line.outTokens, 30);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the kit prompt tells the model not to invent or repeat unclear proper names", async () => {
  let sys = "";
  await postingKit(clip, {
    model: "m",
    request: async (messages) => {
      sys = messages[0].content;
      return { title: "t", caption: "c", hashtags: ["a", "b", "c"] };
    },
  });
  assert.match(sys, /proper names/i);
  assert.match(sys, /describ/i);
});
