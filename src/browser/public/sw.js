// Selects Web service worker: keeps the app shell available offline and installable.
// It never runs inference (phones stop service workers after seconds), and it does not
// touch cross-origin requests: the models are kept by the page itself (OPFS "models",
// Cache Storage, and wllama's OPFS cache). The WebAssembly runtimes and the module scripts
// workers import (ONNX Runtime, MediaPipe, wllama: 15 to 27 MB each) are left to the HTTP
// cache (immutable, hashed names): a copy here would double them on a phone, and a failed
// fetch inside the service worker made a worker's import fail in WebKit ("Importing a module
// script failed"), which stopped the speech model from loading.
const SHELL = "selects-shell-v2";
const CORE = ["./", "./demo.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("selects-shell-") && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (/\.(wasm|mjs)$/.test(url.pathname) || req.destination === "worker") return;
  // hashed build assets never change: cache first
  if (url.pathname.includes("/assets/")) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone()));
        return res;
      })),
    );
    return;
  }
  // pages and the manifest: the network first, so an update shows up; the cache when offline
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone()));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("./demo.html"))),
  );
});
