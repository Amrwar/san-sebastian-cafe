/*
 * San Sebastian Café service worker — deliberately minimal.
 * - Never caches pages, prices, carts, orders or any /api response (they must always be live).
 * - Caches only immutable, content-hashed build assets (/_next/static/*) for faster repeat loads.
 * - When a page navigation fails because the device is offline, shows the localized offline page.
 * - Shows Web Push order notices and opens the order when one is tapped.
 */
const VERSION = "ssc-v2";
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

// Web Push: order notices (ready, cancelled…). The payload is { title, body, url, tag }.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Not JSON: show nothing rather than a broken notice.
    return;
  }
  if (!data.title) return;
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: "/icon",
      badge: "/icon",
      data: { url: data.url },
    }),
  );
});

// Tapping a notice opens the order (or focuses a tab already showing it).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data && event.notification.data.url;
  const target = new URL(
    typeof path === "string" && path.startsWith("/") ? path : "/",
    self.location.origin,
  );
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url === target.href);
      return open ? open.focus() : self.clients.openWindow(target.href);
    }),
  );
});
