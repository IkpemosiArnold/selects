// One way to call an outside provider (Groq, Cloudflare, Google's Gemini API, the Selects
// proxy, the speed probe), so every call has the same guarantees:
//   - one deadline that covers the whole exchange, the response body included (a server that
//     sends its headers and then stalls is a timeout, not a hang);
//   - a cap on the response size, enforced while reading: the reader is cancelled at the cap,
//     so a misbehaving server can never make the device or the proxy download more;
//   - the caller's AbortSignal stops the request at any point;
//   - failures that are worth trying elsewhere (no answer, a timeout, 429, 5xx) are marked
//     transient, and failover() tries providers in order on exactly those.
// Browser-safe and Node-safe: fetch, AbortController and streams only.

/** Errors from providerRequest: .status (0 when there was no answer), .transient, .timeout, .tooLarge. */
const fail = (message, extra) => Object.assign(new Error(message), extra);

/**
 * fetch(url, init) under a deadline and a size cap. Options:
 *   deadlineMs  the whole exchange, body included (default 30 s)
 *   maxBytes    the most it will read of the body (default 4 MB)
 *   overCap     "error" (default: throw .tooLarge) or "truncate" (stop at the cap, truncated: true)
 *   read        "text", "json", "bytes" or "none", or (response) => one of those
 *   signal      the caller's AbortSignal
 *   fetchImpl   fetch to use (tests)
 * Resolves { status, ok, headers, text, json, bytes (byte count), data (Uint8Array for "bytes"),
 * truncated, ms }. A non-2xx answer resolves too (with its body); only no answer, a timeout,
 * an abort or an over-size body throw.
 */
export async function providerRequest(url, init = {}, { deadlineMs = 30000, maxBytes = 4 << 20, overCap = "error", read = "text", signal = null, fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  const t0 = Date.now();
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, deadlineMs);
  const onAbort = () => ctl.abort();
  if (signal?.aborted) ctl.abort();
  signal?.addEventListener?.("abort", onAbort, { once: true });
  // settles when the deadline or the caller stops the request, so nothing waits on a server
  // (or a fetch) that ignores the abort signal
  const stopped = new Promise((_, reject) => {
    if (ctl.signal.aborted) reject(new Error("aborted"));
    ctl.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  stopped.catch(() => {});
  const why = (e) => {
    if (signal?.aborted) return Object.assign(new Error("Stopped before it finished."), { name: "AbortError" });
    if (timedOut) return fail(`No full answer within ${Math.round(deadlineMs / 1000)} s.`, { status: 0, transient: true, timeout: true });
    return fail(`Could not reach the server: ${e?.message || e}`, { status: 0, transient: true });
  };
  try {
    let res;
    try {
      res = await Promise.race([fetchImpl(url, { ...init, signal: ctl.signal }), stopped]);
    } catch (e) {
      throw why(e);
    }
    const mode = typeof read === "function" ? read(res) : read;
    const out = { status: res.status, ok: res.ok, headers: res.headers, text: null, json: null, bytes: 0, data: null, truncated: false };
    if (mode === "none") {
      await res.body?.cancel?.().catch(() => {});
      return { ...out, ms: Date.now() - t0 };
    }
    const chunks = [];
    try {
      if (res.body?.getReader) {
        const reader = res.body.getReader();
        for (;;) {
          let step;
          try {
            step = await Promise.race([reader.read(), stopped]);
          } catch (e) {
            reader.cancel().catch(() => {});
            throw e;
          }
          const { done, value } = step;
          if (done) break;
          const room = maxBytes - out.bytes;
          if (value.byteLength > room) {
            if (room > 0) chunks.push(value.subarray(0, room));
            out.bytes += Math.max(0, room);
            await reader.cancel().catch(() => {});
            if (overCap !== "truncate") throw fail(`The answer was larger than ${maxBytes} bytes.`, { status: res.status, transient: false, tooLarge: true });
            out.truncated = true;
            break;
          }
          chunks.push(value);
          out.bytes += value.byteLength;
        }
      } else {
        // a response without a stream (some test doubles): read it, then apply the cap
        const buf = new Uint8Array(await Promise.race([res.arrayBuffer(), stopped]));
        if (buf.byteLength > maxBytes && overCap !== "truncate") throw fail(`The answer was larger than ${maxBytes} bytes.`, { status: res.status, transient: false, tooLarge: true });
        chunks.push(buf.subarray(0, maxBytes));
        out.bytes = Math.min(buf.byteLength, maxBytes);
        out.truncated = buf.byteLength > maxBytes;
      }
    } catch (e) {
      if (e?.tooLarge) throw e;
      throw why(e);
    }
    const data = new Uint8Array(out.bytes);
    let o = 0;
    for (const c of chunks) {
      data.set(c, o);
      o += c.byteLength;
    }
    if (mode === "bytes") out.data = data;
    else {
      out.text = new TextDecoder().decode(data);
      if (mode === "json") {
        try {
          out.json = JSON.parse(out.text);
        } catch {
          out.json = null;
        }
      }
    }
    return { ...out, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

/** True for failures worth trying with the next provider: no answer, a timeout, 429 or 5xx. */
export const worthFailover = (e) => !!e && e.name !== "AbortError" && (e.status === 0 || e.status === 429 || e.status >= 500 || e.transient === true && e.status == null);

/**
 * Try providers in order: call(provider) for each until one succeeds. Moves on only for
 * failures worth it (worthFailover); anything else (a refused request, an abort) stops at once.
 */
export async function failover(providers, call, { shouldTry = worthFailover } = {}) {
  let last = null;
  for (const p of providers) {
    try {
      return await call(p);
    } catch (e) {
      last = e;
      if (!shouldTry(e)) throw e;
    }
  }
  throw last || new Error("No provider to try.");
}
