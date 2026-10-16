// Share or save a rendered clip from the page. Phones get the system share
// sheet with the video file and its caption (Web Share API level 2); other
// browsers save the file. The file is fetched once and kept for the share,
// because a share has to start while the tap still counts as a tap.

/** "01 - Weightlifting Isn't Dangerous.mp4": the name a person would give it. */
export function clipFileName(rank, title, ext = "mp4") {
  const n = String(rank ?? 0).padStart(2, "0");
  const t = String(title || "Clip").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${n} - ${t}.${ext}`;
}

let support = null;
/** Whether this browser can share a video file at all. */
export function canShareFiles() {
  if (support != null) return support;
  try {
    const probe = new File([new Blob([""], { type: "video/mp4" })], "probe.mp4", { type: "video/mp4" });
    support = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [probe] }));
  } catch {
    support = false;
  }
  return support;
}

const cache = new Map(); // url -> Promise<File>
export function prefetchClip(url, name) {
  if (!url) return null;
  if (!cache.has(url)) {
    cache.set(
      url,
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`The clip could not be read (${r.status}).`);
          return r.blob();
        })
        .then((b) => new File([b], name, { type: b.type && b.type !== "application/octet-stream" ? b.type : "video/mp4" }))
        .catch((e) => {
          cache.delete(url);
          throw e;
        })
    );
  }
  return cache.get(url);
}

export function saveFile(file) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/** Share the clip; resolves "shared", "cancelled" or "saved" (when sharing is not possible). */
export async function shareClip({ url, name, title, text }) {
  const file = await prefetchClip(url, name);
  if (canShareFiles() && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text });
      return "shared";
    } catch (e) {
      if (e?.name === "AbortError") return "cancelled";
      // NotAllowedError: the tap expired while the file loaded. Save it instead.
    }
  }
  saveFile(file);
  return "saved";
}
