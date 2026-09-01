// Service worker for the Remedial Healthcare Digital Order Book.
// Bump CACHE_VERSION whenever index.html or its bundled assets change meaningfully, so
// returning users pick up the new version instead of a stale cached copy. Bumping this is
// the only thing that forces an update -- otherwise the old cache would serve forever.
const CACHE_VERSION = "rhc-v10";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/rhc-assets/icons/icon-192.png",
  "/rhc-assets/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never intercept POSTs (orders, admin actions, etc.)

  const url = new URL(req.url);

  // Live data must always come from the network -- never serve a cached/stale API response
  // (territory status, product catalog, order history, admin data all change constantly).
  if (url.pathname.startsWith("/api/")) return;

  // App shell (the page itself): network-first, falling back to cache when offline or the
  // network is flaky -- so the app still opens and shows the last-seen version, but a
  // connected user always gets the freshest copy rather than something stuck in cache.
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match("/index.html")))
    );
    return;
  }

  // Everything else (product images, label PDFs, icons, fonts loaded from CDN, etc.):
  // cache-first, since these rarely change and cache-first keeps the app snappy and usable
  // with a weak connection. Falls back to the network for anything not yet cached.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
