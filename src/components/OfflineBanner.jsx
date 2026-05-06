import React, { useEffect, useState } from "react";
import { subscribeOnlineStatus, listQueue, replayQueue, installSyncListener } from "../lib/sync-queue.js";

/**
 * OfflineBanner — banniere visible en haut quand le user est offline OU
 * quand des operations sont en attente de synchronisation.
 */
export function OfflineBanner() {
  const [online, setOnline] = useState(true);
  const [queueSize, setQueueSize] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);

  useEffect(() => {
    const unsub = subscribeOnlineStatus(setOnline);
    installSyncListener((result) => {
      setLastSync(result);
      refreshQueue();
    });
    refreshQueue();
    const t = setInterval(refreshQueue, 5000);
    return () => { unsub(); clearInterval(t); };
  }, []);

  async function refreshQueue() {
    const items = await listQueue();
    setQueueSize(items.length);
  }

  async function manualSync() {
    setSyncing(true);
    const result = await replayQueue();
    setLastSync(result);
    await refreshQueue();
    setSyncing(false);
  }

  // Online + pas de queue = rien a afficher
  if (online && queueSize === 0) return null;

  const isOffline = !online;
  const label = isOffline
    ? `📡 Hors ligne · ${queueSize} action${queueSize > 1 ? "s" : ""} en attente`
    : `🔄 ${queueSize} action${queueSize > 1 ? "s" : ""} à synchroniser`;

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 9000,
      background: isOffline ? "var(--orange)" : "var(--gold)",
      color: "#0b0c10", padding: "8px 18px",
      fontSize: 12, fontWeight: 600, letterSpacing: 0.5,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      boxShadow: "0 2px 8px rgba(0,0,0,0.3)"
    }}>
      <span>{label}</span>
      {!isOffline && queueSize > 0 && (
        <button
          onClick={manualSync}
          disabled={syncing}
          style={{
            background: "rgba(0,0,0,0.15)", color: "#0b0c10", border: "none",
            padding: "4px 10px", borderRadius: 4, fontSize: 11, fontWeight: 700,
            cursor: syncing ? "default" : "pointer"
          }}
        >
          {syncing ? "Sync..." : "Synchroniser"}
        </button>
      )}
    </div>
  );
}
