// Read a video's duration, size and frame rate with ffprobe.
import fs from "node:fs";
import path from "node:path";
import { run } from "./util.mjs";

const ratio = (s) => {
  if (!s || s === "0/0" || s === "N/A") return null;
  const [a, b] = String(s).split(/[:/]/).map(Number);
  return b ? a / b : a;
};

/**
 * @param {string} file
 * @returns source object { path, name, duration, width, height, fps, sar, displayWidth, hasAudio }
 *   width and height are the stored pixel size; displayWidth corrects for non-square pixels.
 */
export async function probe(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    const err = new Error(`No file at ${abs}.`);
    err.hint = "Check the path. Drag the file into the terminal to paste its full path.";
    throw err;
  }
  let out;
  try {
    out = await run("ffprobe", ["-v", "error", "-show_entries", "stream=index,codec_type,codec_name,width,height,sample_aspect_ratio,avg_frame_rate,r_frame_rate,channels,sample_rate:stream_side_data=rotation:stream_tags=rotate:format=duration", "-of", "json", abs]);
  } catch (e) {
    const err = new Error(`ffprobe could not read ${path.basename(abs)}: ${e.message}`);
    err.hint = "Make sure the file is a video ffmpeg can open, and that ffprobe is installed (brew install ffmpeg).";
    throw err;
  }
  const j = JSON.parse(out.stdout);
  // attached cover art shows up as a video stream; skip it
  const v = (j.streams || []).find((s) => s.codec_type === "video" && s.codec_name !== "mjpeg" && s.codec_name !== "png");
  const audios = (j.streams || []).filter((s) => s.codec_type === "audio");
  const a = audios[0];
  const duration = +(+j.format?.duration || 0).toFixed(2);
  if (!a) {
    const err = new Error(`${path.basename(abs)} has no audio track, so there is nothing to transcribe.`);
    err.hint = "Choose a video with speech in it.";
    throw err;
  }
  const sar = ratio(v?.sample_aspect_ratio) || 1;
  const fps = +(ratio(v?.avg_frame_rate) || ratio(v?.r_frame_rate) || 25).toFixed(3);
  const rotation = v ? rotationOf(v) : 0;
  const dispW = v ? Math.round(v.width * sar) : 0;
  const turned = Math.abs(rotation) % 180 === 90;
  return {
    path: abs,
    name: path.basename(abs),
    duration,
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps,
    sar: +sar.toFixed(4),
    displayWidth: v ? Math.round(v.width * sar) : 0,
    hasVideo: !!v,
    videoStream: v ? v.index : null,
    vcodec: v?.codec_name ?? null,
    // phones store portrait video as landscape pixels plus a rotation; ffmpeg turns frames
    // upright when it decodes, so every size decision uses the upright size
    rotation,
    uprightWidth: turned ? v.height : dispW,
    uprightHeight: turned ? dispW : (v?.height ?? 0),
    audioStreams: audios.map((s) => ({ index: s.index, codec: s.codec_name, channels: s.channels ?? null, sampleRate: s.sample_rate ? +s.sample_rate : null })),
  };
}

/** Rotation in degrees from the display matrix side data, or the old "rotate" tag. */
export function rotationOf(stream) {
  const sd = (stream.side_data_list || []).find((d) => d.rotation != null);
  const r = sd ? Number(sd.rotation) : Number(stream.tags?.rotate ?? 0);
  return Number.isFinite(r) ? ((Math.round(r) % 360) + 360) % 360 : 0;
}

/** Upright display size of a source (falls back to the stored size for old job.json files). */
export function uprightSize(src) {
  const w = src.uprightWidth || src.displayWidth || src.width;
  const h = src.uprightHeight || src.height;
  return { w, h };
}
