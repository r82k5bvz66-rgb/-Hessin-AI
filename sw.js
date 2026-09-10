const CACHE = "hessin-ai-v222";
const ASSETS = ["/", "/index.html", "/style.css", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // لا تلمس API أو الصور/الفيديو — دائماً من الشبكة
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/app.js")) {
    event.respondWith(fetch(req));
    return;
  }
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok && req.method === "GET") {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then((c) => c || caches.match("/")))
  );
});
