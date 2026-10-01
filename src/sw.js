// IO BILL - Service Worker custom (Workbox + Push)
// Genere par vite-plugin-pwa en mode injectManifest

import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { NetworkFirst, CacheFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";

// ─── Prise de contrôle à la mise à jour ─────────────────────
// v8.112 — En mode injectManifest, vite-plugin-pwa n'injecte RIEN de tout
// ça : `registerType: "autoUpdate"` ne suffit pas, c'est au service worker
// de le faire lui-même. Sans cette ligne, le nouveau worker restait en
// attente tant que TOUS les onglets de l'app n'étaient pas fermés — ce qui
// n'arrive jamais sur un téléphone. Résultat : un déploiement pouvait ne
// jamais atteindre l'utilisateur, et il fallait un rechargement forcé.
//
// On s'arrête volontairement à skipWaiting, SANS clientsClaim : le build
// est découpé en 6 fichiers chargés à la demande. Prendre le contrôle d'une
// page déjà ouverte lui ferait réclamer des morceaux de l'ancienne version
// que le cache vient de purger. Ici le nouveau worker s'active tout de
// suite mais ne sert la page qu'au rechargement suivant : un rafraîchissement
// ordinaire suffit, au lieu de fermer tous les onglets.
self.skipWaiting();

// ─── Precache (assets statiques generes par Vite) ──────────
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// ─── Runtime caching ───────────────────────────────────────
registerRoute(
  /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
  new CacheFirst({
    cacheName: "google-fonts",
    plugins: [new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 })]
  })
);

registerRoute(
  /\/rest\/v1\/.*/i,
  new NetworkFirst({
    cacheName: "supabase-api",
    networkTimeoutSeconds: 5,
    plugins: [new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 60 * 5 })]
  })
);

// ─── PUSH NOTIFICATIONS ────────────────────────────────────
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "IO BILL", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "IO BILL";
  const options = {
    body: data.body || "",
    icon: data.icon || "/icon-192.png",
    badge: data.badge || "/icon-192.png",
    tag: data.tag || "iobill-notif",
    data: { url: data.url || "/", ...(data.data || {}) },
    requireInteraction: !!data.requireInteraction,
    actions: data.actions || []
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsList) => {
      // Focus l'onglet existant si possible
      for (const client of clientsList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      // Sinon ouvre un nouvel onglet
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});

// ─── Skip waiting on update ─────────────────────────────────
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});
