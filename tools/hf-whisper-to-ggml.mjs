#!/usr/bin/env node
// Convert a Hugging Face Whisper fine-tune (model.safetensors + config.json + vocab.json)
// to a whisper.cpp ggml file, with Node alone (no Python, torch or transformers).
// It follows whisper.cpp's models/convert-h5-to-ggml.py: the same header, tensor names and
// f16/f32 choices. The mel filters are copied from an existing multilingual ggml model with
// the same number of mel bins (they are fixed for a given n_mels).
//
// Usage: node tools/hf-whisper-to-ggml.mjs <hf-model-dir> <ref-ggml-model.bin> <out.bin>
import fs from "node:fs";
import path from "node:path";

const [dirModel, refModel, outFile] = process.argv.slice(2);
if (!outFile) {
  console.error("Usage: node tools/hf-whisper-to-ggml.mjs <hf-model-dir> <ref-ggml-model.bin> <out.bin>");
  process.exit(1);
}

const hp = JSON.parse(fs.readFileSync(path.join(dirModel, "config.json"), "utf8"));
const vocab = JSON.parse(fs.readFileSync(path.join(dirModel, "vocab.json"), "utf8"));
const maxLength = Number.isInteger(hp.max_length) ? hp.max_length : hp.max_target_positions ?? 448;

// ---- mel filters from the reference ggml file ----
function readMelFilters(file, nMels) {
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(4 * 15);
  fs.readSync(fd, head, 0, head.length, 0);
  if (head.readUInt32LE(0) !== 0x67676d6c) throw new Error(`${file} is not a ggml whisper model`);
  const refMels = head.readInt32LE(4 * 10);
  if (refMels !== nMels) throw new Error(`reference has ${refMels} mel bins, the model needs ${nMels}`);
  const fm = head.readInt32LE(4 * 12);
  const fn = head.readInt32LE(4 * 13);
  const bytes = Buffer.alloc(8 + fm * fn * 4);
  fs.readSync(fd, bytes, 0, bytes.length, 4 * 12);
  fs.closeSync(fd);
  return bytes; // n_mel, n_fft, then floats: written verbatim
}

// ---- GPT-2 byte decoder (bytes_to_unicode inverse) ----
function byteDecoder() {
  const bs = [];
  for (let c = 33; c <= 126; c++) bs.push(c);
  for (let c = 161; c <= 172; c++) bs.push(c);
  for (let c = 174; c <= 255; c++) bs.push(c);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }
  const dec = new Map();
  bs.forEach((b, i) => dec.set(String.fromCodePoint(cs[i]), b));
  return dec;
}

// ---- float32 -> float16 (round to nearest even) ----
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  exp = exp - 127 + 15;
  if (exp >= 0x1f) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - exp;
    let h = mant >> shift;
    const rem = mant & ((1 << shift) - 1);
    const half = 1 << (shift - 1);
    if (rem > half || (rem === half && h & 1)) h++;
    return sign | h;
  }
  let h = (exp << 10) | (mant >> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && h & 1)) h++;
  return sign | h;
}
function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

// ---- tensor name mapping (as convert-h5-to-ggml.py) ----
const CONV = {
  "self_attn.k_proj": "attn.key", "self_attn.q_proj": "attn.query", "self_attn.v_proj": "attn.value", "self_attn.out_proj": "attn.out",
  self_attn_layer_norm: "attn_ln", "encoder_attn.q_proj": "cross_attn.query", "encoder_attn.v_proj": "cross_attn.value",
  "encoder_attn.out_proj": "cross_attn.out", encoder_attn_layer_norm: "cross_attn_ln", fc1: "mlp.0", fc2: "mlp.2", final_layer_norm: "mlp_ln",
  "encoder.layer_norm.bias": "encoder.ln_post.bias", "encoder.layer_norm.weight": "encoder.ln_post.weight",
  "encoder.embed_positions.weight": "encoder.positional_embedding", "decoder.layer_norm.bias": "decoder.ln.bias",
  "decoder.layer_norm.weight": "decoder.ln.weight", "decoder.embed_positions.weight": "decoder.positional_embedding",
  "decoder.embed_tokens.weight": "decoder.token_embedding.weight", "proj_out.weight": "decoder.proj.weight",
};
function mapName(name) {
  let nn = name.split(".");
  if (nn[0] === "model") nn = nn.slice(1);
  if (nn[1] === "layers") {
    nn[1] = "blocks";
    const key = nn.slice(3, -1).join(".");
    const mapped = key === "encoder_attn.k_proj" ? (nn[0] === "encoder" ? "attn.key" : "cross_attn.key") : CONV[key];
    if (!mapped) throw new Error(`no mapping for ${name}`);
    return [...nn.slice(0, 3), mapped, nn[nn.length - 1]].join(".");
  }
  const joined = nn.join(".");
  return CONV[joined] || joined;
}

