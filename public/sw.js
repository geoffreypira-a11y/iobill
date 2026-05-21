// IO BILL — Service Worker v8.27.5 KILL+REINSTALL
// Étape 1 : ce SW supprime TOUS les caches existants à l'activation
// Étape 2 : il sert ensuite en network-first (toujours frais)
// → Une seule visite avec ce SW suffit à invalider l'ancien cache cassé

const CACHE_VERSION = "iobill-v8-27-5";
const STATIC_CACHE = `${CACHE_VERSION}-static`;

self.addEventListener("install", (event) => {
  // Active immédiatement, ne pas attendre que les onglets se ferment
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // SUPPRIMER TOUS les anciens caches sans exception
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      // Prendre le contrôle de tous les onglets ouverts
      await self.clients.claim();
      // Forcer un reload de tous les onglets pour servir le nouveau bundle
      const clientsList = await self.clients.matchAll({ type: "window" });
      for (const client of clientsList) {
        client.navigate(client.url);
      }
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Ne jamais intercepter API, Supabase, services externes
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

  // Cache-first uniquement pour fonts/images
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
        }).catch(() => cached);
      })
    );
    return;
  }

  // Network-first pour HTML/JS/CSS (toujours essayer réseau d'abord)
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

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
