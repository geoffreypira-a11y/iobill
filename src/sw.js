// IO BILL - Service Worker custom (Workbox + Push)
// Genere par vite-plugin-pwa en mode injectManifest

import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { NetworkFirst, CacheFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";

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
