// ═══════════════════════════════════════════════════════════════
//  IO BILL — REALTIME (WebSocket Supabase)
// ═══════════════════════════════════════════════════════════════
// Implementation legere du protocole Realtime de Supabase sans
// le SDK officiel (qui pese 70KB+). On utilise directement la
// WebSocket native du navigateur.
//
// Protocole : Phoenix Channels (Supabase est basé dessus).
// Doc : https://supabase.com/docs/guides/realtime/protocol

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Singleton : une seule WebSocket pour toute l'app, partagee
// entre tous les composants.
let ws = null;
let wsReady = false;
let wsRef = 1;
let pendingMessages = [];
let subscribers = new Map(); // topic → array de callbacks
let heartbeatTimer = null;
let reconnectTimer = null;
let currentToken = null;

function makeRef() {
  return String(wsRef++);
}

function send(msg) {
  if (ws && wsReady) {
    ws.send(JSON.stringify(msg));
  } else {
    pendingMessages.push(msg);
  }
}

function flushPending() {
  while (pendingMessages.length > 0) {
    const msg = pendingMessages.shift();
    ws.send(JSON.stringify(msg));
  }
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    send({
      topic: "phoenix",
      event: "heartbeat",
      payload: {},
      ref: makeRef()
    });
  }, 30000); // toutes les 30s
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function connect(token) {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  currentToken = token;
  const wsUrl = SUPABASE_URL.replace(/^https?:/, "wss:") + "/realtime/v1/websocket"
    + "?apikey=" + encodeURIComponent(SUPABASE_ANON_KEY)
    + "&vsn=1.0.0";
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    console.warn("[realtime] failed to create WebSocket", e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    wsReady = true;
    flushPending();
    startHeartbeat();
    // Re-souscrire a tous les topics
    for (const topic of subscribers.keys()) {
      joinTopic(topic);
    }
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg || !msg.topic) return;
    // Realtime envoie des events postgres_changes
    if (msg.event === "postgres_changes" || msg.event === "INSERT" || msg.event === "UPDATE" || msg.event === "DELETE") {
      const callbacks = subscribers.get(msg.topic) || [];
      for (const cb of callbacks) {
        try { cb(msg.payload); } catch {}
      }
    }
  };

  ws.onclose = () => {
    wsReady = false;
    stopHeartbeat();
    scheduleReconnect();
  };

  ws.onerror = () => {
    // Le close handler va prendre le relais
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (currentToken && subscribers.size > 0) {
      connect(currentToken);
    }
  }, 3000);
}

function joinTopic(topic) {
  // topic format : "realtime:public:table_name:filter"
  // ex : "realtime:public:notifications:company_id=eq.xxxx"
  const [, , table, filter] = topic.split(":");

  send({
    topic,
    event: "phx_join",
    payload: {
      config: {
        postgres_changes: [
          {
            event: "*",
            schema: "public",
            table,
            filter: filter || undefined
          }
        ]
      },
      access_token: currentToken
    },
    ref: makeRef()
  });
}

// ─── API publique ──────────────────────────────────────────────
//
// subscribe(token, table, filter, callback)
//   → s'abonne aux changements sur cette table+filter
//   → retourne une fonction unsubscribe()
//
// Le callback recoit { data: row, eventType: "INSERT"|"UPDATE"|"DELETE" }
//
export function subscribe(token, table, filter, callback) {
  const topic = `realtime:public:${table}:${filter}`;

  // Premier abonne pour ce topic
  if (!subscribers.has(topic)) {
    subscribers.set(topic, []);
  }
  subscribers.get(topic).push(callback);

  // Connecter si pas encore connecte
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connect(token);
  } else if (subscribers.get(topic).length === 1) {
    // Topic nouveau sur connexion existante : rejoindre
    joinTopic(topic);
  }

  // Retourne unsubscribe
  return () => {
    const cbs = subscribers.get(topic);
    if (!cbs) return;
    const idx = cbs.indexOf(callback);
    if (idx >= 0) cbs.splice(idx, 1);
    if (cbs.length === 0) {
      subscribers.delete(topic);
      // Quitter le topic
      send({
        topic,
        event: "phx_leave",
        payload: {},
        ref: makeRef()
      });
      // Si plus aucun abonne du tout, fermer la WS
      if (subscribers.size === 0 && ws) {
        ws.close();
        ws = null;
        wsReady = false;
        stopHeartbeat();
      }
    }
  };
}
