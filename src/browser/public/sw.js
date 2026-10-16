// Selects Web service worker: keeps the app shell available offline and installable.
// It never runs inference (phones stop service workers after seconds), and it does not
// touch cross-origin requests: the models are cached by the page itself (Cache Storage
// "transformers-cache" and "selects-models", and wllama's OPFS cache).
const SHELL = "selects-shell-v1";
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
