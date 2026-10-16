// Download a model file once and keep it in the browser's Cache Storage ("selects-models"),
// reporting honest progress. Later visits read it from the cache with no network.

export const CACHE_NAME = "selects-models";

async function openCache() {
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null; // private windows and some embeds have no Cache Storage
  }
}

/** True when the file is already cached (no download needed). */
export async function isCached(url) {
  const c = await openCache();
  return !!(c && (await c.match(url)));
}

/**
 * Fetch url through the cache. onProgress({ loaded, total, cached }) while downloading.
 * Returns a Response whose body streams from the cache (or from memory when there is no
 * cache), so a 2 GB model is never held twice.
 */
export async function cachedFetch(url, { onProgress, signal, expectedBytes } = {}) {
  const cache = await openCache();
  const hit = cache && (await cache.match(url));
  if (hit) {
    const total = +hit.headers.get("content-length") || expectedBytes || 0;
    onProgress?.({ loaded: total, total, cached: true });
    return hit;
  }
  const res = await fetch(url, { signal, mode: "cors", credentials: "omit" });
  if (!res.ok) throw Object.assign(new Error(`Download failed (${res.status}) for ${url}`), { hint: "Check the connection, then try again. Nothing was uploaded." });
  const total = +res.headers.get("content-length") || expectedBytes || 0;
  let loaded = 0;
  const counted = res.body.pipeThrough(
    new TransformStream({
      transform(chunk, ctrl) {
        loaded += chunk.byteLength;
        onProgress?.({ loaded, total, cached: false });
        ctrl.enqueue(chunk);
      },
    }),
  );
  const headers = new Headers({ "content-type": res.headers.get("content-type") || "application/octet-stream" });
  if (total) headers.set("content-length", String(total));
  if (cache) {
    await cache.put(url, new Response(counted, { headers }));
    return cache.match(url);
  }
  return new Response(counted, { headers });
}

/** Drop a cached model (for a "free up space" control). */
export async function forget(url) {
  const c = await openCache();
  return c ? c.delete(url) : false;
}

/** How much the origin stores, for the UI ({ usage, quota } in bytes, or null). */
export async function storageEstimate() {
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}
