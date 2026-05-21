// IO BILL — Service Worker v8.27.3
// Stratégie : network-first pour HTML/JS/CSS, cache-first pour fonts/images
// Cache versionné pour invalider à chaque release

const CACHE_VERSION = "iobill-v8-27-3";
const STATIC_CACHE = `${CACHE_VERSION}-static`;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Jamais cacher API, Supabase, services externes
  if (
    url.pathname.startsWith("/api/") ||
    url.hostname.includes("supabase.co") ||
    url.hostname.includes("supabase.in") ||
    url.hostname.includes("resend.com") ||
    url.hostname.includes("mistral.ai") ||
    url.hostname.includes("stripe.com") ||
    url.hostname.includes("yousign.app")
  ) {
    return;
  }

  // Cache-first pour fonts/images
  if (url.pathname.match(/\.(woff2?|ttf|otf|eot|png|jpg|jpeg|gif|svg|ico|webp)$/i)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put(req, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // Network-first pour HTML/JS/CSS
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});

// Permet à l'app de demander un skip waiting depuis JS
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
