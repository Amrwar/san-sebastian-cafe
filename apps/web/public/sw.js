/*
 * San Sebastian Café service worker — deliberately minimal.
 * - Never caches pages, prices, carts, orders or any /api response (they must always be live).
 * - Caches only immutable, content-hashed build assets (/_next/static/*) for faster repeat loads.
 * - When a page navigation fails because the device is offline, shows the localized offline page.
 */
const VERSION = "ssc-v1";
const OFFLINE_PAGES = ["/fr/offline", "/en/offline"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(OFFLINE_PAGES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const page = url.pathname.startsWith("/en") ? "/en/offline" : "/fr/offline";
        return (await caches.match(page)) ?? Response.error();
      }),
    );
  }
});
