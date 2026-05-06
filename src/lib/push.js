// IO BILL - Web Push notifications (PWA)
// Doc : https://web.dev/push-notifications-overview/
//
// Workflow :
// 1) L'utilisateur clique "Activer les notifications" -> Notification.requestPermission()
// 2) On récupère un push subscription via service worker
// 3) On envoie l'objet (endpoint + p256dh + auth) à /api/push-subscribe
// 4) Le serveur peut envoyer des notifs via /api/push-send (avec web-push lib ou VAPID inline)

import { sb } from "./supabase.js";

const VAPID_PUBLIC_KEY = import.meta.env?.VITE_VAPID_PUBLIC_KEY || "";

export function pushSupported() {
  return typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

export function pushPermission() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission; // "default" | "granted" | "denied"
}

/**
 * Active les notifications push pour le user courant
 */
export async function enablePush(token) {
  if (!pushSupported()) throw new Error("Push not supported in this browser");
  if (!VAPID_PUBLIC_KEY) throw new Error("VAPID public key not configured (VITE_VAPID_PUBLIC_KEY)");

  // Demander la permission
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    throw new Error(perm === "denied" ? "Permission refusée" : "Permission non accordée");
  }

  // Recuperer le service worker
  const registration = await navigator.serviceWorker.ready;

  // S'abonner
  const sub = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
  });

  // Envoyer l'abonnement au serveur
  const subJson = sub.toJSON();
  const r = await fetch("/api/push-subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      endpoint: subJson.endpoint,
      p256dh: subJson.keys.p256dh,
      auth: subJson.keys.auth,
      user_agent: navigator.userAgent
    })
  });

  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || "Subscription failed");
  }
  return await r.json();
}

/**
 * Désactive les notifications
 */
export async function disablePush(token) {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const sub = await registration.pushManager.getSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    // Nettoyer cote serveur
    await fetch("/api/push-unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint })
    }).catch(() => {});
  }
}

/**
 * Verifie si le user est deja abonne
 */
export async function isPushSubscribed() {
  if (!pushSupported()) return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    const sub = await registration.pushManager.getSubscription();
    return !!sub;
  } catch {
    return false;
  }
}

// VAPID conversion (URL-safe base64 -> Uint8Array)
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
}
