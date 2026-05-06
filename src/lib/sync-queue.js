// IO BILL - File de synchronisation pour mode degrade offline
// Quand le user est offline, les mutations (POST/PATCH/DELETE) sont stockees
// dans IndexedDB et rejouees automatiquement quand la connexion revient.
//
// Strategie :
// - Wrapper sur fetch pour Supabase + API Vercel
// - Si offline -> queue + return optimistic response
// - Si online -> exec direct
// - Listener "online" -> replay queue
//
// Limites V1.1 :
// - Pas de gestion des conflits cote DB (last-write-wins)
// - Le ID des nouvelles entites est genere cote DB, donc on ne peut pas
//   re-utiliser la reponse hors-ligne pour les inserts (workaround: UI gere ca avec un uid local)
// - Les blobs (uploads Storage) ne sont pas queues (gros volume)

const DB_NAME = "iobill-sync";
const STORE_NAME = "queue";

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function enqueue(item) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const req = store.add({
        ...item,
        queued_at: Date.now(),
        attempts: 0
      });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    console.warn("[sync] enqueue failed:", e);
    return null;
  }
}

export async function listQueue() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function dequeue(id) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const req = tx.objectStore(STORE_NAME).delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

export async function updateAttempts(id, attempts) {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const get = store.get(id);
      get.onsuccess = () => {
        const item = get.result;
        if (!item) return resolve(false);
        item.attempts = attempts;
        item.last_attempt_at = Date.now();
        store.put(item);
        resolve(true);
      };
      get.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

// ─── Replay : rejoue toutes les requetes en queue ──────────
let isReplaying = false;

export async function replayQueue() {
  if (isReplaying) return { replayed: 0, failed: 0 };
  if (!navigator.onLine) return { replayed: 0, failed: 0, offline: true };

  isReplaying = true;
  const items = await listQueue();
  let replayed = 0;
  let failed = 0;

  for (const item of items) {
    try {
      const r = await fetch(item.url, {
        method: item.method,
        headers: item.headers,
        body: item.body
      });
      if (r.ok) {
        await dequeue(item.id);
        replayed++;
      } else if (r.status >= 400 && r.status < 500) {
        // 4xx = erreur client, on ne retentera pas
        await dequeue(item.id);
        failed++;
      } else {
        await updateAttempts(item.id, (item.attempts || 0) + 1);
        failed++;
      }
    } catch {
      await updateAttempts(item.id, (item.attempts || 0) + 1);
      failed++;
    }
  }

  isReplaying = false;
  return { replayed, failed, total: items.length };
}

// ─── Auto-replay quand on repasse online ────────────────────
let listenerInstalled = false;

export function installSyncListener(onProgress) {
  if (listenerInstalled || typeof window === "undefined") return;
  listenerInstalled = true;

  window.addEventListener("online", async () => {
    const result = await replayQueue();
    onProgress?.(result);
  });

  // Replay au boot si online
  if (navigator.onLine) {
    setTimeout(() => replayQueue().then(onProgress).catch(() => {}), 1500);
  }
}

// ─── Indicateur online/offline pour la UI ──────────────────
export function subscribeOnlineStatus(callback) {
  if (typeof window === "undefined") return () => {};
  const handler = () => callback(navigator.onLine);
  window.addEventListener("online", handler);
  window.addEventListener("offline", handler);
  callback(navigator.onLine);
  return () => {
    window.removeEventListener("online", handler);
    window.removeEventListener("offline", handler);
  };
}

// ─── Helper : queue-aware fetch ─────────────────────────────
// A utiliser pour les mutations (POST/PATCH/DELETE) non-critiques.
// Les operations critiques (auth, paiement Stripe) ne doivent PAS etre queues.
export async function fetchOrQueue(url, options = {}) {
  if (navigator.onLine) {
    return fetch(url, options);
  }
  // Offline -> queue
  await enqueue({
    url,
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body
  });
  // Retourne une reponse fictive pour ne pas casser l'UI
  return new Response(JSON.stringify({ queued: true }), {
    status: 202,
    headers: { "Content-Type": "application/json" }
  });
}