// ---- safetensors ----
const stFile = path.join(dirModel, "model.safetensors");
const fd = fs.openSync(stFile, "r");
const lenBuf = Buffer.alloc(8);
fs.readSync(fd, lenBuf, 0, 8, 0);
const headerLen = Number(lenBuf.readBigUInt64LE(0));
const hb = Buffer.alloc(headerLen);
fs.readSync(fd, hb, 0, headerLen, 8);
const header = JSON.parse(hb.toString("utf8"));
const dataStart = 8 + headerLen;

const out = fs.openSync(outFile + ".part", "w");
const w = (buf) => fs.writeSync(out, buf);
const i32 = (...vals) => {
  const b = Buffer.alloc(4 * vals.length);
  vals.forEach((v, i) => b.writeInt32LE(v, i * 4));
  w(b);
};

i32(0x67676d6c, hp.vocab_size, hp.max_source_positions, hp.d_model, hp.encoder_attention_heads, hp.encoder_layers, maxLength, hp.d_model, hp.decoder_attention_heads, hp.decoder_layers, hp.num_mel_bins, 1);
w(readMelFilters(refModel, hp.num_mel_bins));
const dec = byteDecoder();
const toks = Object.entries(vocab).sort((a, b) => a[1] - b[1]);
i32(toks.length);
for (const [t] of toks) {
  const bytes = Buffer.from([...t].map((ch) => {
    const b = dec.get(ch);
    if (b == null) throw new Error(`token char not in byte map: ${JSON.stringify(ch)}`);
    return b;
  }));
  i32(bytes.length);
  w(bytes);
}

let n = 0;
for (const [name, info] of Object.entries(header)) {
  if (name === "__metadata__" || name === "proj_out.weight") continue;
  const gname = mapName(name);
  let shape = info.shape.filter((d, i, a) => !(d === 1 && a.length > 1)); // squeeze
  if (gname === "encoder.conv1.bias" || gname === "encoder.conv2.bias") shape = [shape[0], 1];
  const [a, z] = info.data_offsets;
  const raw = Buffer.alloc(z - a);
  fs.readSync(fd, raw, 0, raw.length, dataStart + a);
  let vals;
  if (info.dtype === "F32") vals = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  else if (info.dtype === "F16") vals = Float32Array.from(new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2), halfToFloat);
  else throw new Error(`unsupported dtype ${info.dtype} for ${name}`);
  const nDims = shape.length;
  // the python script casts to f16 first, then back to f32 for 1-D tensors and these four
  const keepF32 = nDims < 2 || ["encoder.conv1.bias", "encoder.conv2.bias", "encoder.positional_embedding", "decoder.positional_embedding"].includes(gname);
  const nameBuf = Buffer.from(gname, "utf8");
  i32(nDims, nameBuf.length, keepF32 ? 0 : 1);
  i32(...shape.slice().reverse());
  w(nameBuf);
  if (keepF32) {
    const o = Buffer.alloc(vals.length * 4);
    for (let i = 0; i < vals.length; i++) o.writeFloatLE(halfToFloat(toHalf(vals[i])), i * 4);
    w(o);
  } else {
    const o = Buffer.alloc(vals.length * 2);
    for (let i = 0; i < vals.length; i++) o.writeUInt16LE(toHalf(vals[i]), i * 2);
    w(o);
  }
  n++;
}
fs.closeSync(out);
fs.closeSync(fd);
fs.renameSync(outFile + ".part", outFile);
console.log(`wrote ${n} tensors to ${outFile} (${(fs.statSync(outFile).size / 1e6).toFixed(0)} MB)`);
