// Audiograms in the review app: a recording with no picture is previewed and rendered over a
// background (one of the drawn characters, or the person's own image), with a meter and a
// mouth that follow its sound. The drawing is src/core/audiogram.mjs, the same code both
// renders use, so the card shows what the MP4 will.
import { useEffect, useState } from "react";
import { api } from "./api.js";
import { AUDIOGRAM_PRESETS, audiogramSettings, isAudioOnly, paintCover, paintPreset } from "../../../src/core/audiogram.mjs";

export { AUDIOGRAM_PRESETS, audiogramSettings, isAudioOnly };

export const isAudioJob = (job) => isAudioOnly(job?.source);

const makeCanvas = (w, h) => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

const thumbs = new Map();
/** A small picture of a preset (for the picker, the done list and the peek), as a data URL. */
export function presetThumb(id, w = 120) {
  const key = `${id}:${w}`;
  if (thumbs.has(key)) return thumbs.get(key);
  let url = null;
  try {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = Math.round((w * 16) / 9);
    paintPreset(c.getContext("2d"), id, c.width, c.height);
    url = c.toDataURL("image/jpeg", 0.82);
  } catch {}
  thumbs.set(key, url);
  return url;
}

/** The still that stands for an audio job: its image, or its preset. */
export function audiogramStill(job) {
  const a = audiogramSettings(job?.settings);
  if (a.bg === "cover") return api.coverUrl?.(job.id, job.settings?.audiogram?.coverAt) || presetThumb("sunny", 240);
  return presetThumb(a.bg, 240);
}

/** Load the person's background image for the preview, or null. */
export function useCoverImage(job) {
  const a = audiogramSettings(job?.settings);
  const url = a.bg === "cover" ? api.coverUrl?.(job.id, job.settings?.audiogram?.coverAt) : null;
  const [img, setImg] = useState(null);
  useEffect(() => {
    if (!url) return setImg(null);
    let live = true;
    const im = new Image();
    im.onload = () => live && setImg(im);
    im.onerror = () => live && setImg(null);
    im.src = url;
    return () => {
      live = false;
    };
  }, [url]);
  return img;
}

/**
 * Paint the still background for the preview at w x h. cover: a loaded image when the
 * job uses the person's image.
 */
export function paintStill(ctx, job, w, h, cover) {
  const a = audiogramSettings(job?.settings);
  if (a.bg === "cover" && cover) paintCover(ctx, cover, w, h, { focus: a.focus, makeCanvas });
  else paintPreset(ctx, a.bg === "cover" ? null : a.bg, w, h);
  return a.bg === "cover" ? "cover" : a.bg;
}

/** The clip's loudness for the preview meter ({ fps, start, v, mouth }), or null while it loads. */
export function useLevels(job, start, end) {
  const [env, setEnv] = useState(null);
  const id = job?.id;
  const audio = isAudioJob(job);
  useEffect(() => {
    if (!audio || !api.levels || !(end > start)) return setEnv(null);
    let live = true;
    // a little either side, so the meter has bars before the first word and after the last
    const a = Math.max(0, start - 3);
    const b = Math.min(job.source?.duration || end + 3, end + 3);
    api.levels(id, a, b).then((e) => live && setEnv(e ? { ...e, start: a } : null)).catch(() => live && setEnv(null));
    return () => {
      live = false;
    };
  }, [id, audio, start, end]); // eslint-disable-line react-hooks/exhaustive-deps
  return env;
}
