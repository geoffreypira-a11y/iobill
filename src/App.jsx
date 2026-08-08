// IO Car v2.1 — 2026-04-20T22:18:38
import React, { useState, useEffect, useRef, useCallback } from "react";
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";

// v8.37 — Pont IO BILL (composants UI)
import IobillBridgeCard from "./components/IobillBridgeCard.jsx";
import IobillInvoiceSync from "./components/IobillInvoiceSync.jsx";

// v8.49.16 — Système d'essai gratuit 7 jours + paywall
import { TrialBanner, hasValidAccess } from "./components/TrialBanner.jsx";
import { TrialExpiredPage } from "./modules/core/TrialExpiredPage.jsx";

/* ═══════════════════════════════════════════════════════════════
   SUPABASE CONFIG
═══════════════════════════════════════════════════════════════ */
const SUPABASE_URL = "https://lnukqnopmlvaqxbdwhst.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxudWtxbm9wbWx2YXF4YmR3aHN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2MzY3OTgsImV4cCI6MjA5MjIxMjc5OH0.HkS1i0cakprVyY83_lGuym8CjuiDwXjYIEeVAmm_F6s";

// Client Supabase léger sans SDK (fetch natif)
const sb = {
  headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=representation" },

  async signUp(email, password, garage_name) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST", headers: { ...this.headers, "Authorization": `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ email, password, data: { garage_name } })
    });
    const j = await r.json().catch(() => ({}));
    // v8.49.17.1 — Propager les erreurs HTTP (429 rate limit, 4xx métier, 5xx serveur)
    // Supabase retourne l'erreur sous plusieurs formats selon le cas :
    //   - { error: "..." } (erreur métier classique)
    //   - { code: 429, error_code: "over_email_send_rate_limit", msg: "..." } (rate limit)
    //   - { code: 4xx, error_code: "...", msg: "..." } (autres 4xx)
    // On normalise tout en { error: { message: "..." } } pour que le handler
    // du composant Auth affiche un vrai message d'erreur au user.
    if (!r.ok || j.error_code || j.error) {
      const msg = j.msg || j.error?.message || j.error_description || j.error || `Erreur ${r.status}`;
      return { error: { message: msg, code: j.code || r.status, error_code: j.error_code } };
    }
    return j;
  },

  async signIn(email, password) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST", headers: { ...this.headers },
      body: JSON.stringify({ email, password })
    });
    const j = await r.json().catch(() => ({}));
    // v8.49.17.1 — Idem signUp : propager toutes les formes d'erreur Supabase
    if (!r.ok || j.error_code || j.error) {
      const msg = j.msg || j.error?.message || j.error_description || j.error || `Erreur ${r.status}`;
      return { error: { message: msg, code: j.code || r.status, error_code: j.error_code } };
    }
    return j;
  },

  // v8.49 — Renouvelle l'access_token à partir du refresh_token
  // Retourne { access_token, refresh_token, user } ou { error }
  async refresh(refreshToken) {
    if (!refreshToken) return { error: "no_refresh_token" };
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST", headers: { ...this.headers },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    return r.json();
  },

  async signOut(token) {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: "POST", headers: { ...this.headers, "Authorization": `Bearer ${token}` }
    });
  },

  async getUser(token) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { ...this.headers, "Authorization": `Bearer ${token}` }
    });
    return r.json();
  },

  async resetPassword(email) {
    // v8.50 — Ajout redirectTo explicite pour que le mail redirige vers l'app prod
    // (sinon Supabase utilise le "Site URL" configuré qui peut être localhost:3000).
    // Propage aussi les erreurs (429 rate limit, 4xx, etc.) comme signUp/signIn.
    const origin = (typeof window !== "undefined" && window.location?.origin) || "https://app.iocar.online";
    const r = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
      method: "POST", headers: { ...this.headers },
      body: JSON.stringify({
        email,
        redirect_to: `${origin}/reset-password`
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error_code || j.error) {
      const msg = j.msg || j.error?.message || j.error_description || j.error || `Erreur ${r.status}`;
      return { error: { message: msg, code: j.code || r.status, error_code: j.error_code } };
    }
    return j;
  },

  // v8.50 — Update password (utilisé par le flow reset password)
  // L'access_token du recovery vient du hash de l'URL (Supabase redirige avec
  // #access_token=xxx&type=recovery). On utilise ce token pour appeler
  // /auth/v1/user avec le nouveau mot de passe.
  async updatePassword(accessToken, newPassword) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: {
        ...this.headers,
        "Authorization": `Bearer ${accessToken}`
      },
      body: JSON.stringify({ password: newPassword })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error_code || j.error) {
      const msg = j.msg || j.error?.message || j.error_description || j.error || `Erreur ${r.status}`;
      return { error: { message: msg, code: j.code || r.status, error_code: j.error_code } };
    }
    return j;
  },

  // CRUD générique
  authedHeaders(token) {
    return { ...this.headers, "Authorization": `Bearer ${token}` };
  },

  async select(token, table, filter = "") {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}&order=created_at.desc`, {
      headers: this.authedHeaders(token)
    });
    return r.ok ? r.json() : [];
  },

  async upsert(token, table, data) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: { ...this.authedHeaders(token), "Prefer": "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(data)
    });
    return r.ok ? r.json() : null;
  },

  async update(token, table, id, data) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: "PATCH",
      headers: { ...this.authedHeaders(token), "Prefer": "return=representation" },
      body: JSON.stringify(data)
    });
    return r.ok ? r.json() : null;
  },

  async delete(token, table, id) {
    await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
      method: "DELETE", headers: this.authedHeaders(token)
    });
  },

  async getGarage(token, userId) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/garages?user_id=eq.${userId}`, {
      headers: this.authedHeaders(token)
    });
    const data = await r.json();
    return data?.[0] || null;
  },

  async updateGarage(token, userId, data) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/garages?user_id=eq.${userId}`, {
      method: "PATCH",
      headers: { ...this.authedHeaders(token), "Prefer": "return=representation" },
      body: JSON.stringify(data)
    });
    return r.ok ? r.json() : null;
  },
};

// Persistance token dans localStorage
const TOKEN_KEY = "iocar_token";
const REFRESH_KEY = "iocar_refresh_token";  // v8.49 — refresh token Supabase pour auto-renouveler
const USER_KEY  = "iocar_user";
function saveSession(token, user, refreshToken) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    // v8.49 — sauvegarde refresh_token si fourni (peut être omis lors du bootstrap)
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  } catch(e) {}
}
function loadSession() {
  try {
    return {
      token: localStorage.getItem(TOKEN_KEY),
      refreshToken: localStorage.getItem(REFRESH_KEY),  // v8.49
      user: JSON.parse(localStorage.getItem(USER_KEY) || "null")
    };
  } catch(e) { return { token: null, refreshToken: null, user: null }; }
}
function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);  // v8.49
    localStorage.removeItem(USER_KEY);
  } catch(e) {}
}

// v8.49 — Décoder l'expiration du JWT (sans lib, sans vérification de signature — juste lire exp)
function decodeJwtExp(token) {
  if (!token || typeof token !== "string") return 0;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return 0;
    // JWT payload est du base64url
    const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return (payload.exp || 0) * 1000;  // ms
  } catch(e) { return 0; }
}

/* ═══════════════════════════════════════════════════════════════
   BROUILLONS DE FORMULAIRES — protection contre la perte de saisie
   ═══════════════════════════════════════════════════════════════
   Sauvegarde automatique du formulaire en cours dans localStorage,
   pour que l'abonné puisse récupérer sa saisie en cas de coupure
   réseau, fermeture accidentelle d'onglet, refresh, etc.

   Sécurité :
    - Stockage local uniquement (jamais envoyé sur un serveur)
    - TTL de 24h : un brouillon plus vieux est ignoré (et purgé)
    - Une clé par type de formulaire (ex: "draft:order", "draft:vehicle")
    - Pas de stockage de données ultra-sensibles (signatures complètes
      bypass — leur dataURL pèse trop lourd et n'est pas critique)
*/
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DRAFT_PREFIX = "iocar_draft_";

function saveDraft(key, formData) {
  try {
    const payload = {
      data: formData,
      ts: Date.now(),
    };
    localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify(payload));
  } catch (e) {
    // Quota plein ou autre — silencieusement ignoré, pas critique
  }
}

function loadDraft(key) {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + key);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (!payload?.ts || Date.now() - payload.ts > DRAFT_TTL_MS) {
      // Expiré → on purge
      localStorage.removeItem(DRAFT_PREFIX + key);
      return null;
    }
    return payload.data;
  } catch (e) {
    return null;
  }
}

function clearDraft(key) {
  try { localStorage.removeItem(DRAFT_PREFIX + key); } catch (e) {}
}

// Nettoie tous les brouillons expirés (à appeler de temps en temps)
function purgeExpiredDrafts() {
  try {
    const now = Date.now();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(DRAFT_PREFIX)) continue;
      try {
        const p = JSON.parse(localStorage.getItem(k) || "{}");
        if (!p?.ts || now - p.ts > DRAFT_TTL_MS) {
          localStorage.removeItem(k);
          i--; // l'index a été décalé après suppression
        }
      } catch (e) {
        localStorage.removeItem(k); // JSON corrompu → on purge
      }
    }
  } catch (e) {}
}

/* ═══════════════════════════════════════════════════════════════
   STORAGE HELPERS — upload images via /api (jamais directement)
═══════════════════════════════════════════════════════════════ */
// Upload une dataURL vers le bucket approprié et retourne { path, signedUrl }.
// Le backend vérifie l'auth, valide le MIME, range le fichier sous garage_<uuid>/.
async function uploadImageToStorage({ kind, dataUrl, filename }) {
  const token = loadSession().token;
  if (!token || token === "demo") {
    // Mode démo : on renvoie la dataURL telle quelle (pas de storage)
    return { path: null, signedUrl: dataUrl, demo: true };
  }
  const res = await fetch("/api/upload-image", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ kind, dataUrl, filename }),
  });
  if (!res.ok) {
    let msg = `Upload error ${res.status}`;
    try { const j = await res.json(); msg = j.error || msg; } catch(e) {}
    throw new Error(msg);
  }
  return res.json();
}

// Régénère une URL signée pour un fichier Storage privé
async function getImageSignedUrl({ bucket, path }) {
  const token = loadSession().token;
  if (!token || token === "demo" || !path) return null;
  const res = await fetch("/api/get-image-url", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ bucket, path }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.signedUrl || null;
}


/* ═══════════════════════════════════════════════════════════════
   STYLES
═══════════════════════════════════════════════════════════════ */
const STYLE = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400&family=DM+Mono:wght@400;500&display=swap');

*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0b0c10;--card:#13141a;--card2:#1c1d26;--card3:#22232e;
  --gold:#d4a843;--gold2:#f0c86a;--gold3:rgba(212,168,67,.15);
  --border:rgba(212,168,67,.14);--border2:rgba(255,255,255,.06);
  --text:#f0ede8;--muted:#6b6a7a;--muted2:#9997aa;
  --green:#3ecf7a;--red:#e55c5c;--blue:#5c9ce5;--orange:#e5973c;
  --radius:10px;
}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
input,textarea,select{font-family:'DM Sans',sans-serif}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:var(--card)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}

/* LAYOUT */
.shell{display:flex;min-height:100vh}
.sidebar{
  width:220px;flex-shrink:0;background:var(--card);
  border-right:1px solid var(--border2);
  display:flex;flex-direction:column;
  position:sticky;top:0;height:100vh;overflow-y:auto;
}
.sidebar.demo-pushed{top:36px;height:calc(100vh - 36px)}
.content{flex:1;overflow-x:hidden;min-width:0}

/* SIDEBAR */
.sidebar-logo{
  padding:24px 20px 20px;
  border-bottom:1px solid var(--border2);
}
.logo-main{font-family:'Syne',sans-serif;font-size:22px;font-weight:800;letter-spacing:3px;color:var(--gold)}
.logo-main span{color:var(--text)}
.logo-sub{font-size:10px;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-top:3px}

.nav-section{padding:16px 12px 8px}
.nav-label{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);padding:0 8px;margin-bottom:6px}
.nav-item{
  display:flex;align-items:center;gap:10px;
  padding:10px 12px;border-radius:8px;
  font-size:13px;font-weight:500;cursor:pointer;
  transition:all .15s;color:var(--muted2);
  border:1px solid transparent;
  margin-bottom:2px;
}
.nav-item:hover{background:var(--card2);color:var(--text)}
.nav-item.active{background:var(--gold3);color:var(--gold);border-color:var(--border)}
.nav-icon{font-size:16px;width:20px;text-align:center}

.sidebar-footer{margin-top:auto;padding:16px;border-top:1px solid var(--border2)}
.dealer-info{font-size:11px;color:var(--muted);line-height:1.6}

/* PAGE */
.page{padding:28px 32px;max-width:1300px}
.page-admin{max-width:none;padding-left:24px;padding-right:24px}
.page.demo-offset{padding-top:64px}
.page-header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:28px;gap:16px;flex-wrap:wrap}
.page-title{font-family:'Syne',sans-serif;font-size:28px;font-weight:800;letter-spacing:1px}
.page-sub{font-size:13px;color:var(--muted);margin-top:4px}

/* BUTTONS */
.btn{display:inline-flex;align-items:center;gap:7px;padding:9px 18px;border-radius:7px;border:none;cursor:pointer;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:600;transition:all .15s;letter-spacing:.3px}
.btn-primary{background:var(--gold);color:#0b0c10}
.btn-primary:hover{background:var(--gold2);transform:translateY(-1px)}
.btn-ghost{background:transparent;color:var(--muted2);border:1px solid var(--border2)}
.btn-ghost:hover{border-color:var(--border);color:var(--text)}
.btn-danger{background:rgba(229,92,92,.15);color:var(--red);border:1px solid rgba(229,92,92,.2)}
.btn-danger:hover{background:rgba(229,92,92,.25)}
.btn-sm{padding:6px 12px;font-size:12px}
.btn-xs{padding:4px 9px;font-size:11px}

/* CARDS */
.card{background:var(--card);border:1px solid var(--border2);border-radius:var(--radius)}
.card-pad{padding:20px 24px}

/* KPI GRID */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-bottom:28px}
.kpi{background:var(--card);border:1px solid var(--border2);border-radius:var(--radius);padding:20px;transition:border-color .2s;cursor:default}
.kpi:hover{border-color:var(--border)}
.kpi-label{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
.kpi-val{font-family:'Syne',sans-serif;font-size:30px;font-weight:700;line-height:1}
.kpi-val.green{color:var(--green)}
.kpi-val.gold{color:var(--gold)}
.kpi-val.red{color:var(--red)}
.kpi-val.blue{color:var(--blue)}
.kpi-foot{font-size:11px;color:var(--muted);margin-top:6px}

/* TABLE */
.tbl-wrap{overflow-x:auto;border-radius:var(--radius);border:1px solid var(--border2)}
table{width:100%;border-collapse:collapse;font-size:13px}
thead th{background:var(--card2);padding:10px 14px;text-align:left;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);font-weight:600;white-space:nowrap}
tbody td{padding:12px 14px;border-bottom:1px solid var(--border2);color:var(--text);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody tr{transition:background .1s;cursor:pointer}
tbody tr:hover td{background:var(--card2)}

/* BADGES */
.badge{display:inline-flex;align-items:center;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:.5px;white-space:nowrap}
.badge-green{background:rgba(62,207,122,.12);color:var(--green);border:1px solid rgba(62,207,122,.2)}
.badge-gold{background:var(--gold3);color:var(--gold);border:1px solid var(--border)}
.badge-red{background:rgba(229,92,92,.12);color:var(--red);border:1px solid rgba(229,92,92,.2)}
.badge-blue{background:rgba(92,156,229,.12);color:var(--blue);border:1px solid rgba(92,156,229,.2)}
.badge-orange{background:rgba(229,151,60,.12);color:var(--orange);border:1px solid rgba(229,151,60,.2)}
.badge-muted{background:rgba(107,106,122,.12);color:var(--muted2);border:1px solid rgba(107,106,122,.2)}

/* PLATE */
.plate{display:inline-flex;align-items:center;gap:5px;background:#fff;border:1.5px solid #003189;border-radius:5px;padding:3px 10px}
.plate-eu{background:#003189;color:#fdd835;font-size:8px;font-weight:700;padding:2px 4px;border-radius:3px;line-height:1.4;text-align:center}
.plate-num{font-family:'DM Mono',monospace;font-size:13px;font-weight:700;color:#111;letter-spacing:2px}

/* FORM */
.form-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
.form-group{display:flex;flex-direction:column;gap:5px}
.form-group.full{grid-column:1/-1}
.form-label{font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);font-weight:600}
.form-input{background:var(--card2);border:1px solid var(--border2);border-radius:7px;padding:9px 12px;color:var(--text);font-size:13px;outline:none;transition:border-color .15s;width:100%}
.form-input:focus{border-color:var(--gold)}
.form-input::placeholder{color:var(--muted)}
select.form-input{cursor:pointer}
textarea.form-input{resize:vertical;min-height:72px}

/* MODAL */
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px);animation:fadein .15s}
@keyframes fadein{from{opacity:0}to{opacity:1}}
.modal{background:var(--card);border:1px solid var(--border);border-radius:14px;width:100%;max-height:90vh;overflow-y:auto;animation:slideup .2s}
@keyframes slideup{from{transform:translateY(20px);opacity:0}to{transform:none;opacity:1}}
.modal-sm{max-width:480px}
.modal-md{max-width:700px}
.modal-lg{max-width:960px}
.modal-hd{display:flex;align-items:center;justify-content:space-between;padding:20px 24px;border-bottom:1px solid var(--border2);position:sticky;top:0;background:var(--card);z-index:1}
.modal-title{font-family:'Syne',sans-serif;font-size:18px;font-weight:700}
.modal-body{padding:24px}
.modal-foot{padding:16px 24px;border-top:1px solid var(--border2);display:flex;justify-content:flex-end;gap:10px}
.close-btn{background:var(--card2);border:none;color:var(--muted2);width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;transition:all .15s}
.close-btn:hover{background:var(--card3);color:var(--text)}

/* TABS */
.tabs{display:flex;gap:4px;background:var(--card);border:1px solid var(--border2);border-radius:9px;padding:4px;margin-bottom:20px;width:fit-content}
.tab{padding:7px 16px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;color:var(--muted2);letter-spacing:.5px}
.tab.active{background:var(--gold);color:#0b0c10}
.tab:not(.active):hover{color:var(--text)}

/* SEARCH BAR */
.search-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.search-input{background:var(--card);border:1px solid var(--border2);border-radius:7px;padding:8px 14px 8px 36px;color:var(--text);font-size:13px;outline:none;width:240px;transition:border-color .15s;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%236b6a7a' stroke-width='2'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.35-4.35'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:12px center}
.search-input:focus{border-color:var(--border)}

/* PROGRESS BAR */
.progress{height:4px;background:var(--card2);border-radius:2px;overflow:hidden;margin-top:8px}
.progress-fill{height:100%;border-radius:2px;transition:width .3s}

/* DIVIDER */
.divider{border:none;border-top:1px solid var(--border2);margin:20px 0}

/* ═══ AUTH SCREENS ═══ */
.auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);padding:20px}
.auth-box{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:40px;width:100%;max-width:420px;animation:slideup .25s}
.auth-error{background:rgba(229,92,92,.12);border:1px solid rgba(229,92,92,.2);color:var(--red);border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:16px}
.auth-success{background:rgba(62,207,122,.1);border:1px solid rgba(62,207,122,.2);color:var(--green);border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:16px}
.auth-switch{text-align:center;margin-top:20px;font-size:13px;color:var(--muted)}
.auth-switch a{color:var(--gold);cursor:pointer;font-weight:600}
.plan-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700}
.plan-trial{background:rgba(212,168,67,.15);color:var(--gold);border:1px solid var(--border)}
.plan-active{background:rgba(62,207,122,.12);color:var(--green);border:1px solid rgba(62,207,122,.2)}
.plan-suspended{background:rgba(229,92,92,.12);color:var(--red);border:1px solid rgba(229,92,92,.2)}

/* ═══ MOBILE RESPONSIVE ═══ */
.hamburger{
  display:none;position:fixed;top:12px;left:12px;z-index:400;
  width:42px;height:42px;border-radius:10px;
  background:var(--card);border:1px solid var(--border2);
  cursor:pointer;align-items:center;justify-content:center;
  flex-direction:column;gap:5px;box-shadow:0 4px 16px rgba(0,0,0,.4);
}
.hamburger span{width:18px;height:2px;background:var(--text);border-radius:2px;transition:all .2s}
.sidebar-overlay{
  display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);
  z-index:300;backdrop-filter:blur(2px);
}
.bottom-nav{
  display:none;position:fixed;bottom:0;left:0;right:0;
  background:var(--card);border-top:1px solid var(--border2);
  z-index:250;padding:6px 4px calc(6px + env(safe-area-inset-bottom));
  grid-template-columns:repeat(5,1fr);gap:0;
}
.bottom-nav-item{
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:3px;padding:6px 4px;border-radius:8px;cursor:pointer;
  font-size:9px;font-weight:600;color:var(--muted2);letter-spacing:.5px;
  text-transform:uppercase;transition:all .15s;
}
.bottom-nav-item.active{color:var(--gold)}
.bottom-nav-item .bn-icon{font-size:20px;line-height:1}

@media(max-width:768px){
  .hamburger{display:flex}
  .sidebar{
    position:fixed;left:-240px;top:0;bottom:0;z-index:350;
    width:240px;transition:left .25s cubic-bezier(.4,0,.2,1);
    box-shadow:4px 0 24px rgba(0,0,0,.5);
  }
  .sidebar.open{left:0}
  .sidebar-overlay{display:block}
  .content{padding-top:0}
  .content.demo-offset{padding-top:36px}
  .page{padding:70px 16px 90px}
  .page-title{font-size:20px;line-height:1.15;word-break:break-word}
  .page-sub{font-size:12px}
  /* Le titre principal de chaque page peut chevaucher le burger menu (top:12px, height:42px).
     On ajoute du padding-top sur le header de page pour que ça respire. */
  .page-header{padding-top:8px}
  .kpi-grid{grid-template-columns:repeat(2,1fr)!important;gap:10px;margin-bottom:20px;justify-content:stretch!important}
  .kpi{padding:14px}
  .kpi-val{font-size:22px}
  .tbl-wrap{border-radius:8px;font-size:12px}
  thead th{padding:8px 10px;font-size:9px}
  tbody td{padding:10px;font-size:12px}
  .modal{border-radius:16px 16px 0 0;max-height:95vh;position:fixed;bottom:0;left:0;right:0;width:100%!important;max-width:100%!important;margin:0}
  .modal-bg{align-items:flex-end;padding:0}
  .modal-lg,.modal-md,.modal-sm{max-width:100%}
  .form-grid{grid-template-columns:1fr}
  .form-group.full{grid-column:1}
  .tabs{overflow-x:auto;width:100%;-webkit-overflow-scrolling:touch}
  .tab{white-space:nowrap;font-size:11px;padding:6px 12px}
  .search-input{width:100%}
  .search-bar{flex-direction:column;align-items:stretch}
  .page-header{flex-direction:column;gap:12px}
  .page-header > div:last-child{display:flex;flex-wrap:wrap;gap:8px}
  .bottom-nav{display:grid}
  /* Masquer le label sidebar sur mobile */
  .sidebar .nav-item{font-size:13px}
  /* Adapte pdoc pour mobile */
  .print-doc{padding:20px}
  .pdoc-head{flex-direction:column;gap:16px}
  .pdoc-parties{flex-direction:column;gap:12px}
  .pdoc-totals{justify-content:flex-end}
  /* Cards CRM */
  .crm-grid{grid-template-columns:1fr!important}
  /* Page Paramètres : grille Logo+Infos passe en pleine largeur */
  .settings-grid{grid-template-columns:1fr!important}
  /* ─── Page Admin mobile ─────────────────────────────────────
     Le tableau garde son scroll horizontal (impossible de réduire
     9 colonnes sans perte d'info), mais on ajoute un hint visuel.
     Les KPI passent en 2 colonnes serrées pour économiser la verticale. */
  .page-admin{padding:70px 12px 90px!important}
  .page-admin .kpi-grid{grid-template-columns:repeat(2,1fr)!important;gap:8px}
  .page-admin .kpi{padding:10px}
  .page-admin .kpi-label{font-size:9px}
  .page-admin .kpi-val{font-size:16px!important}
  /* Hint visuel sur le tableau scrollable : ombre à droite si débordement */
  .page-admin .tbl-wrap{
    position:relative;
    background:linear-gradient(to right,var(--card) 30%,rgba(0,0,0,0)),
               linear-gradient(to right,rgba(0,0,0,0),var(--card) 70%) 100% 0,
               radial-gradient(farthest-side at 0 50%,rgba(212,168,67,.2),rgba(0,0,0,0)),
               radial-gradient(farthest-side at 100% 50%,rgba(212,168,67,.2),rgba(0,0,0,0)) 100% 0;
    background-repeat:no-repeat;
    background-size:40px 100%,40px 100%,15px 100%,15px 100%;
    background-attachment:local,local,scroll,scroll;
  }
  .page-admin table{font-size:11px}
  .page-admin thead th{padding:6px 8px;white-space:nowrap}
  .page-admin tbody td{padding:8px;white-space:nowrap}
  /* ─── Dashboard responsive ─────────────────────────────────────
     Force les grids 2 colonnes du dashboard en pleine largeur sur mobile
     (KPI/camembert, stock dormant/relances, activité/todo).
     On utilise data-mobile-stack="1" sur le conteneur cible côté JSX,
     ou directement les sélecteurs ci-dessous pour les grids existants. */
  .dash-2col{grid-template-columns:1fr!important}
  /* Le donut Répartition trésorerie devient plus petit en mobile et
     se centre verticalement avec sa légende en dessous */
  .dash-piewrap{flex-direction:column!important;gap:12px!important;align-items:stretch!important}
  .dash-pie{width:160px!important;height:160px!important;margin:0 auto!important}
  /* Sélecteur de période : 2 colonnes max au lieu de tout sur 1 ligne */
  .period-selector{flex-wrap:wrap;width:100%}
  .period-selector button{flex:1 1 calc(50% - 4px)!important;text-align:center;padding:8px 6px!important;font-size:11px!important;min-width:0}
  /* Panneau toggles modules : titre sur sa propre ligne */
  .modules-toggle-panel{flex-direction:column!important;align-items:stretch!important}
  .modules-toggle-panel > div:first-child{margin-bottom:6px}
}
@media(max-width:480px){
  .kpi-grid{grid-template-columns:1fr 1fr!important}
  .kpi-val{font-size:20px}
  .btn{font-size:12px;padding:8px 14px}
  .btn-sm{padding:5px 10px;font-size:11px}
  .page-title{font-size:18px}
}
@media print{
  .no-print,.sidebar,.hamburger,.bottom-nav{display:none!important}
  @page{size:A4 portrait;margin:10mm}
  /* Force le layout horizontal de l'en-tête du document, même si l'aperçu d'impression simule une largeur < 768px */
  .pdoc-head{flex-direction:row!important;justify-content:space-between!important;align-items:flex-start!important;gap:24px!important;margin-bottom:16px!important}
  .pdoc-head > div:first-child{flex:1;min-width:0}
  .pdoc-head > div:last-child{flex-shrink:0;text-align:right}
  .pdoc-parties{grid-template-columns:1fr 1fr!important;gap:40px!important;margin-bottom:14px!important}
  .pdoc-type{text-align:right!important}
  .pdoc-ref{text-align:right!important}
  /* Compaction générale pour tenir sur une page */
  .print-doc{padding:0!important;min-height:auto!important}
  .print-doc-bar{display:none!important}
  .pdoc-divider{margin:10px 0!important}
  .pdoc-table{margin-bottom:14px!important}
  .pdoc-table td{padding:6px 14px!important;background:transparent!important}
  .pdoc-table th{padding:6px 14px!important}
  .pdoc-totals{margin-bottom:14px!important}
  .pdoc-trow{padding:5px 0!important}
  .pdoc-footer{margin-top:18px!important;padding-top:12px!important}
  .pdoc-paiements{margin-top:12px!important;padding:10px 14px!important}
  /* FILIGRANE — garantir que le navigateur l'imprime (les couleurs très claires sont supprimées par défaut) */
  .pdoc-watermark{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}
  .pdoc-watermark img{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}
}

/* PRINT DOC */
.print-doc{
  font-family:'DM Sans',sans-serif;
  background:#fff;color:#111;
  padding:36px;
  border-radius:8px;
  min-height:1090px;
  display:flex;
  flex-direction:column;
}
.print-doc-content{flex:1}
.print-doc-bar{
  height:5px;background:linear-gradient(90deg,#d4a843,#f0c86a,#d4a843);
  margin:-36px -36px 32px;
  border-radius:8px 8px 0 0;
}
.pdoc-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px}
.pdoc-logo{font-family:'Syne',sans-serif;font-size:26px;font-weight:800;letter-spacing:3px;color:#111}
.pdoc-type{font-family:'Syne',sans-serif;font-size:20px;font-weight:800;color:#d4a843;text-align:right}
.pdoc-ref{font-size:11px;color:#888;text-align:right;margin-top:4px}
.pdoc-divider{border:none;border-top:1px solid #e8e8e8;margin:20px 0}
.pdoc-parties{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-bottom:28px}
.pdoc-plabel{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#aaa;margin-bottom:6px}
.pdoc-pname{font-size:15px;font-weight:700}
.pdoc-pinfo{font-size:12px;color:#555;line-height:1.8;margin-top:4px}
.pdoc-table{width:100%;border-collapse:collapse;margin-bottom:24px}
.pdoc-table th{background:#f8f6f0;padding:9px 14px;text-align:left;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#888;font-weight:600}
.pdoc-table td{padding:12px 14px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#333}
.pdoc-table tr:last-child td{border-bottom:none}
.pdoc-totals{display:flex;justify-content:flex-end;margin-bottom:28px}
.pdoc-totals-box{width:260px}
.pdoc-trow{display:flex;justify-content:space-between;padding:7px 0;font-size:12px;color:#666;border-bottom:1px solid #f0f0f0}
.pdoc-trow.big{font-size:15px;font-weight:700;color:#111;border-bottom:2px solid #111;padding:10px 0}
.pdoc-footer{display:flex;justify-content:space-between;align-items:flex-end;margin-top:36px;padding-top:20px;border-top:1px solid #e8e8e8}
.pdoc-sig{border-bottom:1px solid #ccc;width:180px;height:55px;display:flex;align-items:flex-end;padding-bottom:6px;font-size:10px;color:#bbb;letter-spacing:1px}
.pdoc-legal{font-size:9px;color:#bbb;max-width:260px;line-height:1.7}
.pdoc-paiements{margin-top:20px;padding:14px 16px;background:#f9f8f5;border-radius:6px}
.pdoc-paiements-title{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#aaa;margin-bottom:10px}

/* VEHICLE FICHE PRINT */
.fiche-print{
  background:linear-gradient(135deg,#0d0d18 0%,#16172a 100%);
  color:#f0ede8;border-radius:12px;overflow:hidden;
  page-break-inside:avoid;
}
@media print{
  .fiche-print{background:#fff!important;color:#111!important;border:1px solid #ddd}
}
.fiche-banner{height:6px;background:linear-gradient(90deg,#d4a843,#f0c86a,#d4a843)}
.fiche-head{padding:24px 28px 16px;display:flex;justify-content:space-between;align-items:flex-start}
.fiche-brand{font-family:'Syne',sans-serif;font-size:36px;font-weight:800;letter-spacing:3px;line-height:1}
.fiche-model{font-size:16px;color:#d4a843;font-weight:600;margin-top:4px}
.fiche-year{font-family:'Syne',sans-serif;font-size:64px;font-weight:800;color:rgba(212,168,67,.12);line-height:1}
.fiche-specs{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:rgba(255,255,255,.06);margin:0 0 0}
.fiche-spec{background:rgba(13,13,24,.8);padding:14px 20px}
@media print{.fiche-spec{background:#f9f9f9!important}.fiche-specs{background:#ddd!important}}
.fiche-slabel{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#6b6a7a;margin-bottom:4px}
.fiche-sval{font-size:14px;font-weight:600}
.fiche-price{padding:20px 28px;display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(212,168,67,.15)}
.fiche-price-label{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#6b6a7a}
.fiche-price-val{font-family:'Syne',sans-serif;font-size:36px;font-weight:800;color:#d4a843}
.fiche-options{padding:0 28px 20px;font-size:12px;color:#9997aa;line-height:1.7}
`;

/* ═══════════════════════════════════════════════════════════════
   UTILS
═══════════════════════════════════════════════════════════════ */
const uid = () => crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
const today = () => new Date().toLocaleDateString("fr-FR");
const fmt = (n) => Number(n || 0).toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const fmtDec = (n) => Number(n || 0).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });

// ─── DATES ──────────────────────────────────────────────────
// Parse une date "DD/MM/YYYY" (format affiché partout dans l'app) en objet Date.
// Retourne null si le format est invalide ou la chaîne vide.
function parseFr(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const m = dateStr.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = new Date(parseInt(yyyy), parseInt(mm) - 1, parseInt(dd));
  return isNaN(d.getTime()) ? null : d;
}

// Renvoie true si dateStr (au format "DD/MM/YYYY") tombe dans la période demandée.
// period ∈ {"day", "month", "year", "all"}. "all" → true sans regarder la date.
// Une date invalide ou manquante renvoie false (sauf pour "all").
function inPeriod(dateStr, period) {
  if (period === "all") return true;
  const d = parseFr(dateStr);
  if (!d) return false;
  const now = new Date();
  if (period === "day") {
    return d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }
  if (period === "month") {
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }
  if (period === "6months") {
    // v8.49.11 — Glissant : entre (aujourd'hui − 6 mois) et aujourd'hui
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
    return d >= sixMonthsAgo && d <= now;
  }
  if (period === "year") {
    return d.getFullYear() === now.getFullYear();
  }
  return true;
}

// Renvoie true si dateStr tombe dans la période *précédente* (hier, mois dernier,
// année dernière). Utile pour les comparatifs "vs période précédente".
// "all" n'a pas de précédent → false.
function inPreviousPeriod(dateStr, period) {
  if (period === "all") return false;
  const d = parseFr(dateStr);
  if (!d) return false;
  const now = new Date();
  if (period === "day") {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    return d.getDate() === yesterday.getDate() && d.getMonth() === yesterday.getMonth() && d.getFullYear() === yesterday.getFullYear();
  }
  if (period === "month") {
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return d.getMonth() === prev.getMonth() && d.getFullYear() === prev.getFullYear();
  }
  if (period === "6months") {
    // v8.49.11 — Précédente : entre −12 mois et −6 mois
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, now.getDate());
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
    return d >= twelveMonthsAgo && d < sixMonthsAgo;
  }
  if (period === "year") {
    return d.getFullYear() === now.getFullYear() - 1;
  }
  return false;
}

// Nombre de jours entiers écoulés entre dateStr (DD/MM/YYYY) et aujourd'hui.
// Retourne null si la date est invalide. Toujours positif si la date est dans le passé.
function daysSince(dateStr) {
  const d = parseFr(dateStr);
  if (!d) return null;
  const now = new Date();
  const ms = now.setHours(0, 0, 0, 0) - d.setHours(0, 0, 0, 0);
  return Math.floor(ms / 86400000);
}

// ─── QUOTA RECHERCHE PLAQUE ──────────────────────────────────
// Constantes partagées par TOUS les points de recherche plaque (dashboard,
// formulaire véhicule, reprise dans facture). Une seule source de vérité.
const QUOTA_FREE = 10;            // recherches gratuites par mois
const COST_EXTRA = 0.20;          // € HT par recherche au-delà du quota

// Renvoie l'état du quota pour un usage donné :
//   { used, remaining, isFree, payantes, montantHT, color, text }
// "text" est prêt à afficher sous un bouton (ex: "7/10 gratuites" ou "12/10 · 0,40 € à facturer").
function getQuotaStatus(usage) {
  const monthKey = new Date().toISOString().slice(0, 7);
  const used = usage?.[monthKey] || 0;
  const isFree = used < QUOTA_FREE;
  const remaining = Math.max(0, QUOTA_FREE - used);
  const payantes = Math.max(0, used - QUOTA_FREE);
  const montantHT = payantes * COST_EXTRA;
  let text, color;
  if (isFree) {
    // Format : "7/10 gratuites" (vert si reste >= 3, orange si reste 1-2)
    text = `${used}/${QUOTA_FREE} gratuites`;
    color = remaining >= 3 ? "var(--green)" : "var(--orange)";
  } else {
    // Format : "12/10 · 0,40 € à facturer" (rouge)
    text = `${used}/${QUOTA_FREE} · ${montantHT.toFixed(2)} € HT à facturer`;
    color = "var(--red)";
  }
  return { used, remaining, isFree, payantes, montantHT, color, text };
}


function getPayStatut(c, type) {
  if (type === "avoir") {
    if (c.reste <= 0.01) return { label: "✅ Remboursé", cls: "badge-green" };
    if (c.encaisse > 0) return { label: "⏳ Partiel", cls: "badge-orange" };
    return { label: "💸 À rembourser", cls: "badge-red" };
  }
  if (c.grandTotal <= 0) return { label: "—", cls: "badge-muted" };
  if (c.reste <= 0.01) return { label: "✅ Soldé", cls: "badge-green" };
  if (c.encaisse > 0) return { label: "⏳ Partiel", cls: "badge-orange" };
  return { label: "💰 À encaisser", cls: "badge-red" };
}
const STATUTS_FLEET = {
  disponible: { label: "Disponible",  cls: "badge-green" },
  réservé:    { label: "Réservé",     cls: "badge-gold" },
  vendu:      { label: "Vendu",       cls: "badge-blue" },
  livré:      { label: "Livré",       cls: "badge-muted" },
  atelier:    { label: "Atelier",     cls: "badge-orange" },
};

function calcOrder(o) {
  const prixVente = parseFloat(o.prix_ht) || 0; // C'est en fait le prix de vente TTC
  const remAmt = parseFloat(o.remise_ttc) || 0;
  const prixApresRemise = prixVente - remAmt;
  const fraisMiseDispo = parseFloat(o.frais_mise_dispo) || 0;
  const carteGrise = parseFloat(o.carte_grise) || 0; // Carte grise = hors TVA toujours
  const avecTva = o.avec_tva !== false;
  const tvaPct = parseFloat(o.tva_pct) || 20;

  // Le prix de vente + frais mise dispo = montant TTC soumis à TVA
  const montantTTC_soumis = prixApresRemise + fraisMiseDispo;

  let ht, tvaAmt;
  if (avecTva) {
    // TVA classique "en dedans" sur tout : HT = TTC / (1 + taux)
    ht = montantTTC_soumis / (1 + tvaPct / 100);
    tvaAmt = montantTTC_soumis - ht;
  } else {
    // v8.48.9 — Régime marge occasion (Art. 297A CGI) :
    //   Le VÉHICULE est vendu sans TVA visible (elle est prélevée sur la marge du
    //   garage, hors facture). Les FRAIS de mise à disposition restent taxables
    //   au taux normal (prestation accessoire indépendante du véhicule d'occasion).
    //   → HT = prixVehicule + (frais/1.20), TVA = (frais - frais/1.20)
    const fraisHt = fraisMiseDispo / (1 + tvaPct / 100);
    ht = prixApresRemise + fraisHt;
    tvaAmt = fraisMiseDispo - fraisHt;
  }

  // Total TTC (BASE TVA) = HT + TVA − reprise véhicule.
  // La reprise vient en déduction du TTC (c'est l'équivalent d'une remise
  // sur le prix). La carte grise est traitée à part comme débours ci-dessous.
  // v8.49.11 — Sémantique fiscalement correcte : la carte grise n'est PLUS
  // dans le TTC (base TVA), elle est en débours séparé (art. 267 II 2° CGI).
  //   - c.ttc         = HT + TVA (hors débours)         → base fiscale / CA
  //   - c.debourTotal = somme des débours refacturés    → HORS CA (compte 467)
  //   - c.grandTotal  = c.ttc + c.debourTotal            → à payer par le client
  const repriseValeur = o.reprise_active ? (parseFloat(o.reprise_valeur) || 0) : 0;
  const ttc = montantTTC_soumis - repriseValeur;
  const debourTotal = carteGrise;
  const grandTotal = ttc + debourTotal;

  // Acompte versé à la signature (TTC, par défaut 0).
  // L'acompte EST un encaissement réel — il doit être inclus dans `encaisse`
  // pour que le Reste à payer affiché dans le modal de paiement soit correct.
  // ⚠ Pour les AVOIRS : on ignore l'acompte. Un avoir est un remboursement, pas
  // une vente — il n'a pas de logique "acompte signature". Si l'order est cloné
  // d'une facture qui en avait un, on le neutralise ici.
  const acompteTtc = o.type === "avoir" ? 0 : (parseFloat(o.acompte_ttc) || 0);
  const paiementsTotal = (o.paiements || []).reduce((s, p) => s + (parseFloat(p.montant) || 0), 0);
  const encaisse = acompteTtc + paiementsTotal;
  // v8.49.11 — reste calculé sur grandTotal (ce que paye vraiment le client, avec débours)
  const reste = grandTotal - encaisse;

  // Net après acompte = utile pour l'affichage sur le PDF (séparation visuelle
  // entre acompte signature et paiements ultérieurs)
  // v8.49.11 — sur grandTotal aussi.
  const netApresAcompte = grandTotal - acompteTtc;

  // Les avoirs : le signe négatif est appliqué sur ttc/ht/tva pour le dashboard
  // Mais encaisse et reste restent en valeur absolue pour la logique de paiement
  const sign = o.type === "avoir" ? -1 : 1;
  return {
    ht: ht * sign, remAmt, base: prixApresRemise, fraisMiseDispo,
    carteGrise, repriseValeur, baseTotal: montantTTC_soumis,
    tvaAmt: tvaAmt * sign,
    ttc: ttc * sign,                    // v8.49.11 — TTC hors débours (base TVA)
    debourTotal: debourTotal * sign,    // v8.49.11 — Somme débours (art. 267 II 2°)
    grandTotal: grandTotal * sign,      // v8.49.11 — À payer par le client
    encaisse, reste, avecTva, tvaPct, acompteTtc,
    netApresAcompte: netApresAcompte * sign, paiementsTotal
  };
}

// ─── NUMÉROTATION SÉQUENTIELLE ──────────────────────────────
// v8.49.9 — Séries distinctes pour éviter les collisions IOCAR ↔ IOBILL.
//   BC-YYYY-NNNN       : Bons de commande IOCAR (pas poussés à IOBILL, aucun risque)
//   VEH-YYYY-NNNN      : Factures IOCAR (véhicules) — poussées à IOBILL en insert propre
//   AV-VEH-YYYY-NNNN   : Avoirs IOCAR (avoirs sur véhicules) — poussés à IOBILL en credit_note
// Côté IOBILL les factures natives restent en FAC-YYYY-NNNN et les nouveaux avoirs
// natifs deviennent AV-FAC-YYYY-NNNN pour la symétrie. Les avoirs IOBILL antérieurs
// à ce patch (AV-YYYY-NNNN) restent tels quels — pas de renumérotation rétroactive.
// Comme les préfixes diffèrent, aucun conflit possible.
// Conforme fiscalement : art. 242 nonies A CGI + BOI-TVA-DECLA-30-20-20-10 §120
// autorisent explicitement plusieurs séries de numérotation dès qu'elles sont
// chronologiques et identifiables.
//
// ⚠️ Les anciennes factures IOCAR au format FAC-YYYY-NNNN restent intactes.
// Elles n'apparaîtront simplement plus dans le compteur des VEH- (nouvelle série)
// et n'entrent plus en conflit avec IOBILL puisqu'à la prochaine facture IOCAR,
// on démarre en VEH-YYYY-0001.
function nextRef(orders, type) {
  const year = new Date().getFullYear();
  const prefix = type === "bc" ? "BC"
               : type === "avoir" ? "AV-VEH"
               : "VEH";
  const existing = (orders || [])
    .filter(o => o.type === type && o.ref?.startsWith(`${prefix}-${year}-`))
    // v8.49.9 — .pop() prend le DERNIER segment après split (le numéro),
    // ce qui marche que le préfixe ait 1 tiret (VEH-2026-0001)
    // ou 2 tirets (AV-VEH-2026-0001).
    .map(o => parseInt(o.ref.split("-").pop()) || 0);
  const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  return `${prefix}-${year}-${String(next).padStart(4, "0")}`;
}
const CARBURANT_MAP = {
  "ES": "Essence", "GO": "Diesel", "EL": "Électrique",
  "GH": "Hybride", "FE": "Hybride rechargeable", "GP": "GPL",
  "GN": "GNV", "HY": "Hydrogène", "ESSENCE": "Essence",
  "DIESEL": "Diesel", "GAZOLE": "Diesel", "ELECTRIQUE": "Électrique",
};
function mapCarburant(raw) {
  if (!raw) return "—";
  const k = raw.toUpperCase().trim();
  return CARBURANT_MAP[k] || raw;
}

// Extraire l'année depuis une date MEC (formats: "20/06/2019", "2019-06-20", "2019", etc.)
function getYear(v) {
  const d = v?.date_mise_en_circulation || v?.annee || "";
  if (!d) return "";
  const s = String(d);
  // Format DD/MM/YYYY ou DD-MM-YYYY
  if (s.length >= 10 && (s[2] === "/" || s[2] === "-")) return s.substring(6, 10);
  // Format YYYY-MM-DD
  if (s.length >= 10 && (s[4] === "-" || s[4] === "/")) return s.substring(0, 4);
  // Juste une année
  if (/^\d{4}$/.test(s)) return s;
  return s;
}

// Appel côté serveur : la clé RapidAPI N'EST PLUS dans le bundle JS.
// L'endpoint /api/lookup-plate s'occupe du quota, du report Stripe metered
// et de la normalisation des données. Le front reçoit directement un objet véhicule prêt à l'emploi.
async function aiLookupPlate(plate, _apiKey /* ignoré — la clé reste côté serveur */) {
  const token = loadSession().token;
  if (!token) throw new Error("Non authentifié");

  const res = await fetch("/api/lookup-plate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ plate }),
  });

  if (!res.ok) {
    let msg = `API error ${res.status}`;
    try { const j = await res.json(); msg = j.error || msg; } catch(e) {}
    throw new Error(msg);
  }

  const { vehicle /*, quota */ } = await res.json();
  return vehicle;
}

/* ═══════════════════════════════════════════════════════════════
   STORAGE HOOK
═══════════════════════════════════════════════════════════════ */
function useStored(key, def) {
  const [val, setVal] = useState(def);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let done = false;
    const finish = () => { if (!done) { done = true; setReady(true); } };

    // Timeout de sécurité — si storage ne répond pas en 1.5s, on continue avec la valeur par défaut
    const timer = setTimeout(finish, 1500);

    if (window.storage?.get) {
      window.storage.get(key)
        .then(r => { if (r?.value) { try { setVal(JSON.parse(r.value)); } catch(e) {} } })
        .catch(() => {})
        .finally(() => { clearTimeout(timer); finish(); });
    } else {
      // storage non disponible — mode dégradé
      clearTimeout(timer);
      finish();
    }

    return () => { done = true; clearTimeout(timer); };
  }, []); // eslint-disable-line

  const save = useCallback((v) => {
    setVal(v);
    if (window.storage?.set) {
      window.storage.set(key, JSON.stringify(v)).catch(() => {});
    }
  }, []); // eslint-disable-line

  return [val, save, ready];
}

/* ═══════════════════════════════════════════════════════════════
   PLATE BADGE
═══════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════
   SIGNATURE PAD — Canvas tactile pour signature manuscrite
═══════════════════════════════════════════════════════════════ */
function SignaturePad({ label, onSave, savedImg }) {
  const canvasRef = React.useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);

  const getPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const touch = e.touches ? e.touches[0] : e;
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  };

  const startDraw = (e) => {
    e.preventDefault();
    const ctx = canvasRef.current.getContext("2d");
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    setDrawing(true);
  };

  const draw = (e) => {
    if (!drawing) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext("2d");
    const pos = getPos(e);
    ctx.lineTo(pos.x, pos.y);
    ctx.strokeStyle = "#222";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    setHasDrawn(true);
  };

  const endDraw = (e) => {
    if (e) e.preventDefault();
    setDrawing(false);
  };

  const clear = () => {
    const ctx = canvasRef.current.getContext("2d");
    ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    setHasDrawn(false);
    if (onSave) onSave(null);
  };

  const save = async () => {
    if (!hasDrawn) return;
    const dataUrl = canvasRef.current.toDataURL("image/png");
    // Upload vers Storage privé — on renvoie { path, signedUrl } pour que
    // la facture/bon de commande garde le PATH (immuable) et puisse
    // régénérer une signedUrl au moment de l'affichage/impression.
    try {
      const up = await uploadImageToStorage({
        kind: "signature",
        dataUrl,
        filename: `sig-${Date.now()}`,
      });
      if (onSave) onSave({
        path: up.path,
        url:  up.signedUrl || dataUrl,
        demo: up.demo,
      });
    } catch(err) {
      // Fallback : on garde la dataURL en local si le serveur est indisponible
      console.warn("Upload signature échoué, fallback local :", err.message);
      if (onSave) onSave({ path: null, url: dataUrl, demo: true });
    }
  };

  if (savedImg) {
    // savedImg peut être soit une dataURL (legacy) soit un objet { path, url }
    const imgSrc = typeof savedImg === "string" ? savedImg : (savedImg.url || "");
    return (
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: "var(--muted)", marginBottom: 6 }}>{label}</div>
        <img src={imgSrc} alt="Signature" style={{ maxWidth: 240, maxHeight: 80, border: "1px solid var(--border2)", borderRadius: 6, background: "#fff" }} />
        <div style={{ marginTop: 6 }}>
          <button className="btn btn-ghost btn-xs" onClick={() => onSave(null)}>✕ Effacer</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: "var(--muted)", marginBottom: 6 }}>{label}</div>
      <canvas
        ref={canvasRef}
        width={280}
        height={90}
        style={{ border: "1px solid var(--border2)", borderRadius: 6, background: "#fff", cursor: "crosshair", touchAction: "none", display: "block" }}
        onMouseDown={startDraw} onMouseMove={draw} onMouseUp={endDraw} onMouseLeave={endDraw}
        onTouchStart={startDraw} onTouchMove={draw} onTouchEnd={endDraw}
      />
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        {hasDrawn && <button className="btn btn-primary btn-xs" onClick={save}>✅ Valider</button>}
        {hasDrawn && <button className="btn btn-ghost btn-xs" onClick={clear}>🗑 Effacer</button>}
        {!hasDrawn && <div style={{ fontSize: 10, color: "var(--muted)" }}>Signez dans le cadre ci-dessus</div>}
      </div>
    </div>
  );
}

function PlateBadge({ plate }) {
  if (!plate) return <span style={{ color: "var(--muted)" }}>—</span>;
  return (
    <div className="plate">
      <div className="plate-eu"><span>🇫🇷</span><br />F</div>
      <span className="plate-num">{plate}</span>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════
   CALCULATEUR CARTE GRISE (ESTIMATION 2026)
═══════════════════════════════════════════════════════════════ */
const TARIFS_REGIONS_2026 = {
  // Tarifs VP par CV fiscal — source : service-public.fr mars 2026
  "Île-de-France": 68.95, "Auvergne-Rhône-Alpes": 43.00, "Bourgogne-Franche-Comté": 60.00,
  "Bretagne": 60.00, "Centre-Val de Loire": 60.00, "Corse": 53.00,
  "Grand Est": 60.00, "Hauts-de-France": 43.00, "Normandie": 60.00,
  "Nouvelle-Aquitaine": 58.00, "Occitanie": 47.00, "Pays de la Loire": 51.00,
  "Provence-Alpes-Côte d'Azur": 60.00,
};

// CTTE (utilitaires) : même tarif
const TARIFS_CTTE_2026 = {
  "Île-de-France": 68.95, "Auvergne-Rhône-Alpes": 43.00, "Bourgogne-Franche-Comté": 60.00,
  "Bretagne": 60.00, "Centre-Val de Loire": 60.00, "Corse": 53.00,
  "Grand Est": 60.00, "Hauts-de-France": 43.00, "Normandie": 60.00,
  "Nouvelle-Aquitaine": 58.00, "Occitanie": 47.00, "Pays de la Loire": 51.00,
  "Provence-Alpes-Côte d'Azur": 60.00,
};

// Mapping code postal (2 premiers chiffres) → région
const DEPT_TO_REGION = {
  "75":"Île-de-France","77":"Île-de-France","78":"Île-de-France","91":"Île-de-France","92":"Île-de-France","93":"Île-de-France","94":"Île-de-France","95":"Île-de-France",
  "01":"Auvergne-Rhône-Alpes","03":"Auvergne-Rhône-Alpes","07":"Auvergne-Rhône-Alpes","15":"Auvergne-Rhône-Alpes","26":"Auvergne-Rhône-Alpes","38":"Auvergne-Rhône-Alpes","42":"Auvergne-Rhône-Alpes","43":"Auvergne-Rhône-Alpes","63":"Auvergne-Rhône-Alpes","69":"Auvergne-Rhône-Alpes","73":"Auvergne-Rhône-Alpes","74":"Auvergne-Rhône-Alpes",
  "21":"Bourgogne-Franche-Comté","25":"Bourgogne-Franche-Comté","39":"Bourgogne-Franche-Comté","58":"Bourgogne-Franche-Comté","70":"Bourgogne-Franche-Comté","71":"Bourgogne-Franche-Comté","89":"Bourgogne-Franche-Comté","90":"Bourgogne-Franche-Comté",
  "22":"Bretagne","29":"Bretagne","35":"Bretagne","56":"Bretagne",
  "18":"Centre-Val de Loire","28":"Centre-Val de Loire","36":"Centre-Val de Loire","37":"Centre-Val de Loire","41":"Centre-Val de Loire","45":"Centre-Val de Loire",
  "2A":"Corse","2B":"Corse","20":"Corse",
  "08":"Grand Est","10":"Grand Est","51":"Grand Est","52":"Grand Est","54":"Grand Est","55":"Grand Est","57":"Grand Est","67":"Grand Est","68":"Grand Est","88":"Grand Est",
  "02":"Hauts-de-France","59":"Hauts-de-France","60":"Hauts-de-France","62":"Hauts-de-France","80":"Hauts-de-France",
  "14":"Normandie","27":"Normandie","50":"Normandie","61":"Normandie","76":"Normandie",
  "16":"Nouvelle-Aquitaine","17":"Nouvelle-Aquitaine","19":"Nouvelle-Aquitaine","23":"Nouvelle-Aquitaine","24":"Nouvelle-Aquitaine","33":"Nouvelle-Aquitaine","40":"Nouvelle-Aquitaine","47":"Nouvelle-Aquitaine","64":"Nouvelle-Aquitaine","79":"Nouvelle-Aquitaine","86":"Nouvelle-Aquitaine","87":"Nouvelle-Aquitaine",
  "09":"Occitanie","11":"Occitanie","12":"Occitanie","30":"Occitanie","31":"Occitanie","32":"Occitanie","34":"Occitanie","46":"Occitanie","48":"Occitanie","65":"Occitanie","66":"Occitanie","81":"Occitanie","82":"Occitanie",
  "44":"Pays de la Loire","49":"Pays de la Loire","53":"Pays de la Loire","72":"Pays de la Loire","85":"Pays de la Loire",
  "04":"Provence-Alpes-Côte d'Azur","05":"Provence-Alpes-Côte d'Azur","06":"Provence-Alpes-Côte d'Azur","13":"Provence-Alpes-Côte d'Azur","83":"Provence-Alpes-Côte d'Azur","84":"Provence-Alpes-Côte d'Azur",
};

// Noms officiels des départements (utilisés dans le sélecteur de carte grise).
// Sources : INSEE — métropole + Corse (DOM-TOM exclus pour l'instant car non couverts par DEPT_TO_REGION).
const DEPT_NAMES = {
  "01":"Ain","02":"Aisne","03":"Allier","04":"Alpes-de-Haute-Provence","05":"Hautes-Alpes",
  "06":"Alpes-Maritimes","07":"Ardèche","08":"Ardennes","09":"Ariège","10":"Aube",
  "11":"Aude","12":"Aveyron","13":"Bouches-du-Rhône","14":"Calvados","15":"Cantal",
  "16":"Charente","17":"Charente-Maritime","18":"Cher","19":"Corrèze","20":"Corse",
  "2A":"Corse-du-Sud","2B":"Haute-Corse","21":"Côte-d'Or","22":"Côtes-d'Armor","23":"Creuse",
  "24":"Dordogne","25":"Doubs","26":"Drôme","27":"Eure","28":"Eure-et-Loir",
  "29":"Finistère","30":"Gard","31":"Haute-Garonne","32":"Gers","33":"Gironde",
  "34":"Hérault","35":"Ille-et-Vilaine","36":"Indre","37":"Indre-et-Loire","38":"Isère",
  "39":"Jura","40":"Landes","41":"Loir-et-Cher","42":"Loire","43":"Haute-Loire",
  "44":"Loire-Atlantique","45":"Loiret","46":"Lot","47":"Lot-et-Garonne","48":"Lozère",
  "49":"Maine-et-Loire","50":"Manche","51":"Marne","52":"Haute-Marne","53":"Mayenne",
  "54":"Meurthe-et-Moselle","55":"Meuse","56":"Morbihan","57":"Moselle","58":"Nièvre",
  "59":"Nord","60":"Oise","61":"Orne","62":"Pas-de-Calais","63":"Puy-de-Dôme",
  "64":"Pyrénées-Atlantiques","65":"Hautes-Pyrénées","66":"Pyrénées-Orientales","67":"Bas-Rhin","68":"Haut-Rhin",
  "69":"Rhône","70":"Haute-Saône","71":"Saône-et-Loire","72":"Sarthe","73":"Savoie",
  "74":"Haute-Savoie","75":"Paris","76":"Seine-Maritime","77":"Seine-et-Marne","78":"Yvelines",
  "79":"Deux-Sèvres","80":"Somme","81":"Tarn","82":"Tarn-et-Garonne","83":"Var",
  "84":"Vaucluse","85":"Vendée","86":"Vienne","87":"Haute-Vienne","88":"Vosges",
  "89":"Yonne","90":"Territoire de Belfort","91":"Essonne","92":"Hauts-de-Seine","93":"Seine-Saint-Denis",
  "94":"Val-de-Marne","95":"Val-d'Oise",
};

// Helper : extrait le code département depuis une adresse (5 chiffres → 2 premiers).
// Identique à la logique de getRegionFromPostal mais retourne le département au lieu de la région.
function getDeptFromPostal(address) {
  if (!address) return null;
  const match = String(address).match(/\b(\d{5})\b/);
  if (!match) return null;
  return match[1].substring(0, 2);
}

function getRegionFromPostal(address) {
  if (!address) return null;
  const match = address.match(/\b(\d{5})\b/);
  if (!match) return null;
  const dept = match[1].substring(0, 2);
  return DEPT_TO_REGION[dept] || null;
}

function calcCarteGrise({ cv, energie, region, genre, dateMEC }) {
  const isCTTE = (genre || "").toUpperCase() === "CTTE";
  const tarifs = isCTTE ? TARIFS_CTTE_2026 : TARIFS_REGIONS_2026;
  const tarifCV = tarifs[region] || 46;
  const isElec = /[eé]lectrique/i.test(energie || "");
  // Âge du véhicule au jour près : si >= 10 ans exactement, tarif divisé par 2
  let ageOver10 = false;
  if (dateMEC) {
    const s = String(dateMEC);
    let mecDate = null;
    if (s.includes("/")) {
      // Format DD/MM/YYYY
      const p = s.split("/");
      if (p.length === 3) mecDate = new Date(parseInt(p[2]), parseInt(p[1]) - 1, parseInt(p[0]));
    } else if (s.includes("-")) {
      // Format YYYY-MM-DD
      mecDate = new Date(s);
    }
    if (mecDate && !isNaN(mecDate.getTime())) {
      const now = new Date();
      const diff = now.getTime() - mecDate.getTime();
      const tenYearsMs = 10 * 365.25 * 24 * 60 * 60 * 1000;
      ageOver10 = diff >= tenYearsMs;
    }
  }
  const coefAge = ageOver10 ? 0.5 : 1;
  // Y1 : taxe régionale
  let exoElec = 0;
  if (isElec) {
    if (region === "Corse" || region === "Pays de la Loire") exoElec = 1;
    else if (region === "Bretagne" || region === "Hauts-de-France") exoElec = 0.5;
  }
  const y1 = (cv || 0) * tarifCV * (1 - exoElec) * coefAge;
  // Y2 : taxe formation professionnelle (34€ pour CTTE, 0€ pour VP)
  const y2 = isCTTE ? 34 : 0;
  // Y3 : PAS de malus CO2 pour les véhicules d'occasion
  const y3 = 0;
  // Y4 : taxe de gestion (11€ fixe)
  const y4 = 11;
  // Y5 : redevance d'acheminement (2.76€ fixe)
  const y5 = 2.76;
  const total = y1 + y2 + y3 + y4 + y5;
  return { y1, y2, y3, y4, y5, total, tarifCV, isElec, isCTTE, exoElec, ageOver10, coefAge };
}

function CarteGriseCalc({ vehicleData, clientAddress, onApply, standalone }) {
  const [cv, setCv] = useState(parseInt(vehicleData?.puissance_fiscale) || parseInt(vehicleData?.puissance_cv) || 5);
  const [energie, setEnergie] = useState(vehicleData?.carburant || "Essence");
  const [genre, setGenre] = useState(vehicleData?.genre || "VP");

  // ─── DÉPARTEMENT / RÉGION ─────────────────────────────────────────────
  // Logique : la source de vérité est le département (2 premiers chiffres du CP).
  // - Auto-détection depuis l'adresse client (clientAddress)
  // - L'abonné peut OVERRIDER manuellement via le sélecteur (deptOverride)
  // - La région utilisée pour le calcul est dérivée du département actif
  // - En mode standalone : pas d'adresse, fallback sur "13" par défaut
  const detectedDept = getDeptFromPostal(clientAddress);
  const [deptOverride, setDeptOverride] = useState(null);
  // Le département actif : override > détecté > fallback "13"
  const activeDept = deptOverride || detectedDept || "13";
  // La région correspondante (utilisée pour le calcul du tarif)
  const region = DEPT_TO_REGION[activeDept] || "Provence-Alpes-Côte d'Azur";
  // Indicateur visuel : la région est-elle auto-détectée (pas overridée) ?
  const isAuto = !deptOverride && !!detectedDept;

  // Liste des énergies utilisée pour le menu déroulant (mode standalone uniquement).
  // Couvre les valeurs reconnues par calcCarteGrise (cf. mapping dans cette fonction).
  const ENERGIES_OPTIONS = ["Essence", "Diesel", "Hybride", "Hybride rechargeable", "Électrique", "GPL", "GNV", "E85"];

  // Liste des départements pour le sélecteur, triés numériquement.
  // On utilise le mapping DEPT_NAMES — affiche "13 — Bouches-du-Rhône" etc.
  const DEPT_OPTIONS = Object.keys(DEPT_NAMES).sort((a, b) => {
    // Tri numérique avec gestion de "2A" / "2B" qui passent après "20"
    const na = parseInt(a, 10) || 0;
    const nb = parseInt(b, 10) || 0;
    if (na !== nb) return na - nb;
    return a.localeCompare(b);
  });

  React.useEffect(() => {
    if (vehicleData?.puissance_fiscale) setCv(parseInt(vehicleData.puissance_fiscale) || 5);
    else if (vehicleData?.puissance_cv) setCv(parseInt(vehicleData.puissance_cv) || 5);
    if (vehicleData?.carburant) setEnergie(vehicleData.carburant);
    if (vehicleData?.genre) setGenre(vehicleData.genre);
  }, [vehicleData?.puissance_fiscale, vehicleData?.puissance_cv, vehicleData?.carburant, vehicleData?.genre]);

  // Quand l'adresse client change (ex: nouveau client sélectionné), on RESET l'override
  // pour que la détection auto reprenne le contrôle. L'abonné peut toujours re-overrider.
  React.useEffect(() => {
    setDeptOverride(null);
  }, [clientAddress]);

  const dateMEC = vehicleData?.date_mise_en_circulation || "";
  const cg = calcCarteGrise({ cv, energie, region, genre, dateMEC });

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 14 }}>
        <div className="form-group">
          <label className="form-label">
            Département {isAuto && <span style={{ fontSize: 9, color: "var(--green)" }}>✓ auto</span>}
            {deptOverride && (
              <span
                onClick={() => setDeptOverride(null)}
                style={{ fontSize: 9, color: "var(--gold)", cursor: "pointer", marginLeft: 6, textDecoration: "underline" }}
                title="Réinitialiser sur le département du client"
              >
                ↺ auto
              </span>
            )}
          </label>
          <select
            className="form-input"
            value={activeDept}
            onChange={e => setDeptOverride(e.target.value)}
            style={{ fontSize: 11 }}
          >
            {DEPT_OPTIONS.map(d => (
              <option key={d} value={d}>{d} — {DEPT_NAMES[d]}</option>
            ))}
          </select>
          {/* Sous-titre indiquant la région calculée — utile car le tarif dépend de la région, pas du département */}
          <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 3, fontStyle: "italic" }}>
            Région : {region}
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Puissance fiscale (CV) {vehicleData?.puissance_fiscale && <span style={{ fontSize: 9, color: "var(--green)" }}>✓ auto</span>}</label>
          <input className="form-input" type="number" min={1} max={100} value={cv} onChange={e => setCv(parseInt(e.target.value) || 1)} />
        </div>
        <div className="form-group">
          <label className="form-label">Énergie {vehicleData?.carburant && <span style={{ fontSize: 9, color: "var(--green)" }}>✓ auto</span>}</label>
          {standalone ? (
            <select className="form-input" value={energie} onChange={e => setEnergie(e.target.value)} style={{ fontSize: 11 }}>
              {ENERGIES_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          ) : (
            <input className="form-input" value={energie} onChange={e => setEnergie(e.target.value)} style={{ fontSize: 11 }} placeholder="Essence, Diesel, Électrique..." />
          )}
        </div>
        <div className="form-group">
          <label className="form-label">Genre {vehicleData?.genre && <span style={{ fontSize: 9, color: "var(--green)" }}>✓ auto</span>}</label>
          <select className="form-input" value={genre} onChange={e => setGenre(e.target.value)} style={{ fontSize: 11 }}>
            <option value="VP">VP — Tourisme</option>
            <option value="CTTE">CTTE — Utilitaire</option>
          </select>
        </div>
      </div>

      <div style={{ background: "var(--card2)", borderRadius: 8, padding: "12px 16px", border: "1px solid var(--border2)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "3px 0" }}>
            <span style={{ color: "var(--muted)" }}>Y.1 Taxe régionale ({cv} CV × {cg.tarifCV.toFixed(2)}€) {cg.isCTTE ? "CTTE" : "VP"}{cg.coefAge < 1 ? " (−50% ≥10 ans)" : ""}{cg.exoElec > 0 ? ` (exo élec ${cg.exoElec * 100}%)` : ""}</span>
            <span style={{ fontWeight: 600 }}>{fmtDec(cg.y1)}</span>
          </div>
          {cg.isCTTE && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "3px 0" }}>
            <span style={{ color: "var(--muted)" }}>Y.2 Taxe formation professionnelle</span>
            <span style={{ fontWeight: 600 }}>{fmtDec(cg.y2)}</span>
          </div>}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "3px 0" }}>
            <span style={{ color: "var(--muted)" }}>Y.4 Taxe de gestion</span>
            <span style={{ fontWeight: 600 }}>{fmtDec(cg.y4)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "3px 0" }}>
            <span style={{ color: "var(--muted)" }}>Y.5 Redevance acheminement</span>
            <span style={{ fontWeight: 600 }}>{fmtDec(cg.y5)}</span>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, padding: "8px 0", borderTop: "2px solid var(--gold)" }}>
          <span style={{ fontSize: 14, fontWeight: 800 }}>TOTAL</span>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: "var(--gold)" }}>{fmtDec(cg.total)}</span>
            {onApply && <button className="btn btn-primary btn-sm" onClick={() => onApply(Math.round(cg.total * 100) / 100)}>
              ✅ Appliquer
            </button>}
          </div>
        </div>
        {cg.isElec && <div style={{ fontSize: 10, color: "var(--green)", marginTop: 4 }}>🔋 Véhicule électrique : exonération taxe régionale</div>}
        <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 4 }}>⚠️ Véhicule d'occasion — pas de malus CO₂</div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════════════════════════ */
function Dashboard({ vehicles, setVehicles, orders, setTab, apiKey, usage, setUsage, livrePolice, dealer, setDealer }) {
  // ─── FILTRE PÉRIODE ─────────────────────────────────────────
  // Le filtre s'applique UNIQUEMENT à : 🏷 Vendus et ✅ Encaissé.
  // Les autres KPIs (stock, BC en cours, à encaisser, solde tréso, activité, suivi)
  // restent des INSTANTANÉS — c'est-à-dire la photo de l'instant présent, indépendante
  // de la période choisie.
  const [period, setPeriod] = useState("month");

  // STOCK : instantané (toujours à date du jour).
  const fleet = vehicles.length;
  const dispo = vehicles.filter(v => v.statut === "disponible").length;

  // VENDUS — filtré par période (sur date_sortie du livre de police).
  const vendu = (livrePolice || []).filter(e => {
    if (!e.date_sortie) return false;
    if (e.motif_sortie && e.motif_sortie !== "vente") return false;
    return inPeriod(e.date_sortie, period);
  }).length;

  // BC EN COURS — instantané, tous les BC non convertis.
  const nbBC = orders.filter(o => o.type === "bc").length;

  // CA total et "À ENCAISSER" — instantanés, sur tous les orders.
  const aEncaisser = orders.reduce((s, o) => {
    if (o.type === "avoir") return s;
    return s + Math.max(0, calcOrder(o).reste);
  }, 0);

  // ENCAISSÉ TOTAL (instantané, toutes périodes) — utilisé uniquement pour le Solde tréso.
  // Identique au calcul filtré ci-dessous, mais sans la condition inPeriod.
  const encaisseTotal = orders.reduce((s, o) => {
    const sign = o.type === "avoir" ? -1 : 1;
    let local = 0;
    if (o.type !== "avoir") {
      local += parseFloat(o.acompte_ttc) || 0;
    }
    for (const p of (o.paiements || [])) {
      local += parseFloat(p.montant) || 0;
    }
    return s + local * sign;
  }, 0);

  // ENCAISSÉ — filtré par période (date des paiements, et date de création pour l'acompte).
  // Pour un avoir, l'encaissement est en réalité un remboursement (donc négatif).
  const encaisse = orders.reduce((s, o) => {
    const sign = o.type === "avoir" ? -1 : 1;
    let local = 0;
    // Acompte signature : compte si la date de création de l'order est dans la période
    // (les avoirs ont acompte_ttc forcé à 0, cf. calcOrder).
    if (o.type !== "avoir") {
      const acompte = parseFloat(o.acompte_ttc) || 0;
      if (acompte > 0 && inPeriod(o.date_creation, period)) {
        local += acompte;
      }
    }
    // Paiements : chaque paiement compte à sa date.
    for (const p of (o.paiements || [])) {
      if (inPeriod(p.date, period)) {
        local += parseFloat(p.montant) || 0;
      }
    }
    return s + local * sign;
  }, 0);

  // v8.49.11 — TVA COLLECTÉE (période) et DÉBOURS REFACTURÉS (période)
  // Base : orders émis (factures + avoirs) dont date_creation ∈ période.
  // - TVA collectée : somme des c.tvaAmt (avoirs → négatifs via calcOrder sign)
  // - Débours refacturés : somme des c.debourTotal (hors CA, art. 267 II 2° CGI)
  // On exclut les BC (bons de commande) car ils ne sont pas encore émis fiscalement.
  const tvaCollectee = orders.reduce((s, o) => {
    if (o.type === "bc") return s;
    if (!inPeriod(o.date_creation, period)) return s;
    const c = calcOrder(o);
    return s + (c.tvaAmt || 0);
  }, 0);
  const debourRefacture = orders.reduce((s, o) => {
    if (o.type === "bc") return s;
    if (!inPeriod(o.date_creation, period)) return s;
    const c = calcOrder(o);
    return s + (c.debourTotal || 0);
  }, 0);
  // Périodes précédentes (comparatif ↗/↘)
  const tvaCollecteePrev = orders.reduce((s, o) => {
    if (o.type === "bc") return s;
    if (!inPreviousPeriod(o.date_creation, period)) return s;
    const c = calcOrder(o);
    return s + (c.tvaAmt || 0);
  }, 0);
  const debourRefacturePrev = orders.reduce((s, o) => {
    if (o.type === "bc") return s;
    if (!inPreviousPeriod(o.date_creation, period)) return s;
    const c = calcOrder(o);
    return s + (c.debourTotal || 0);
  }, 0);

  // ACHATS véhicules — instantané, tous les véhicules en stock + frais docs.
  const totalAchats = vehicles.reduce((s, v) => s + (parseFloat(v.prix_achat) || 0), 0);
  const totalFraisDocs = vehicles.reduce((s, v) => s + (v.documents || []).reduce((s2, d) => s2 + (parseFloat(d.montant) || 0), 0), 0);
  // Solde tréso : INSTANTANÉ PUR — encaissé total (toutes périodes) − achats totaux.
  // Indépendant du sélecteur de période : c'est la photo réelle de la trésorerie à date.
  const soldeTreso = encaisseTotal - totalAchats - totalFraisDocs;
  const tresoPositive = soldeTreso >= 0;

  // ─── STOCK DORMANT ──────────────────────────────────────────
  // Véhicules disponibles classés par âge en stock (date_entree). On garde le top 5.
  // Seuils : ≥ 90 jours = critique (rouge), ≥ 60 jours = à surveiller (orange).
  const stockDormant = vehicles
    .filter(v => v.statut === "disponible")
    .map(v => ({ v, jours: daysSince(v.date_entree) }))
    .filter(x => x.jours !== null && x.jours >= 60)
    .sort((a, b) => b.jours - a.jours)
    .slice(0, 5);
  const cashBloque = stockDormant.reduce((s, x) => s + (parseFloat(x.v.prix_achat) || 0), 0);

  // ─── RELANCES CLIENTS ───────────────────────────────────────
  // Factures avec un reste > 0, classées par ancienneté (date_creation). Top 5.
  // Seuils : ≥ 30 jours = critique, ≥ 15 jours = à surveiller, sinon récent.
  const relances = orders
    .filter(o => o.type === "facture" && calcOrder(o).reste > 0.01)
    .map(o => ({ o, jours: daysSince(o.date_creation), reste: calcOrder(o).reste }))
    .filter(x => x.jours !== null)
    .sort((a, b) => b.jours - a.jours)
    .slice(0, 5);
  const totalRelances = relances.reduce((s, x) => s + x.reste, 0);

  // ─── COMPARATIF VS PÉRIODE PRÉCÉDENTE ───────────────────────
  // Recalcule les mêmes agrégats sur la période précédente (mois dernier, année dernière, etc.)
  const venduPrev = (livrePolice || []).filter(e => {
    if (!e.date_sortie) return false;
    if (e.motif_sortie && e.motif_sortie !== "vente") return false;
    return inPreviousPeriod(e.date_sortie, period);
  }).length;

  const encaissePrev = orders.reduce((s, o) => {
    const sign = o.type === "avoir" ? -1 : 1;
    let local = 0;
    if (o.type !== "avoir") {
      const acompte = parseFloat(o.acompte_ttc) || 0;
      if (acompte > 0 && inPreviousPeriod(o.date_creation, period)) {
        local += acompte;
      }
    }
    for (const p of (o.paiements || [])) {
      if (inPreviousPeriod(p.date, period)) {
        local += parseFloat(p.montant) || 0;
      }
    }
    return s + local * sign;
  }, 0);

  // Helpers pour formatter les variations
  const periodLabel = period === "day" ? "hier" : period === "month" ? "mois dernier" : period === "6months" ? "6 mois précédents" : period === "year" ? "an dernier" : "";
  const variationPct = (current, previous) => {
    if (previous === 0) return current > 0 ? null : 0; // null = pas de précédent significatif
    return Math.round((current - previous) / Math.abs(previous) * 100);
  };

  // ─── ACTIVITÉ RÉCENTE ───────────────────────────────────────
  // 6 derniers documents toutes périodes confondues.
  const recent = [...orders].sort((a, b) => (b.date_creation || "").localeCompare(a.date_creation || "")).slice(0, 6);

  // ─── MODULE "À FAIRE" ───────────────────────────────────────
  // Détecte les actions opérationnelles en attente :
  // 1) BC vieux de plus de 15 jours (probablement à transformer en facture)
  // 2) Avoirs avec un reste à rembourser > 0
  // 3) Véhicules vendus dans le livre de police marqués "_incomplete"
  const todoBC = orders.filter(o => o.type === "bc" && (daysSince(o.date_creation) ?? 0) >= 15);
  const todoAvoirs = orders.filter(o => o.type === "avoir" && calcOrder(o).reste > 0.01);
  const todoLivret = (livrePolice || []).filter(e => e._incomplete);
  const todoCount = todoBC.length + todoAvoirs.length + todoLivret.length;

  // ─── MODULES VISIBLES ───────────────────────────────────────
  // L'utilisateur peut activer/désactiver chaque module. Persistance :
  //   1) Source de vérité : Supabase (colonne garages.ui_prefs.dashboard_modules)
  //      — suit l'abonné sur tous ses appareils
  //   2) Miroir : localStorage — fallback offline et chargement instantané
  //
  // Sécurité : toutes les écritures passent par setDealer → sb.update → RLS Supabase.
  // L'abonné ne peut écrire que sur SON propre garage (policies déjà en place).
  const MODULE_KEYS = ["instantane", "periode", "stock_dormant", "relances", "activite", "todo"];
  const DEFAULT_VISIBLE = { instantane: true, periode: true, stock_dormant: true, relances: true, activite: false, todo: false };

  // Sanitize : ne garde que les clés connues et force en booléen.
  // Empêche l'injection de données arbitraires dans le state même si la BD/localStorage
  // contiennent des valeurs altérées.
  const sanitizeModules = (raw) => {
    if (!raw || typeof raw !== "object") return null;
    const out = {};
    for (const k of MODULE_KEYS) {
      if (k in raw) out[k] = raw[k] === true; // force boolean strict
    }
    return out;
  };

  const [moduleVisible, setModuleVisible] = useState(() => {
    // 1) Tente de lire depuis dealer.ui_prefs (source de vérité)
    try {
      const fromDealer = sanitizeModules(dealer?.ui_prefs?.dashboard_modules);
      if (fromDealer) return { ...DEFAULT_VISIBLE, ...fromDealer };
    } catch (e) { /* ignore */ }
    // 2) Fallback localStorage (pour les abonnés existants avant migration)
    try {
      const raw = localStorage.getItem("iocar_dashboard_modules");
      if (raw) {
        const fromLocal = sanitizeModules(JSON.parse(raw));
        if (fromLocal) return { ...DEFAULT_VISIBLE, ...fromLocal };
      }
    } catch (e) { /* ignore */ }
    return DEFAULT_VISIBLE;
  });

  // Si dealer.ui_prefs change (ex. login depuis un autre appareil ou refresh), on resync.
  useEffect(() => {
    const fromDealer = sanitizeModules(dealer?.ui_prefs?.dashboard_modules);
    if (fromDealer) {
      setModuleVisible(prev => ({ ...DEFAULT_VISIBLE, ...fromDealer }));
    }
  }, [dealer?.ui_prefs?.dashboard_modules]);

  const toggleModule = (key) => {
    if (!MODULE_KEYS.includes(key)) return; // garde-fou
    const next = { ...moduleVisible, [key]: !moduleVisible[key] };
    setModuleVisible(next);
    // Miroir localStorage (chargement instantané au prochain login)
    try { localStorage.setItem("iocar_dashboard_modules", JSON.stringify(next)); } catch (e) { /* ignore */ }
    // Source de vérité : Supabase (via setDealer → sb.update, RLS protégé)
    if (typeof setDealer === "function") {
      const newPrefs = { ...(dealer?.ui_prefs || {}), dashboard_modules: next };
      setDealer({ ...dealer, ui_prefs: newPrefs });
    }
  };


  // ─── RECHERCHE PLAQUE ────────────────────────────────────────
  const [searchPlate, setSearchPlate] = useState("");
  const [searching, setSearching] = useState(false);
  const [foundVehicle, setFoundVehicle] = useState(null); // ouvre VehicleModal

  const monthKey = new Date().toISOString().slice(0, 7);
  const usedThisMonth = usage?.[monthKey] || 0;
  const isFree = usedThisMonth < 10;

  const handlePlateSearch = async () => {
    const plate = searchPlate.trim().toUpperCase().replace(/\s/g, "");
    if (!plate) return;
    if (!isFree) {
      const ok = window.confirm(
        `⚠️ Quota mensuel atteint (${usedThisMonth} recherches ce mois)\n\nCette recherche est payante : 0,20 €\n\nConfirmer ?`
      );
      if (!ok) return;
    }
    setSearching(true);
    try {
      const data = await aiLookupPlate(plate, apiKey);
      setUsage({ ...usage, [monthKey]: usedThisMonth + 1 });
      setFoundVehicle({
        ...data,
        plate,
        options: Array.isArray(data.options) ? data.options.join(", ") : "",
        statut: "disponible",
        date_entree: today(),
        prix_achat: "", prix_vente: "",
      });
    } catch (e) {
      alert(`Erreur : ${e.message}`);
    } finally {
      setSearching(false);
    }
  };

  // Données camembert — on n'affiche que les parts > 0
  // Note : si encaisse est négatif (cas extrême : plus de remboursements que d'encaissements
  // dans la période), on le force à 0 dans le camembert pour ne pas afficher de tranche.
  const pieEncaisse = Math.max(0, encaisse);
  const pieTotal = totalAchats + pieEncaisse + aEncaisser;
  const pieData = [
    { name: "Avance tréso (achats)", value: totalAchats, color: "#e55c5c" },
    { name: "Encaissé", value: pieEncaisse, color: "#3ecf7a" },
    { name: "À encaisser", value: aEncaisser, color: "#e5973c" },
  ].filter(d => d.value > 0);

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0];
    return (
      <div style={{ background: "#1c1d26", border: "1px solid rgba(212,168,67,.2)", borderRadius: 8, padding: "10px 14px" }}>
        <div style={{ fontSize: 12, color: "#9997aa", marginBottom: 4 }}>{d.name}</div>
        <div style={{ fontSize: 16, fontWeight: 700, color: d.payload.color }}>{fmt(d.value)}</div>
        {pieTotal > 0 && <div style={{ fontSize: 11, color: "#6b6a7a", marginTop: 2 }}>{Math.round(d.value / pieTotal * 100)}%</div>}
      </div>
    );
  };

  const CustomLegend = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingLeft: 8 }}>
      {pieData.map(d => (
        <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 12, height: 12, borderRadius: 3, background: d.color, flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 12, color: "#9997aa" }}>{d.name}</div>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "Syne", color: d.color }}>{fmt(d.value)}</div>
          </div>
        </div>
      ))}
      <div style={{ marginTop: 6, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,.06)" }}>
        <div style={{ fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: "#6b6a7a", marginBottom: 4 }}>Solde net tréso</div>
        <div style={{ fontSize: 18, fontWeight: 800, fontFamily: "Syne", color: tresoPositive ? "#3ecf7a" : "#e55c5c" }}>{fmt(soldeTreso)}</div>
        {aEncaisser > 0.01 && (
          <div style={{ fontSize: 11, color: "#d4a843", marginTop: 4 }}>Projection : {fmt(soldeTreso + aEncaisser)}</div>
        )}
      </div>
    </div>
  );

  return (
    <div className="page">
      {/* Modal véhicule ouvert après recherche plaque */}
      {foundVehicle && (
        <VehicleModal
          vehicle={foundVehicle}
          apiKey={apiKey}
          usage={usage}
          setUsage={setUsage}
          onSave={v => {
            setVehicles([v, ...vehicles]);
            setFoundVehicle(null);
            setSearchPlate("");
          }}
          onClose={() => setFoundVehicle(null)}
        />
      )}

      <div className="page-header">
        <div>
          <div className="page-title">Tableau de bord</div>
          <div className="page-sub">Vue d'ensemble de votre activité</div>
        </div>
        {/* BARRE RECHERCHE PLAQUE */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{
            display: "flex", alignItems: "stretch",
            border: "1.5px solid var(--border)", borderRadius: 8, overflow: "hidden",
            transition: "border-color .2s",
          }}
            onFocus={e => e.currentTarget.style.borderColor = "var(--gold)"}
            onBlur={e => e.currentTarget.style.borderColor = "var(--border)"}
          >
            <div style={{
              background: "var(--card2)", padding: "0 12px",
              display: "flex", alignItems: "center", gap: 6,
              borderRight: "1px solid var(--border2)",
              fontFamily: "DM Mono", fontSize: 10, color: "var(--muted)", letterSpacing: 1
            }}>
              🇫🇷 FR
            </div>
            <input
              value={searchPlate}
              onChange={e => setSearchPlate(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === "Enter" && handlePlateSearch()}
              placeholder="AB-123-CD"
              maxLength={9}
              style={{
                background: "var(--card)", border: "none", outline: "none",
                padding: "10px 14px", fontFamily: "DM Mono", fontSize: 18,
                fontWeight: 700, letterSpacing: 4, color: "var(--text)",
                width: 160,
              }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <button
              className={`btn ${isFree ? "btn-primary" : "btn-ghost"}`}
              onClick={handlePlateSearch}
              disabled={searching || !searchPlate.trim()}
              style={!isFree ? { borderColor: "var(--orange)", color: "var(--orange)" } : {}}
            >
              {searching ? "⏳ Recherche..." : isFree ? "🔍 Identifier" : "💳 Identifier (0,20€)"}
            </button>
            {(() => {
              const q = getQuotaStatus(usage);
              return (
                <div style={{ fontSize: 10, textAlign: "right", color: q.color, letterSpacing: .5, fontWeight: 600 }}>
                  {q.text}
                </div>
              );
            })()}
          </div>
        </div>
      </div>

      {/* ───────────────────────────────────────────────────────
          PANNEAU MODULES — toggles d'affichage (persistance localStorage)
          ─────────────────────────────────────────────────────── */}
      <div className="modules-toggle-panel" style={{
        background: "var(--card2)", border: "1px solid var(--border2)",
        borderRadius: 10, padding: "10px 14px", marginBottom: 20,
        display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap"
      }}>
        <div style={{ fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--muted)", flexShrink: 0 }}>
          🎛 Modules
        </div>
        {[
          { key: "instantane", label: "État actuel" },
          { key: "periode", label: "Sur la période" },
          { key: "stock_dormant", label: "Stock dormant" },
          { key: "relances", label: "À relancer" },
          { key: "activite", label: "Activité récente" },
          { key: "todo", label: `À faire${todoCount > 0 ? ` (${todoCount})` : ""}` },
        ].map(m => {
          const on = !!moduleVisible[m.key];
          return (
            <div
              key={m.key}
              onClick={() => toggleModule(m.key)}
              style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}
              title={on ? "Cliquer pour masquer" : "Cliquer pour afficher"}
            >
              <div style={{
                width: 32, height: 18, borderRadius: 9,
                background: on ? "var(--gold)" : "var(--card)",
                border: "1px solid var(--border2)", position: "relative", transition: "background .2s", flexShrink: 0
              }}>
                <div style={{
                  width: 14, height: 14, borderRadius: "50%", background: "#fff",
                  position: "absolute", top: 1,
                  left: on ? 16 : 1,
                  transition: "left .2s", boxShadow: "0 1px 2px rgba(0,0,0,.3)"
                }} />
              </div>
              <span style={{ fontSize: 12, color: on ? "var(--text)" : "var(--muted)", fontWeight: on ? 600 : 400 }}>
                {m.label}
              </span>
            </div>
          );
        })}
      </div>

      {moduleVisible.instantane && <>
      {/* ───────────────────────────────────────────────────────
          KPI — Section 1 : INSTANTANÉ (état présent, non filtré)
          ─────────────────────────────────────────────────────── */}
      <div style={{ fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--muted)", marginBottom: 8, textAlign: "center" }}>
        📸 État actuel · instantané
      </div>
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 220px))", justifyContent: "center", marginBottom: 24 }}>
        <div className="kpi" onClick={() => setTab("fleet")} style={{ cursor: "pointer" }}>
          <div className="kpi-label">🚗 En stock</div>
          <div className="kpi-val gold">{dispo}</div>
          <div className="kpi-foot">{fleet} total</div>
        </div>
        <div className="kpi" onClick={() => setTab("orders")} style={{ cursor: "pointer" }}>
          <div className="kpi-label">📋 BC en cours</div>
          <div className="kpi-val blue">{nbBC}</div>
          <div className="kpi-foot">bons de commande</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">⏳ À encaisser</div>
          <div className="kpi-val" style={{ color: aEncaisser > 0.01 ? "var(--orange)" : "var(--green)" }}>{fmt(aEncaisser)}</div>
          <div className="kpi-foot">{aEncaisser > 0.01 ? "solde restant dû" : "tout soldé ✓"}</div>
        </div>
        <div className="kpi" style={{ border: `1px solid ${tresoPositive ? "rgba(62,207,122,.3)" : "rgba(229,92,92,.3)"}`, background: tresoPositive ? "rgba(62,207,122,.04)" : "rgba(229,92,92,.04)" }}>
          <div className="kpi-label" style={{ color: tresoPositive ? "var(--green)" : "var(--red)" }}>🏦 Solde tréso</div>
          <div className="kpi-val" style={{ color: tresoPositive ? "var(--green)" : "var(--red)" }}>{fmt(soldeTreso)}</div>
          <div className="kpi-foot">encaissé − achats</div>
        </div>
      </div>
      </>}

      {moduleVisible.periode && <>

      {/* ───────────────────────────────────────────────────────
          KPI — Section 2 : PÉRIODE (filtré par le sélecteur)
          ─────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, marginBottom: 8, flexWrap: "wrap"
      }}>
        <div style={{ fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--gold)" }}>
          📅 Sur la période
        </div>
        <div className="period-selector" style={{
          display: "inline-flex", background: "var(--card2)",
          border: "1px solid var(--border2)", borderRadius: 8, padding: 3, gap: 2
        }}>
          {[
            { key: "day", label: "Aujourd'hui" },
            { key: "month", label: "Ce mois" },
            { key: "6months", label: "6 mois" },
            { key: "year", label: "Cette année" },
            { key: "all", label: "Depuis le début" },
          ].map(opt => {
            const active = period === opt.key;
            return (
              <button
                key={opt.key}
                onClick={() => setPeriod(opt.key)}
                style={{
                  padding: "6px 14px", fontSize: 12, fontWeight: 600,
                  borderRadius: 6, border: "none", cursor: "pointer",
                  background: active ? "var(--gold)" : "transparent",
                  color: active ? "#0a0a0a" : "var(--muted)",
                  transition: "all .15s",
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>
      {/* Layout : à gauche les 3 KPIs période en colonne, à droite le camembert
          (qui reflète aussi la période choisie) */}
      <div className="dash-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20, alignItems: "stretch" }}>

        {/* COLONNE GAUCHE : 3 KPIs période */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="kpi" onClick={() => setTab("fleet")} style={{ cursor: "pointer", borderLeft: "3px solid var(--gold)" }}>
            <div className="kpi-label">🏷 Vendus</div>
            <div className="kpi-val" style={{ color: "var(--muted2)" }}>{vendu}</div>
            {period !== "all" ? (() => {
              const diff = vendu - venduPrev;
              const color = diff > 0 ? "var(--green)" : diff < 0 ? "var(--red)" : "var(--muted)";
              const arrow = diff > 0 ? "↗" : diff < 0 ? "↘" : "→";
              return <div className="kpi-foot" style={{ color }}>{arrow} {diff >= 0 ? "+" : ""}{diff} vs {periodLabel}</div>;
            })() : <div className="kpi-foot">véhicules cédés</div>}
          </div>
          <div className="kpi" style={{ borderLeft: "3px solid var(--gold)" }}>
            <div className="kpi-label">✅ Encaissé</div>
            <div className="kpi-val green">{fmt(encaisse)}</div>
            {period !== "all" ? (() => {
              const pct = variationPct(encaisse, encaissePrev);
              if (pct === null) return <div className="kpi-foot" style={{ color: "var(--muted)" }}>nouveau · pas de {periodLabel}</div>;
              const color = pct > 0 ? "var(--green)" : pct < 0 ? "var(--red)" : "var(--muted)";
              const arrow = pct > 0 ? "↗" : pct < 0 ? "↘" : "→";
              return <div className="kpi-foot" style={{ color }}>{arrow} {pct >= 0 ? "+" : ""}{pct}% vs {periodLabel}</div>;
            })() : <div className="kpi-foot">depuis le début</div>}
          </div>
          <div className="kpi" style={{ borderLeft: "3px solid var(--gold)" }}>
            <div className="kpi-label">💰 Panier moyen</div>
            {(() => {
              const panier = vendu > 0 ? encaisse / vendu : 0;
              return <div className="kpi-val gold">{fmt(panier)}</div>;
            })()}
            <div className="kpi-foot">{vendu > 0 ? `${vendu} vente${vendu > 1 ? "s" : ""}` : "aucune vente"}</div>
          </div>
          {/* v8.49.11 — TVA collectée (par période, art. 269 CGI) */}
          <div className="kpi" style={{ borderLeft: "3px solid var(--gold)" }}>
            <div className="kpi-label">📊 TVA collectée</div>
            <div className="kpi-val" style={{ color: "var(--gold)" }}>{fmt(tvaCollectee)}</div>
            {period !== "all" ? (() => {
              const pct = variationPct(tvaCollectee, tvaCollecteePrev);
              if (pct === null) return <div className="kpi-foot" style={{ color: "var(--muted)" }}>nouveau · pas de {periodLabel}</div>;
              const color = pct > 0 ? "var(--green)" : pct < 0 ? "var(--red)" : "var(--muted)";
              const arrow = pct > 0 ? "↗" : pct < 0 ? "↘" : "→";
              return <div className="kpi-foot" style={{ color }}>{arrow} {pct >= 0 ? "+" : ""}{pct}% vs {periodLabel}</div>;
            })() : <div className="kpi-foot">à reverser à l'État</div>}
          </div>
          {/* v8.49.11 — Débours refacturés (HORS CA, art. 267 II 2° CGI) */}
          <div className="kpi" style={{ borderLeft: "3px solid var(--gold)" }}>
            <div className="kpi-label">🪪 Débours refacturés</div>
            <div className="kpi-val" style={{ color: "var(--muted2)" }}>{fmt(debourRefacture)}</div>
            {period !== "all" ? (() => {
              const pct = variationPct(debourRefacture, debourRefacturePrev);
              if (pct === null) return <div className="kpi-foot" style={{ color: "var(--muted)" }}>hors CA (art. 267 II 2°)</div>;
              const color = pct > 0 ? "var(--green)" : pct < 0 ? "var(--red)" : "var(--muted)";
              const arrow = pct > 0 ? "↗" : pct < 0 ? "↘" : "→";
              return <div className="kpi-foot" style={{ color }}>{arrow} {pct >= 0 ? "+" : ""}{pct}% vs {periodLabel}</div>;
            })() : <div className="kpi-foot">hors CA (art. 267 II 2°)</div>}
          </div>
        </div>

        {/* COLONNE DROITE : camembert répartition trésorerie */}
        <div className="card" style={{ borderLeft: "3px solid var(--gold)" }}>
          <div className="card-pad" style={{ borderBottom: "1px solid var(--border2)" }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>🏦 Répartition trésorerie</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>Avance achats · Encaissé · À encaisser</div>
          </div>
          <div style={{ padding: "20px 24px" }}>
            {pieData.length === 0 ? (
              <div style={{ textAlign: "center", color: "var(--muted)", fontSize: 13, padding: "40px 0" }}>
                Aucune donnée financière
              </div>
            ) : (
              <div className="dash-piewrap" style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div className="dash-pie" style={{ width: 200, height: 200, flexShrink: 0 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={pieData}
                        cx="50%"
                        cy="50%"
                        innerRadius={55}
                        outerRadius={90}
                        paddingAngle={3}
                        dataKey="value"
                        strokeWidth={0}
                      >
                        {pieData.map((entry, i) => (
                          <Cell key={i} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip content={<CustomTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <CustomLegend />
              </div>
            )}
          </div>
        </div>
      </div>
      </>}

      {/* ───────────────────────────────────────────────────────
          STOCK DORMANT + RELANCES — côte à côte (modules indépendants)
          Si un seul module est actif, il prend toute la largeur.
          ─────────────────────────────────────────────────────── */}
      {(moduleVisible.stock_dormant || moduleVisible.relances) && (
      <div className="dash-2col" style={{
        display: "grid",
        gridTemplateColumns: (moduleVisible.stock_dormant && moduleVisible.relances) ? "1fr 1fr" : "1fr",
        gap: 16, marginBottom: 20
      }}>

        {moduleVisible.stock_dormant && (
        <div className="card">
          <div className="card-pad" style={{ borderBottom: "1px solid var(--border2)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>⚠ Stock dormant</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>véhicules en stock depuis ≥ 60 jours</div>
            </div>
            {cashBloque > 0 && (
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1, textTransform: "uppercase" }}>cash bloqué</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--orange)", fontFamily: "Syne" }}>{fmt(cashBloque)}</div>
              </div>
            )}
          </div>
          {stockDormant.length === 0 ? (
            <div className="card-pad" style={{ color: "var(--muted)", fontSize: 13 }}>✅ Tout votre stock est récent (&lt; 60j)</div>
          ) : (
            <div>
              {stockDormant.map(({ v, jours }) => {
                const critique = jours >= 90;
                const badgeBg = critique ? "rgba(229,92,92,.15)" : "rgba(229,151,60,.15)";
                const badgeColor = critique ? "var(--red)" : "var(--orange)";
                return (
                  <div
                    key={v.id}
                    onClick={() => setTab("fleet")}
                    style={{ padding: "10px 20px", borderBottom: "1px solid var(--border2)", display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}
                  >
                    <div style={{
                      background: badgeBg, color: badgeColor,
                      fontSize: 11, fontWeight: 700, padding: "4px 8px",
                      borderRadius: 6, minWidth: 50, textAlign: "center",
                      fontFamily: "DM Mono",
                    }}>
                      {jours} j
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {v.marque || "—"} {v.modele || ""} {v.plate ? `· ${v.plate}` : ""}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>
                        {parseFloat(v.prix_achat) > 0 ? `Acheté ${fmt(parseFloat(v.prix_achat))} · ` : ""}entré le {v.date_entree || "—"}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        )}

        {moduleVisible.relances && (
        <div className="card">
          <div className="card-pad" style={{ borderBottom: "1px solid var(--border2)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>📞 À relancer</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>factures avec un reste à encaisser</div>
            </div>
            {totalRelances > 0 && (
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1, textTransform: "uppercase" }}>en attente</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--orange)", fontFamily: "Syne" }}>{fmt(totalRelances)}</div>
              </div>
            )}
          </div>
          {relances.length === 0 ? (
            <div className="card-pad" style={{ color: "var(--muted)", fontSize: 13 }}>✅ Aucune facture en attente</div>
          ) : (
            <div>
              {relances.map(({ o, jours, reste }) => {
                const critique = jours >= 30;
                const moyen = jours >= 15;
                const badgeBg = critique ? "rgba(229,92,92,.15)" : moyen ? "rgba(229,151,60,.15)" : "rgba(94,126,238,.15)";
                const badgeColor = critique ? "var(--red)" : moyen ? "var(--orange)" : "var(--blue)";
                return (
                  <div
                    key={o.id}
                    onClick={() => setTab("orders")}
                    style={{ padding: "10px 20px", borderBottom: "1px solid var(--border2)", display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}
                  >
                    <div style={{
                      background: badgeBg, color: badgeColor,
                      fontSize: 11, fontWeight: 700, padding: "4px 8px",
                      borderRadius: 6, minWidth: 60, textAlign: "center",
                      fontFamily: "DM Mono",
                    }}>
                      +{jours} j
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {o.client?.name || "—"}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>
                        {o.ref} · reste <span style={{ color: "var(--orange)", fontWeight: 600 }}>{fmt(reste)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        )}
      </div>
      )}

      {/* ───────────────────────────────────────────────────────
          ACTIVITÉ RÉCENTE + À FAIRE — côte à côte (modules indépendants)
          ─────────────────────────────────────────────────────── */}
      {(moduleVisible.activite || moduleVisible.todo) && (
      <div className="dash-2col" style={{
        display: "grid",
        gridTemplateColumns: (moduleVisible.activite && moduleVisible.todo) ? "1fr 1fr" : "1fr",
        gap: 16, marginBottom: 20
      }}>

        {moduleVisible.activite && (
        <div className="card">
          <div className="card-pad" style={{ borderBottom: "1px solid var(--border2)" }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>🕒 Activité récente</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>6 derniers documents</div>
          </div>
          {recent.length === 0 ? (
            <div className="card-pad" style={{ color: "var(--muted)", fontSize: 13 }}>Aucune activité</div>
          ) : (
            <div>
              {recent.map(o => {
                const c = calcOrder(o);
                return (
                  <div key={o.id} style={{ padding: "11px 20px", borderBottom: "1px solid var(--border2)", display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 18 }}>{o.type === "facture" ? "🧾" : o.type === "avoir" ? "↩️" : "📝"}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{o.client?.name || "Client non défini"}</div>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>{o.ref} · {o.date_creation}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{fmt(c.grandTotal)}</div>
                      <span className={`badge ${getPayStatut(c, o.type).cls}`}>{getPayStatut(c, o.type).label}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        )}

        {moduleVisible.todo && (
        <div className="card">
          <div className="card-pad" style={{ borderBottom: "1px solid var(--border2)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>✅ À faire</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>actions opérationnelles en attente</div>
            </div>
            {todoCount > 0 && (
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1, textTransform: "uppercase" }}>en attente</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--gold)", fontFamily: "Syne" }}>{todoCount}</div>
              </div>
            )}
          </div>
          {todoCount === 0 ? (
            <div className="card-pad" style={{ color: "var(--muted)", fontSize: 13 }}>🎉 Rien à faire, tout est à jour</div>
          ) : (
            <div>
              {todoBC.length > 0 && (
                <div onClick={() => setTab("orders")} style={{ padding: "10px 20px", borderBottom: "1px solid var(--border2)", display: "flex", alignItems: "flex-start", gap: 12, cursor: "pointer" }}>
                  <span style={{ fontSize: 16, marginTop: 2 }}>📝</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{todoBC.length} BC à transformer en facture</div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>
                      {todoBC.slice(0, 3).map(o => o.ref).join(", ")}{todoBC.length > 3 ? `, +${todoBC.length - 3}` : ""} (&gt; 15 jours)
                    </div>
                  </div>
                </div>
              )}
              {todoLivret.length > 0 && (
                <div onClick={() => setTab("livrepolice")} style={{ padding: "10px 20px", borderBottom: "1px solid var(--border2)", display: "flex", alignItems: "flex-start", gap: 12, cursor: "pointer" }}>
                  <span style={{ fontSize: 16, marginTop: 2 }}>📋</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{todoLivret.length} entrée{todoLivret.length > 1 ? "s" : ""} du livre de police à compléter</div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>information manquante (acheteur, sortie...)</div>
                  </div>
                </div>
              )}
              {todoAvoirs.length > 0 && (
                <div onClick={() => setTab("orders")} style={{ padding: "10px 20px", borderBottom: "1px solid var(--border2)", display: "flex", alignItems: "flex-start", gap: 12, cursor: "pointer" }}>
                  <span style={{ fontSize: 16, marginTop: 2 }}>💸</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{todoAvoirs.length} avoir{todoAvoirs.length > 1 ? "s" : ""} à rembourser</div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>
                      {todoAvoirs.slice(0, 3).map(o => o.ref).join(", ")}{todoAvoirs.length > 3 ? `, +${todoAvoirs.length - 3}` : ""}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        )}
      </div>
      )}
      {/* CALCULATEUR CARTE GRISE */}
      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-pad" style={{ borderBottom: "1px solid var(--border2)" }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>🪪 Calculateur Carte Grise (estimation)</div>
        </div>
        <div className="card-pad">
          <CarteGriseCalc vehicleData={null} clientAddress={null} onApply={null} standalone />
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   VEHICLE FORM MODAL
═══════════════════════════════════════════════════════════════ */
function VehicleModal({ vehicle, onSave, onClose, apiKey, usage, setUsage, garageId, viewMode }) {
  const isEdit = !!vehicle?.id;
  // ─── BROUILLON ───────────────────────────────────────────
  // Comme pour OrderForm : sauvegarde auto en localStorage en mode création,
  // et propose la restauration au montage si une saisie en cours est trouvée.
  const DRAFT_KEY = "vehicle_new";
  const [draftToRestore, setDraftToRestore] = useState(null);

  const [form, setForm] = useState(vehicle ? {
    ...vehicle,
    options: Array.isArray(vehicle.options) ? vehicle.options.join(", ") : vehicle.options || "",
    // Si le véhicule a déjà un prix d'achat, on active le toggle tréso
    includeTreso: !!(parseFloat(vehicle.prix_achat) > 0),
    // v8.39 — Régime TVA hérité ou défaut 'normal'
    vat_regime: vehicle.vat_regime || "normal",
  } : {
    plate: "", marque: "", modele: "", finition: "", date_mise_en_circulation: "",
    motorisation: "", carburant: "Essence", puissance_cv: "", co2: "", boite: "Manuelle 6",
    transmission: "Traction", couleur: "", couleur_int: "", nb_portes: 5, nb_places: 5,
    kilometrage: "", vin: "", date_entree: today(),
    prix_achat: "", prix_vente: "",
    statut: "disponible", options: "", notes: "",
    includeTreso: false,
    // v8.39 — Régime TVA : 'normal' (défaut) ou 'margin_297a' (achat à particulier)
    vat_regime: "normal",
  });
  const [loading, setLoading] = useState(false);

  // Au montage : check si un brouillon "vehicle_new" existe (et qu'on n'est pas en édition)
  useEffect(() => {
    if (isEdit) return;
    const draft = loadDraft(DRAFT_KEY);
    // On ne propose la restauration que si le brouillon contient quelque chose d'utile
    if (draft && (draft.plate || draft.marque || draft.modele || draft.vin)) {
      setDraftToRestore(draft);
    }
  }, []);

  // Sauvegarde auto debouncée du formulaire en mode création
  useEffect(() => {
    if (isEdit) return;
    const t = setTimeout(() => saveDraft(DRAFT_KEY, form), 1000);
    return () => clearTimeout(t);
  }, [form, isEdit]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // ─── QUOTA MENSUEL ────────────────────────────────────────────
  // Utilise les constantes globales (QUOTA_FREE, COST_EXTRA) et le helper getQuotaStatus.
  const monthKey = new Date().toISOString().slice(0, 7); // "2026-04"
  const usedThisMonth = usage?.[monthKey] || 0;
  const quotaStatus = getQuotaStatus(usage);
  const isFree = quotaStatus.isFree;
  const remaining = quotaStatus.remaining;

  const handleAI = async () => {
    if (!form.plate) return;

    // Confirmation si quota dépassé (pas pour l'admin)
    if (!isFree && viewMode !== "admin") {
      const ok = window.confirm(
        `⚠️ Quota mensuel atteint (${usedThisMonth} recherches ce mois)\n\n` +
        `Cette recherche est payante : ${COST_EXTRA.toFixed(2)} €\n\n` +
        `Confirmer la recherche ?`
      );
      if (!ok) return;
    }

    setLoading(true);
    try {
      // Appel serveur : le quota est incrémenté atomiquement en DB et le
      // report Stripe metered est fait côté serveur si overage.
      const data = await aiLookupPlate(form.plate.toUpperCase().replace(/\s/g, ""), apiKey);
      setForm(f => ({ ...f, ...data, options: Array.isArray(data.options) ? data.options.join(", ") : "" }));
      // Mise à jour optimiste du compteur local (le serveur fait déjà l'incrément DB)
      const newUsage = { ...usage, [monthKey]: usedThisMonth + 1 };
      setUsage(newUsage);
    } catch (e) {
      alert(`Erreur de récupération : ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const submit = () => {
    if (!form.marque || !form.modele) return alert("Marque et modèle requis");
    onSave({
      ...form,
      id: form.id || uid(),
      plate: (form.plate || "").toUpperCase().replace(/\s/g, ""),
      prix_achat: form.includeTreso ? (parseFloat(form.prix_achat) || 0) : 0,
      prix_vente: parseFloat(form.prix_vente) || 0,   // toujours sauvegardé
      kilometrage: parseInt(form.kilometrage) || 0,
      options: form.options ? String(form.options).split(",").map(s => s.trim()).filter(Boolean) : [],
    });
    // Purge du brouillon après sauvegarde réussie (mode création uniquement)
    if (!isEdit) clearDraft(DRAFT_KEY);
  };

  return (
    <div className="modal-bg" onClick={e => e.target === e.currentTarget && onClose()}>
      {/* ─── POPUP DE RESTAURATION DE BROUILLON ─────────────
          Identique à celui de OrderForm — propose la reprise d'une saisie
          interrompue (coupure réseau, fermeture accidentelle, refresh). */}
      {draftToRestore && (
        <div className="modal-bg" style={{ zIndex: 1000 }}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <span className="modal-title">📝 Brouillon récupéré</span>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 16 }}>
                Une saisie en cours a été détectée
                {draftToRestore?.plate && <> pour la plaque <strong>{draftToRestore.plate}</strong></>}
                {!draftToRestore?.plate && draftToRestore?.marque && <> pour <strong>{draftToRestore.marque} {draftToRestore.modele || ""}</strong></>}
                .<br />
                Voulez-vous reprendre où vous en étiez ?
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => { clearDraft(DRAFT_KEY); setDraftToRestore(null); }}
                >
                  🗑 Repartir de zéro
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => { setForm(draftToRestore); setDraftToRestore(null); }}
                >
                  ↩ Restaurer ma saisie
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="modal modal-lg">
        <div className="modal-hd">
          <span className="modal-title">{vehicle ? "Modifier le véhicule" : "Ajouter un véhicule"}</span>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {/* Plaque + Identifier */}
          <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "flex-start" }}>
            <input className="form-input" placeholder="Plaque (ex: AB-123-CD)" value={form.plate}
              onChange={e => set("plate", e.target.value.toUpperCase())} style={{ flex: 1, fontFamily: "DM Mono", letterSpacing: 2 }} />
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
              <button className={`btn ${isFree ? "btn-primary" : "btn-ghost"}`} onClick={handleAI} disabled={loading}
                style={!isFree ? { borderColor: "var(--orange)", color: "var(--orange)" } : {}}>
                {loading ? "⏳" : isFree ? "🔍" : "💳"} {loading ? "Recherche..." : "Identifier la plaque"}
              </button>
              <div style={{ fontSize: 10, color: quotaStatus.color, letterSpacing: 1, fontWeight: 600 }}>
                {quotaStatus.text}
              </div>
            </div>
          </div>

          {/* v8.39 — RÉGIME TVA — défini à l'acquisition, hérité au BC */}
          <div style={{
            background: form.vat_regime === "margin_297a" ? "rgba(229,151,60,.08)" : "rgba(212,168,67,.06)",
            border: "1px solid " + (form.vat_regime === "margin_297a" ? "rgba(229,151,60,.3)" : "var(--border2)"),
            borderRadius: 10, padding: "12px 18px", marginBottom: 14,
            display: "flex", alignItems: "center", gap: 14
          }}>
            <div style={{ fontSize: 20 }}>{form.vat_regime === "margin_297a" ? "🧾" : "📑"}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, letterSpacing: 2, textTransform: "uppercase", color: "var(--gold)", fontWeight: 700, marginBottom: 4 }}>
                Régime TVA à la revente
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
                {form.vat_regime === "margin_297a"
                  ? "TVA sur la marge (art. 297 A CGI)"
                  : "TVA normale (20% sur prix total)"}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.4 }}>
                {form.vat_regime === "margin_297a"
                  ? "Acheté à un particulier ou non-assujetti. La TVA ne sera pas mentionnée sur la facture client."
                  : "Acheté à un pro avec TVA déductible. La TVA sera détaillée sur la facture client."}
              </div>
            </div>
            <div style={{
              width: 44, height: 24, borderRadius: 12, cursor: "pointer",
              background: form.vat_regime === "margin_297a" ? "rgba(229,151,60,.6)" : "var(--gold)",
              border: "1px solid var(--border2)", position: "relative", transition: "background .2s", flexShrink: 0
            }} onClick={() => set("vat_regime", form.vat_regime === "margin_297a" ? "normal" : "margin_297a")}>
              <div style={{
                width: 18, height: 18, borderRadius: "50%", background: "#fff",
                position: "absolute", top: 2,
                left: form.vat_regime === "margin_297a" ? 23 : 3,
                transition: "left .2s", boxShadow: "0 1px 3px rgba(0,0,0,.3)"
              }} />
            </div>
          </div>

          {/* PRIX DE VENTE — toujours visible */}
          <div style={{
            background: "rgba(62,207,122,.06)", border: "1px solid rgba(62,207,122,.2)",
            borderRadius: 10, padding: "14px 20px", marginBottom: 14,
            display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap"
          }}>
            <div style={{ fontSize: 20 }}>🏷</div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <div style={{ fontSize: 10, letterSpacing: 2, textTransform: "uppercase", color: "var(--green)", fontWeight: 700, marginBottom: 6 }}>
                Prix de vente TTC
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input className="form-input" type="number" placeholder="0"
                  value={form.prix_vente || ""}
                  onChange={e => set("prix_vente", e.target.value)}
                  style={{ fontSize: 22, fontWeight: 700, fontFamily: "Syne", color: "var(--green)", maxWidth: 180 }}
                />
                <span style={{ fontSize: 18, color: "var(--muted)" }}>€</span>
              </div>
            </div>
            {parseFloat(form.prix_vente) > 0 && form.includeTreso && parseFloat(form.prix_achat) > 0 && (() => {
              const totalDocs = (form.documents || []).reduce((s, d) => s + (parseFloat(d.montant) || 0), 0);
              const coutTotal = parseFloat(form.prix_achat) + totalDocs;
              const marge = parseFloat(form.prix_vente) - coutTotal;
              return (
                <div style={{ textAlign: "center", padding: "8px 14px", background: "var(--card2)", borderRadius: 8, border: "1px solid var(--border2)" }}>
                  <div style={{ fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--muted)", marginBottom: 4 }}>Marge prévue</div>
                  <div style={{ fontSize: 20, fontWeight: 800, fontFamily: "Syne", color: marge >= 0 ? "var(--green)" : "var(--red)" }}>
                    {marge.toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 })}
                  </div>
                  {totalDocs > 0 && (
                    <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>
                      Achat {fmt(parseFloat(form.prix_achat))} + Frais {fmt(totalDocs)} = Coût total {fmt(coutTotal)}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* TRÉSORERIE — Optionnelle (prix d'achat seulement) */}
          <div style={{ marginBottom: 20 }}>
            <div
              style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", marginBottom: form.includeTreso ? 12 : 0 }}
              onClick={() => set("includeTreso", !form.includeTreso)}
            >
              <div style={{
                width: 40, height: 22, borderRadius: 11, flexShrink: 0,
                background: form.includeTreso ? "var(--gold)" : "var(--card2)",
                border: "1px solid var(--border2)", position: "relative", transition: "background .2s"
              }}>
                <div style={{
                  width: 16, height: 16, borderRadius: "50%", background: "#fff",
                  position: "absolute", top: 2, left: form.includeTreso ? 21 : 3, transition: "left .2s",
                  boxShadow: "0 1px 3px rgba(0,0,0,.3)"
                }} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: form.includeTreso ? "var(--red)" : "var(--muted2)" }}>
                💸 Inclure le prix d'achat dans la trésorerie
              </span>
            </div>

            {form.includeTreso && (
              <div style={{
                background: "linear-gradient(135deg, rgba(229,92,92,.08), rgba(229,92,92,.04))",
                border: "1px solid rgba(229,92,92,.25)", borderRadius: 10,
                padding: "14px 20px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap"
              }}>
                <div style={{ fontSize: 20 }}>💸</div>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, textTransform: "uppercase", color: "var(--red)", fontWeight: 700, marginBottom: 6 }}>
                    Sortie trésorerie — Prix d'achat
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input className="form-input" type="number" placeholder="0"
                      value={form.prix_achat || ""}
                      onChange={e => set("prix_achat", e.target.value)}
                      style={{ fontSize: 22, fontWeight: 700, fontFamily: "Syne", color: "var(--red)", maxWidth: 180 }}
                    />
                    <span style={{ fontSize: 18, color: "var(--muted)" }}>€</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="form-grid">
            {[["marque", "Marque *"], ["modele", "Modèle *"], ["finition", "Finition"], ["genre", "Genre national"], ["date_mise_en_circulation", "Date 1ère MEC"],
              ["motorisation", "Motorisation"], ["puissance_cv", "Puissance (ch)", "number"], ["puissance_fiscale", "Puissance fiscale (CV)", "number"], ["co2", "CO₂ (g/km)", "number"], ["boite", "Boîte"],
              ["couleur", "Couleur ext."], ["couleur_int", "Couleur int."], ["kilometrage", "Kilométrage", "number"],
              ["vin", "N° VIN"], ["date_entree", "Date d'entrée (achat)"], ["carburant", "Carburant"]].map(([k, label, type]) => (
                <div className="form-group" key={k}>
                  <label className="form-label" style={k === "numero_formule" ? { color: "var(--gold)" } : undefined}>{label}</label>
                  <input className="form-input" type={type || "text"} value={form[k] || ""} onChange={e => set(k, e.target.value)} />
                </div>
              ))}
              <div className="form-group">
                <label className="form-label" style={{ color: "var(--gold)" }}>N° de formule</label>
                <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
                  <span style={{ background: "var(--card2)", border: "1px solid var(--border)", borderRight: "none", borderRadius: "6px 0 0 6px", padding: "8px 10px", fontSize: 14, color: "var(--muted)", fontFamily: "DM Mono", letterSpacing: 1 }}>20</span>
                  <input className="form-input" style={{ borderRadius: "0 6px 6px 0", fontFamily: "DM Mono", letterSpacing: 1 }} maxLength={9} value={form.numero_formule || ""} onChange={e => set("numero_formule", e.target.value)} placeholder="24 AB 12345" />
                </div>
              </div>
            <div className="form-group">
              <label className="form-label">Transmission</label>
              <select className="form-input" value={form.transmission} onChange={e => set("transmission", e.target.value)}>
                {["Traction", "Propulsion", "Intégrale (4x4)"].map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div className="form-group full">
              <label className="form-label">Options (séparées par des virgules)</label>
              <input className="form-input" value={Array.isArray(form.options) ? form.options.join(", ") : form.options || ""}
                onChange={e => set("options", e.target.value)} placeholder="GPS, Toit pano, Caméra recul..." />
            </div>

            {/* ── Documents rattachés (CT, entretien, pneus…) ── */}
            <div className="form-group full">
              <label className="form-label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                📎 Documents & Entretiens
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => {
                  const docs = form.documents || [];
                  set("documents", [...docs, {
                    id: uid(), type: "entretien", date: today(),
                    description: "", montant: "", prestataire: "", notes: ""
                  }]);
                }}>+ Ajouter</button>
              </label>
              {(form.documents || []).length === 0 ? (
                <div style={{ padding: "16px", textAlign: "center", color: "var(--muted)", fontSize: 12, background: "var(--card2)", borderRadius: 8 }}>
                  Aucun document rattaché — Ajoutez des factures CT, entretiens, pneus…
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {(form.documents || []).map((doc, idx) => (
                    <div key={doc.id} style={{ background: "var(--card2)", borderRadius: 8, padding: "10px 14px", border: "1px solid var(--border2)" }}>
                      <div style={{ display: "flex", gap: 8, marginBottom: 6, flexWrap: "wrap", alignItems: "center" }}>
                        <select className="form-input" value={doc.type} style={{ width: 140, padding: "5px 8px", fontSize: 11 }}
                          onChange={e => {
                            const docs = [...(form.documents || [])];
                            docs[idx] = { ...docs[idx], type: e.target.value };
                            set("documents", docs);
                          }}>
                          <option value="ct">🔧 Contrôle Technique</option>
                          <option value="entretien">🛠 Entretien / Révision</option>
                          <option value="pneus">🔄 Pneumatiques</option>
                          <option value="carrosserie">🚗 Carrosserie</option>
                          <option value="mecanique">⚙️ Mécanique</option>
                          <option value="assurance">🛡 Assurance</option>
                          <option value="autre">📄 Autre</option>
                        </select>
                        <input type="date" className="form-input" value={doc.date} style={{ width: 140, padding: "5px 8px", fontSize: 11 }}
                          onChange={e => {
                            const docs = [...(form.documents || [])];
                            docs[idx] = { ...docs[idx], date: e.target.value };
                            set("documents", docs);
                          }} />
                        <input className="form-input" placeholder="Montant TTC (€)" value={doc.montant} style={{ width: 110, padding: "5px 8px", fontSize: 11 }}
                          onChange={e => {
                            const docs = [...(form.documents || [])];
                            docs[idx] = { ...docs[idx], montant: e.target.value };
                            set("documents", docs);
                          }} />
                        <input className="form-input" placeholder="Prestataire" value={doc.prestataire} style={{ flex: 1, padding: "5px 8px", fontSize: 11, minWidth: 120 }}
                          onChange={e => {
                            const docs = [...(form.documents || [])];
                            docs[idx] = { ...docs[idx], prestataire: e.target.value };
                            set("documents", docs);
                          }} />
                        <button className="btn btn-danger btn-sm" style={{ padding: "4px 8px", fontSize: 11 }}
                          onClick={() => set("documents", (form.documents || []).filter(d => d.id !== doc.id))}>🗑</button>
                      </div>
                      <input className="form-input" placeholder="Description (ex: Vidange + filtres, CT favorable...)" value={doc.description}
                        style={{ width: "100%", padding: "5px 8px", fontSize: 11 }}
                        onChange={e => {
                          const docs = [...(form.documents || [])];
                          docs[idx] = { ...docs[idx], description: e.target.value };
                          set("documents", docs);
                        }} />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="form-group full">
              <label className="form-label">Notes internes</label>
              <textarea className="form-input" rows={2} value={form.notes || ""} onChange={e => set("notes", e.target.value)} />
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Annuler</button>
          <button className="btn btn-primary" onClick={submit}>💾 Enregistrer</button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   VEHICLE FICHE PRINT
═══════════════════════════════════════════════════════════════ */
function VehicleFiche({ v, dealer, onClose }) {
  return (
    <div className="modal-bg no-print" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-md">
        <div className="modal-hd no-print">
          <span className="modal-title">Aperçu fiche véhicule</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={() => {
              const el = document.querySelector('.fiche-print');
              if (!el) return;
              const win = window.open('', '_blank');
              if (!win) return;
              win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"/>');
              win.document.write('<title>Fiche ' + (v.marque || '') + ' ' + (v.modele || '') + '</title>');
              win.document.write('<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Syne:wght@700;800&display=swap" rel="stylesheet">');
              win.document.write('<style>');
              document.querySelectorAll('style').forEach(s => win.document.write(s.textContent));
              win.document.write('body{margin:0;padding:20px;background:#fff;font-family:"DM Sans",sans-serif}');
              win.document.write('.fiche-print{max-width:700px;margin:0 auto}');
              win.document.write('@page{size:A4 portrait;margin:10mm}');
              win.document.write('@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}');
              win.document.write('</style>');
              win.document.write('</head><body>');
              win.document.write(el.outerHTML);
              win.document.write('</body></html>');
              win.document.close();
              win.focus();
              setTimeout(() => { win.print(); }, 600);
            }}>🖨 Imprimer</button>
            <button className="close-btn" onClick={onClose}>×</button>
          </div>
        </div>
        <div style={{ padding: 24 }}>
          <div className="fiche-print">
            <div className="fiche-banner" />
            <div className="fiche-head">
              <div>
                <div className="fiche-brand">{v.marque}</div>
                <div className="fiche-model">{v.modele} {v.finition}</div>
                <div style={{ marginTop: 12 }}><PlateBadge plate={v.plate} /></div>
              </div>
              <div className="fiche-year">{getYear(v)}</div>
            </div>
            <div className="fiche-specs">
              {[
                ["1ère MEC", v.date_mise_en_circulation || getYear(v)], ["Kilométrage", `${Number(v.kilometrage || 0).toLocaleString("fr-FR")} km`],
                ["Motorisation", v.motorisation], ["Carburant", v.carburant],
                ["Puissance", `${v.puissance_cv} ch`], ["Boîte", v.boite],
                ["Transmission", v.transmission], ["Couleur ext.", v.couleur],
                ["Couleur int.", v.couleur_int], ["Nb portes", v.nb_portes],
                ["Nb places", v.nb_places], ["N° VIN", v.vin],
              ].map(([l, val], i) => (
                <div className="fiche-spec" key={i}>
                  <div className="fiche-slabel">{l}</div>
                  <div className="fiche-sval">{val || "—"}</div>
                </div>
              ))}
            </div>
            {v.options?.length > 0 && (
              <div className="fiche-options">
                <div style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#d4a843", marginBottom: 6 }}>Options & équipements inclus</div>
                {v.options.join(" · ")}
              </div>
            )}
            <div className="fiche-price">
              <div>
                <div className="fiche-price-label">Prix de vente</div>
                <div className="fiche-price-val">{fmt(v.prix_vente)}</div>
                <div style={{ fontSize: 11, color: "#6b6a7a", marginTop: 4 }}>TTC · Extension de garantie possible</div>
              </div>
              <div style={{ textAlign: "right", fontSize: 11, color: "#6b6a7a" }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#f0ede8" }}>{dealer?.name || "AUTO DEALER"}</div>
                <div>{dealer?.address?.split("\n")[0]}</div>
                <div>{dealer?.phone}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   FLEET PAGE
═══════════════════════════════════════════════════════════════ */
function FleetPage({ vehicles, setVehicles, orders, setOrders, apiKey, usage, setUsage, livrePolice, setLivrePolice, viewMode, garageId, dealer, token }) {
  const [modal, setModal] = useState(null);
  const [fiche, setFiche] = useState(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [pendingDelete, setPendingDelete] = useState(null); // {id, label} | null
  const [showDemoLimit, setShowDemoLimit] = useState(false);

  // ── AUTO-CRÉATION LP : surveille les véhicules et crée les entrées manquantes ──
  const prevVehicleIdsRef = React.useRef(new Set());
  React.useEffect(() => {
    if (!setLivrePolice || !vehicles) return;
    const prevIds = prevVehicleIdsRef.current;
    const newVehicles = vehicles.filter(v => !prevIds.has(v.id));
    
    if (newVehicles.length > 0) {
      setLivrePolice(currentLP => {
        const lp = currentLP || [];
        let lpCopy = [...lp];
        let updated = false;
        
        for (const v of newVehicles) {
          const alreadyInLP = lpCopy.find(e => 
            (v.plate && e.immat && e.immat === v.plate) || 
            (v.id && e.vehicle_id && e.vehicle_id === v.id)
          );
          if (alreadyInLP) continue;
          
          const nums = lpCopy.map(e => parseInt(e.num_ordre) || 0);
          // v8.48.8 — Le num de départ peut être défini par le garage (registre papier existant)
          const startOffset = parseInt(dealer?.lp_start_offset) || 1;
          const nextNum = nums.length > 0 ? Math.max(0, ...nums) + 1 : startOffset;

          // Si le véhicule provient d'une reprise, on utilise les infos du client
          // qui a cédé le véhicule pour pré-remplir les champs vendeur du LP.
          // Côté LP, ce client EST le vendeur/fournisseur (point de vue anti-recel).
          // L'abonné devra quand même compléter la pièce d'identité (non capturée en facture).
          const repriseClient = v.origine === "reprise" && v.reprise_client ? v.reprise_client : null;
          const vendeurDefaults = repriseClient ? {
            vendeur_type: repriseClient.type || "particulier",
            vendeur_nom: repriseClient.nom || repriseClient.name || "",       // "name" pour rétrocompat
            vendeur_prenom: repriseClient.prenom || "",
            vendeur_adresse: repriseClient.adresse || repriseClient.address || "", // "address" pour rétrocompat
          } : {
            vendeur_type: "particulier",
            vendeur_nom: "",
            vendeur_prenom: "",
            vendeur_adresse: "",
          };

          // Une entrée auto-créée n'est "incomplete" que si la pièce d'identité ET le prix
          // d'achat manquent. Pour une reprise : prix_achat = 0 (cf. logique reprise =
          // pas de cash décaissé), donc l'entrée reste flagged jusqu'à saisie de la pièce.
          const newEntry = {
            id: crypto.randomUUID ? crypto.randomUUID() : `lp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            vehicle_id: v.id,
            num_ordre: nextNum,
            date_entree: v.date_entree || today(),
            marque: v.marque || "",
            modele: v.modele || "",
            annee: getYear(v) || "",
            couleur: v.couleur || "",
            immat: v.plate || "",
            vin: v.vin || "",
            kilometrage: v.kilometrage || "",
            pays_origine: "France",
            // Pour une reprise : prix_achat = valeur de reprise (référence comptable interne).
            // Pour un véhicule normal : prix_achat saisi par l'abonné.
            prix_achat: v.origine === "reprise"
              ? (parseFloat(v.valeur_reprise) || 0)
              : (v.prix_achat || ""),
            ...vendeurDefaults,
            vendeur_piece_type: "CNI", vendeur_piece_id: "", vendeur_piece_date: "", vendeur_piece_autorite: "",
            mode_reglement: v.origine === "reprise" ? "Reprise (compensation)" : "Virement",
            date_sortie: "", acheteur_nom: "", acheteur_adresse: "",
            // Champs CNI acheteur — OPTIONNELS (n'entrent pas dans isComplete).
            // Bonne pratique mais pas exigée par l'art. R.321-3 du Code pénal.
            acheteur_piece_type: "CNI", acheteur_piece_id: "", acheteur_piece_date: "", acheteur_piece_autorite: "",
            notes: v.origine === "reprise"
              ? (() => {
                  const cedeur = repriseClient
                    ? `${repriseClient.prenom || ""} ${repriseClient.nom || repriseClient.name || ""}`.trim() || "client"
                    : "client";
                  return `Véhicule repris lors de la vente ${v.origine_ref || ""} · Cédé par ${cedeur} · Pièce d'identité à compléter`.trim();
                })()
              : "Entrée créée automatiquement depuis la flotte — à compléter",
            _incomplete: true,
          };
          lpCopy.push(newEntry);
          updated = true;
          console.log(`✅ LP auto-créé: ${v.marque} ${v.modele} (${v.plate || "sans plaque"}) → N°${nextNum}`);
        }
        
        return updated ? lpCopy : lp;
      });
    }
    
    // Mettre à jour le ref avec tous les IDs actuels
    prevVehicleIdsRef.current = new Set(vehicles.map(v => v.id));
  }, [vehicles]); // Se déclenche quand les véhicules changent

  // v8.48.6 — SYNC PRIX_ACHAT : quand un prix_achat est saisi/modifié côté véhicule
  // et que l'entrée LP existe déjà avec prix_achat vide, on synchronise.
  // Sécurité : on ne touche PAS aux entrées LP déjà sorties (historique inaltérable).
  React.useEffect(() => {
    if (!setLivrePolice || !vehicles) return;
    setLivrePolice(currentLP => {
      const lp = currentLP || [];
      let changed = false;
      const next = lp.map(e => {
        // Skip si LP déjà sorti (historique figé), skip si prix_achat déjà renseigné
        if (e.date_sortie) return e;
        if (parseFloat(e.prix_achat) > 0) return e;
        // Trouve le véhicule correspondant
        const v = vehicles.find(x => x.id === e.vehicle_id || (x.plate && e.immat && x.plate === e.immat));
        if (!v) return e;
        const vPrix = parseFloat(v.prix_achat) || 0;
        if (vPrix <= 0) return e;
        changed = true;
        return { ...e, prix_achat: v.prix_achat };
      });
      return changed ? next : lp;
    });
  }, [vehicles]);

  const filtered = vehicles.filter(v => {
    const matchS = !search || `${v.marque} ${v.modele} ${v.plate} ${v.finition}`.toLowerCase().includes(search.toLowerCase());
    const matchF = filter === "all" || v.statut === filter;
    return matchS && matchF;
  });

  const save = (v) => {
    const exists = vehicles.find(x => x.id === v.id);

    // Véhicule passé "livré" → retirer de la flotte + date sortie LP avec infos acheteur
    if (v.statut === "livré") {
      // Trouver la facture/BC liée pour récupérer le client (essayer par vehicle_id puis par plaque)
      const linkedOrder = (orders || []).find(o => o.vehicle_id === v.id) 
        || (orders || []).find(o => v.plate && o.vehicle_plate && o.vehicle_plate === v.plate);
      const clientName = linkedOrder?.client?.name || "";
      const clientAddress = linkedOrder?.client?.address || "";
      const clientPhone = linkedOrder?.client?.phone || "";

      // v8.37 — Calcul du prix de vente final pour propagation au LP
      // Convention IOCAR : `prix_ht` est en fait le prix de vente TTC après remise
      // (cf. calcOrder ligne 733). On reprend la même logique.
      let prixVenteFinal = "";
      if (linkedOrder) {
        const prixVenteRaw = parseFloat(linkedOrder.prix_ht) || 0;
        const remiseAmt = parseFloat(linkedOrder.remise_ttc) || 0;
        const fraisMD = parseFloat(linkedOrder.frais_mise_dispo) || 0;
        const carteGrise = parseFloat(linkedOrder.carte_grise) || 0;
        const reprise = linkedOrder.reprise_active ? (parseFloat(linkedOrder.reprise_valeur) || 0) : 0;
        // Total TTC encaissé par le garage = prix vente TTC - remise + frais + CG - reprise
        prixVenteFinal = ((prixVenteRaw - remiseAmt) + fraisMD + carteGrise - reprise).toFixed(2);
      }

      console.log("🚗 Livré → recherche client:", { vehicleId: v.id, plate: v.plate, found: !!linkedOrder, clientName, prixVenteFinal, ordersCount: (orders || []).length });
      
      if (setLivrePolice) {
        setLivrePolice(currentLP => {
          const lp = currentLP || [];
          const lpEntry = lp.find(e => e.vehicle_id === v.id || (v.plate && e.immat === v.plate));
          if (lpEntry && !lpEntry.date_sortie) {
            console.log("🚗 Livré → LP mise à jour:", v.plate, "→ acheteur:", clientName, "prix_vente:", prixVenteFinal);
            return lp.map(e =>
              e.id === lpEntry.id ? { 
                ...e, 
                date_sortie: today(), 
                acheteur_nom: clientName,
                acheteur_adresse: clientAddress,
                acheteur_phone: clientPhone,
                // v8.37 — On ne touche PAS au prix_achat SAUF si l'entrée LP a été créée
                //         sans prix (import, reprise mal renseignée, etc.)
                //         → on récupère la valeur véhicule courante à ce moment-là.
                // v8.48.6 — Fix : si prix_achat vide côté LP mais renseigné côté véhicule,
                //           on le synchronise pour permettre le calcul de marge.
                prix_achat: (parseFloat(e.prix_achat) > 0)
                  ? e.prix_achat
                  : (parseFloat(v.prix_achat) || e.prix_achat || ""),
                // v8.37 — On remplit prix_vente avec le total TTC final si vide
                // (si déjà rempli manuellement, on respecte la valeur saisie)
                prix_vente: e.prix_vente || prixVenteFinal,
              } : e
            );
          }
          return lp;
        });
      }

      // v8.37 — Hook IO BILL : pousser la facture en PAID à IOBILL (fire-and-forget)
      // Déclenché uniquement si :
      //   - le compte IOBILL est lié
      //   - auto_push activé dans paramètres
      //   - on a trouvé un linkedOrder de type facture
      //   - la facture est totalement soldée (sécurité)
      if (token && dealer?.iobill_auto_push && dealer?.iobill_company_id
          && linkedOrder && linkedOrder.type === 'facture') {
        // Calcul "reste" inline (réplique calcOrder simplifiée)
        const prixVente = parseFloat(linkedOrder.prix_ht) || 0;
        const remAmt = parseFloat(linkedOrder.remise_ttc) || 0;
        const fraisMD = parseFloat(linkedOrder.frais_mise_dispo) || 0;
        const carteGrise = parseFloat(linkedOrder.carte_grise) || 0;
        const reprise = linkedOrder.reprise_active ? (parseFloat(linkedOrder.reprise_valeur) || 0) : 0;
        const ttc = (prixVente - remAmt) + fraisMD + carteGrise - reprise;
        const acompte = parseFloat(linkedOrder.acompte_ttc) || 0;
        const paiements = (Array.isArray(linkedOrder.paiements) ? linkedOrder.paiements : [])
          .reduce((s, p) => s + (parseFloat(p.montant) || 0), 0);
        const reste = ttc - (acompte + paiements);

        if (reste <= 0.01) {
          // Fire-and-forget : pas d'await, n'impacte pas la fluidité
          fetch("/api/iobill-bridge", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ action: "mark_invoice_paid", order_id: linkedOrder.id })
          })
            .then(r => r.json())
            .then(j => {
              if (j.ok && j.invoice_id && setOrders) {
                setOrders(prev => (prev || []).map(o => o.id === linkedOrder.id ? {
                  ...o,
                  iobill_invoice_id: j.invoice_id,
                  iobill_invoice_number: j.invoice_number,
                  iobill_pdf_url: j.pdf_url || o.iobill_pdf_url,
                  iobill_status: j.status || 'paid', // v8.48.2 — propage le status pour que la pilule passe de "brouillon" à "finalisé"
                  iobill_synced_at: new Date().toISOString(),
                  iobill_sync_error: null
                } : o));
                console.log("✅ Facture transmise à IOBILL :", j.invoice_number);
              } else if (j.error) {
                console.warn("Push IOBILL au Livré : erreur", j.error);
              }
            })
            .catch(e => console.warn("Push IOBILL au Livré : échec réseau", e));
        }
      }

      // Supprimer de la flotte — le véhicule est parti
      setVehicles(vehicles.filter(x => x.id !== v.id));
      setModal(null);
      return;
    }

    // Véhicule passé "vendu" → reste dans la flotte, pas de date sortie LP (pas encore livré)
    const next = exists ? vehicles.map(x => x.id === v.id ? v : x) : [v, ...vehicles];
    setVehicles(next);

    setModal(null);
  };

  const del = (id) => {
    setVehicles(vehicles.filter(v => v.id !== id));
    setPendingDelete(null);
  };

  return (
    <div className="page">
      {modal && <VehicleModal vehicle={modal === "add" ? null : modal} onSave={save} onClose={() => setModal(null)} apiKey={apiKey} usage={usage} setUsage={setUsage} garageId={garageId} viewMode={viewMode} />}
      {fiche && <VehicleFiche v={fiche} dealer={dealer} onClose={() => setFiche(null)} />}
      {pendingDelete && (
        <ConfirmModal
          title="Supprimer le véhicule"
          message={`Voulez-vous supprimer définitivement le véhicule ${pendingDelete.label} de la flotte ? Cette action est irréversible.`}
          confirmLabel="Supprimer"
          onConfirm={() => del(pendingDelete.id)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {viewMode === "trial" && showDemoLimit && <DemoLimitModal type="vehicles" onClose={() => setShowDemoLimit(false)} />}

      <div className="page-header">
        <div>
          <div className="page-title">Flotte véhicules</div>
          <div className="page-sub">{vehicles.length} véhicule{vehicles.length !== 1 ? "s" : ""} · {vehicles.filter(v => v.statut === "disponible").length} disponibles</div>
        </div>
        <button className="btn btn-primary" onClick={() => {
          if (viewMode === "trial" && vehicles.length >= DEMO_LIMITS.vehicles) { setShowDemoLimit(true); return; }
          setModal("add");
        }}>+ Ajouter un véhicule</button>
      </div>

      <div className="search-bar" style={{ marginBottom: 16 }}>
        <input className="search-input" placeholder="Rechercher marque, modèle, plaque..." value={search} onChange={e => setSearch(e.target.value)} />
        <div className="tabs" style={{ margin: 0 }}>
          {[["all", "Tous"], ...Object.entries(STATUTS_FLEET).map(([k, v]) => [k, v.label])].map(([k, l]) => (
            <div key={k} className={`tab${filter === k ? " active" : ""}`} onClick={() => setFilter(k)}>{l}</div>
          ))}
        </div>
      </div>

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Plaque</th><th>Véhicule</th><th>Année</th><th>Motorisation</th>
              <th>Km</th><th>Achat TTC</th><th>Frais TTC</th><th>Vente TTC</th><th>Marge</th><th>Statut</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={10} style={{ textAlign: "center", color: "var(--muted)", padding: 40 }}>Aucun véhicule trouvé</td></tr>
            )}
            {filtered.map(v => {
              const totalDocs = (v.documents || []).reduce((s, d) => s + (parseFloat(d.montant) || 0), 0);
              const coutTotal = (parseFloat(v.prix_achat) || 0) + totalDocs;
              const marge = (parseFloat(v.prix_vente) || 0) - coutTotal;
              const lpEntry = livrePolice?.find(e => e.vehicle_id === v.id || e.immat === v.plate);
              const lpIncomplete = lpEntry?._incomplete || !lpEntry;
              return (
                <tr key={v.id}>
                  <td>
                    <PlateBadge plate={v.plate} />
                    {lpIncomplete && (
                      <div style={{ fontSize: 9, color: "var(--orange)", marginTop: 3, letterSpacing: .5 }}
                        title={lpEntry ? "Livre de Police incomplet" : "Pas encore dans le Livre de Police"}>
                        {lpEntry ? "⚠️ LP incomplet" : "⚠️ Absent du LP"}
                      </div>
                    )}
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{v.marque} {v.modele}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>{v.finition} · {v.couleur}</div>
                  </td>
                  <td>{getYear(v)}</td>
                  <td>
                    <div style={{ fontSize: 12 }}>{v.motorisation}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>{v.carburant} · {v.puissance_cv}ch</div>
                  </td>
                  <td style={{ fontFamily: "DM Mono", fontSize: 12 }}>{Number(v.kilometrage || 0).toLocaleString("fr-FR")}</td>
                  <td style={{ fontFamily: "DM Mono", fontSize: 12 }}>{fmt(v.prix_achat)}</td>
                  <td style={{ fontFamily: "DM Mono", fontSize: 12, color: totalDocs > 0 ? "var(--orange)" : "var(--muted)" }}>
                    {totalDocs > 0 ? fmt(totalDocs) : "—"}
                    {(v.documents || []).length > 0 && <div style={{ fontSize: 9, color: "var(--muted)" }}>{(v.documents || []).length} doc{(v.documents || []).length > 1 ? "s" : ""}</div>}
                  </td>
                  <td style={{ fontFamily: "DM Mono", fontWeight: 700, color: "var(--gold)" }}>{fmt(v.prix_vente)}</td>
                  <td style={{ fontFamily: "DM Mono", color: marge >= 0 ? "var(--green)" : "var(--red)", fontWeight: 600 }}>{fmt(marge)}</td>
                  <td><span className={`badge ${STATUTS_FLEET[v.statut]?.cls || "badge-muted"}`}>{STATUTS_FLEET[v.statut]?.label}</span></td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="btn btn-ghost btn-xs" onClick={() => setFiche(v)}>🏷 Fiche</button>
                      {v.statut === "vendu" && (
                        <button className="btn btn-ghost btn-xs" style={{ color: "var(--green)" }}
                          title="Marquer comme livré"
                          onClick={() => save({ ...v, statut: "livré" })}>
                          🚗 Livré
                        </button>
                      )}
                      <button className="btn btn-ghost btn-xs" onClick={() => setModal(v)}>✏️</button>
                      {v.statut === "vendu" ? (
                        <button className="btn btn-danger btn-xs" style={{ opacity: 0.3, cursor: "not-allowed" }} onClick={() => alert("Impossible de supprimer un véhicule vendu non livré.\nPassez-le en « Livré » d'abord.")}>🗑</button>
                      ) : (
                        <button className="btn btn-danger btn-xs" onClick={() => setPendingDelete({ id: v.id, label: `${v.marque} ${v.modele} ${v.plate ? `(${v.plate})` : ""}` })}>🗑</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   CONFIRM MODAL — réutilisable partout
═══════════════════════════════════════════════════════════════ */
function AvoirChoiceModal({ order, totalTtc, onTotal, onPartiel, onCancel }) {
  return (
    <div className="modal-bg" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="modal modal-sm" style={{ maxWidth: 460 }}>
        <div className="modal-hd">
          <span className="modal-title" style={{ color: "var(--red)" }}>↩️ Créer un avoir</span>
          <button className="close-btn" onClick={onCancel}>×</button>
        </div>
        <div className="modal-body" style={{ padding: "20px 24px" }}>
          <p style={{ fontSize: 14, color: "var(--muted2)", lineHeight: 1.6, margin: "0 0 16px 0" }}>
            Avoir sur la facture <strong style={{ color: "var(--text)", fontFamily: "monospace" }}>{order.ref}</strong>
          </p>
          <div style={{
            padding: "12px 16px",
            background: "rgba(255,255,255,.03)",
            border: "1px solid rgba(255,255,255,.08)",
            borderRadius: 8,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>Montant total TTC</span>
            <span style={{ fontSize: 18, fontWeight: 600, color: "var(--gold)" }}>{fmtDec(totalTtc)}</span>
          </div>
          <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6, margin: "16px 0 0 0" }}>
            Choisissez le type d'avoir à créer :
          </p>
        </div>
        <div className="modal-foot" style={{ gap: 8, flexWrap: "wrap" }}>
          <button className="btn btn-ghost" onClick={onCancel}>Annuler</button>
          <button className="btn btn-danger" onClick={onPartiel}>Avoir partiel</button>
          <button className="btn btn-primary" onClick={onTotal}>Avoir total</button>
        </div>
      </div>
    </div>
  );
}

function AvoirPartielModal({ order, totalTtc, onConfirm, onCancel }) {
  const [montant, setMontant] = useState("");
  const [error, setError] = useState("");

  const handleConfirm = () => {
    const val = parseFloat(String(montant).replace(",", "."));
    if (!val || val <= 0) {
      setError("Veuillez saisir un montant valide supérieur à 0.");
      return;
    }
    if (val > totalTtc) {
      setError(`Le montant ne peut pas dépasser le total TTC (${fmtDec(totalTtc)}).`);
      return;
    }
    onConfirm(val);
  };

  return (
    <div className="modal-bg" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="modal modal-sm" style={{ maxWidth: 440 }}>
        <div className="modal-hd">
          <span className="modal-title" style={{ color: "var(--red)" }}>↩️ Avoir partiel</span>
          <button className="close-btn" onClick={onCancel}>×</button>
        </div>
        <div className="modal-body" style={{ padding: "20px 24px" }}>
          <p style={{ fontSize: 14, color: "var(--muted2)", lineHeight: 1.6, margin: "0 0 16px 0" }}>
            Avoir partiel sur la facture <strong style={{ color: "var(--text)", fontFamily: "monospace" }}>{order.ref}</strong>
          </p>
          <div style={{
            padding: "12px 16px",
            background: "rgba(255,255,255,.03)",
            border: "1px solid rgba(255,255,255,.08)",
            borderRadius: 8,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}>
            <span style={{ fontSize: 13, color: "var(--muted)" }}>Total TTC de la facture</span>
            <span style={{ fontSize: 16, fontWeight: 600, color: "var(--gold)" }}>{fmtDec(totalTtc)}</span>
          </div>
          <label style={{ display: "block", fontSize: 13, color: "var(--muted)", marginBottom: 6 }}>
            Montant de l'avoir (€)
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            max={totalTtc}
            value={montant}
            onChange={e => { setMontant(e.target.value); setError(""); }}
            onKeyDown={e => { if (e.key === "Enter") handleConfirm(); }}
            placeholder="Ex : 500.00"
            autoFocus
            style={{
              width: "100%",
              padding: "10px 12px",
              fontSize: 15,
              background: "rgba(255,255,255,.05)",
              border: `1px solid ${error ? "var(--red)" : "rgba(255,255,255,.1)"}`,
              borderRadius: 8,
              color: "var(--text)",
              outline: "none",
            }}
          />
          {error && (
            <p style={{ fontSize: 12, color: "var(--red)", margin: "8px 0 0 0" }}>{error}</p>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onCancel}>Annuler</button>
          <button className="btn btn-primary" onClick={handleConfirm}>Créer l'avoir</button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({ title, message, confirmLabel = "Supprimer", onConfirm, onCancel }) {
  return (
    <div className="modal-bg" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="modal modal-sm" style={{ maxWidth: 420 }}>
        <div className="modal-hd">
          <span className="modal-title" style={{ color: "var(--red)" }}>🗑 {title}</span>
          <button className="close-btn" onClick={onCancel}>×</button>
        </div>
        <div className="modal-body" style={{ padding: "20px 24px" }}>
          <p style={{ fontSize: 14, color: "var(--muted2)", lineHeight: 1.6, margin: 0 }}>{message}</p>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onCancel}>Annuler</button>
          <button className="btn btn-danger" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   DEMO LIMITS
═══════════════════════════════════════════════════════════════ */
const DEMO_LIMITS = { vehicles: 2, orders: 2, clients: 2 };

function DemoLimitModal({ type, onClose }) {
  const labels = { vehicles: "véhicules", orders: "bons de commande / factures", clients: "clients CRM" };
  const limits = { vehicles: 2, orders: 2, clients: 2 };
  return (
    <div className="modal-bg" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-sm" style={{ maxWidth: 440, textAlign: "center" }}>
        <div className="modal-body" style={{ padding: "36px 32px" }}>
          <div style={{ fontSize: 52, marginBottom: 16 }}>🚀</div>
          <div style={{ fontFamily: "Syne", fontSize: 20, fontWeight: 800, marginBottom: 10 }}>
            Limite démo atteinte
          </div>
          <div style={{ fontSize: 13, color: "var(--muted2)", lineHeight: 1.7, marginBottom: 24 }}>
            Le mode démo est limité à <strong style={{ color: "var(--text)" }}>{limits[type]} {labels[type]}</strong>.<br />
            Abonnez-vous pour accéder à toutes les fonctionnalités sans limite.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <button className="btn btn-primary" style={{ justifyContent: "center", padding: "12px" }}
              onClick={() => { onClose(); window.dispatchEvent(new CustomEvent("iocar_goto_register")); }}>
              🚀 S'abonner — 34,99€/mois
            </button>
            <button className="btn btn-ghost btn-sm" style={{ justifyContent: "center" }} onClick={onClose}>
              Continuer en démo
            </button>
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 16, lineHeight: 1.6 }}>
            Vos données démo sont conservées lors de l'abonnement.<br />
            Paiement par carte bancaire requis.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   PAYMENT MODAL
═══════════════════════════════════════════════════════════════ */
function PaymentModal({ order, onSave, onClose }) {
  const c = calcOrder(order);
  const isAvoir = order.type === "avoir";
  const displayTtc = Math.abs(c.grandTotal); // v8.49.11 — Total à payer (avec débours)
  const displayAcompte = c.acompteTtc;
  const displayPaiements = c.paiementsTotal;
  const displayEncaisse = Math.abs(c.encaisse);
  const displayReste = Math.abs(c.reste);
  const [form, setForm] = useState({ date: today(), montant: displayReste.toFixed(2), mode: "Virement" });
  const modes = ["Virement", "Chèque", "Espèces", "CB", "Financement"];
  const submit = () => {
    if (!parseFloat(form.montant)) return;
    const pmt = { id: uid(), ...form, montant: parseFloat(form.montant) };
    const updated = { ...order, paiements: [...(order.paiements || []), pmt] };
    const newC = calcOrder(updated);
    updated.statut = Math.abs(newC.reste) <= 0.01 ? "payé" : Math.abs(newC.encaisse) > 0 ? "partiel" : updated.statut;
    onSave(updated);
  };
  return (
    <div className="modal-bg" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-sm">
        <div className="modal-hd">
          <span className="modal-title">{isAvoir ? "Enregistrer un remboursement" : "Enregistrer un paiement"}</span>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div style={{ background: "var(--card2)", borderRadius: 8, padding: "14px 16px", marginBottom: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ color: "var(--muted)" }}>{isAvoir ? "Montant avoir" : "Total TTC"}</span>
              <span style={{ fontWeight: 700 }}>{fmtDec(displayTtc)}</span>
            </div>
            {/* Ligne acompte (uniquement si > 0) — l'acompte est un encaissement réel */}
            {displayAcompte > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: 6 }}>
                <span style={{ color: "var(--muted)" }}>Acompte versé à la signature</span>
                <span style={{ color: "var(--green)" }}>- {fmtDec(displayAcompte)}</span>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginTop: 6 }}>
              <span style={{ color: "var(--muted)" }}>{isAvoir ? "Déjà remboursé (paiements)" : "Déjà encaissé (paiements)"}</span>
              <span style={{ color: "var(--green)" }}>- {fmtDec(displayPaiements)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, fontWeight: 700, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border2)" }}>
              <span>{isAvoir ? "Reste à rembourser" : "Reste à payer"}</span>
              <span style={{ color: displayReste <= 0.01 ? "var(--green)" : "var(--orange)" }}>{fmtDec(displayReste)}</span>
            </div>
          </div>
          <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <div className="form-group">
              <label className="form-label">Date</label>
              <input className="form-input" type="text" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="form-group">
              <label className="form-label">Mode</label>
              <select className="form-input" value={form.mode} onChange={e => setForm(f => ({ ...f, mode: e.target.value }))}>
                {modes.map(m => <option key={m}>{m}</option>)}
              </select>
            </div>
            <div className="form-group full">
              <label className="form-label">Montant (€)</label>
              <input className="form-input" type="number" step="0.01" value={form.montant} onChange={e => setForm(f => ({ ...f, montant: e.target.value }))} />
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Annuler</button>
          <button className="btn btn-primary" onClick={submit}>✅ Enregistrer</button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   ORDER / INVOICE FORM
═══════════════════════════════════════════════════════════════ */
function OrderForm({ order, vehicles, onSave, onClose, apiKey, clients, setClients, orders, setVehiclesRaw, usage, setUsage }) {
  const isEdit = !!order?.id;
  // ─── BROUILLON ───────────────────────────────────────────
  // Clé du brouillon — un seul à la fois pour les NOUVEAUX documents.
  // En mode édition, pas de brouillon (on travaille sur des données réelles).
  const DRAFT_KEY = "order_new";
  // État pour proposer la restauration au montage si un brouillon existe
  const [draftToRestore, setDraftToRestore] = useState(null);

  const [form, setForm] = useState(order || {
    type: "bc", ref: "", date_creation: today(), date_echeance: "",
    client: { name: "", address: "", phone: "", email: "", siren: "" },
    vehicle_id: "", vehicle_plate: "", vehicle_label: "",
    vehicle_data: null, // données complètes du véhicule pour la désignation
    prix_ht: "", remise_ttc: 0, tva_pct: 20, avec_tva: true,
    frais_mise_dispo: 180, // frais de mise à disposition (par défaut 180€)
    garantie_mois: 3, // durée garantie : 3, 6 ou 12 mois
    carte_grise: 0, // frais carte grise
    acompte_ttc: 0, // acompte versé à la signature (en TTC, par défaut 0)
    // Reprise véhicule (optionnelle)
    reprise_active: false,
    reprise_plate: "",
    reprise_marque: "",
    reprise_modele: "",
    reprise_annee: "",
    reprise_vin: "",
    reprise_km: "",
    reprise_valeur: 0,
    reprise_ajoutee_flotte: false,
    categorie_operation: "livraison_biens",
    tva_sur_debits: false,
    paiements: [], notes: ""
  });

  // Au montage : si nouveau document et brouillon existant, on propose la restauration
  useEffect(() => {
    if (isEdit) return;
    const draft = loadDraft(DRAFT_KEY);
    if (draft && draft.client?.name || draft && (draft.prix_ht || draft.notes || draft.vehicle_id)) {
      // On ne propose la restauration que si le brouillon contient quelque chose d'utile
      setDraftToRestore(draft);
    }
  }, []); // une seule fois au montage

  // Sauvegarde auto du brouillon — uniquement en mode création, pas en édition.
  // Pour ne pas saturer le localStorage, on debounce à 1s après chaque modif.
  useEffect(() => {
    if (isEdit) return;
    const t = setTimeout(() => saveDraft(DRAFT_KEY, form), 1000);
    return () => clearTimeout(t);
  }, [form, isEdit]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const setClient = (k, v) => setForm(f => ({ ...f, client: { ...f.client, [k]: v } }));

  // ── CRM : sélection + création rapide ────────────────────
  const [clientSearch, setClientSearch] = useState("");
  const [showClientDropdown, setShowClientDropdown] = useState(false);
  const [showCreateClient, setShowCreateClient] = useState(false);
  const [newClientForm, setNewClientForm] = useState({ civilite: "", nom: "", prenom: "", email: "", phone: "", adresse: "", code_postal: "", ville: "", pays: "France" });
  // ── Reprise véhicule : recherche par plaque ──────────────
  const [repriseSearching, setRepriseSearching] = useState(false);

  const filteredClients = (clients || []).filter(c =>
    !clientSearch || `${c.prenom} ${c.nom} ${c.email} ${c.phone}`.toLowerCase().includes(clientSearch.toLowerCase())
  );

  const selectClientFromCrm = (c) => {
    const fullAddr = [c.adresse, c.code_postal && c.ville ? `${c.code_postal} ${c.ville}` : (c.code_postal || c.ville || ""), c.pays && c.pays !== "France" ? c.pays : ""].filter(Boolean).join("\n");
    setForm(f => ({
      ...f,
      client_id: c.id,
      client: {
        name: `${c.prenom || ""} ${c.nom}`.trim(),
        // v8.48.7 — On stocke aussi nom/prénom séparés pour le Cerfa (ordre NOM Prénom obligatoire)
        nom: c.nom || "",
        prenom: c.prenom || "",
        address: fullAddr || c.adresse || "",
        phone: c.phone || "",
        email: c.email || "",
        civilite: c.civilite || "",
      }
    }));
    setClientSearch("");
    setShowClientDropdown(false);
  };

  const createAndSelectClient = () => {
    if (!newClientForm.nom.trim()) return alert("Le nom est requis");
    const newClient = {
      id: uid(),
      // Prospect si BC (pas encore de facture), Client si facture directe
      statut: form.type === "bc" ? "prospect" : "client",
      date_contact: today(),
      annotations: [], notes: "", vehicule_interet: "", budget: 0,
      ...newClientForm,
    };
    if (setClients) setClients([newClient, ...(clients || [])]);
    selectClientFromCrm(newClient);
    setShowCreateClient(false);
    setNewClientForm({ civilite: "", nom: "", prenom: "", email: "", phone: "", adresse: "", code_postal: "", ville: "", pays: "France" });
  };

  const linkedClient = form.client_id ? (clients || []).find(c => c.id === form.client_id) : null;

  const selectVehicle = (id) => {
    const v = vehicles.find(x => x.id === id);
    if (!v) return set("vehicle_id", "");
    // v8.39 — Hérite le régime TVA du véhicule (défini à l'acquisition)
    //   normal      → avec_tva = true  (TVA visible sur facture)
    //   margin_297a → avec_tva = false (TVA marge, pas mentionnée)
    const vatRegime = v.vat_regime || "normal";
    const heriteAvecTva = vatRegime !== "margin_297a";
    setForm(f => ({
      ...f,
      vehicle_id: id,
      vehicle_plate: v.plate,
      vehicle_label: `${v.marque} ${v.modele} ${v.finition || ""} (${getYear(v)})`.trim(),
      vehicle_data: {
        plate: v.plate, marque: v.marque, modele: v.modele, finition: v.finition,
        annee: getYear(v), date_mise_en_circulation: v.date_mise_en_circulation, vin: v.vin, carburant: v.carburant, puissance_cv: v.puissance_cv,
        puissance_fiscale: v.puissance_fiscale, co2: v.co2, genre: v.genre || "VP",
        kilometrage: v.kilometrage, couleur: v.couleur, motorisation: v.motorisation,
        boite: v.boite, date_entree: v.date_entree,
        date_mise_en_circulation: v.date_mise_en_circulation, options: v.options,
      },
      prix_ht: f.prix_ht || v.prix_vente || "",
      // Hérite régime TVA et synchronise avec_tva (sauf si l'user a déjà fait un choix manuel)
      vehicle_vat_regime: vatRegime,
      avec_tva: heriteAvecTva,
    }));
  };

  const c = calcOrder(form);

  const submit = () => {
    if (!form.client.name) return alert("Nom du client requis");
    // Générer la ref séquentielle si pas encore définie
    const ref = form.ref || nextRef(orders, form.type);
    onSave({ ...form, id: form.id || uid(), ref });
    // On purge le brouillon après sauvegarde réussie
    if (!isEdit) clearDraft(DRAFT_KEY);
  };

  return (
    <div className="modal-bg" onClick={e => e.target === e.currentTarget && onClose()}>
      {/* ─── POPUP DE RESTAURATION DE BROUILLON ─────────────
          S'affiche au montage si un brouillon existe (saisie en cours
          interrompue par fermeture/coupure). L'abonné choisit de
          restaurer ou de repartir de zéro. */}
      {draftToRestore && (
        <div className="modal-bg" style={{ zIndex: 1000 }}>
          <div className="modal modal-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <span className="modal-title">📝 Brouillon récupéré</span>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 16 }}>
                Une saisie en cours a été détectée
                {draftToRestore?.client?.name && <> pour <strong>{draftToRestore.client.name}</strong></>}
                {draftToRestore?.vehicle_label && <> sur <strong>{draftToRestore.vehicle_label}</strong></>}
                .<br />
                Voulez-vous reprendre où vous en étiez ?
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => { clearDraft(DRAFT_KEY); setDraftToRestore(null); }}
                >
                  🗑 Repartir de zéro
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => { setForm(draftToRestore); setDraftToRestore(null); }}
                >
                  ↩ Restaurer ma saisie
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="modal modal-lg">
        <div className="modal-hd">
          <span className="modal-title">{isEdit ? `Modifier ${form.ref}` : "Nouveau document"}</span>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>
            <div className="form-group">
              <label className="form-label">Type de document</label>
              <select className="form-input" value={form.type} onChange={e => {
                const t = e.target.value;
                set("type", t);
                set("ref", nextRef(orders, t));
              }}>
                <option value="bc">Bon de commande</option>
                <option value="facture">Facture</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Référence</label>
              <input className="form-input" value={form.ref || nextRef(orders, form.type)} onChange={e => set("ref", e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Date</label>
              <input className="form-input" value={form.date_creation} onChange={e => set("date_creation", e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Livraison le</label>
              <input className="form-input" value={form.date_echeance} onChange={e => set("date_echeance", e.target.value)} placeholder="jj/mm/aaaa" />
            </div>
          </div>

          {/* ── SECTION CLIENT ── */}
          <div style={{ fontFamily: "Syne", fontSize: 13, fontWeight: 700, letterSpacing: 1, color: "var(--gold)", textTransform: "uppercase", marginBottom: 12 }}>CLIENT</div>

          {/* Badge client lié */}
          {linkedClient && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, padding: "8px 12px", background: "rgba(62,207,122,.08)", border: "1px solid rgba(62,207,122,.2)", borderRadius: 8 }}>
              <span style={{ fontSize: 18 }}>✅</span>
              <div style={{ flex: 1, fontSize: 13 }}>
                <strong>{linkedClient.prenom} {linkedClient.nom}</strong>
                <span style={{ color: "var(--muted)", marginLeft: 8, fontSize: 11 }}>Fiche CRM liée</span>
              </div>
            </div>
          )}

          {/* Dropdown recherche CRM */}
          {showClientDropdown && (
            <div style={{ marginBottom: 14, background: "var(--card2)", borderRadius: 10, border: "1px solid var(--border)", padding: 12 }}>
              <input className="form-input" placeholder="Rechercher un client CRM..." value={clientSearch}
                onChange={e => setClientSearch(e.target.value)} autoFocus style={{ marginBottom: 8 }} />
              <div style={{ maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                {filteredClients.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "16px 12px" }}>
                    <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
                      Aucun client trouvé pour <strong>"{clientSearch}"</strong>
                    </div>
                    <button className="btn btn-primary btn-sm" onClick={() => {
                      // Pré-remplir le formulaire avec la recherche en cours
                      const parts = clientSearch.trim().split(" ");
                      setNewClientForm({
                        prenom: parts.length > 1 ? parts.slice(0, -1).join(" ") : "",
                        nom: parts[parts.length - 1] || clientSearch,
                        email: "", phone: "", adresse: ""
                      });
                      setShowClientDropdown(false);
                      setShowCreateClient(true);
                    }}>
                      ➕ Créer "{clientSearch}"
                    </button>
                  </div>
                ) : filteredClients.map(c => (
                  <div key={c.id} onClick={() => selectClientFromCrm(c)}
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", borderRadius: 6, cursor: "pointer", background: "var(--card)", border: "1px solid var(--border2)" }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = "var(--gold)"}
                    onMouseLeave={e => e.currentTarget.style.borderColor = "var(--border2)"}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{c.prenom} {c.nom}</div>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>{c.email || c.phone || "—"}</div>
                    </div>
                    <span className={`badge ${STATUTS_CLIENT[c.statut || "prospect"]?.cls}`} style={{ fontSize: 10 }}>
                      {STATUTS_CLIENT[c.statut || "prospect"]?.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Création rapide client */}
          {showCreateClient && (
            <div style={{ marginBottom: 14, background: "var(--card2)", borderRadius: 10, border: "1px solid var(--border)", padding: 14 }}>
              <div style={{ fontFamily: "Syne", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: "var(--gold)", textTransform: "uppercase", marginBottom: 10 }}>
                Créer un nouveau client
              </div>
              <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 10 }}>
                <div className="form-group" style={{ gridColumn: "1/-1" }}>
                  <label className="form-label">Civilité</label>
                  <select className="form-input" value={newClientForm.civilite} onChange={e => setNewClientForm(f => ({ ...f, civilite: e.target.value }))}>
                    <option value="">—</option>
                    <option value="M">M.</option>
                    <option value="F">Mme</option>
                  </select>
                </div>
                {[["prenom", "Prénom"], ["nom", "Nom *"], ["email", "Email"], ["phone", "Téléphone"]].map(([k, l]) => (
                  <div className="form-group" key={k}>
                    <label className="form-label">{l}</label>
                    <input className="form-input" value={newClientForm[k]} onChange={e => setNewClientForm(f => ({ ...f, [k]: e.target.value }))} />
                  </div>
                ))}
                <div className="form-group" style={{ gridColumn: "1/-1" }}>
                  <label className="form-label">Adresse</label>
                  <input className="form-input" value={newClientForm.adresse} onChange={e => setNewClientForm(f => ({ ...f, adresse: e.target.value }))} placeholder="N° et rue" />
                </div>
                <div className="form-group">
                  <label className="form-label">Code postal</label>
                  <input className="form-input" value={newClientForm.code_postal} onChange={e => setNewClientForm(f => ({ ...f, code_postal: e.target.value }))} placeholder="13001" />
                </div>
                <div className="form-group">
                  <label className="form-label">Ville</label>
                  <input className="form-input" value={newClientForm.ville} onChange={e => setNewClientForm(f => ({ ...f, ville: e.target.value }))} placeholder="Marseille" />
                </div>
                <div className="form-group">
                  <label className="form-label">Pays</label>
                  <input className="form-input" value={newClientForm.pays} onChange={e => setNewClientForm(f => ({ ...f, pays: e.target.value }))} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-primary btn-sm" onClick={createAndSelectClient}>✅ Créer et sélectionner</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowCreateClient(false)}>Annuler</button>
              </div>
            </div>
          )}

          {/* Infos client en lecture seule si sélectionné */}
          {form.client?.name && !showClientDropdown && !showCreateClient ? (
            <div style={{ background: "var(--card2)", borderRadius: 10, border: "1px solid var(--border2)", padding: "14px 16px", marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: form.client.siren !== undefined ? 10 : 0 }}>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <div style={{ width: 38, height: 38, borderRadius: "50%", background: "var(--gold3)", border: "2px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Syne", fontWeight: 800, fontSize: 15, color: "var(--gold)", flexShrink: 0 }}>
                    {(form.client.name?.[0] || "?").toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{form.client.name}</div>
                    <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                      {[form.client.phone, form.client.email, form.client.address?.split("\n")[0]].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                </div>
                <button className="btn btn-ghost btn-xs" onClick={() => {
                  setForm(f => ({ ...f, client_id: null, client: { name: "", address: "", phone: "", email: "", siren: "" } }));
                }}>✕ Changer</button>
              </div>
              {/* SIREN client — obligatoire B2B facture 2026 */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ fontSize: 11, color: "var(--muted)", minWidth: 80 }}>SIREN client</div>
                <input className="form-input" style={{ fontSize: 12, fontFamily: "DM Mono", flex: 1, padding: "4px 8px" }}
                  placeholder="9 chiffres — requis pour facture B2B (2026)"
                  value={form.client.siren || ""}
                  onChange={e => setForm(f => ({ ...f, client: { ...f.client, siren: e.target.value } }))} />
                {form.client.siren && form.client.siren.replace(/\s/g, "").length !== 9 && (
                  <span style={{ fontSize: 10, color: "var(--orange)" }}>⚠️ 9 chiffres requis</span>
                )}
              </div>
            </div>
          ) : !showClientDropdown && !showCreateClient && (
            <div style={{ marginBottom: 20, padding: "20px", background: "var(--card2)", borderRadius: 10, border: "2px dashed var(--border2)", textAlign: "center" }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>👤</div>
              <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 14 }}>Aucun client sélectionné</div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                <button className="btn btn-primary btn-sm" onClick={() => setShowClientDropdown(true)}>👥 Choisir dans le CRM</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowCreateClient(true)}>➕ Créer un client</button>
              </div>
            </div>
          )}

          <div style={{ fontFamily: "Syne", fontSize: 13, fontWeight: 700, letterSpacing: 1, color: "var(--gold)", marginBottom: 10, textTransform: "uppercase" }}>VÉHICULE</div>
          <div className="form-grid" style={{ marginBottom: 20 }}>
            <div className="form-group full">
              <label className="form-label">Sélectionner depuis la flotte</label>
              <select className="form-input" value={form.vehicle_id} onChange={e => selectVehicle(e.target.value)}>
                <option value="">— Choisir un véhicule —</option>
                {vehicles.map(v => <option key={v.id} value={v.id}>{v.plate} · {v.marque} {v.modele} {v.finition} ({getYear(v)})</option>)}
              </select>
            </div>
            <div className="form-group full">
              <label className="form-label">Libellé véhicule</label>
              <input className="form-input" value={form.vehicle_label} onChange={e => set("vehicle_label", e.target.value)} placeholder="ou saisir manuellement" />
            </div>
          </div>

          {/* Frais & Garantie */}
          <div className="form-grid" style={{ marginBottom: 12 }}>
            <div className="form-group">
              <label className="form-label">Frais de mise à disposition TTC (€)</label>
              <input className="form-input" type="number" value={form.frais_mise_dispo ?? 180} onChange={e => set("frais_mise_dispo", parseFloat(e.target.value) || 0)} />
            </div>
            <div className="form-group">
              <label className="form-label">Frais carte grise (€)</label>
              <input className="form-input" type="number" value={form.carte_grise ?? 0} onChange={e => set("carte_grise", parseFloat(e.target.value) || 0)} />
            </div>
            <div className="form-group">
              <label className="form-label">Garantie véhicule</label>
              <select className="form-input" value={form.garantie_mois ?? 3} onChange={e => set("garantie_mois", parseInt(e.target.value))}>
                <option value={3}>3 mois</option>
                <option value={6}>6 mois</option>
                <option value={12}>12 mois</option>
                <option value={0}>Sans garantie</option>
              </select>
            </div>
          </div>

          {/* Calculateur carte grise intégré */}
          <details style={{ marginBottom: 20, background: "var(--card2)", borderRadius: 10, border: "1px solid var(--border2)", padding: "0" }}>
            <summary style={{ padding: "10px 14px", cursor: "pointer", fontSize: 12, fontWeight: 600, color: "var(--gold)", listStyle: "none", display: "flex", alignItems: "center", gap: 8 }}>
              🪪 Calculer la carte grise automatiquement
              {getRegionFromPostal(form.client?.address) && <span style={{ fontSize: 10, color: "var(--green)", fontWeight: 400 }}>
                (région détectée : {getRegionFromPostal(form.client?.address)})
              </span>}
            </summary>
            <div style={{ padding: "12px 14px", borderTop: "1px solid var(--border2)" }}>
              <CarteGriseCalc
                vehicleData={(() => {
                  const fv = form.vehicle_id && vehicles ? vehicles.find(vh => vh.id === form.vehicle_id) : null;
                  return fv || form.vehicle_data;
                })()}
                clientAddress={form.client?.address}
                onApply={(total) => set("carte_grise", total)}
              />
            </div>
          </details>

          {/* ═══ ACOMPTE VERSÉ À LA SIGNATURE ═══
              N'apparaît que pour BC et factures — pas pour les avoirs (remboursement). */}
          {form.type !== "avoir" && (
            <div className="form-row" style={{ marginBottom: 20 }}>
              <div className="form-group">
                <label className="form-label">
                  💰 Acompte versé à la signature (€ TTC)
                  <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 8, fontWeight: 400 }}>
                    Laisser à 0 si pas d'acompte
                  </span>
                </label>
                <input
                  className="form-input"
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.acompte_ttc ?? 0}
                  onChange={e => set("acompte_ttc", parseFloat(e.target.value) || 0)}
                />
              </div>
            </div>
          )}

          {/* ═══ REPRISE VÉHICULE ═══ */}
          <div style={{ fontFamily: "Syne", fontSize: 13, fontWeight: 700, letterSpacing: 1, color: "var(--gold)", marginBottom: 10, textTransform: "uppercase" }}>REPRISE VÉHICULE</div>

          {/* Toggle d'activation (même style que le toggle TVA) */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, padding: "10px 14px", background: "var(--card2)", borderRadius: 8, border: "1px solid var(--border2)" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Le client a un véhicule à reprendre</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                {form.reprise_active
                  ? ((parseFloat(form.reprise_valeur) || 0) > 0
                      ? `Valeur ${fmt(parseFloat(form.reprise_valeur))} déduite du total TTC`
                      : "Saisissez la valeur de reprise ci-dessous")
                  : "Aucune reprise — la vente est un achat simple"}
              </div>
            </div>
            <div style={{
              width: 44, height: 24, borderRadius: 12, cursor: "pointer",
              background: form.reprise_active ? "var(--gold)" : "var(--card)",
              border: "1px solid var(--border2)", position: "relative", transition: "background .2s", flexShrink: 0
            }} onClick={() => set("reprise_active", !form.reprise_active)}>
              <div style={{
                width: 18, height: 18, borderRadius: "50%", background: "#fff",
                position: "absolute", top: 2,
                left: form.reprise_active ? 23 : 3,
                transition: "left .2s", boxShadow: "0 1px 3px rgba(0,0,0,.3)"
              }} />
            </div>
          </div>

          {form.reprise_active && (
            <div style={{ marginBottom: 20, padding: "16px", background: "var(--card2)", borderRadius: 10, border: "1px solid rgba(212,168,67,.3)" }}>
              {/* Ligne recherche plaque */}
              <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "flex-end" }}>
                <div style={{ flex: 1 }}>
                  <label className="form-label">Plaque d'immatriculation</label>
                  <input
                    className="form-input"
                    value={form.reprise_plate || ""}
                    onChange={e => set("reprise_plate", e.target.value.toUpperCase())}
                    placeholder="AB-123-CD"
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  style={{ height: 40 }}
                  disabled={repriseSearching || !(form.reprise_plate || "").trim()}
                  onClick={async () => {
                    const plate = (form.reprise_plate || "").trim().toUpperCase().replace(/\s/g, "");
                    if (!plate) return;
                    // Vérification du quota mensuel — même logique que la recherche dashboard.
                    // Le serveur compte de toute façon, mais on prévient l'utilisateur AVANT
                    // pour éviter les factures surprise.
                    const monthKey = new Date().toISOString().slice(0, 7);
                    const usedThisMonth = usage?.[monthKey] || 0;
                    const isFree = usedThisMonth < QUOTA_FREE;
                    if (!isFree) {
                      const ok = window.confirm(
                        `⚠️ Quota mensuel atteint (${usedThisMonth} recherches ce mois)\n\nCette recherche est payante : ${COST_EXTRA.toFixed(2)} €\n\nConfirmer ?`
                      );
                      if (!ok) return;
                    }
                    setRepriseSearching(true);
                    try {
                      const data = await aiLookupPlate(plate, apiKey);
                      // Incrément local après succès — le serveur a déjà incrémenté son compteur
                      // atomique en BD. Ce setUsage met juste à jour l'affichage côté front.
                      if (typeof setUsage === "function") {
                        setUsage({ ...usage, [monthKey]: usedThisMonth + 1 });
                      }
                      setForm(f => ({
                        ...f,
                        reprise_plate: plate,
                        reprise_marque: data.marque || f.reprise_marque,
                        reprise_modele: data.modele || f.reprise_modele,
                        reprise_annee: data.annee || f.reprise_annee,
                        reprise_vin: data.vin || f.reprise_vin,
                        reprise_data: data, // on garde les données complètes pour la flotte
                      }));
                    } catch (err) {
                      alert(`Erreur recherche plaque : ${err.message}`);
                    } finally {
                      setRepriseSearching(false);
                    }
                  }}
                >
                  {repriseSearching ? "…" : "🔍 Rechercher"}
                </button>
              </div>

              {/* Compteur quota mensuel — visible en permanence pour que l'abonné
                  sache combien de recherches gratuites il lui reste, et le montant
                  qui sera facturé s'il dépasse. */}
              {(() => {
                const q = getQuotaStatus(usage);
                return (
                  <div style={{ marginBottom: 10, fontSize: 11, color: q.color, fontWeight: 600, letterSpacing: .3 }}>
                    {q.text}
                  </div>
                );
              })()}

              {/* Champs véhicule */}
              <div className="form-grid" style={{ marginBottom: 10 }}>
                <div className="form-group">
                  <label className="form-label">Marque</label>
                  <input className="form-input" value={form.reprise_marque || ""} onChange={e => set("reprise_marque", e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Modèle</label>
                  <input className="form-input" value={form.reprise_modele || ""} onChange={e => set("reprise_modele", e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Année</label>
                  <input className="form-input" value={form.reprise_annee || ""} onChange={e => set("reprise_annee", e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Kilométrage</label>
                  <input className="form-input" type="number" value={form.reprise_km || ""} onChange={e => set("reprise_km", e.target.value)} placeholder="km" />
                </div>
                <div className="form-group full">
                  <label className="form-label">N° de série (VIN)</label>
                  <input className="form-input" value={form.reprise_vin || ""} onChange={e => set("reprise_vin", e.target.value)} placeholder="17 caractères" />
                </div>
                <div className="form-group full">
                  <label className="form-label" style={{ color: "var(--gold)" }}>Valeur de reprise TTC (€) · déduite du total</label>
                  <input
                    className="form-input"
                    type="number"
                    step="0.01"
                    value={form.reprise_valeur || ""}
                    onChange={e => set("reprise_valeur", parseFloat(e.target.value) || 0)}
                    placeholder="0.00"
                    style={{ fontSize: 15, fontWeight: 600 }}
                  />
                </div>
              </div>

              {/* Bouton ajouter à la flotte */}
              {setVehiclesRaw && (parseFloat(form.reprise_valeur) || 0) > 0 && (form.reprise_plate || "").trim() && (form.reprise_marque || "").trim() && (
                <div style={{ paddingTop: 10, borderTop: "1px solid var(--border2)" }}>
                  {form.reprise_ajoutee_flotte ? (
                    <div style={{ fontSize: 12, color: "var(--green)", textAlign: "center", padding: "8px" }}>
                      ✅ Véhicule ajouté à la flotte
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ width: "100%" }}
                      onClick={() => {
                        const d = form.reprise_data || {};
                        // Récupération des infos client (qui cède son ancien véhicule au garage).
                        // Du point de vue du LP, ce client EST le vendeur/fournisseur du véhicule repris.
                        // On préfère les champs SÉPARÉS du CRM (prenom, nom, adresse, code_postal, ville)
                        // au lieu du form.client.name consolidé qui ne distingue pas prénom/nom.
                        const client = form.client || {};
                        const crmClient = form.client_id && clients
                          ? clients.find(x => x.id === form.client_id)
                          : null;
                        const isClientPro = !!(client.siren && String(client.siren).trim());
                        // Construction d'une adresse PROPREMENT formatée à partir des champs séparés.
                        const buildAddress = (cc) => {
                          if (!cc) return "";
                          const parts = [];
                          if (cc.adresse) parts.push(cc.adresse);
                          const cpVille = [cc.code_postal, cc.ville].filter(Boolean).join(" ");
                          if (cpVille) parts.push(cpVille);
                          if (cc.pays && cc.pays !== "France") parts.push(cc.pays);
                          return parts.join(", ");
                        };
                        const newVehicle = {
                          id: uid(),
                          plate: (form.reprise_plate || "").toUpperCase().replace(/\s/g, ""),
                          marque: form.reprise_marque || "",
                          modele: form.reprise_modele || "",
                          annee: form.reprise_annee || "",
                          vin: form.reprise_vin || "",
                          kilometrage: form.reprise_km || "",
                          // La reprise n'est PAS une sortie de trésorerie : aucun cash n'a été décaissé.
                          // On garde la valeur dans valeur_reprise pour historique/marge future,
                          // mais prix_achat=0 et includeTreso=false pour exclure du total achats.
                          prix_achat: 0,
                          includeTreso: false,
                          valeur_reprise: parseFloat(form.reprise_valeur) || 0,
                          origine: "reprise",
                          origine_ref: form.ref || "",
                          // Infos vendeur pré-remplies depuis le client de la facture.
                          // Permet au LP auto-créé de se baser sur ces données au lieu d'avoir
                          // tous les champs vides. L'abonné devra quand même compléter la pièce d'identité.
                          // Si client lié au CRM : on utilise les champs séparés (nom/prenom/adresse/cp/ville).
                          // Sinon (saisie libre dans la facture) : on prend ce qu'on a (name consolidé).
                          reprise_client: crmClient ? {
                            // Champs séparés depuis la fiche CRM (proprement remplis)
                            nom: crmClient.nom || "",
                            prenom: crmClient.prenom || "",
                            adresse: buildAddress(crmClient),
                            phone: crmClient.phone || "",
                            email: crmClient.email || "",
                            siren: client.siren || crmClient.siren || "",
                            type: (client.siren || crmClient.siren) ? "pro" : "particulier",
                          } : {
                            // Fallback : pas de client CRM lié, on prend ce qu'il y a dans le formulaire
                            nom: client.name || "",
                            prenom: "",
                            adresse: client.address || "",
                            phone: client.phone || "",
                            email: client.email || "",
                            siren: client.siren || "",
                            type: isClientPro ? "pro" : "particulier",
                          },
                          prix_vente: "",
                          statut: "disponible",
                          date_entree: today(),
                          // Données additionnelles si issues de la recherche
                          finition: d.finition || "",
                          motorisation: d.motorisation || "",
                          carburant: d.carburant || "",
                          puissance_cv: d.puissance_cv || "",
                          puissance_fiscale: d.puissance_fiscale || "",
                          puissance_kw: d.puissance_kw || "",
                          co2: d.co2 || "",
                          boite: d.boite || "",
                          transmission: d.transmission || "",
                          couleur: d.couleur || "",
                          nb_portes: d.nb_portes || "",
                          nb_places: d.nb_places || "",
                          genre: d.genre || "VP",
                          carrosserie: d.carrosserie || "",
                          date_mise_en_circulation: d.date_mise_en_circulation || "",
                          documents: [],
                          notes: (() => {
                            const cedeur = crmClient
                              ? `${crmClient.prenom || ""} ${crmClient.nom || ""}`.trim()
                              : (client.name || "—");
                            return `Véhicule repris lors de la vente ${form.ref || ""} · Valeur de reprise : ${fmt(parseFloat(form.reprise_valeur) || 0)} · Cédé par ${cedeur || "—"}`.trim();
                          })(),
                        };
                        setVehiclesRaw(prev => [newVehicle, ...(prev || [])]);
                        set("reprise_ajoutee_flotte", true);
                      }}
                    >
                      ➕ Ajouter ce véhicule à ma flotte (valeur reprise : {fmt(parseFloat(form.reprise_valeur) || 0)} · hors trésorerie)
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          <div style={{ fontFamily: "Syne", fontSize: 13, fontWeight: 700, letterSpacing: 1, color: "var(--gold)", marginBottom: 10, textTransform: "uppercase" }}>TARIFICATION</div>

          {/* Toggle TVA */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, padding: "10px 14px", background: "var(--card2)", borderRadius: 8, border: "1px solid var(--border2)" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Vente soumise à TVA</div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                {form.avec_tva !== false ? "TVA applicable — régime normal ou marge" : "Vente hors TVA — véhicule d'occasion régime particulier (art. 297A CGI)"}
              </div>
            </div>
            <div style={{
              width: 44, height: 24, borderRadius: 12, cursor: "pointer",
              background: form.avec_tva !== false ? "var(--gold)" : "var(--card)",
              border: "1px solid var(--border2)", position: "relative", transition: "background .2s", flexShrink: 0
            }} onClick={() => set("avec_tva", form.avec_tva === false ? true : false)}>
              <div style={{
                width: 18, height: 18, borderRadius: "50%", background: "#fff",
                position: "absolute", top: 2,
                left: form.avec_tva !== false ? 23 : 3,
                transition: "left .2s", boxShadow: "0 1px 3px rgba(0,0,0,.3)"
              }} />
            </div>
          </div>

          <div className="form-grid" style={{ marginBottom: 4 }}>
            <div className="form-group">
              <label className="form-label">Prix de vente TTC (€)</label>
              <input className="form-input" type="number" value={form.prix_ht} onChange={e => set("prix_ht", e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Remise (€ TTC)</label>
              <input className="form-input" type="number" value={form.remise_ttc} onChange={e => set("remise_ttc", e.target.value)} />
            </div>
            {form.avec_tva !== false && (
              <div className="form-group">
                <label className="form-label">Taux TVA (%)</label>
                <select className="form-input" value={form.tva_pct} onChange={e => set("tva_pct", parseFloat(e.target.value))}>
                  <option value={20}>20% — Taux normal</option>
                  <option value={10}>10% — Taux intermédiaire</option>
                  <option value={5.5}>5,5% — Taux réduit</option>
                  <option value={0}>0% — Exonéré</option>
                </select>
              </div>
            )}
          </div>

          <div style={{ background: "var(--card2)", borderRadius: 8, padding: "14px 16px", marginBottom: 16, display: "flex", gap: 24, flexWrap: "wrap" }}>
            {/* v8.49.11 — La carte grise passe en DÉBOURS (art. 267 II 2° CGI), donc :
                 - Total TTC = HT + TVA (base fiscale, sans CG)
                 - Débours (CG) affiché séparé
                 - Total à payer = TTC + Débours (ce que règle vraiment le client) */}
            {(c.avecTva
              ? [
                  ["HT", fmtDec(c.ht)],
                  ["TVA " + (c.tvaPct || 20) + "%", fmtDec(c.tvaAmt)],
                  c.remAmt > 0 ? ["Remise", "- " + fmtDec(c.remAmt)] : null,
                  ["Total TTC", fmtDec(c.ttc)],
                  c.debourTotal > 0 ? ["Débours (CG)", fmtDec(c.debourTotal)] : null,
                  c.debourTotal > 0 ? ["Total à payer", fmtDec(c.grandTotal)] : null
                ].filter(Boolean)
              : [
                  ["Prix TTC", fmtDec(c.ttc)],
                  c.debourTotal > 0 ? ["Débours (CG)", fmtDec(c.debourTotal)] : null,
                  c.debourTotal > 0 ? ["Total à payer", fmtDec(c.grandTotal)] : null,
                  ["TVA", "Non applicable"],
                  ["Régime", "Art. 297A CGI"]
                ].filter(Boolean)
            ).map(([l, v]) => (
              <div key={l}>
                <div style={{ fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--muted)", marginBottom: 3 }}>{l}</div>
                <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "Syne" }}>{v}</div>
              </div>
            ))}
          </div>

          {/* Mentions obligatoires 2026 — uniquement pour factures et avoirs */}
          {/* Mentions obligatoires — sur tous les documents pour qu'elles soient reportées lors de la conversion BC→Facture */}
          <div style={{ marginBottom: 16, padding: "12px 14px", background: "rgba(212,168,67,.06)", border: "1px solid var(--border)", borderRadius: 8 }}>
            <div style={{ fontFamily: "Syne", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: "var(--gold)", textTransform: "uppercase", marginBottom: 10 }}>
              📋 Mentions obligatoires
            </div>
              <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <div className="form-group">
                  <label className="form-label">Catégorie de l'opération *</label>
                  <select className="form-input" value={form.categorie_operation || "livraison_biens"} onChange={e => set("categorie_operation", e.target.value)}>
                    <option value="livraison_biens">Livraison de biens</option>
                    <option value="prestation_services">Prestation de services</option>
                    <option value="mixte">Livraison + Prestation</option>
                  </select>
                </div>
                <div className="form-group" style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 20 }}>
                  <div style={{
                    width: 36, height: 20, borderRadius: 10, cursor: "pointer", flexShrink: 0,
                    background: form.tva_sur_debits ? "var(--gold)" : "var(--card2)",
                    border: "1px solid var(--border2)", position: "relative", transition: "background .2s"
                  }} onClick={() => set("tva_sur_debits", !form.tva_sur_debits)}>
                    <div style={{ width: 14, height: 14, borderRadius: "50%", background: "#fff", position: "absolute", top: 2, left: form.tva_sur_debits ? 19 : 3, transition: "left .2s" }} />
                  </div>
                  <span style={{ fontSize: 12 }}>TVA sur les débits</span>
                </div>
                {form.type === "avoir" && (
                  <div className="form-group full">
                    <label className="form-label">Facture d'origine (référence)</label>
                    <input className="form-input" style={{ fontFamily: "DM Mono" }}
                      value={form.facture_origine || ""}
                      onChange={e => set("facture_origine", e.target.value)}
                      placeholder="ex: VEH-2026-0001" />
                  </div>
                )}
              </div>
            </div>

          <div className="form-group">
            <label className="form-label">Notes / Conditions</label>
            <textarea className="form-input" rows={2} value={form.notes} onChange={e => set("notes", e.target.value)} placeholder="Conditions de garantie, délai de livraison..." />
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Annuler</button>
          <button className="btn btn-primary" onClick={submit}>💾 Enregistrer</button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   PRINT DOCUMENT
═══════════════════════════════════════════════════════════════ */
function PrintDoc({ order, dealer, onClose, viewMode }) {
  const c = calcOrder(order);
  const [sigVendeur, setSigVendeur] = useState(null);
  const [sigClient, setSigClient] = useState(null);
  const [sigMode, setSigMode] = useState("papier"); // BC par défaut papier
  return (
    <div className="modal-bg print-modal" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg print-modal-inner" style={{ display: "flex", flexDirection: "column", maxHeight: "92vh" }}>

        {/* Barre fixe */}
        <div className="modal-hd no-print" style={{ flexShrink: 0 }}>
          <span className="modal-title">Aperçu — {order.ref}</span>
          <div style={{ display: "flex", gap: 8 }}>
            {order.type === "facture" && viewMode !== "trial" && (
              <button className="btn btn-ghost btn-sm" onClick={() => exportFacturX(order, dealer, "en16931")}
                title="Export Factur-X EN16931 — compatible Plateforme Agréée (PA/PDP)">
                ⚡ Factur-X PA
              </button>
            )}
            {order.type === "facture" && viewMode === "trial" && (
              <button className="btn btn-ghost btn-sm" style={{ opacity: .5, cursor: "not-allowed" }}
                title="Disponible avec un abonnement"
                onClick={() => window.dispatchEvent(new CustomEvent("iocar_goto_register"))}>
                ⚡ Factur-X PA 🔒
              </button>
            )}
            <button className="btn btn-primary btn-sm" onClick={() => {
              const el = document.querySelector('.print-doc');
              if (!el) return;
              const win = window.open('', '_blank');
              if (!win) return;
              win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"/>');
              win.document.write('<title>' + (order.ref || 'Document') + '</title>');
              win.document.write('<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Syne:wght@700;800&display=swap" rel="stylesheet">');
              win.document.write('<style>');
              // Copier TOUS les styles de la page
              document.querySelectorAll('style').forEach(s => win.document.write(s.textContent));
              // Forcer le layout A4 et le footer en bas
              win.document.write('body{margin:0;padding:0;background:#fff;font-family:"DM Sans",sans-serif}');
              // Le print-doc occupe TOUTE la hauteur de la page A4 (≈ 287mm utiles avec marges 5mm).
              // Avec display:flex + flex-direction:column + flex:1 sur le content, le footer
              // est PHYSIQUEMENT collé en bas de page 1, peu importe la taille du contenu.
              win.document.write('.print-doc{min-height:287mm!important;display:flex;flex-direction:column;padding:14px 18px}');
              win.document.write('.print-doc-content{flex:1!important;display:flex;flex-direction:column}');
              // Force le layout horizontal de l'en-tête (annule la règle mobile @media max-width:768px
              // qui fait passer pdoc-head en colonne, puisque la fenêtre d'impression peut être étroite)
              win.document.write('.pdoc-head{flex-direction:row!important;justify-content:space-between!important;align-items:flex-start!important;gap:24px!important;margin-bottom:16px!important}');
              win.document.write('.pdoc-head > div:first-child{flex:1;min-width:0}');
              win.document.write('.pdoc-head > div:last-child{flex-shrink:0;text-align:right}');
              win.document.write('.pdoc-parties{display:block!important;margin-bottom:14px!important}');
              win.document.write('.pdoc-type{text-align:right!important}');
              win.document.write('.pdoc-ref{text-align:right!important}');
              // Compaction pour tenir sur une seule page A4
              win.document.write('.print-doc-bar{display:none!important}');
              win.document.write('.pdoc-divider{margin:10px 0!important}');
              win.document.write('.pdoc-table{margin-bottom:14px!important}');
              win.document.write('.pdoc-table td{padding:6px 14px!important}');
              win.document.write('.pdoc-table th{padding:6px 14px!important}');
              win.document.write('.pdoc-totals{margin-bottom:14px!important}');
              win.document.write('.pdoc-trow{padding:5px 0!important}');
              win.document.write('.pdoc-footer{margin-top:10px!important;padding-top:8px!important}');
              // Compaction drastique du bloc Mentions/Conditions/Infos qui sinon déborde sur une 2e page
              win.document.write('.pdoc-footer *{line-height:1.35!important}');
              win.document.write('.pdoc-footer > div:first-child{margin-bottom:6px!important;padding:6px 10px!important;font-size:9px!important}');
              win.document.write('.pdoc-footer > div:last-child > div{font-size:8.5px!important;line-height:1.35!important}');
              win.document.write('.pdoc-paiements{margin-top:12px!important;padding:10px 14px!important}');
              // Filigrane — forcer l'impression des couleurs très claires
              win.document.write('.pdoc-watermark{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}');
              win.document.write('.pdoc-watermark img{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}');
              win.document.write('.pdoc-table td{background:transparent!important}');
              // Anti-page-break sur les blocs critiques (totaux + footer mentions doivent rester en bloc).
              // On NE FORCE PAS de saut de page : on laisse le navigateur poser le contenu naturellement.
              // Si tout tient sur 1 page → tant mieux. Si ça déborde, le navigateur cassera proprement
              // entre 2 sections (et grâce à page-break-inside:avoid, jamais au milieu d'un bloc important).
              win.document.write('.pdoc-totals, .pdoc-footer, .pdoc-paiements{page-break-inside:avoid!important}');
              // Marges A4 minimales
              win.document.write('@page{size:A4 portrait;margin:5mm 6mm}');
              win.document.write('@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}');
              win.document.write('</style>');
              win.document.write('</head><body>');
              win.document.write(el.outerHTML);
              win.document.write('</body></html>');
              win.document.close();
              win.focus();
              setTimeout(() => { win.print(); }, 600);
            }}>🖨 Imprimer / PDF</button>
            <button className="close-btn" onClick={onClose}>×</button>
          </div>
        </div>

        {/* Document scrollable */}
        <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
          <div className="print-doc" style={{ position: "relative", overflow: "hidden" }}>
            {/* ── FILIGRANE DIAGONAL : logo du garage en travers, en très transparent ── */}
            {dealer?.logo && (
              <div className="pdoc-watermark" aria-hidden="true" style={{
                position: "absolute",
                top: 0, left: 0, right: 0, bottom: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
                zIndex: 0,
                overflow: "hidden",
              }}>
                <img src={dealer.logo} alt="" style={{
                  width: "75%",
                  maxWidth: 600,
                  opacity: 0.06,
                  transform: "rotate(-28deg)",
                  filter: dealer.logoInvert ? "invert(1)" : "none",
                  mixBlendMode: dealer.logoBlend || "normal",
                  objectFit: "contain",
                }} />
              </div>
            )}
            <div className="print-doc-content" style={{ position: "relative", zIndex: 1 }}>
            <div className="print-doc-bar" />
            <div className="pdoc-head">
              <div>
                {dealer?.logo ? (
                  // Avec logo : on n'affiche pas le nom en gros, le logo le contient déjà
                  <div style={{ marginBottom: 8 }}>
                    <img src={dealer.logo} alt="Logo"
                      style={{
                        maxHeight: 60, maxWidth: 200, objectFit: "contain",
                        mixBlendMode: dealer.logoBlend || "normal",
                        filter: dealer.logoInvert ? "invert(1)" : "none"
                      }} />
                  </div>
                ) : (
                  // Sans logo : on affiche le nom en gros
                  <div className="pdoc-logo">{dealer?.name || "AUTO DEALER"}</div>
                )}
                <div style={{ fontSize: 10, color: "#888", marginTop: 4, lineHeight: 1.5 }}>
                  {dealer?.address?.split("\n").map((l, i) => <span key={i}>{l}<br /></span>)}
                  {dealer?.phone && <span>Tél : {dealer.phone}</span>}
                  {dealer?.phone && dealer?.email && <span> · </span>}
                  {dealer?.email && <span>{dealer.email}</span>}
                  {(dealer?.phone || dealer?.email) && (dealer?.siret || dealer?.tva_num) && <br />}
                  {dealer?.siret && <span>SIRET : {dealer.siret}</span>}
                  {dealer?.siret && dealer?.tva_num && <span> · </span>}
                  {dealer?.tva_num && <span>TVA : {dealer.tva_num}</span>}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="pdoc-type">{order.type === "facture" ? "FACTURE" : order.type === "avoir" ? "AVOIR" : "BON DE COMMANDE"}</div>
                <div className="pdoc-ref">N° {order.ref}</div>
                <div className="pdoc-ref">Date : {order.date_creation}</div>
                {order.date_echeance && <div className="pdoc-ref">Livraison le : {order.date_echeance}</div>}

                {/* Bloc CLIENT directement sous FACTURE/Ref pour gagner de la place verticale */}
                <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid #e8e8e8", textAlign: "right" }}>
                  <div className="pdoc-plabel" style={{ marginBottom: 4 }}>Client</div>
                  <div className="pdoc-pname" style={{ fontSize: 13 }}>{order.client?.name || "—"}</div>
                  <div className="pdoc-pinfo" style={{ fontSize: 10 }}>{order.client?.address}{order.client?.phone && <><br />{order.client.phone}</>}{order.client?.email && <><br />{order.client.email}</>}</div>
                </div>
              </div>
            </div>
            <hr className="pdoc-divider" />
            {/* ═══ v8.48 — ENCADRÉ VÉHICULE style IOBILL (encadré jaune) ═══ */}
            {order.vehicle_data && (() => {
              const vd = order.vehicle_data;
              const vehLabel = [vd.marque, vd.modele, vd.finition].filter(Boolean).join(" ");
              const plate = vd.plate || order.vehicle_plate || "";
              const infosLeft = [];
              const infosRight = [];
              if (vd.annee) infosLeft.push(`Année : ${vd.annee}`);
              if (vd.date_mise_en_circulation) infosLeft.push(`1ère circ. : ${vd.date_mise_en_circulation}`);
              if (vd.kilometrage) infosLeft.push(`Kilométrage : ${Number(vd.kilometrage).toLocaleString("fr-FR")} km`);
              if (vd.genre) infosLeft.push(`Genre : ${vd.genre}`);
              const optionsStr = Array.isArray(vd.options) ? vd.options.join(", ") : (vd.options || "");
              if (optionsStr) infosLeft.push(`Options : ${optionsStr}`);
              if (vd.vin) infosRight.push(`VIN : ${vd.vin}`);
              if (vd.carburant) infosRight.push(`Carburant : ${vd.carburant}`);
              if (vd.puissance_cv || vd.puissance_fiscale) {
                const powerParts = [];
                if (vd.puissance_cv) powerParts.push(`${vd.puissance_cv} ch`);
                if (vd.puissance_fiscale) powerParts.push(`${vd.puissance_fiscale} CV`);
                infosRight.push(`Puissance : ${powerParts.join(" · ")}`);
              }
              return (
                <div style={{
                  position: "relative",
                  border: "0.8px solid #d4a843",
                  background: "#fcfbf4",
                  padding: "18px 14px 12px 14px",
                  marginBottom: 14,
                  borderRadius: 2
                }}>
                  {/* Label VÉHICULE en haut à gauche */}
                  <div style={{
                    position: "absolute",
                    top: -8,
                    left: 8,
                    background: "#d4a843",
                    color: "#fff",
                    fontSize: 8,
                    fontWeight: 700,
                    letterSpacing: 1,
                    padding: "2px 8px"
                  }}>VÉHICULE</div>
                  {/* Ligne titre : marque/modèle + plaque badge */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#1a1a1a" }}>{vehLabel || "Véhicule"}</div>
                    {plate && (
                      <div style={{
                        background: "#1a1a1a",
                        border: "0.5px solid #d4a843",
                        color: "#d4a843",
                        padding: "3px 10px",
                        fontSize: 11,
                        fontWeight: 700,
                        fontFamily: "monospace",
                        letterSpacing: 0.5
                      }}>{String(plate).toUpperCase()}</div>
                    )}
                  </div>
                  {/* Infos sur 2 colonnes */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 20px" }}>
                    <div>
                      {infosLeft.map((info, i) => (
                        <div key={i} style={{ fontSize: 9, color: "#6b6b78", marginBottom: 1 }}>{info}</div>
                      ))}
                    </div>
                    <div>
                      {infosRight.map((info, i) => (
                        <div key={i} style={{ fontSize: 9, color: "#6b6b78", marginBottom: 1 }}>{info}</div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })()}
            {/* ═══ v8.48 — TABLEAU LIGNES style IOBILL ═══ */}
            <table className="pdoc-table" style={{ marginBottom: 14 }}>
              <thead>
                <tr>
                  <th>Désignation</th>
                  <th style={{ textAlign: "center", width: 40 }}>Qté</th>
                  <th style={{ textAlign: "center", width: 50 }}>Unité</th>
                  <th style={{ textAlign: "right", width: 80 }}>P.U. HT</th>
                  <th style={{ textAlign: "center", width: 50 }}>TVA</th>
                  <th style={{ textAlign: "right", width: 90 }}>Total HT</th>
                </tr>
              </thead>
              <tbody>
                {/* L1 - Véhicule
                    v8.48.9 — En régime marge (avecTva=false), le véhicule n'a pas de TVA
                    visible (elle est prélevée sur la marge). PU HT = TTC. */}
                <tr>
                  <td style={{ fontSize: 11 }}>
                    VENTE VÉHICULE - {(() => {
                      const vd = order.vehicle_data || {};
                      const vehLabel = [vd.marque, vd.modele, vd.finition].filter(Boolean).join(" ") || (order.vehicle_label || "Véhicule");
                      const plate = vd.plate || order.vehicle_plate || "";
                      return plate ? `${vehLabel} (${plate})` : vehLabel;
                    })()}
                  </td>
                  <td style={{ textAlign: "center", fontSize: 11 }}>1</td>
                  <td style={{ textAlign: "center", fontSize: 11 }}>u</td>
                  <td style={{ textAlign: "right", fontSize: 11 }}>{fmtDec(c.avecTva ? c.base / (1 + (c.tvaPct || 20) / 100) : c.base)}</td>
                  <td style={{ textAlign: "center", fontSize: 11, color: c.avecTva ? undefined : "#888" }}>{c.avecTva ? `${c.tvaPct || 20}%` : "—"}</td>
                  <td style={{ textAlign: "right", fontSize: 11, fontWeight: 600 }}>{fmtDec(c.avecTva ? c.base / (1 + (c.tvaPct || 20) / 100) : c.base)}</td>
                </tr>
                {/* L2 - Frais de mise à disposition
                    v8.48.9 — Les frais sont TOUJOURS taxables au taux normal, même en régime marge */}
                {(parseFloat(order.frais_mise_dispo) || 0) > 0 && (() => {
                  const fmd = parseFloat(order.frais_mise_dispo) || 0;
                  // En régime marge OU classique, les frais sont taxables au taux normal
                  const fmdHt = fmd / (1 + (c.tvaPct || 20) / 100);
                  return (
                    <tr>
                      <td style={{ fontSize: 11 }}>Frais de mise à disposition</td>
                      <td style={{ textAlign: "center", fontSize: 11 }}>1</td>
                      <td style={{ textAlign: "center", fontSize: 11 }}>u</td>
                      <td style={{ textAlign: "right", fontSize: 11 }}>{fmtDec(fmdHt)}</td>
                      <td style={{ textAlign: "center", fontSize: 11 }}>{c.tvaPct || 20}%</td>
                      <td style={{ textAlign: "right", fontSize: 11, fontWeight: 600 }}>{fmtDec(fmdHt)}</td>
                    </tr>
                  );
                })()}
              </tbody>
            </table>

            {/* Totaux — v8.49.11 : refonte fiscale
                La carte grise est désormais un DÉBOURS (art. 267 II 2° CGI) :
                  - hors base TVA (déjà sortie de c.ttc via calcOrder)
                  - affichée en bloc séparé après le Total TTC
                  - ajoutée au TOTAL À PAYER (c.grandTotal)
                Cohérent avec la présentation IOBILL. */}
            <div className="pdoc-totals">
              <div className="pdoc-totals-box">
                {c.avecTva ? (
                  <>
                    <div className="pdoc-trow"><span>Montant HT</span><span>{fmtDec(c.ht)}</span></div>
                    <div className="pdoc-trow"><span>TVA {c.tvaPct || 20}%</span><span>{fmtDec(c.tvaAmt)}</span></div>
                    {c.remAmt > 0 && <div className="pdoc-trow" style={{ color: "#e5973c" }}><span>Remise</span><span>- {fmtDec(c.remAmt)}</span></div>}
                    {c.repriseValeur > 0 && <div className="pdoc-trow" style={{ color: "#c79528" }}><span>Reprise véhicule</span><span>- {fmtDec(c.repriseValeur)}</span></div>}
                    <div className="pdoc-trow big"><span>TOTAL TTC</span><span>{fmtDec(c.ttc)}</span></div>
                  </>
                ) : (
                  <>
                    {/* v8.48.9 — Régime marge : véhicule sans TVA + frais avec TVA sur taux normal */}
                    <div className="pdoc-trow"><span>Montant HT</span><span>{fmtDec(c.ht)}</span></div>
                    {c.tvaAmt > 0 && <div className="pdoc-trow"><span>TVA {c.tvaPct || 20}% (frais uniquement)</span><span>{fmtDec(c.tvaAmt)}</span></div>}
                    <div className="pdoc-trow" style={{ fontSize: 10, color: "#aaa" }}><span>Véhicule hors TVA</span><span>Art. 297A CGI</span></div>
                    {c.remAmt > 0 && <div className="pdoc-trow" style={{ color: "#e5973c" }}><span>Remise</span><span>- {fmtDec(c.remAmt)}</span></div>}
                    {c.repriseValeur > 0 && <div className="pdoc-trow" style={{ color: "#c79528" }}><span>Reprise véhicule</span><span>- {fmtDec(c.repriseValeur)}</span></div>}
                    <div className="pdoc-trow big"><span>TOTAL TTC</span><span>{fmtDec(c.ttc)}</span></div>
                  </>
                )}
                {/* v8.49.11 — Bloc DÉBOURS + TOTAL À PAYER (art. 267 II 2° CGI)
                    Fiscalement correct : la carte grise est une avance payée pour
                    le compte du client, hors base TVA. */}
                {c.debourTotal > 0 && (
                  <>
                    <div className="pdoc-trow" style={{ fontSize: 10, color: "#888", marginTop: 6, textTransform: "uppercase", letterSpacing: 1 }}>
                      <span>Débours (art. 267 II 2° CGI)</span><span></span>
                    </div>
                    {c.carteGrise > 0 && (
                      <div className="pdoc-trow"><span>Carte grise</span><span>{fmtDec(c.carteGrise)}</span></div>
                    )}
                    <div className="pdoc-trow" style={{ fontSize: 9, color: "#aaa", fontStyle: "italic" }}>
                      <span>Sommes avancées pour le compte du client, hors base TVA</span><span></span>
                    </div>
                    <div className="pdoc-trow big" style={{ borderTop: "1px solid #ddd", paddingTop: 4, marginTop: 4 }}>
                      <span>TOTAL À PAYER</span><span>{fmtDec(c.grandTotal)}</span>
                    </div>
                    <div className="pdoc-trow" style={{ fontSize: 9, color: "#888" }}>
                      <span>dont {fmtDec(c.tvaAmt)} TVA · {fmtDec(c.debourTotal)} débours</span><span></span>
                    </div>
                  </>
                )}
                {c.acompteTtc > 0 && <>
                  <div className="pdoc-trow" style={{ color: "#3ecf7a" }}><span>Acompte versé à la signature</span><span>- {fmtDec(c.acompteTtc)}</span></div>
                  <div className="pdoc-trow" style={{ fontWeight: 700, color: "#0a0a0a", borderTop: "1px solid #e8e8e8", paddingTop: 6, marginTop: 4 }}><span>Reste à payer</span><span>{fmtDec(c.netApresAcompte)}</span></div>
                </>}
                {/* Encaissements ULTÉRIEURS (hors acompte signature, qui est déjà affiché ci-dessus).
                    On utilise paiementsTotal pour ne pas compter l'acompte deux fois.
                    Pour un avoir, on parle de "remboursement" et non d'"encaissement". */}
                {c.paiementsTotal > 0 && <>
                  <div className="pdoc-trow" style={{ color: "#3ecf7a" }}><span>{order.type === "avoir" ? "Remboursé" : (c.acompteTtc > 0 ? "Encaissements ultérieurs" : "Encaissé")}</span><span>- {fmtDec(c.paiementsTotal)}</span></div>
                  <div className="pdoc-trow" style={{ fontWeight: 700, color: c.reste <= 0 ? "#3ecf7a" : "#e5973c" }}><span>{order.type === "avoir" ? "Reste à rembourser" : "Solde restant"}</span><span>{fmtDec(c.reste)}</span></div>
                </>}
              </div>
            </div>

            {/* Garantie véhicule */}
            {(order.garantie_mois || 0) > 0 && (
              <div className="pdoc-section pdoc-garantie" style={{ marginTop: 12, padding: "8px 14px", background: "#f9f8f5", borderRadius: 6, fontSize: 11, color: "#555", border: "1px solid #e8e8e8" }}>
                🛡 <strong>Garantie véhicule : {order.garantie_mois} mois</strong>
              </div>
            )}

            {/* Reprise véhicule */}
            {order.reprise_active && (parseFloat(order.reprise_valeur) || 0) > 0 && (
              <div className="pdoc-section pdoc-reprise" style={{ marginTop: 12, padding: "10px 14px", background: "#fdf8ec", borderRadius: 6, fontSize: 11, color: "#555", border: "1px solid #e8d9a8" }}>
                <div style={{ fontWeight: 700, color: "#8a6a1a", marginBottom: 6, fontSize: 12 }}>🔄 Reprise véhicule</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 16px", fontSize: 11 }}>
                  {(order.reprise_marque || order.reprise_modele) && (
                    <div><span style={{ color: "#888" }}>Modèle : </span><strong>{[order.reprise_marque, order.reprise_modele].filter(Boolean).join(" ")}</strong></div>
                  )}
                  {order.reprise_plate && (
                    <div><span style={{ color: "#888" }}>Plaque : </span><strong style={{ fontFamily: "monospace" }}>{order.reprise_plate}</strong></div>
                  )}
                  {order.reprise_annee && (
                    <div><span style={{ color: "#888" }}>Année : </span><strong>{order.reprise_annee}</strong></div>
                  )}
                  {order.reprise_km && (
                    <div><span style={{ color: "#888" }}>Kilométrage : </span><strong>{order.reprise_km} km</strong></div>
                  )}
                  {order.reprise_vin && (
                    <div style={{ gridColumn: "1 / -1" }}><span style={{ color: "#888" }}>N° de série : </span><strong style={{ fontFamily: "monospace" }}>{order.reprise_vin}</strong></div>
                  )}
                  <div style={{ gridColumn: "1 / -1", marginTop: 4, paddingTop: 6, borderTop: "1px solid #e8d9a8" }}>
                    <span style={{ color: "#888" }}>Valeur de reprise déduite du total : </span>
                    <strong style={{ color: "#8a6a1a", fontSize: 12 }}>{fmtDec(parseFloat(order.reprise_valeur) || 0)}</strong>
                  </div>
                </div>
              </div>
            )}
            {order.paiements?.length > 0 && (
              <div className="pdoc-paiements">
                <div className="pdoc-paiements-title">Historique des paiements</div>
                {order.paiements.map(p => (
                  <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#555", padding: "3px 0", borderBottom: "1px solid #ece" }}>
                    <span>{p.date} — {p.mode}</span><span style={{ fontWeight: 700, color: "#3ecf7a" }}>{fmtDec(p.montant)}</span>
                  </div>
                ))}
              </div>
            )}
            {order.notes && (
              <div style={{ marginTop: 20, padding: "12px 16px", background: "#f9f8f5", borderRadius: 6, fontSize: 12, color: "#555" }}>
                <div style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#aaa", marginBottom: 6 }}>Notes / Conditions</div>
                {order.notes}
              </div>
            )}
            </div>{/* /print-doc-content */}
            {order.type === "bc" ? (
              /* BON DE COMMANDE — signatures */
              <div>
                <div className="no-print" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, margin: "12px 0", padding: "6px 10px", background: "#f9f8f5", borderRadius: 6 }}>
                  <span style={{ fontSize: 10, color: "#aaa" }}>Signature :</span>
                  <button style={{ fontSize: 10, padding: "3px 8px", border: "1px solid #ddd", borderRadius: 4, background: sigMode === "ecran" ? "#d4a843" : "#fff", color: sigMode === "ecran" ? "#fff" : "#555", cursor: "pointer" }} onClick={() => setSigMode("ecran")}>✍️ Écran</button>
                  <button style={{ fontSize: 10, padding: "3px 8px", border: "1px solid #ddd", borderRadius: 4, background: sigMode === "papier" ? "#d4a843" : "#fff", color: sigMode === "papier" ? "#fff" : "#555", cursor: "pointer" }} onClick={() => setSigMode("papier")}>📝 Papier</button>
                </div>
                <div className="pdoc-footer">
                  <div>
                    {sigMode === "ecran" ? (
                      <SignaturePad label="Signature vendeur" onSave={setSigVendeur} savedImg={sigVendeur} />
                    ) : (
                      <div className="pdoc-sig">Signature vendeur</div>
                    )}
                  </div>
                  <div>
                    {sigMode === "ecran" ? (
                      <SignaturePad label="Signature client / Bon pour accord" onSave={setSigClient} savedImg={sigClient} />
                    ) : (
                      <div className="pdoc-sig">Signature client / Bon pour accord</div>
                    )}
                  </div>
                  <div className="pdoc-legal">Acompte de 30% requis à la signature. Document non contractuel avant encaissement de l'acompte.</div>
                </div>
              </div>
            ) : (
              /* FACTURE / AVOIR — mentions légales obligatoires 2026 */
              <div style={{ marginTop: 32, paddingTop: 16, borderTop: "2px solid #e8e8e8" }}>
                {/* Mentions obligatoires 2026 — bande centrale */}
                <div className="pdoc-section pdoc-operation" style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12, padding: "8px 12px", background: "#f9f8f5", borderRadius: 6, fontSize: 10, color: "#888" }}>
                  <span>📦 Opération : <strong style={{ color: "#555" }}>
                    {order.categorie_operation === "prestation_services" ? "Prestation de services"
                      : order.categorie_operation === "mixte" ? "Livraison de biens + Prestation de services"
                      : "Livraison de biens"}
                  </strong></span>
                  {order.tva_sur_debits && <span>💶 TVA acquittée sur les <strong style={{ color: "#555" }}>débits</strong></span>}
                  {!order.tva_sur_debits && order.avec_tva !== false && <span>💶 TVA acquittée sur les <strong style={{ color: "#555" }}>encaissements</strong></span>}
                  {order.client?.siren && <span>🏢 SIREN client : <strong style={{ color: "#555", fontFamily: "monospace" }}>{order.client.siren}</strong></span>}
                  {order.type === "avoir" && order.facture_origine && <span>📎 Facture d'origine : <strong style={{ color: "#555", fontFamily: "monospace" }}>{order.facture_origine}</strong></span>}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
                  <div style={{ fontSize: 9, color: "#aaa", lineHeight: 1.8, flex: 1 }}>
                    <strong style={{ color: "#888", letterSpacing: 1, textTransform: "uppercase", fontSize: 8 }}>Mentions légales</strong><br />
                    {dealer?.name}{dealer?.siret && ` — SIRET : ${dealer.siret}`}{dealer?.tva_num && ` — TVA : ${dealer.tva_num}`}<br />
                    {dealer?.address?.replace(/\n/g, ", ")}<br />
                    {dealer?.email && `Email : ${dealer.email}`}{dealer?.phone && ` — Tél : ${dealer.phone}`}
                  </div>
                  <div style={{ fontSize: 9, color: "#aaa", lineHeight: 1.8, flex: 1 }}>
                    <strong style={{ color: "#888", letterSpacing: 1, textTransform: "uppercase", fontSize: 8 }}>Conditions de règlement</strong><br />
                    {(dealer?.conditions_reglement || "TVA acquittée sur les encaissements.\nTout retard de paiement entraîne des pénalités au taux légal en vigueur (art. L441-10 C. com.).\nIndemnité forfaitaire de recouvrement : 40 €.").split("\n").map((l, i) => <span key={i}>{l}<br /></span>)}
                  </div>
                  <div style={{ fontSize: 9, color: "#aaa", lineHeight: 1.8, flex: 1 }}>
                    <strong style={{ color: "#888", letterSpacing: 1, textTransform: "uppercase", fontSize: 8 }}>Informations complémentaires</strong><br />
                    {(dealer?.infos_complementaires || "En cas de litige, tribunal compétent selon règles de droit commun.\nFacture à conserver pendant 10 ans (art. L123-22 C. com.).").split("\n").map((l, i) => <span key={i}>{l}<br /></span>)}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   ORDERS PAGE
═══════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════
   DÉCLARATION DE CESSION (Cerfa 15776*02)
   Pré-remplie avec les données véhicule + client + garage
═══════════════════════════════════════════════════════════════ */
function CessionDoc({ order, dealer, vehicles, clients, onUpdateOrder, onClose }) {
  // Données véhicule : fraîches depuis la flotte si disponibles, sinon celles de la commande
  const freshVehicle = order.vehicle_id && vehicles ? vehicles.find(vh => vh.id === order.vehicle_id) : null;
  const orderV = order.vehicle_data || {};
  const v = {
    plate: freshVehicle?.plate || orderV.plate,
    marque: freshVehicle?.marque || orderV.marque,
    modele: freshVehicle?.modele || orderV.modele,
    finition: freshVehicle?.finition || orderV.finition,
    vin: freshVehicle?.vin || orderV.vin,
    genre: freshVehicle?.genre || orderV.genre || "VP",
    date_mise_en_circulation: freshVehicle?.date_mise_en_circulation || orderV.date_mise_en_circulation,
    kilometrage: freshVehicle?.kilometrage || orderV.kilometrage,
    carburant: freshVehicle?.carburant || orderV.carburant,
    numero_formule: freshVehicle?.numero_formule || orderV.numero_formule,
  };
  // Récupérer la civilité depuis le client CRM
  const crmClient = order.client_id && clients ? clients.find(c => c.id === order.client_id) : null;
  const client = {
    ...(order.client || {}),
    civilite: order.client?.civilite || crmClient?.civilite || "",
  };
  const [loading, setLoading] = useState(false);
  const [pdfUrl, setPdfUrl] = useState(null);

  // ── DATE DU CERFA — figée à la première génération ──
  // Si le cerfa n'a jamais été généré (pas de cession_date sur l'order),
  // on prend today() ; sinon on garde la date sauvegardée pour ne pas
  // l'écraser à chaque réouverture du document.
  const [cessionDate, setCessionDate] = useState(order.cession_date || today());
  const [cessionHeure, setCessionHeure] = useState(order.cession_heure || new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }));

  const generatePdf = async () => {
    setLoading(true);
    try {
      if (!window.PDFLib) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js";
          script.onload = resolve;
          script.onerror = reject;
          document.head.appendChild(script);
        });
      }
      const { PDFDocument } = window.PDFLib;

      const pdfBytes = await fetch("/cerfa_15776-01_acroform.pdf").then(r => r.arrayBuffer());
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const form = pdfDoc.getForm();

      // ── Helpers ultra-simples — exactement comme le test console qui marche ──
      const setText = (name, value) => {
        if (!value) return;
        try { form.getTextField(name).setText(String(value)); }
        catch(e) { console.warn("Champ:", name, e.message); }
      };
      const setCheck = (name) => {
        try { form.getCheckBox(name).check(); }
        catch(e) { console.warn("Check:", name, e.message); }
      };
      const setRadio = (name, value) => {
        try { form.getRadioGroup(name).select(value); }
        catch(e) { console.warn("Radio:", name, e.message); }
      };

      // ── Parser d'adresse française ──
      const parseAddress = (addr) => {
        if (!addr) return { num: "", ext: "", type: "", nom: "", cp: "", ville: "" };
        const lines = addr.split("\n").map(l => l.trim()).filter(Boolean);
        const rue = lines[0] || "";
        const cpLine = lines.find(l => /\d{5}/.test(l)) || "";
        const cpMatch = cpLine.match(/(\d{5})\s*(.*)/);
        const cp = cpMatch ? cpMatch[1] : "";
        const ville = cpMatch ? cpMatch[2].trim() : "";
        const types = ["RUE","AVENUE","AVE","AV","BOULEVARD","BD","BLVD","IMPASSE","IMP","CHEMIN","CH","ROUTE","RTE","PLACE","PL","ALLÉE","ALLEE","PASSAGE","COURS","SQUARE","SQ","LOTISSEMENT","LOT","RÉSIDENCE","RESIDENCE","HAMEAU","LIEU-DIT","QUAI","VOIE","SENTIER","TRAVERSE"];
        const extensions = ["BIS","TER","QUATER","A","B","C"];
        const parts = rue.split(/\s+/);
        let num = "", ext = "", type = "", nom = "";
        let idx = 0;
        if (parts[idx] && /^\d+$/.test(parts[idx])) { num = parts[idx]; idx++; }
        if (parts[idx] && extensions.includes(parts[idx].toUpperCase())) { ext = parts[idx]; idx++; }
        if (parts[idx] && types.includes(parts[idx].toUpperCase())) { type = parts[idx]; idx++; }
        nom = parts.slice(idx).join(" ");
        if (!type && !num) nom = rue;
        return { num, ext, type, nom, cp, ville };
      };

      const dA = parseAddress(dealer?.address || "");
      const cA = parseAddress(client.address || "");
      // ⚠ On utilise la date FIGÉE depuis le state — pas today() — pour que la date
      // ne change pas à chaque réouverture du document après l'impression.
      const dateJ = cessionDate;
      const [dj, dm, da] = dateJ.includes("/") ? dateJ.split("/") : ["","",""];
      const heure = cessionHeure;
      const [h1, h2] = heure.split(":");
      const dateMEC = v.date_mise_en_circulation || "";
      const mecP = dateMEC.includes("/") ? dateMEC.split("/") : [];

      for (const pk of ["Page1", "Page2"]) {
        const p = (n) => `${pk}.${n}`;

        // VÉHICULE
        setText(p("num_Immatriculation"), v.plate);
        setText(p("num_Identification"), v.vin);
        if (mecP.length === 3) {
          setText(p("num_DateImmatriculationJour"), mecP[0]);
          setText(p("num_DateImmatriculationMois"), mecP[1]);
          setText(p("num_DateImmatriculationAnnée"), mecP[2]);
        } else { setText(p("num_DateImmatriculationJour"), dateMEC); }
        setText(p("txt_MarqueVéhicule"), v.marque);
        setText(p("txt_TypeVarianteVersionVéhicule"), v.finition);
        setText(p("txt_GenreNational"), v.genre || "VP");
        setText(p("txt_DénominationCommerciale"), v.modele);
        setText(p("num_KilométrageCompteur"), v.kilometrage ? String(Number(v.kilometrage).toLocaleString("fr-FR")).replace(/\u202f/g, " ").replace(/\u00a0/g, " ") : "");

        // Numéro de formule du certificat d'immatriculation (préfixé par "20" sur le Cerfa)
        if (v.numero_formule) setText(p("num_Formule"), v.numero_formule);

        // Certificat immatriculation : OUI
        setRadio(p("Groupe_de_boutons_radio1"), "1");

        // ANCIEN PROPRIÉTAIRE
        setRadio(p("Groupe_de_boutons_radio3"), "1");  // Personne morale
        setText(p("txt_IdentitéVendeur"), dealer?.name);
        setText(p("Num_Siret"), dealer?.siret);
        setText(p("num_VoieAdresse"), dA.num);
        setText(p("txt_ExtensionAdresse"), dA.ext);
        setText(p("txt_TypeVoieAdresse"), dA.type);
        setText(p("txt_NomVoie"), dA.nom);
        setText(p("num_CodePostalAdresse"), dA.cp);
        setText(p("txt_CommuneAdresse"), dA.ville);
        setRadio(p("Groupe_de_boutons_radio4"), "1");  // Céder
        setText(p("num_DateVenteJour"), dj);
        setText(p("num_DateVenteMois"), dm);
        setText(p("num_DateVenteAnnée"), da);
        setText(p("num_HoraireVente1"), h1);
        setText(p("num_HoraireVente2"), h2);
        setCheck(p("ckb_ValidationDéclaration1"));
        setCheck(p("ckb_ValidationDéclaration2"));
        setText(p("txt_LieuDéclaration1"), dA.ville);
        setText(p("num_DateDéclaration"), dateJ);

        // NOUVEAU PROPRIÉTAIRE
        setRadio(p("Groupe_de_boutons_radio5"), "2");  // Personne physique
        if (client.civilite === "M") setRadio(p("Groupe_de_boutons_radio6"), "1");
        if (client.civilite === "F") setRadio(p("Groupe_de_boutons_radio6"), "2");
        // v8.48.7 — Ordre Cerfa officiel : "NOM Prénom" (nom en majuscules d'abord)
        // Fallback : si nom/prénom séparés absents, on splitte client.name (qui est "Prénom Nom" par défaut)
        const identiteAcheteur = (() => {
          if (client.nom || client.prenom) {
            return `${(client.nom || "").toUpperCase()} ${client.prenom || ""}`.trim();
          }
          // Fallback : split "Prénom Nom" → "NOM Prénom"
          const parts = (client.name || "").trim().split(/\s+/);
          if (parts.length >= 2) {
            const nom = parts[parts.length - 1];
            const prenom = parts.slice(0, -1).join(" ");
            return `${nom.toUpperCase()} ${prenom}`.trim();
          }
          return client.name || "";
        })();
        setText(p("txt_IdentitéAcheteur"), identiteAcheteur);
        if (client.siren) setText(p("num_SiretAcheteur"), client.siren);
        setText(p("num_VoieAdresseAcheteur"), cA.num);
        setText(p("txt_ExtensionAdresseAcheteur"), cA.ext);
        setText(p("txt_TypeVoieAdresseAcheteur"), cA.type);
        setText(p("txt_NomVoieAdresseAcheteur"), cA.nom);
        setText(p("num_CodePostalAdresseAcheteur"), cA.cp);
        setText(p("txt_CommuneAdresseAcheteur"), cA.ville);
        setCheck(p("ckb_ValidationDéclarationA1"));
        setCheck(p("ckb_ValidationDéclarationA2"));
        setText(p("txt_LieuDéclaration2"), dA.ville);
        setText(p("txt_dateDéclaration"), dateJ);
      }

      const filledBytes = await pdfDoc.save();
      const blob = new Blob([filledBytes], { type: "application/pdf" });
      setPdfUrl(URL.createObjectURL(blob));
    } catch (err) {
      console.error("Erreur Cerfa:", err);
      alert("Erreur Cerfa : " + err.message);
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    generatePdf();
    // Si c'est la PREMIÈRE génération (pas de date sauvegardée sur l'order),
    // on persiste maintenant la date+heure pour qu'elles restent stables.
    if (!order.cession_date && onUpdateOrder) {
      onUpdateOrder({ ...order, cession_date: cessionDate, cession_heure: cessionHeure });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bouton "Mettre à jour la date" : remet la date à aujourd'hui, sauvegarde,
  // et regénère le PDF avec la nouvelle date.
  const refreshDate = () => {
    if (!window.confirm(`La date actuelle du Cerfa est ${cessionDate} à ${cessionHeure}.\n\nLa remplacer par la date d'aujourd'hui (${today()}) ?`)) return;
    const newDate = today();
    const newHeure = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    setCessionDate(newDate);
    setCessionHeure(newHeure);
    if (onUpdateOrder) onUpdateOrder({ ...order, cession_date: newDate, cession_heure: newHeure });
    // Petit délai pour laisser React mettre à jour le state avant regénération
    setTimeout(() => generatePdf(), 50);
  };

  return (
    <div className="modal-bg" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 1000, width: "98vw", height: "92vh", display: "flex", flexDirection: "column" }}>
        <div className="modal-hd" style={{ flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
            <span className="modal-title">Cerfa 15776 — Cession {v.plate || ""}</span>
            <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "DM Mono, monospace", whiteSpace: "nowrap" }}>
              📅 {cessionDate} · {cessionHeure}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {pdfUrl && (
              <>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={refreshDate}
                  title="Remplacer par la date du jour"
                  style={{ fontSize: 11 }}
                >🔄 Mettre à jour la date</button>
                <a href={pdfUrl} download={"Cession_" + (v.plate || "vehicule") + "_" + cessionDate.replace(/\//g, "-") + ".pdf"} className="btn btn-primary btn-sm">Telecharger</a>
                <button className="btn btn-ghost btn-sm" onClick={() => { const w = window.open(pdfUrl, "_blank"); if (w) setTimeout(() => w.print(), 800); }}>Imprimer</button>
              </>
            )}
            <button className="close-btn" onClick={onClose}>x</button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: "hidden", background: "#333", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {loading ? (
            <div style={{ textAlign: "center", color: "#fff", padding: 40 }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>...</div>
              <div>Generation du Cerfa...</div>
            </div>
          ) : pdfUrl ? (
            <iframe src={pdfUrl} style={{ width: "100%", height: "100%", border: "none" }} title="Cerfa 15776" />
          ) : (
            <div style={{ textAlign: "center", color: "#fff", padding: 40 }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>Erreur</div>
              <button className="btn btn-primary btn-sm" style={{ marginTop: 12 }} onClick={generatePdf}>Reessayer</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   PV DE LIVRAISON
   Document attestant la remise du véhicule à l'acheteur.
   Reprend les données du Livre de Police + signatures + annotation.
   Imprimable et téléchargeable en PDF (via window.print).
═══════════════════════════════════════════════════════════════ */
function PVLivraisonDoc({ entry, dealer, onSave, onClose }) {
  const [form, setForm] = useState({
    pv_annotation: entry.pv_annotation || "",
    pv_signature_garage: entry.pv_signature_garage || null,
    pv_signature_acheteur: entry.pv_signature_acheteur || null,
    // Date + heure de signature (figées au clic "Signé", jamais écrasées ensuite)
    pv_signe_date: entry.pv_signe_date || null,
    pv_signe_heure: entry.pv_signe_heure || null,
  });

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Action "Signé" : fige la date + heure courantes (si pas déjà signé), sauvegarde et ferme.
  // Si déjà signé : on confirme avant d'écraser (cas "re-signature").
  const handleSign = () => {
    if (form.pv_signe_date) {
      const ok = window.confirm(`Le document a déjà été signé le ${form.pv_signe_date} à ${form.pv_signe_heure}.\n\nVoulez-vous re-signer maintenant ? La nouvelle date remplacera l'ancienne.`);
      if (!ok) { onClose(); return; }
    }
    const now = new Date();
    const newDate = today();
    const newHeure = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    const updated = { ...entry, ...form, pv_signe_date: newDate, pv_signe_heure: newHeure };
    if (onSave) onSave(updated);
    onClose();
  };

  const handlePrint = () => {
    // Sauvegarde silencieuse avant impression (pour conserver les signatures)
    if (onSave) onSave({ ...entry, ...form });

    // Ouvre une fenêtre popup avec uniquement le document, comme pour les BC/factures.
    // Plus robuste que `window.print()` direct sur la modale (qui souffre des règles
    // de visibility/position des modaux et finit par imprimer une page blanche).
    const el = document.getElementById('pv-livraison-print');
    if (!el) { alert("Document introuvable"); return; }
    const win = window.open('', '_blank');
    if (!win) { alert("Le navigateur a bloqué la fenêtre d'impression"); return; }

    win.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"/>');
    win.document.write('<title>PV de Livraison ' + (entry.immat || '') + '</title>');
    win.document.write('<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Syne:wght@700;800&display=swap" rel="stylesheet">');
    win.document.write('<style>');
    win.document.write('body{margin:0;padding:0;background:#fff;font-family:"DM Sans",sans-serif;color:#1a1a1a}');
    win.document.write('#pv-livraison-print{max-width:none!important;margin:0 auto;padding:8mm 10mm!important;color:#1a1a1a!important;font-size:11px!important;line-height:1.4!important;position:relative!important;overflow:hidden!important}');
    win.document.write('#pv-livraison-print *{color:inherit}');
    // Filigrane — forcer l'impression des couleurs très claires (sinon les navigateurs n'impriment pas les fonds)
    win.document.write('.pdoc-watermark{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}');
    win.document.write('.pdoc-watermark img{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;color-adjust:exact!important}');
    // Compaction agressive pour tenir sur 1 page A4
    win.document.write('#pv-livraison-print > div:first-child{margin-bottom:10px!important;padding-bottom:8px!important}');// en-tête
    win.document.write('#pv-livraison-print table{margin-bottom:10px!important}');
    win.document.write('#pv-livraison-print table td{padding:4px 10px!important;font-size:10.5px!important}');
    win.document.write('#pv-livraison-print > div{margin-bottom:8px!important}');
    win.document.write('#pv-livraison-print > div[style*="grid"]{gap:10px!important;margin-bottom:8px!important}');
    win.document.write('#pv-livraison-print > div[style*="grid"] > div{padding:8px 10px!important}');
    // Réduire la taille des images de signature pour gagner de la place verticale
    win.document.write('#pv-livraison-print img[alt*="signature"]{max-height:60px!important;max-width:200px!important}');
    win.document.write('#pv-livraison-print h1, #pv-livraison-print h2{margin:0!important}');
    win.document.write('.hide-on-print{display:none!important}');
    win.document.write('.only-on-print{display:block!important}');
    win.document.write('img{max-width:100%}');
    // Anti-saut de page sur les blocs critiques de fin
    win.document.write('#pv-livraison-print > div[style*="grid-template-columns"]:last-of-type{page-break-inside:avoid!important;margin-top:14px!important}');
    win.document.write('@page{size:A4 portrait;margin:6mm}');
    win.document.write('@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}');
    win.document.write('</style>');
    win.document.write('</head><body>');
    win.document.write(el.outerHTML);
    win.document.write('</body></html>');
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 600);
  };

  const sigGarage   = typeof form.pv_signature_garage   === "string" ? form.pv_signature_garage   : form.pv_signature_garage?.url;
  const sigAcheteur = typeof form.pv_signature_acheteur === "string" ? form.pv_signature_acheteur : form.pv_signature_acheteur?.url;

  // Nom et adresse du garage
  const garageName    = dealer?.name    || "Concession";
  const garageAddr    = dealer?.address || "";
  const garageSiret   = dealer?.siret   || "";
  const garageEmail   = dealer?.email   || "";
  const garagePhone   = dealer?.phone   || "";
  const dateLivraison = entry.date_sortie || today();

  return (
    <div className="modal-bg" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 900, width: "98vw", maxHeight: "92vh", display: "flex", flexDirection: "column" }}>
        <div className="modal-hd" style={{ flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
            <span className="modal-title">📜 PV de Livraison — N°{String(entry.num_ordre || 0).padStart(4, "0")} · {entry.immat || ""}</span>
            {form.pv_signe_date && (
              <span style={{ fontSize: 11, color: "var(--green)", fontFamily: "DM Mono, monospace", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 4 }}>
                ✓ Signé le {form.pv_signe_date} à {form.pv_signe_heure}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={handlePrint}>🖨 Imprimer / PDF</button>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSign}
              title={form.pv_signe_date ? "Re-signer (remplace la date actuelle)" : "Marquer comme signé et figer la date+heure"}
            >
              ✍️ {form.pv_signe_date ? "Re-signer" : "Signé"}
            </button>
            <button className="close-btn" onClick={onClose}>×</button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: "auto", background: "#2a2a2a", padding: 20 }}>
          {/* Document A4 imprimable */}
          <div className="pdoc" id="pv-livraison-print" style={{ position: "relative", overflow: "hidden", background: "#fff", color: "#1a1a1a", padding: "32px 40px", maxWidth: 800, margin: "0 auto", fontFamily: "DM Sans, system-ui, sans-serif", fontSize: 12, lineHeight: 1.5 }}>

            {/* ── FILIGRANE DIAGONAL : logo du garage en travers, en très transparent ── */}
            {dealer?.logo && (
              <div className="pdoc-watermark" aria-hidden="true" style={{
                position: "absolute",
                top: 0, left: 0, right: 0, bottom: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
                zIndex: 0,
                overflow: "hidden",
              }}>
                <img src={dealer.logo} alt="" style={{
                  width: "75%",
                  maxWidth: 600,
                  opacity: 0.06,
                  transform: "rotate(-28deg)",
                  filter: dealer.logoInvert ? "invert(1)" : "none",
                  mixBlendMode: dealer.logoBlend || "normal",
                  objectFit: "contain",
                }} />
              </div>
            )}

            {/* Contenu au-dessus du filigrane */}
            <div style={{ position: "relative", zIndex: 1 }}>

            {/* En-tête */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, paddingBottom: 16, borderBottom: "2px solid #d4a843" }}>
              <div>
                {dealer?.logo && <img src={dealer.logo} alt="logo" style={{ maxHeight: 60, marginBottom: 8 }} />}
                <div style={{ fontSize: 16, fontWeight: 700, color: "#1a1a1a" }}>{garageName}</div>
                {garageAddr && <div style={{ fontSize: 11, color: "#444", whiteSpace: "pre-line" }}>{garageAddr}</div>}
                {garageSiret && <div style={{ fontSize: 11, color: "#444" }}>SIRET : {garageSiret}</div>}
                <div style={{ fontSize: 11, color: "#444" }}>
                  {garagePhone && <span>📞 {garagePhone}</span>}
                  {garagePhone && garageEmail && <span> · </span>}
                  {garageEmail && <span>✉ {garageEmail}</span>}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontFamily: "Syne, sans-serif", fontSize: 22, fontWeight: 800, color: "#d4a843", letterSpacing: 1 }}>PV DE LIVRAISON</div>
                <div style={{ fontSize: 11, color: "#666", marginTop: 4 }}>Procès-verbal de remise de véhicule</div>
                <div style={{ fontSize: 12, color: "#1a1a1a", marginTop: 8 }}>N°{String(entry.num_ordre || 0).padStart(4, "0")}</div>
                <div style={{ fontSize: 12, color: "#1a1a1a" }}>Date : <strong>{dateLivraison}</strong></div>
              </div>
            </div>

            {/* Préambule */}
            <div style={{ marginBottom: 20, fontSize: 12, color: "#1a1a1a", lineHeight: 1.6 }}>
              Le présent procès-verbal atteste la remise du véhicule désigné ci-dessous par le vendeur à l'acheteur, à la date indiquée. Les deux parties reconnaissent que le véhicule a été livré conformément aux conditions contractuelles convenues et après vérifications mutuelles.
            </div>

            {/* Parties */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
              <div style={{ padding: "12px 14px", background: "#f9f8f5", borderRadius: 6, border: "1px solid #e8e8e8" }}>
                <div style={{ fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", color: "#666", marginBottom: 6, fontWeight: 700 }}>Le vendeur</div>
                <div style={{ fontWeight: 700, fontSize: 13, color: "#1a1a1a" }}>{garageName}</div>
                {garageAddr && <div style={{ fontSize: 11, color: "#333", whiteSpace: "pre-line" }}>{garageAddr}</div>}
                {garageSiret && <div style={{ fontSize: 11, color: "#333" }}>SIRET : {garageSiret}</div>}
              </div>
              <div style={{ padding: "12px 14px", background: "#f9f8f5", borderRadius: 6, border: "1px solid #e8e8e8" }}>
                <div style={{ fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", color: "#666", marginBottom: 6, fontWeight: 700 }}>L'acheteur</div>
                <div style={{ fontWeight: 700, fontSize: 13, color: "#1a1a1a" }}>{entry.acheteur_nom || "—"}</div>
                {entry.acheteur_adresse && <div style={{ fontSize: 11, color: "#333" }}>{entry.acheteur_adresse}</div>}
              </div>
            </div>

            {/* Récapitulatif véhicule */}
            <div style={{ fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", color: "#d4a843", marginBottom: 10, fontWeight: 700 }}>🚗 Véhicule livré</div>
            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 20, border: "1px solid #e8e8e8", color: "#1a1a1a" }}>
              <tbody>
                {[
                  ["Marque", entry.marque],
                  ["Modèle", entry.modele],
                  ["Année", entry.annee],
                  ["Couleur", entry.couleur],
                  ["Immatriculation", entry.immat],
                  ["N° VIN / Châssis", entry.vin],
                  ["Kilométrage à la livraison", entry.kilometrage ? `${entry.kilometrage} km` : ""],
                  ["Pays d'origine", entry.pays_origine],
                ].filter(([, v]) => v).map(([k, v]) => (
                  <tr key={k} style={{ borderBottom: "1px solid #f0f0f0" }}>
                    <td style={{ padding: "8px 12px", fontSize: 11, color: "#444", width: "35%", background: "#fafafa", fontWeight: 600 }}>{k}</td>
                    <td style={{ padding: "8px 12px", fontSize: 12, fontWeight: 600, color: "#1a1a1a" }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Annotation */}
            {form.pv_annotation && (
              <>
                <div style={{ fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", color: "#d4a843", marginBottom: 10, fontWeight: 700 }}>📝 Observations / accessoires remis</div>
                <div style={{ padding: "12px 14px", background: "#fdf8ec", border: "1px solid #e8d9a8", borderRadius: 6, fontSize: 12, color: "#1a1a1a", whiteSpace: "pre-wrap", marginBottom: 20, lineHeight: 1.6 }}>
                  {form.pv_annotation}
                </div>
              </>
            )}

            {/* Mention */}
            <div style={{ fontSize: 11, color: "#333", marginBottom: 24, padding: "10px 14px", background: "#fafafa", border: "1px dashed #ccc", borderRadius: 6, lineHeight: 1.5 }}>
              Les soussignés reconnaissent que le véhicule désigné ci-dessus a été remis en bon état apparent à la date indiquée, accompagné de l'ensemble de ses documents et accessoires éventuellement listés ci-dessus.
            </div>

            {/* Signatures */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginTop: 24 }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: "#666", marginBottom: 8, fontWeight: 600 }}>Signature du vendeur</div>
                {/* Si signature présente : affichage direct en <img> (visible à l'écran ET imprimable).
                    Sinon : SignaturePad pour saisie + cadre vide pour l'impression. */}
                {sigGarage ? (
                  <img src={sigGarage} alt="signature vendeur" style={{ maxHeight: 80, maxWidth: 240, border: "1px solid #ddd", padding: 4, background: "#fff", display: "block", margin: "0 auto" }} />
                ) : (
                  <>
                    <div className="hide-on-print">
                      <SignaturePad label="" savedImg={null} onSave={(s) => set("pv_signature_garage", s)} />
                    </div>
                    <div style={{ height: 80, border: "1px dashed #aaa", borderRadius: 4, maxWidth: 240, margin: "0 auto", display: "none" }} className="only-on-print">&nbsp;</div>
                  </>
                )}
                <div style={{ marginTop: 8, fontSize: 11, color: "#1a1a1a", fontWeight: 700 }}>{garageName}</div>
              </div>

              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: "#666", marginBottom: 8, fontWeight: 600 }}>Signature de l'acheteur</div>
                {sigAcheteur ? (
                  <img src={sigAcheteur} alt="signature acheteur" style={{ maxHeight: 80, maxWidth: 240, border: "1px solid #ddd", padding: 4, background: "#fff", display: "block", margin: "0 auto" }} />
                ) : (
                  <>
                    <div className="hide-on-print">
                      <SignaturePad label="" savedImg={null} onSave={(s) => set("pv_signature_acheteur", s)} />
                    </div>
                    <div style={{ height: 80, border: "1px dashed #aaa", borderRadius: 4, maxWidth: 240, margin: "0 auto", display: "none" }} className="only-on-print">&nbsp;</div>
                  </>
                )}
                <div style={{ marginTop: 8, fontSize: 11, color: "#1a1a1a", fontWeight: 700 }}>{entry.acheteur_nom || "—"}</div>
              </div>
            </div>

            {/* Pied de page : si signé → date+heure de signature ; sinon → date génération */}
            <div style={{ marginTop: 32, paddingTop: 12, borderTop: "1px solid #eee", fontSize: 10, color: "#666", textAlign: "center" }}>
              {form.pv_signe_date ? (
                <>
                  <strong style={{ color: "#1a1a1a" }}>✓ Document signé le {form.pv_signe_date} à {form.pv_signe_heure}</strong>
                  <br />
                  <span style={{ fontSize: 9, color: "#999" }}>{garageName} {garageSiret && `· SIRET ${garageSiret}`}</span>
                </>
              ) : (
                <>Document généré le {today()} · {garageName} {garageSiret && `· SIRET ${garageSiret}`}</>
              )}
            </div>
            </div>{/* /position:relative wrapper */}
          </div>
        </div>
      </div>

      {/* CSS local au composant — l'impression se fait dans une fenêtre popup
          (cf. handlePrint), donc on a juste besoin de bien afficher le doc à l'écran. */}
      <style>{`
        #pv-livraison-print {
          color: #1a1a1a !important;
        }
        #pv-livraison-print, #pv-livraison-print * {
          color: inherit;
        }
        .only-on-print { display: none; }
      `}</style>
    </div>
  );
}

function OrdersPage({ orders, setOrders, vehicles, setVehiclesRaw, dealer, apiKey, usage, setUsage, clients, setClients, viewMode, token }) {
  const [tab, setTabLocal] = useState("all");
  const [modal, setModal] = useState(null);
  const [print, setPrint] = useState(null);
  const [cession, setCession] = useState(null);
  const [payment, setPayment] = useState(null);
  const [search, setSearch] = useState("");
  const [pendingDelete, setPendingDelete] = useState(null);
  const [showDemoLimit, setShowDemoLimit] = useState(false);
  const [avoirChoice, setAvoirChoice] = useState(null); // { order, totalTtc } | null
  const [avoirPartiel, setAvoirPartiel] = useState(null); // { order, totalTtc } | null

  // v8.41 — Helper réutilisable : pousse un avoir à IOBILL (draft ou finalize selon mode)
  // mode : 'draft' (à la création) ou 'finalize' (au remboursement complet, ou auto)
  const pushCreditNoteToIobill = (avoir, mode) => {
    if (!token || !dealer?.iobill_auto_push || !dealer?.iobill_company_id) return;
    if (!avoir.facture_origine) return;
    fetch("/api/iobill-bridge", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "push_credit_note", order_id: avoir.id, mode })
    })
      .then(r => r.json())
      .then(j => {
        if (j.ok && j.credit_note_id) {
          setOrders(prev => (prev || []).map(x => x.id === avoir.id ? {
            ...x,
            iobill_invoice_id: j.credit_note_id,
            iobill_invoice_number: j.credit_note_number,
            iobill_pdf_url: j.pdf_url || null,
            iobill_status: j.status || (mode === 'draft' ? 'draft' : 'issued'),
            iobill_synced_at: new Date().toISOString(),
            iobill_sync_error: null
          } : x));
          console.log(`📝 Avoir ${j.status === 'draft' ? 'brouillon' : 'émis'} poussé à IOBILL :`, j.credit_note_number);
        } else if (j.error) {
          console.warn("Push avoir IOBILL : erreur", j.error);
        }
      })
      .catch(e => console.warn("Push avoir IOBILL : échec réseau", e));
  };

  const save = (o) => {
    // Sauvegarder le document — ajoute un timestamp de création à la 1re sauvegarde
    const exists = orders.find(x => x.id === o.id);
    const oWithTs = exists || o.created_at ? o : { ...o, created_at: new Date().toISOString() };
    const next = exists ? orders.map(x => x.id === o.id ? oWithTs : x) : [oWithTs, ...orders];
    setOrders(next);

    // BC créé → véhicule passe en "réservé"
    if (o.type === "bc" && o.vehicle_id && vehicles && !exists) {
      const veh = vehicles.find(v => v.id === o.vehicle_id);
      if (veh && veh.statut === "disponible") {
        setVehiclesRaw(vehicles.map(v => v.id === o.vehicle_id ? { ...v, statut: "réservé" } : v));
      }
    }

    // Créer automatiquement la fiche client CRM si elle n'existe pas encore
    if (o.client?.name && setClients && clients) {
      const nomClient = o.client.name.trim().toLowerCase();

      // Si client_id est défini, la fiche existe déjà (créée via createAndSelectClient) — on ne touche à rien
      if (!o.client_id) {
        const clientExiste = clients.find(c =>
          `${c.prenom || ""} ${c.nom}`.trim().toLowerCase() === nomClient ||
          `${c.nom || ""} ${c.prenom || ""}`.trim().toLowerCase() === nomClient
        );

        if (!clientExiste) {
          const parts = o.client.name.trim().split(" ");
          const prenom = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";
          const nom = parts[parts.length - 1];
          const statutAuto = o.type === "bc" ? "prospect" : "client";

          const newClient = {
            id: uid(),
            nom, prenom,
            email: o.client.email || "",
            phone: o.client.phone || "",
            adresse: o.client.address || "",
            statut: statutAuto,
            date_contact: today(),
            annotations: [{
              id: uid(),
              texte: o.type === "bc"
                ? `Fiche créée depuis le bon de commande ${o.ref} — statut Prospect`
                : `Fiche créée depuis la facture ${o.ref} — statut Client`,
              date: today(),
              heure: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
            }],
            notes: "", vehicule_interet: "", budget: 0,
          };
          setClients([newClient, ...clients]);
        }
      }
    }

    setModal(null);
  };

  const del = async (id) => {
    const o = orders.find(x => x.id === id);
    if (!o) { setPendingDelete(null); return; }

    // Si c'est un BC et qu'un véhicule est lié → repasser en "disponible"
    if (o.type === "bc" && o.vehicle_id && vehicles) {
      const veh = vehicles.find(v => v.id === o.vehicle_id);
      if (veh && veh.statut === "réservé") {
        setVehiclesRaw(vehicles.map(v => v.id === o.vehicle_id ? { ...v, statut: "disponible" } : v));
      }
    }

    // v8.49.13 — Cascade suppression avoir → IOBILL
    // Si c'est un avoir déjà poussé à IOBILL, on demande à IOBILL de le supprimer
    // aussi. L'API IOBILL refusera si :
    //   - status = 'issued' (chaîne de hashs verrouillée) → code ALREADY_ISSUED
    //   - pdp_transmitted_at NOT NULL (transmis à l'admin) → code PDP_TRANSMITTED
    // Dans ces cas on arrête l'opération locale pour éviter la désynchro.
    if (o.type === "avoir" && o.iobill_invoice_id && token && dealer?.iobill_company_id) {
      try {
        const r = await fetch("/api/iobill-bridge", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: "delete_credit_note", order_id: o.id })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (j?.code === "PDP_TRANSMITTED") {
            alert(
              "❌ Impossible de supprimer cet avoir.\n\n" +
              "Il a déjà été transmis à l'administration fiscale (PDP).\n" +
              "Un avoir transmis est immuable — c'est une obligation légale.\n\n" +
              "Contactez votre expert-comptable si nécessaire."
            );
            setPendingDelete(null);
            return; // ⛔ On arrête
          }
          if (j?.code === "ALREADY_ISSUED") {
            alert(
              "❌ Impossible de supprimer cet avoir.\n\n" +
              "Il est déjà émis (chaîne de hashs verrouillée). Un avoir émis est un " +
              "document comptable définitif — la numérotation séquentielle doit être " +
              "conservée sans rupture (art. 242 nonies A CGI).\n\n" +
              "Contactez votre expert-comptable si nécessaire."
            );
            setPendingDelete(null);
            return;
          }
          console.warn("[del avoir] IOBILL a refusé:", j?.error);
        } else {
          console.log("[del avoir] supprimé côté IOBILL:", j);
        }
      } catch (e) {
        console.warn("[del avoir] exception réseau (on continue local):", e.message);
      }
    }

    setOrders(orders.filter(x => x.id !== id));
    setPendingDelete(null);
  };

  const toFacture = (o) => {
    const updated = {
      ...o,
      type: "facture",
      ref: nextRef(orders, "facture"),
      date_creation: today(),
      // Mentions obligatoires 2026 par défaut si pas déjà définies
      categorie_operation: o.categorie_operation || "livraison_biens",
      tva_sur_debits: o.tva_sur_debits || false,
    };
    setOrders(orders.map(x => x.id === o.id ? updated : x));

    // v8.37 — Hook IO BILL : pousser la facture en BROUILLON à IOBILL (fire-and-forget)
    // Déclenché si :
    //   - le compte IOBILL est lié
    //   - auto_push activé
    //   - on convertit bien un BC vers facture (pas vers avoir, et c'est nouveau)
    if (token && dealer?.iobill_auto_push && dealer?.iobill_company_id
        && !o.iobill_invoice_id) {
      fetch("/api/iobill-bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "push_invoice_draft", order_id: o.id })
      })
        .then(r => r.json())
        .then(j => {
          if (j.ok && j.invoice_id) {
            setOrders(prev => (prev || []).map(x => x.id === o.id ? {
              ...x,
              iobill_invoice_id: j.invoice_id,
              iobill_invoice_number: j.invoice_number,
              iobill_status: j.status || 'draft', // v8.48.2 — propage le status brouillon
              iobill_synced_at: new Date().toISOString(),
              iobill_sync_error: null
            } : x));
            console.log("📝 Facture brouillon poussée à IOBILL :", j.invoice_number);
          } else if (j.error) {
            console.warn("Push draft IOBILL : erreur", j.error);
          }
        })
        .catch(e => console.warn("Push draft IOBILL : échec réseau", e));
    }

    // Passer le véhicule lié en "vendu" automatiquement
    if (o.vehicle_id && vehicles) {
      const veh = vehicles.find(v => v.id === o.vehicle_id);
      if (veh && veh.statut !== "vendu" && veh.statut !== "livré") {
        setVehiclesRaw(vehicles.map(v => v.id === o.vehicle_id ? { ...v, statut: "vendu" } : v));
      }
    }

    // Passer le prospect en "client" dans le CRM
    if (setClients && clients) {
      const nomDoc = (o.client?.name || "").trim().toLowerCase();

      const clientCrm = o.client_id
        // 1. Lien direct par ID (prioritaire)
        ? clients.find(c => c.id === o.client_id)
        // 2. Correspondance par nom complet "Prénom Nom" ou "Nom Prénom"
        : clients.find(c => {
            const fullA = `${c.prenom || ""} ${c.nom || ""}`.trim().toLowerCase();
            const fullB = `${c.nom || ""} ${c.prenom || ""}`.trim().toLowerCase();
            return fullA === nomDoc || fullB === nomDoc || c.nom?.toLowerCase() === nomDoc;
          });

      if (clientCrm) {
        const annot = {
          id: uid(),
          texte: `✅ Statut passé à "Client" — BC ${o.ref} converti en facture ${updated.ref}`,
          date: today(),
          heure: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
        };
        setClients(clients.map(c => c.id === clientCrm.id
          ? { ...c, statut: "client", annotations: [...(c.annotations || []), annot] }
          : c
        ));
      }
    }
  };

  const filtered = orders.filter(o => {
    const c = calcOrder(o);
    const matchT = tab === "all"
      || (tab === "bc" && o.type === "bc")
      || (tab === "facture" && o.type === "facture")
      || (tab === "avoir" && o.type === "avoir")
      || (tab === "encours" && o.type === "facture" && c.reste > 0.01)
      || (tab === "solde" && c.reste <= 0.01 && c.grandTotal > 0);
    const matchS = !search || `${o.ref} ${o.client?.name} ${o.vehicle_label} ${o.vehicle_plate}`.toLowerCase().includes(search.toLowerCase());
    return matchT && matchS;
  }).sort((a, b) => {
    // 1) Priorité : timestamp de création précis (created_at) — le plus récent en haut
    if (a.created_at && b.created_at) {
      return b.created_at.localeCompare(a.created_at);
    }
    // Si un seul a un created_at, il est considéré comme plus récent
    if (a.created_at && !b.created_at) return -1;
    if (!a.created_at && b.created_at) return 1;
    // 2) Fallback pour les anciens documents sans timestamp : date de création (format fr)
    const dateCmp = (b.date_creation || "").localeCompare(a.date_creation || "");
    if (dateCmp !== 0) return dateCmp;
    // 3) À date égale : numéro séquentiel de la ref le plus élevé en haut
    const numA = parseInt((a.ref || "").match(/(\d+)$/)?.[1] || "0", 10);
    const numB = parseInt((b.ref || "").match(/(\d+)$/)?.[1] || "0", 10);
    if (numA !== numB) return numB - numA;
    // 4) Si même numéro : la facture d'abord, puis son avoir juste après
    if (a.type === "facture" && b.type === "avoir") return -1;
    if (a.type === "avoir" && b.type === "facture") return 1;
    return 0;
  });

  return (
    <div className="page">
      {modal && <OrderForm order={modal === "new" ? null : modal} vehicles={vehicles} onSave={save} onClose={() => setModal(null)} apiKey={apiKey} clients={clients} setClients={setClients} orders={orders} viewMode={viewMode} setVehiclesRaw={setVehiclesRaw} usage={usage} setUsage={setUsage} />}
      {print && <PrintDoc order={print} dealer={dealer} onClose={() => setPrint(null)} viewMode={viewMode} />}
      {cession && <CessionDoc
        order={cession}
        dealer={dealer}
        vehicles={vehicles}
        clients={clients}
        onUpdateOrder={(updated) => {
          // Persiste la date du Cerfa sur l'order (cession_date / cession_heure)
          // pour qu'elle ne change pas à chaque réouverture.
          setOrders(orders.map(x => x.id === updated.id ? updated : x));
          setCession(updated);
        }}
        onClose={() => setCession(null)}
      />}
      {viewMode === "trial" && showDemoLimit && <DemoLimitModal type="orders" onClose={() => setShowDemoLimit(false)} />}
      {payment && <PaymentModal order={payment} onSave={o => {
        setOrders(orders.map(x => x.id === o.id ? o : x));
        setPayment(null);

        // v8.41 — Hook IO BILL pour avoirs : push automatique quand un avoir
        // vient d'être totalement remboursé (reste <= 0.01).
        if (o.type === "avoir" && o.facture_origine) {
          const ttc = Math.abs(parseFloat(o.prix_ht) || 0);
          const paiements = (Array.isArray(o.paiements) ? o.paiements : [])
            .reduce((s, p) => s + (parseFloat(p.montant) || 0), 0);
          const reste = ttc - paiements;
          if (reste <= 0.01) {
            // Mode 'finalize' = avoir totalement remboursé → bascule en 'issued' côté IOBILL
            pushCreditNoteToIobill(o, 'finalize');
          }
        }
      }} onClose={() => setPayment(null)} />}
      {pendingDelete && (
        <ConfirmModal
          title="Supprimer le document"
          message={`Voulez-vous supprimer définitivement le document ${pendingDelete.label} ? Cette action est irréversible.`}
          confirmLabel="Supprimer"
          onConfirm={() => del(pendingDelete.id)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {avoirChoice && (
        <AvoirChoiceModal
          order={avoirChoice.order}
          totalTtc={avoirChoice.totalTtc}
          onTotal={() => {
            const o = avoirChoice.order;
            const avoir = {
              ...o, id: uid(), type: "avoir",
              ref: nextRef(orders, "avoir"),
              date_creation: today(),
              created_at: new Date().toISOString(),
              facture_origine: o.ref,
              paiements: [],
              statut: null,
              prix_ht: String(Number(avoirChoice.totalTtc).toFixed(2)),
              frais_mise_dispo: "0",
              carte_grise: "0",
              remise_ttc: "0",
              reprise_active: false,
              reprise_valeur: 0,
              acompte_ttc: 0,  // ⚠ Un avoir n'a pas d'acompte signature
              // v8.49.13 — Reset des marqueurs IOBILL hérités de la facture d'origine.
              // Sans ça, l'avoir affichait "Transmise à IO BILL" dès sa création
              // (badge de la facture d'origine, pas de l'avoir lui-même).
              iobill_invoice_id: null,
              iobill_invoice_number: null,
              iobill_status: null,
              iobill_pdf_url: null,
              iobill_sync_error: null,
              iobill_synced_at: null,
            };
            setOrders([...orders, avoir]);
            setAvoirChoice(null);
          }}
          onPartiel={() => {
            setAvoirPartiel({ order: avoirChoice.order, totalTtc: avoirChoice.totalTtc });
            setAvoirChoice(null);
          }}
          onCancel={() => setAvoirChoice(null)}
        />
      )}
      {avoirPartiel && (
        <AvoirPartielModal
          order={avoirPartiel.order}
          totalTtc={avoirPartiel.totalTtc}
          onConfirm={(montant) => {
            const o = avoirPartiel.order;
            const avoir = {
              ...o, id: uid(), type: "avoir",
              ref: nextRef(orders, "avoir"),
              date_creation: today(),
              created_at: new Date().toISOString(),
              facture_origine: o.ref,
              paiements: [],
              statut: null,
              prix_ht: String(Number(montant).toFixed(2)),
              frais_mise_dispo: "0",
              carte_grise: "0",
              remise_ttc: "0",
              reprise_active: false,
              reprise_valeur: 0,
              acompte_ttc: 0,  // ⚠ Un avoir n'a pas d'acompte signature
              // v8.49.13 — Reset des marqueurs IOBILL hérités de la facture d'origine
              // (idem avoir total).
              iobill_invoice_id: null,
              iobill_invoice_number: null,
              iobill_status: null,
              iobill_pdf_url: null,
              iobill_sync_error: null,
              iobill_synced_at: null,
            };
            setOrders([...orders, avoir]);
            setAvoirPartiel(null);
          }}
          onCancel={() => setAvoirPartiel(null)}
        />
      )}

      <div className="page-header">
        <div>
          <div className="page-title">Commandes & Factures</div>
          <div className="page-sub">{orders.length} document{orders.length !== 1 ? "s" : ""}{viewMode === "trial" && <span style={{ marginLeft: 8, fontSize: 11, color: "var(--orange)" }}>· Mode démo ({orders.length}/{DEMO_LIMITS.orders})</span>}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {viewMode !== "trial" && (
            <button className="btn btn-ghost btn-sm" onClick={() => exportComptableCSV(orders, dealer)} title="Export comptable CSV">
              📊 Export comptable
            </button>
          )}
          <button className="btn btn-primary" onClick={() => {
            if (viewMode === "trial" && orders.length >= DEMO_LIMITS.orders) { setShowDemoLimit(true); return; }
            setModal("new");
          }}>+ Nouveau document</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <div className="tabs" style={{ margin: 0 }}>
          {[["all", "Tous"], ["bc", "BC"], ["facture", "Factures"], ["avoir", "Avoirs"], ["encours", "À encaisser"], ["solde", "Soldés"]].map(([k, l]) => (
            <div key={k} className={`tab${tab === k ? " active" : ""}`} onClick={() => setTabLocal(k)}>{l}</div>
          ))}
        </div>
        <input className="search-input" placeholder="Rechercher..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr><th>Réf.</th><th>Type</th><th>Date</th><th>Client</th><th>Véhicule</th><th>TTC</th><th>Encaissé</th><th>Reste</th><th>Paiement</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={10} style={{ textAlign: "center", color: "var(--muted)", padding: 40 }}>Aucun document trouvé</td></tr>
            )}
            {filtered.map(o => {
              const c = calcOrder(o);
              const pct = c.grandTotal > 0 ? Math.round(c.encaisse / c.grandTotal * 100) : 0;
              const paySt = getPayStatut(c, o.type);
              return (
                <tr key={o.id}>
                  <td style={{ fontFamily: "DM Mono", fontSize: 12, fontWeight: 600 }}>{o.ref}</td>
                  <td>
                    <span className={`badge ${o.type === "facture" ? "badge-gold" : o.type === "avoir" ? "badge-red" : "badge-blue"}`}>
                      {o.type === "facture" ? "🧾 Facture" : o.type === "avoir" ? "↩️ Avoir" : "📝 BC"}
                    </span>
                    {o.type === "avoir" && o.facture_origine && (
                      <div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "DM Mono", marginTop: 2 }}>↳ {o.facture_origine}</div>
                    )}
                  </td>
                  <td style={{ fontSize: 12, color: "var(--muted)" }}>{o.date_creation}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{o.client?.name || "—"}</div>
                    {o.client?.phone && <div style={{ fontSize: 11, color: "var(--muted)" }}>{o.client.phone}</div>}
                  </td>
                  <td>
                    {(() => {
                      const fv = o.vehicle_id && vehicles ? vehicles.find(vh => vh.id === o.vehicle_id) : null;
                      const label = fv ? `${fv.marque} ${fv.modele} ${fv.finition || ""} (${getYear(fv)})`.trim() : (o.vehicle_label || "—");
                      const plate = fv ? fv.plate : o.vehicle_plate;
                      return <>
                        <div style={{ fontSize: 12 }}>{label}</div>
                        {plate && <PlateBadge plate={plate} />}
                      </>;
                    })()}
                  </td>
                  <td style={{ fontFamily: "DM Mono", fontWeight: 700 }}>
                    {/* v8.49.11 — Montant à payer (avec débours) + sous-ligne "dont TVA · débours" */}
                    <div>{fmtDec(c.grandTotal)}</div>
                    {(() => {
                      const vatAbs = Math.abs(c.tvaAmt || 0);
                      const debAbs = Math.abs(c.debourTotal || 0);
                      const parts = [];
                      if (vatAbs > 0) parts.push(`${fmtDec(vatAbs)} TVA`);
                      if (debAbs > 0) parts.push(`${fmtDec(debAbs)} débours`);
                      if (parts.length === 0) return null;
                      return (
                        <div style={{ fontSize: 9, fontWeight: 400, color: "var(--muted)", marginTop: 2 }}>
                          dont {parts.join(" · ")}
                        </div>
                      );
                    })()}
                  </td>
                  <td style={{ fontFamily: "DM Mono", color: "var(--green)" }}>{c.encaisse > 0 ? fmtDec(c.encaisse) : "—"}</td>
                  <td>
                    {c.reste > 0.01 ? <span style={{ color: "var(--orange)", fontFamily: "DM Mono", fontSize: 12, fontWeight: 700 }}>{fmtDec(c.reste)}</span> : <span style={{ color: "var(--green)" }}>✓</span>}
                    {c.grandTotal > 0 && <div className="progress" style={{ marginTop: 4, width: 80 }}><div className="progress-fill" style={{ width: `${pct}%`, background: pct === 100 ? "var(--green)" : "var(--gold)" }} /></div>}
                  </td>
                  <td><span className={`badge ${paySt.cls}`}>{paySt.label}</span></td>
                  <td>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <button className="btn btn-ghost btn-xs" onClick={() => setPrint(o)} title="Imprimer">🖨</button>
                      {o.type === "facture" && o.vehicle_data && (
                        <button className="btn btn-ghost btn-xs" onClick={() => setCession(o)} title="Déclaration de cession" style={{ color: "var(--gold)" }}>📄 Cession</button>
                      )}
                      {/* En mode démo : facture validée = lecture seule */}
                      {(viewMode !== "trial" || o.type === "bc") && o.type === "bc" && (
                        <button className="btn btn-ghost btn-xs" onClick={() => toFacture(o)} title="Convertir en facture">🧾</button>
                      )}
                      {o.type === "facture" && viewMode !== "trial" && !orders.some(a => a.type === "avoir" && a.facture_origine === o.ref) && (() => {
                        return <button className="btn btn-ghost btn-xs" title="Créer un avoir" onClick={() => {
                          // v8.49.11 — Un avoir rembourse ce que le client a payé
                          // (grandTotal), y compris les débours refacturés.
                          const totalTtc = calcOrder(o).grandTotal;
                          setAvoirChoice({ order: o, totalTtc });
                        }}>↩️</button>;
                      })()}
                      {o.type === "facture" && c.reste > 0.01 && viewMode !== "trial" && (
                        <button className="btn btn-ghost btn-xs" style={{ color: "var(--green)" }} onClick={() => setPayment(o)}>💳</button>
                      )}
                      {o.type === "avoir" && c.reste > 0.01 && viewMode !== "trial" && (
                        <button className="btn btn-ghost btn-xs" style={{ color: "var(--red)" }} title="Marquer comme remboursé" onClick={() => {
                          // ⚠ On rembourse uniquement le RESTE (c.reste), pas le total TTC.
                          // Sinon, si l'avoir a déjà un acompte ou un paiement partiel,
                          // on rembourserait deux fois la même somme.
                          // c.reste est déjà en valeur absolue (cf. calcOrder).
                          const montant = Math.round(c.reste * 100) / 100;
                          if (montant <= 0) return;
                          const pmt = { id: uid(), date: today(), montant, mode: "Virement" };
                          // On AJOUTE aux paiements existants — on n'écrase pas, sinon on
                          // perd l'historique d'un éventuel remboursement partiel précédent.
                          const updated = { ...o, paiements: [...(o.paiements || []), pmt], statut: "payé" };
                          setOrders(orders.map(x => x.id === o.id ? updated : x));
                        }}>💸 Remboursé</button>
                      )}
                      {/* Modifier : bloqué sur les factures sauf admin */}
                      {(o.type !== "facture" || viewMode === "admin") && (
                        <button className="btn btn-ghost btn-xs" onClick={() => setModal(o)}>✏️</button>
                      )}
                      {/* v8.49.13 — Supprimer :
                          - Factures : bloqué (sauf admin) — comme avant
                          - Avoirs : bloqué dès qu'ils sont émis (iobill_status='issued')
                            car un avoir émis est verrouillé par chaîne de hashs et
                            transmis à IOBILL. Le supprimer créerait un trou dans la
                            numérotation séquentielle (art. 242 nonies A CGI).
                          - BC : toujours possible (pas encore fiscal). */}
                      {o.type === "avoir" && o.iobill_status === "issued" && viewMode !== "admin" ? (
                        <button
                          className="btn btn-danger btn-xs"
                          style={{ opacity: 0.3, cursor: "not-allowed" }}
                          onClick={() => alert(
                            "❌ Impossible de supprimer cet avoir.\n\n" +
                            "Il est déjà émis (chaîne de hashs verrouillée) et transmis à IO BILL.\n" +
                            "Un avoir émis est un document comptable définitif — obligation fiscale " +
                            "(art. 242 nonies A CGI : numérotation sans rupture).\n\n" +
                            "Si vous avez fait une erreur, contactez votre expert-comptable."
                          )}
                        >🗑</button>
                      ) : (o.type !== "facture" || viewMode === "admin") && (
                        <button className="btn btn-danger btn-xs" onClick={() => setPendingDelete({ id: o.id, label: o.ref })}>🗑</button>
                      )}
                    </div>
                    {/* v8.37 — État de transmission IO BILL (factures/avoirs uniquement) */}
                    {/* v8.40.3 — Le statut est calculé depuis order.iobill_pdf_url (source de vérité IOBILL) */}
                    {(o.type === "facture" || o.type === "avoir") && viewMode !== "trial" && (
                      <div style={{ marginTop: 6 }}>
                        <IobillInvoiceSync
                          token={token}
                          order={o}
                          garage={dealer}
                          onSync={(patch) => setOrders(prev => (prev || []).map(x => x.id === o.id ? { ...x, ...patch } : x))}
                        />
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   TICKET SYSTEM — Support & amélioration (v8.49.15 : chat threadé)
═══════════════════════════════════════════════════════════════ */
function TicketSystem({ dealer }) {
  const [tab, setTab]         = useState("new"); // "new" ou "mine"
  const [type, setType]       = useState("incident");
  const [message, setMessage] = useState("");
  const [sent, setSent]       = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError]     = useState("");
  const [myTickets, setMyTickets]     = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [openChat, setOpenChat]       = useState(null); // ticket ouvert

  const TYPES = [
    { value: "incident",     label: "🔴 Incident technique",       desc: "Bug, erreur, dysfonctionnement" },
    { value: "amelioration", label: "💡 Idée d'amélioration",      desc: "Nouvelle fonctionnalité, suggestion" },
    { value: "question",     label: "❓ Question / Aide",           desc: "Besoin d'assistance ou d'explication" },
    { value: "facturation",  label: "💳 Question de facturation",   desc: "Abonnement, paiement, facture" },
  ];

  const STATUS_LABELS = {
    new:         { label: "🆕 Nouveau",     color: "var(--blue)" },
    in_progress: { label: "💬 En cours",    color: "var(--gold)" },
    resolved:    { label: "✅ Résolu",       color: "var(--green)" },
    closed:      { label: "🔒 Fermé",        color: "var(--muted)" },
  };

  // Charge mes tickets à l'ouverture de l'onglet "mine"
  const loadMyTickets = React.useCallback(async () => {
    const token = localStorage.getItem("iocar_token");
    if (!token) return;
    setLoadingList(true);
    try {
      const r = await fetch("/api/ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ action: "list" }),
      });
      const j = await r.json();
      if (r.ok) setMyTickets(j.tickets || []);
    } catch(e) { /* silencieux */ }
    setLoadingList(false);
  }, []);

  React.useEffect(() => {
    if (tab === "mine") loadMyTickets();
  }, [tab, loadMyTickets]);

  // Compte total de messages non lus (pour badge onglet)
  const totalUnread = myTickets.reduce((s, t) => s + (t.unread_count || 0), 0);

  const submit = async () => {
    if (!message.trim()) { setError("Veuillez décrire votre demande"); return; }
    if (message.length > 5000) { setError("Message trop long (max 5000 caractères)"); return; }
    setSending(true); setError("");
    try {
      const token = localStorage.getItem("iocar_token");
      if (!token) { setError("Session expirée, veuillez vous reconnecter"); setSending(false); return; }
      const res = await fetch("/api/ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ type, message: message.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Erreur lors de l'envoi du ticket"); setSending(false); return; }
      setSent(true);
      setMessage("");
      loadMyTickets();
    } catch(e) {
      setError("Erreur réseau. Si le problème persiste, contactez contact@iocar.online directement.");
    }
    setSending(false);
  };

  return (
    <div className="card card-pad" style={{ marginTop: 24 }}>
      <div style={{ fontFamily: "Syne", fontSize: 14, fontWeight: 700, letterSpacing: 1, color: "var(--gold)", textTransform: "uppercase", marginBottom: 16 }}>
        🎫 Support & Suggestions
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20, borderBottom: "1px solid var(--border)" }}>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => { setTab("new"); setSent(false); }}
          style={{
            borderRadius: 0,
            borderBottom: tab === "new" ? "2px solid var(--gold)" : "2px solid transparent",
            color: tab === "new" ? "var(--gold)" : "var(--muted)",
            fontWeight: 700
          }}
        >📝 Nouveau ticket</button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setTab("mine")}
          style={{
            borderRadius: 0,
            borderBottom: tab === "mine" ? "2px solid var(--gold)" : "2px solid transparent",
            color: tab === "mine" ? "var(--gold)" : "var(--muted)",
            fontWeight: 700,
            display: "inline-flex", alignItems: "center", gap: 6
          }}
        >
          📬 Mes tickets
          {totalUnread > 0 && (
            <span style={{
              background: "var(--red)", color: "#fff", borderRadius: 10, padding: "2px 7px",
              fontSize: 10, fontWeight: 700
            }}>{totalUnread}</span>
          )}
        </button>
      </div>

      {tab === "new" && sent && (
        <div style={{ textAlign: "center", padding: "20px 0" }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
          <div style={{ fontFamily: "Syne", fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Ticket envoyé !</div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 16, lineHeight: 1.7 }}>
            Votre message a été transmis à notre équipe.<br />
            Retrouvez-le dans l'onglet <strong style={{ color: "var(--gold)" }}>Mes tickets</strong> pour suivre la conversation.
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setSent(false)}>Envoyer un autre ticket</button>
        </div>
      )}

      {tab === "new" && !sent && (
        <>
          <div className="form-group" style={{ marginBottom: 16 }}>
            <label className="form-label">Type de demande</label>
            <select className="form-input" value={type} onChange={e => setType(e.target.value)}>
              {TYPES.map(t => <option key={t.value} value={t.value}>{t.label} — {t.desc}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 16 }}>
            <label className="form-label">Votre message</label>
            <textarea className="form-input" rows={5}
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder={
                type === "incident"     ? "Décrivez le problème : que s'est-il passé, à quelle étape, quel message d'erreur ?" :
                type === "amelioration" ? "Décrivez votre idée : quelle fonctionnalité, quel bénéfice attendez-vous ?" :
                type === "facturation"  ? "Décrivez votre question concernant votre abonnement ou facturation..." :
                "Posez votre question ou décrivez ce dont vous avez besoin..."
              }
            />
            {error && <div style={{ fontSize: 12, color: "var(--red)", marginTop: 6 }}>⚠️ {error}</div>}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
              Réponse sous 24h à <strong style={{ color: "var(--muted2)" }}>{dealer?.email || "votre email"}</strong>
            </div>
            <button className="btn btn-primary" onClick={submit} disabled={sending}>
              {sending ? "⏳ Envoi..." : "📨 Envoyer le ticket"}
            </button>
          </div>
        </>
      )}

      {tab === "mine" && (
        <div>
          {loadingList && <div style={{ textAlign: "center", padding: 20, color: "var(--muted)" }}>Chargement…</div>}
          {!loadingList && myTickets.length === 0 && (
            <div style={{ textAlign: "center", padding: 20, color: "var(--muted)", fontSize: 13 }}>
              Aucun ticket pour l'instant. Créez-en un depuis l'onglet "Nouveau ticket".
            </div>
          )}
          {!loadingList && myTickets.map(t => {
            const st = STATUS_LABELS[t.status] || STATUS_LABELS.new;
            const typeLabel = TYPES.find(x => x.value === t.type)?.label || t.type;
            const preview = (t.message || "").slice(0, 100) + ((t.message || "").length > 100 ? "…" : "");
            return (
              <div key={t.id}
                onClick={() => setOpenChat(t)}
                style={{
                  background: "var(--card2)",
                  borderRadius: 10,
                  padding: "12px 14px",
                  marginBottom: 8,
                  cursor: "pointer",
                  border: "1px solid var(--border)"
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>
                    {typeLabel} · {new Date(t.created_at).toLocaleDateString("fr-FR")}
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {t.unread_count > 0 && (
                      <span style={{
                        background: "var(--red)", color: "#fff", borderRadius: 10, padding: "2px 7px",
                        fontSize: 10, fontWeight: 700
                      }}>{t.unread_count} nouveau{t.unread_count > 1 ? "x" : ""}</span>
                    )}
                    <span style={{ fontSize: 11, color: st.color, fontWeight: 700 }}>{st.label}</span>
                  </div>
                </div>
                <div style={{ fontSize: 13, color: "var(--text)" }}>{preview}</div>
              </div>
            );
          })}
        </div>
      )}

      {openChat && (
        <TicketChatModal
          ticket={openChat}
          dealer={dealer}
          onClose={() => { setOpenChat(null); loadMyTickets(); }}
        />
      )}
    </div>
  );
}

/* ─── MODAL CHAT THREADÉ (v8.49.15) ─────────────────────── */
function TicketChatModal({ ticket, dealer, onClose }) {
  const [messages, setMessages] = useState([]);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(ticket.status);
  const scrollRef = React.useRef(null);

  const STATUS_LABELS = {
    new:         { label: "🆕 Nouveau",     color: "var(--blue)" },
    in_progress: { label: "💬 En cours",    color: "var(--gold)" },
    resolved:    { label: "✅ Résolu",       color: "var(--green)" },
    closed:      { label: "🔒 Fermé",        color: "var(--muted)" },
  };
  const st = STATUS_LABELS[status] || STATUS_LABELS.new;
  const readOnly = status === "resolved" || status === "closed";

  const loadThread = React.useCallback(async () => {
    const token = localStorage.getItem("iocar_token");
    if (!token) return;
    try {
      const r = await fetch("/api/ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ action: "thread", ticket_id: ticket.id }),
      });
      const j = await r.json();
      if (r.ok) {
        setMessages(j.messages || []);
        setStatus(j.ticket?.status || status);
        await fetch("/api/ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ action: "mark_read", ticket_id: ticket.id }),
        });
      }
    } catch(e) { /* silencieux */ }
    setLoading(false);
  }, [ticket.id, status]);

  React.useEffect(() => { loadThread(); }, [loadThread]);

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  React.useEffect(() => {
    let channel = null;
    let cancelled = false;
    (async () => {
      try {
        const mod = await import("@supabase/supabase-js");
        const { createClient } = mod;
        const supaUrl = window.__SUPABASE_URL || import.meta.env?.VITE_SUPABASE_URL;
        const supaAnon = window.__SUPABASE_ANON_KEY || import.meta.env?.VITE_SUPABASE_ANON_KEY;
        if (!supaUrl || !supaAnon) return;
        const token = localStorage.getItem("iocar_token");
        const client = createClient(supaUrl, supaAnon, {
          global: { headers: { Authorization: `Bearer ${token}` } }
        });
        channel = client
          .channel(`ticket_${ticket.id}`)
          .on("postgres_changes", {
            event: "INSERT",
            schema: "public",
            table: "ticket_messages",
            filter: `ticket_id=eq.${ticket.id}`
          }, (payload) => {
            if (cancelled) return;
            setMessages(prev => {
              if (prev.some(m => m.id === payload.new.id)) return prev;
              return [...prev, payload.new];
            });
            if (payload.new.author_type === "admin") {
              const tok = localStorage.getItem("iocar_token");
              fetch("/api/ticket", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${tok}` },
                body: JSON.stringify({ action: "mark_read", ticket_id: ticket.id }),
              }).catch(() => {});
            }
          })
          .subscribe();
      } catch(e) {
        console.warn("[TicketChat] Realtime indisponible:", e.message);
      }
    })();
    return () => {
      cancelled = true;
      if (channel && channel.unsubscribe) channel.unsubscribe();
    };
  }, [ticket.id]);

  const send = async () => {
    if (!reply.trim() || sending) return;
    setSending(true);
    try {
      const token = localStorage.getItem("iocar_token");
      const r = await fetch("/api/ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ action: "reply", ticket_id: ticket.id, message: reply.trim() }),
      });
      const j = await r.json();
      if (r.ok && j.message) {
        setMessages(prev => {
          if (prev.some(m => m.id === j.message.id)) return prev;
          return [...prev, j.message];
        });
        setReply("");
      } else {
        alert(j.error || "Erreur envoi message");
      }
    } catch(e) { alert("Erreur réseau"); }
    setSending(false);
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 10000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20
    }}>
      <div style={{
        background: "var(--card)", borderRadius: 14, padding: 0,
        width: "100%", maxWidth: 640, maxHeight: "85vh",
        display: "flex", flexDirection: "column",
        border: "1px solid var(--border)"
      }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontFamily: "Syne", fontSize: 15, fontWeight: 700 }}>
              Ticket #{String(ticket.id).slice(0, 8)}
            </div>
            <div style={{ fontSize: 11, color: st.color, marginTop: 2, fontWeight: 700 }}>
              {st.label}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
          {loading && <div style={{ textAlign: "center", color: "var(--muted)" }}>Chargement…</div>}
          {!loading && (
            <>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 4 }}>
                  Vous · {new Date(ticket.created_at).toLocaleString("fr-FR")}
                </div>
                <div style={{ background: "var(--card2)", padding: 10, borderRadius: 8, fontSize: 13, whiteSpace: "pre-wrap" }}>
                  {ticket.message}
                </div>
              </div>
              {messages.map(m => {
                const mine = m.author_type === "subscriber";
                return (
                  <div key={m.id} style={{ marginBottom: 12, display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start" }}>
                    <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 4 }}>
                      {mine ? "Vous" : "🛠 Support"} · {new Date(m.created_at).toLocaleString("fr-FR")}
                    </div>
                    <div style={{
                      background: mine ? "var(--gold)" : "var(--card2)",
                      color: mine ? "#0a0a0a" : "var(--text)",
                      padding: 10, borderRadius: 8, fontSize: 13, whiteSpace: "pre-wrap",
                      maxWidth: "80%"
                    }}>
                      {m.message}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {readOnly ? (
          <div style={{ padding: 16, borderTop: "1px solid var(--border)", textAlign: "center", color: "var(--muted)", fontSize: 12 }}>
            🔒 Ce ticket est {status === "resolved" ? "résolu" : "fermé"} — plus de réponses possibles
          </div>
        ) : (
          <div style={{ padding: 12, borderTop: "1px solid var(--border)", display: "flex", gap: 8 }}>
            <textarea
              className="form-input"
              rows={2}
              value={reply}
              onChange={e => setReply(e.target.value)}
              placeholder="Répondre…"
              style={{ flex: 1, resize: "none" }}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
            />
            <button className="btn btn-primary" onClick={send} disabled={sending || !reply.trim()}>
              {sending ? "…" : "📤"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsPage({ token, dealer, setDealer, usage, isRealAdmin }) {
  const [form, setForm] = useState(dealer);
  const [showKey, setShowKey] = useState(false);
  const fileRef = useRef();

  const monthKey = new Date().toISOString().slice(0, 7);
  const usedThisMonth = usage?.[monthKey] || 0;

  // ─── PERSISTANCE LOCALE DU LOGO ──────────────────────────
  // Le logo est stocké en base64 et peut être lourd. On sauvegarde en local
  // immédiatement (résiste aux reload) et on tente Supabase en parallèle.
  const LOGO_LS_KEY = "iocar_logo_cache";

  const saveLogoEverywhere = (logoFields) => {
    // logoFields = { logo, logo_original, logoBlend, logoInvert }
    // 1) met à jour le formulaire local (affichage immédiat)
    setForm(f => ({ ...f, ...logoFields }));
    // 2) persiste dans localStorage (résiste au reload)
    try {
      localStorage.setItem(LOGO_LS_KEY, JSON.stringify({
        logo: logoFields.logo ?? null,
        logo_original: logoFields.logo_original ?? null,
        logoBlend: logoFields.logoBlend ?? "normal",
        logoInvert: !!logoFields.logoInvert,
        updated_at: new Date().toISOString(),
      }));
    } catch (e) {
      console.warn("localStorage plein ou indisponible", e);
    }
    // 3) enregistre aussi dans la source "officielle" (Supabase via setDealer)
    //    — garantit que d'autres pages/appareils voient la modif
    if (typeof setDealer === "function") {
      try { setDealer({ ...dealer, ...logoFields }); } catch (e) {}
    }
  };

  // Au montage : si un logo est en localStorage et pas encore dans le dealer, on l'injecte
  useEffect(() => {
    try {
      const cached = localStorage.getItem(LOGO_LS_KEY);
      if (!cached) return;
      const parsed = JSON.parse(cached);
      if (parsed?.logo && !form.logo) {
        setForm(f => ({
          ...f,
          logo: parsed.logo,
          logo_original: parsed.logo_original || parsed.logo,
          logoBlend: parsed.logoBlend || "normal",
          logoInvert: !!parsed.logoInvert,
        }));
      }
    } catch (e) {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compresse une image data-URL : redimensionne à max maxWidth et ré-encode en PNG
  // Réduit la taille de 2 Mo → ~100-300 Ko typiquement, compatible avec toutes les DBs.
  const compressLogo = (dataUrl, maxWidth = 800) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.naturalWidth);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });

  const handleLogo = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      // On compresse directement à l'upload pour éviter les logos énormes
      let finalDataUrl = ev.target.result;
      try {
        finalDataUrl = await compressLogo(ev.target.result, 800);
      } catch (err) {
        console.warn("Compression échouée, on garde l'original", err);
      }

      // Upload vers Supabase Storage via endpoint sécurisé
      let logoPath = null;
      let signedUrl = finalDataUrl; // fallback en cas d'échec réseau
      try {
        const up = await uploadImageToStorage({
          kind: "logo",
          dataUrl: finalDataUrl,
          filename: "logo",
        });
        logoPath = up.path;
        signedUrl = up.signedUrl || finalDataUrl;
      } catch(err) {
        console.warn("Upload Storage échoué, stockage local temporaire :", err.message);
      }

      saveLogoEverywhere({
        logo: signedUrl,               // URL signée (ou dataURL fallback) pour l'affichage
        logo_path: logoPath,           // chemin Storage pour régénérer l'URL plus tard
        logo_original: signedUrl,
        logoBlend: "normal",
        logoInvert: false,
      });
    };
    reader.readAsDataURL(file);
  };

  // ─── DÉTOURAGE AUTOMATIQUE DU FOND BLANC ──────────────────
  // Utilise un canvas pour remplacer les pixels blancs/quasi-blancs par transparent.
  // Tolerance = écart max au blanc (0 = blanc pur seulement, 40 = tolère les gris très clairs).
  const detourerFondBlanc = (tolerance = 20) => {
    const src = form.logo_original || form.logo;
    if (!src) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      // Redimensionne si trop grand (protection contre les énormes uploads)
      const scale = Math.min(1, 800 / img.naturalWidth);
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      try {
        const imageData = ctx.getImageData(0, 0, w, h);
        const d = imageData.data;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          // Si le pixel est "proche du blanc" → on le rend transparent
          if (r >= 255 - tolerance && g >= 255 - tolerance && b >= 255 - tolerance) {
            d[i + 3] = 0; // alpha = 0
          } else {
            // Léger adoucissement des bords : pixels clairs → semi-transparents
            const maxChannel = Math.max(r, g, b);
            if (maxChannel > 240 - tolerance) {
              const ratio = (255 - maxChannel) / (15 + tolerance);
              d[i + 3] = Math.min(255, Math.round(d[i + 3] * Math.max(0.3, ratio)));
            }
          }
        }
        ctx.putImageData(imageData, 0, 0);
        const dataUrl = canvas.toDataURL("image/png");

        // Upload du logo détouré vers Storage (async)
        (async () => {
          let logoPath = form.logo_path || null;
          let signedUrl = dataUrl;
          try {
            const up = await uploadImageToStorage({
              kind: "logo",
              dataUrl,
              filename: "logo-detoure",
            });
            logoPath = up.path;
            signedUrl = up.signedUrl || dataUrl;
          } catch(err) {
            console.warn("Upload Storage échoué :", err.message);
          }
          saveLogoEverywhere({
            logo: signedUrl,
            logo_path: logoPath,
            logo_original: form.logo_original || src,
            logoBlend: "normal",
            logoInvert: false,
          });
        })();
      } catch (err) {
        alert("Impossible de détourer ce logo. Essayez avec une autre image.");
        console.error(err);
      }
    };
    img.onerror = () => alert("Impossible de charger l'image pour le détourage.");
    img.src = src;
  };

  const restaurerLogo = () => {
    if (!form.logo_original) return;
    saveLogoEverywhere({
      logo: form.logo_original,
      logo_original: form.logo_original,
      logoBlend: "normal",
      logoInvert: false,
    });
  };

  const supprimerLogo = () => {
    saveLogoEverywhere({
      logo: null,
      logo_original: null,
      logoBlend: "normal",
      logoInvert: false,
    });
    try { localStorage.removeItem(LOGO_LS_KEY); } catch (e) {}
  };

  const saved = JSON.stringify(form) !== JSON.stringify(dealer);

  return (
    <div className="page">
      <div className="page-header">
        <div><div className="page-title">Paramètres</div><div className="page-sub">Informations de votre concession</div></div>
      </div>

      {/* ─── v8.37 — Carte Pont IO BILL ─── */}
      <div style={{ maxWidth: 900, marginBottom: 20 }}>
        <IobillBridgeCard
          token={token}
          garage={dealer}
          onUpdate={(patch) => setDealer({ ...dealer, ...patch })}
        />
      </div>

      {/* ─── v8.39 — Mentions garage (apparaissent en bas du PDF IO BILL) ─── */}
      {dealer.iobill_company_id && (
        <div style={{ maxWidth: 900, marginBottom: 20 }}>
          <div className="card card-pad">
            <div style={{ fontFamily: "Syne", fontSize: 14, fontWeight: 700, letterSpacing: 1, color: "var(--gold)", textTransform: "uppercase", marginBottom: 8 }}>
              📋 Mentions garage (pour IO BILL)
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 18, lineHeight: 1.5 }}>
              Ces mentions apparaîtront automatiquement en bas du PDF Factur-X de toutes vos factures côté IO BILL.
              Elles seront utiles pour votre comptable et pour les contrôles. Rédigez-les une fois pour toutes.
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 6, letterSpacing: 0.3 }}>
                GARANTIE
              </label>
              <textarea
                className="form-input"
                rows={3}
                placeholder="Exemple : Garantie contractuelle de 12 mois à compter de la livraison. Pièces et main d'œuvre. La garantie légale de conformité (art. L.217-3 du Code de la consommation) et la garantie des vices cachés (art. 1641 du Code civil) s'appliquent en sus."
                value={(dealer.business_mentions || {}).garantie || ""}
                onChange={e => {
                  const newMentions = { ...(dealer.business_mentions || {}), garantie: e.target.value };
                  setDealer({ ...dealer, business_mentions: newMentions });
                }}
                style={{ fontSize: 13, lineHeight: 1.5, width: "100%" }}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 6, letterSpacing: 0.3 }}>
                CONDITIONS DE VENTE
              </label>
              <textarea
                className="form-input"
                rows={3}
                placeholder="Exemple : Paiement intégral exigé à la livraison du véhicule. Le transfert de propriété s'opère au paiement complet du prix. Les risques sont transférés à l'acquéreur dès la livraison."
                value={(dealer.business_mentions || {}).conditions_vente || ""}
                onChange={e => {
                  const newMentions = { ...(dealer.business_mentions || {}), conditions_vente: e.target.value };
                  setDealer({ ...dealer, business_mentions: newMentions });
                }}
                style={{ fontSize: 13, lineHeight: 1.5, width: "100%" }}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 6, letterSpacing: 0.3 }}>
                CESSION
              </label>
              <textarea
                className="form-input"
                rows={2}
                placeholder="Exemple : Certificat de cession Cerfa 15776 fourni séparément à la livraison."
                value={(dealer.business_mentions || {}).cession || ""}
                onChange={e => {
                  const newMentions = { ...(dealer.business_mentions || {}), cession: e.target.value };
                  setDealer({ ...dealer, business_mentions: newMentions });
                }}
                style={{ fontSize: 13, lineHeight: 1.5, width: "100%" }}
              />
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--border2)" }}>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  // Pousser à IOBILL via sync_company
                  try {
                    const r = await fetch("/api/iobill-bridge", {
                      method: "POST",
                      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                      body: JSON.stringify({ action: "sync_company" })
                    });
                    const j = await r.json();
                    if (j.ok) {
                      alert("✅ Mentions transmises à IO BILL !");
                    } else {
                      alert("❌ Erreur : " + (j.error || j.details || "inconnue"));
                    }
                  } catch (e) {
                    alert("❌ Erreur réseau : " + e.message);
                  }
                }}
              >
                🦉 Pousser à IO BILL
              </button>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>
                Sauvegarde locale auto. Cliquez pour propager à IO BILL.
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="settings-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, maxWidth: 900 }}>

        {/* LOGO */}
        <div className="card card-pad">
          <div style={{ fontFamily: "Syne", fontSize: 14, fontWeight: 700, letterSpacing: 1, color: "var(--gold)", textTransform: "uppercase", marginBottom: 16 }}>Logo de la concession</div>

          {/* Preview */}
          <div style={{
            height: 140, borderRadius: 10, border: "2px dashed var(--border2)",
            display: "flex", alignItems: "center", justifyContent: "center",
            marginBottom: 14, overflow: "hidden", position: "relative",
            background: form.logoBg === "dark" ? "#0b0c10" : form.logoBg === "white" ? "#fff" : "repeating-conic-gradient(#1c1d26 0% 25%, #13141a 0% 50%) 0 0 / 16px 16px",
            cursor: "pointer"
          }} onClick={() => fileRef.current?.click()}>
            {form.logo ? (
              <img src={form.logo} alt="Logo"
                style={{
                  maxHeight: 120, maxWidth: "100%", objectFit: "contain",
                  mixBlendMode: form.logoBlend || "normal",
                  filter: form.logoInvert ? "invert(1)" : "none"
                }} />
            ) : (
              <div style={{ textAlign: "center", color: "var(--muted)" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📁</div>
                <div style={{ fontSize: 12 }}>Cliquer pour uploader</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>PNG, JPG, SVG — max 4 Mo</div>
              </div>
            )}
          </div>

          <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleLogo} />

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>📁 Choisir un fichier</button>
            {form.logo && <button className="btn btn-danger btn-sm" onClick={supprimerLogo}>🗑 Supprimer</button>}
          </div>

          {form.logo && (
            <>
              <div style={{ fontFamily: "Syne", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: "var(--muted)", textTransform: "uppercase", marginBottom: 10 }}>Détourage</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

                {/* Bouton de détourage principal */}
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  style={{ width: "100%" }}
                  onClick={() => detourerFondBlanc(20)}
                  title="Supprime le fond blanc du logo (utile pour les logos sur fond blanc photographiés ou scannés)"
                >
                  ✂️ Détourer le fond blanc
                </button>

                {/* Détourage plus agressif si le premier ne suffit pas */}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ width: "100%" }}
                  onClick={() => detourerFondBlanc(50)}
                  title="Détourage plus agressif — utile si le fond n'est pas un blanc pur (gris clair, beige…)"
                >
                  ✂️ Détourage fort (fond clair non blanc)
                </button>

                {/* Restaurer original */}
                {form.logo_original && form.logo !== form.logo_original && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ width: "100%" }}
                    onClick={restaurerLogo}
                  >
                    ↩️ Restaurer l'original
                  </button>
                )}

                {/* Fond d'aperçu (utile pour voir le résultat) */}
                <div style={{ marginTop: 4 }}>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>Fond d'aperçu (visuel uniquement)</div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[["checker", "Damier"], ["dark", "Sombre"], ["white", "Blanc"]].map(([v, l]) => (
                      <button key={v} className={`btn btn-xs ${(form.logoBg || "checker") === v ? "btn-primary" : "btn-ghost"}`}
                        onClick={() => setForm(f => ({ ...f, logoBg: v }))}>{l}</button>
                    ))}
                  </div>
                </div>

                <div style={{ fontSize: 10, color: "var(--green)", marginTop: 2, lineHeight: 1.5, display: "flex", alignItems: "center", gap: 6 }}>
                  <span>✓</span> Logo sauvegardé automatiquement (vous pouvez actualiser la page)
                </div>
                <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2, lineHeight: 1.5 }}>
                  💡 Le détourage crée un PNG transparent à partir de votre logo. Utilisez "Détourage fort" si le fond n'est pas un blanc parfait.
                </div>
              </div>
            </>
          )}
        </div>

        {/* INFOS CONCESSION */}
        <div className="card card-pad">
          <div style={{ fontFamily: "Syne", fontSize: 14, fontWeight: 700, letterSpacing: 1, color: "var(--gold)", textTransform: "uppercase", marginBottom: 16 }}>Informations concession</div>
          <div className="form-grid">
            {[["name", "Nom de la concession"], ["address", "Adresse"], ["phone", "Téléphone"], ["email", "Email"], ["siret", "SIRET"], ["tva_num", "N° TVA intracommunautaire"]].map(([k, l]) => (
              <div className="form-group full" key={k}>
                <label className="form-label">{l}</label>
                {k === "address" ? (
                  <textarea className="form-input" rows={2} value={form[k] || ""} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} />
                ) : (
                  <input className="form-input" value={form[k] || ""} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} />
                )}
              </div>
            ))}

            {/* Mentions facture personnalisables */}
            <div className="form-group full" style={{ marginTop: 8, paddingTop: 12, borderTop: "1px solid var(--border2)" }}>
              <div style={{ fontFamily: "Syne", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: "var(--gold)", textTransform: "uppercase", marginBottom: 10 }}>
                📄 Mentions facture
              </div>
            </div>
            <div className="form-group full">
              <label className="form-label">Conditions de règlement</label>
              <textarea className="form-input" rows={3}
                value={form.conditions_reglement || "TVA acquittée sur les encaissements.\nTout retard de paiement entraîne des pénalités au taux légal en vigueur (art. L441-10 C. com.).\nIndemnité forfaitaire de recouvrement : 40 €."}
                onChange={e => setForm(f => ({ ...f, conditions_reglement: e.target.value }))}
                placeholder="Vos conditions de paiement personnalisées..." />
            </div>
            <div className="form-group full">
              <label className="form-label">Informations complémentaires</label>
              <textarea className="form-input" rows={3}
                value={form.infos_complementaires || "En cas de litige, tribunal compétent selon règles de droit commun.\nFacture à conserver pendant 10 ans (art. L123-22 C. com.)."}
                onChange={e => setForm(f => ({ ...f, infos_complementaires: e.target.value }))}
                placeholder="Tribunal compétent, clause de réserve de propriété, etc." />
            </div>
          </div>

          {/* Clé API — Zone Admin */}
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border2)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontFamily: "Syne", fontSize: 12, fontWeight: 700, letterSpacing: 1, color: "var(--gold)", textTransform: "uppercase" }}>
                🔑 Clé API — Recherche par plaque
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>Ce mois : </span>
                <span style={{ fontSize: 12, fontWeight: 700, color: usedThisMonth < 10 ? "var(--green)" : "var(--orange)" }}>
                  {usedThisMonth} / 10 gratuites
                </span>
              </div>
            </div>

            {!isRealAdmin ? (
              /* Utilisateur normal : simple info, pas d'édition */
              <div style={{ background: "rgba(212,168,67,.06)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px" }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <span style={{ fontSize: 22 }}>ℹ️</span>
                  <div style={{ fontSize: 12, color: "var(--muted2)", lineHeight: 1.6 }}>
                    La clé de recherche par plaque est gérée de manière sécurisée côté serveur.
                    Vous bénéficiez automatiquement de <strong style={{ color: "var(--text)" }}>10 recherches gratuites par mois</strong>,
                    puis 0,20 € par recherche supplémentaire facturée sur votre abonnement.
                  </div>
                </div>
              </div>
            ) : (
              /* Zone admin réelle (is_admin en DB) — peut saisir la clé globale du garage */
              <div style={{ background: "rgba(62,207,122,.05)", border: "1px solid rgba(62,207,122,.2)", borderRadius: 10, padding: "16px 20px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: "var(--green)", fontWeight: 600 }}>🛡 Zone admin (authentifié en DB)</div>
                  <button className="btn btn-ghost btn-xs" onClick={() => setShowKey(s => !s)}>
                    {showKey ? "🙈 Masquer" : "👁 Afficher"}
                  </button>
                </div>
                <div className="form-group">
                  <label className="form-label">Clé RapidAPI de ce garage (optionnelle — sinon clé globale serveur)</label>
                  <input
                    className="form-input"
                    type={showKey ? "text" : "password"}
                    value={form.rapidapi_key || ""}
                    onChange={e => setForm(f => ({ ...f, rapidapi_key: e.target.value }))}
                    placeholder="Laissez vide pour utiliser la clé globale"
                    style={{ fontFamily: "DM Mono", fontSize: 12 }}
                  />
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
                  La clé n'est jamais renvoyée au front pour les utilisateurs non-admin.
                  Pour modifier la clé d'un autre garage, utilisez le panneau Admin.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 20 }}>
        <button className="btn btn-primary" onClick={async () => {
          // v8.49 — Ne pas écraser les champs iobill_* et autres champs
          // "vie propre" du garage. Le form local est initialisé au montage
          // avec dealer et n'est jamais resync : si l'user active IOBILL
          // pendant qu'il est sur cette page, form.iobill_* reste à null.
          // Sans cette protection, l'Enregistrer efface le linkage.
          const {
            iobill_company_id, iobill_api_token, iobill_email,
            iobill_linked_at, iobill_auto_push,
            // Autres champs de contrôle qui ne doivent JAMAIS être écrasés
            // par le formulaire d'édition de la concession :
            is_admin, is_active, sub_status, stripe_customer_id,
            stripe_subscription_id, subscribed_at, payment_failed_at,
            _archived, user_id, created_at,
            ...editableFields
          } = form;
          await setDealer(editableFields);

          // v8.49 — Auto-sync IOBILL après Enregistrer si le linkage est actif.
          // Avant : l'user devait cliquer manuellement "Resynchroniser mes
          // paramètres" pour propager ses modifs (nom, adresse, SIRET, TVA...)
          // vers IOBILL. Maintenant c'est automatique : un Enregistrer côté
          // IOCAR propage tout côté IOBILL en 1 clic.
          if (dealer?.iobill_api_token && token) {
            try {
              const r = await fetch("/api/iobill-bridge", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ action: "sync_company" })
              });
              const j = await r.json().catch(() => ({}));
              if (r.ok) {
                const n = (j?.updated_fields || []).length;
                console.log(`[settings] ✅ ${n} champ(s) synchronisé(s) vers IOBILL`);
              } else {
                console.warn("[settings] Sync IOBILL échouée:", j?.error || r.status);
              }
            } catch (e) {
              console.warn("[settings] Sync IOBILL exception:", e.message);
            }
          }
        }}>
          💾 Enregistrer les paramètres
        </button>
        {saved && <span style={{ marginLeft: 12, fontSize: 12, color: "var(--orange)" }}>● Modifications non sauvegardées</span>}
      </div>

      {/* SECTION MON ABONNEMENT */}
      <SubscriptionSection dealer={dealer} />

      {/* SYSTÈME DE TICKETS */}
      <TicketSystem dealer={form} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   MON ABONNEMENT — accès au Stripe Customer Portal
   Le client peut depuis le portail :
   - Mettre à jour sa CB
   - Annuler son abonnement (effectif à la fin de la période payée)
   - Voir et télécharger ses factures Stripe
═══════════════════════════════════════════════════════════════ */
function SubscriptionSection({ dealer }) {
  const [loading, setLoading] = useState(false);

  const openPortal = async () => {
    const { token } = loadSession();
    if (!token) { alert("Session expirée."); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/customer-portal", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Erreur lors de l'ouverture du portail");
      }
      const { url } = await res.json();
      if (url) window.location.href = url;
    } catch (e) {
      alert(e.message);
    }
    setLoading(false);
  };

  const planLabel = dealer?.plan === "annual" ? "Annuel"
    : dealer?.plan === "monthly" ? "Mensuel"
    : dealer?.plan === "trial" ? "Essai" : "—";

  const hasStripe = !!dealer?.stripe_customer_id;

  return (
    <div style={{ marginTop: 32, padding: "20px 24px", background: "var(--card2)", border: "1px solid var(--border)", borderRadius: 12 }}>
      <div style={{ fontFamily: "Syne", fontSize: 14, fontWeight: 700, letterSpacing: 1, color: "var(--gold)", textTransform: "uppercase", marginBottom: 14 }}>
        💳 Mon abonnement
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: "var(--muted)", marginBottom: 4 }}>Formule</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{planLabel}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: "var(--muted)", marginBottom: 4 }}>Statut</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: dealer?.is_active ? "var(--green)" : "var(--red)" }}>
            {dealer?.is_active ? "✅ Actif" : "🔒 Suspendu"}
          </div>
        </div>
        {dealer?.subscribed_at && (
          <div>
            <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: "var(--muted)", marginBottom: 4 }}>Membre depuis</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              {new Date(dealer.subscribed_at).toLocaleDateString("fr-FR")}
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {hasStripe ? (
          <button className="btn btn-primary" onClick={openPortal} disabled={loading}>
            {loading ? "..." : "🔧 Gérer mon abonnement"}
          </button>
        ) : (
          <div style={{ fontSize: 12, color: "var(--muted)", fontStyle: "italic" }}>
            Aucun abonnement Stripe associé.
          </div>
        )}
      </div>

      {hasStripe && (
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 12, lineHeight: 1.6 }}>
          Le portail vous permet de mettre à jour votre carte bancaire, télécharger vos factures
          ou annuler votre abonnement (l'annulation prend effet à la fin de la période payée,
          sans remboursement au prorata).
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   LIVRE DE POLICE
   Champs obligatoires art. R321-3 à R321-5 Code Pénal
═══════════════════════════════════════════════════════════════ */

// Génère un PDF imprimable du Livre de Police dans une fenêtre popup.
// Format A4 paysage avec une vraie mise en page de registre légal.
function printRegistre(entries, dealer) {
  const win = window.open('', '_blank');
  if (!win) { alert("Le navigateur a bloqué la fenêtre d'impression"); return; }

  const garageName  = dealer?.name    || "Concession";
  const garageAddr  = (dealer?.address || "").replace(/\n/g, " · ");
  const garageSiret = dealer?.siret   || "";
  const dateImpr    = today();

  const esc = (s) => String(s ?? "").replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Lignes du registre
  const rows = entries.map(e => `
    <tr>
      <td class="num">${esc(String(e.num_ordre || "").padStart(4,"0"))}</td>
      <td>${esc(e.date_entree || "")}</td>
      <td>
        <div class="veh"><strong>${esc(e.marque || "")} ${esc(e.modele || "")}</strong></div>
        <div class="vehmeta">${esc(e.couleur || "")} ${e.annee ? "· " + esc(e.annee) : ""}</div>
      </td>
      <td class="immat">${esc(e.immat || "—")}</td>
      <td class="vin">${esc(e.vin || "—")}</td>
      <td class="km">${e.kilometrage ? esc(e.kilometrage) + " km" : "—"}</td>
      <td>
        <div><strong>${esc(e.vendeur_nom || "")} ${esc(e.vendeur_prenom || "")}</strong></div>
        <div class="vehmeta">${esc(e.vendeur_type === "pro" ? "Pro" : "Particulier")}${e.vendeur_piece_id ? " · " + esc(e.vendeur_piece_type || "CNI") + " " + esc(e.vendeur_piece_id) : ""}</div>
      </td>
      <td class="prix">${e.prix_achat ? Number(e.prix_achat).toLocaleString("fr-FR") + " €" : "—"}</td>
      <td>${esc(e.date_sortie || "—")}</td>
      <td>${esc(e.acheteur_nom || "—")}</td>
    </tr>
  `).join("");

  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"/>
<title>Livre de Police — ${esc(garageName)}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Syne:wght@700;800&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "DM Sans", sans-serif; color: #1a1a1a; font-size: 9.5pt; padding: 8mm 6mm; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 8px; margin-bottom: 12px; border-bottom: 2px solid #d4a843; }
  .header h1 { font-family: "Syne", sans-serif; font-size: 18pt; font-weight: 800; color: #1a1a1a; letter-spacing: 1px; }
  .header .sub { font-size: 8pt; color: #666; margin-top: 2px; }
  .header-right { text-align: right; font-size: 8pt; color: #444; line-height: 1.5; }
  .header-right strong { color: #1a1a1a; font-size: 10pt; }
  table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
  thead { background: #f4f0e3; }
  thead th { padding: 5px 6px; text-align: left; font-weight: 700; font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.5px; color: #444; border-bottom: 1px solid #d4a843; }
  tbody td { padding: 5px 6px; border-bottom: 1px solid #eee; vertical-align: top; }
  tbody tr:nth-child(odd) { background: #fafafa; }
  .num { font-family: "DM Mono", monospace; font-weight: 700; color: #d4a843; }
  .veh { font-size: 9pt; }
  .vehmeta { font-size: 7.5pt; color: #777; margin-top: 1px; }
  .immat { font-family: "DM Mono", monospace; font-size: 8pt; }
  .vin { font-family: "DM Mono", monospace; font-size: 7.5pt; color: #555; }
  .km { white-space: nowrap; }
  .prix { font-weight: 600; white-space: nowrap; }
  .footer { margin-top: 16px; padding-top: 8px; border-top: 1px solid #ddd; font-size: 7.5pt; color: #666; display: flex; justify-content: space-between; }
  .legal { background: #fdf8ec; border: 1px solid #e8d9a8; border-radius: 4px; padding: 6px 10px; margin-bottom: 10px; font-size: 7.5pt; color: #6a4f1a; }
  @page { size: A4 landscape; margin: 5mm; }
  @media print { body { padding: 0; } }
</style>
</head><body>
  <div class="header">
    <div>
      <h1>LIVRE DE POLICE</h1>
      <div class="sub">Registre obligatoire — art. R321-3 à R321-5 Code Pénal · Conservation 5 ans</div>
    </div>
    <div class="header-right">
      <strong>${esc(garageName)}</strong>
      ${garageAddr ? `<div>${esc(garageAddr)}</div>` : ""}
      ${garageSiret ? `<div>SIRET : ${esc(garageSiret)}</div>` : ""}
      <div style="margin-top:4px">Imprimé le ${esc(dateImpr)} · ${entries.length} entrée${entries.length > 1 ? "s" : ""}</div>
    </div>
  </div>

  <div class="legal">
    Les soussignés certifient l'exactitude des écritures ci-dessous tenues conformément aux articles R321-3 à R321-5 du Code pénal.
  </div>

  <table>
    <thead>
      <tr>
        <th>N°</th>
        <th>Entrée</th>
        <th>Véhicule</th>
        <th>Immat.</th>
        <th>VIN</th>
        <th>Km</th>
        <th>Vendeur / Provenance</th>
        <th>Prix achat</th>
        <th>Sortie</th>
        <th>Acheteur</th>
      </tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="10" style="text-align:center;padding:30px;color:#888">Aucune entrée</td></tr>`}
    </tbody>
  </table>

  <div class="footer">
    <span>Document généré automatiquement par IO Car</span>
    <span>Page <span class="pagenum"></span></span>
  </div>
</body></html>`);

  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); }, 800);
}

function LivreDePolice({ vehicles, livrePolice, setLivrePolice, dealer, setDealer, viewMode }) {
  const [modal, setModal] = useState(null);
  const [search, setSearch] = useState("");
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pvLivraison, setPvLivraison] = useState(null);

  const entries = livrePolice || [];

  // Toggle pour l'admin : afficher ou masquer les entrées archivées
  const [showArchived, setShowArchived] = useState(false);

  // On filtre les archivées par défaut. Admin peut les afficher via le toggle.
  const visibleEntries = showArchived ? entries : entries.filter(e => !e._archived);

  const sorted = [...visibleEntries].sort((a, b) => (b.num_ordre || 0) - (a.num_ordre || 0));
  const filtered = sorted.filter(e =>
    !search || `${e.marque} ${e.modele} ${e.immat} ${e.vendeur_nom} ${e.acheteur_nom}`.toLowerCase().includes(search.toLowerCase())
  );

  // v8.48.8 — Le num de départ peut être défini par le garage (registre papier existant)
  const startOffset = parseInt(dealer?.lp_start_offset) || 1;
  const nextNum = entries.length > 0
    ? Math.max(...entries.map(e => e.num_ordre || 0)) + 1
    : startOffset;

  // ── HISTORIQUE LP — champs sensibles à tracer ──
  // Ces champs sont surveillés à chaque modification : si leur valeur change,
  // on log un événement dans entry.historique. C'est la traçabilité légale
  // (esprit NF525 / art. R321-3 Code pénal).
  const SENSITIVE_FIELDS = {
    marque: "Marque",
    modele: "Modèle",
    annee: "Année",
    immat: "Immatriculation",
    vin: "VIN / Châssis",
    kilometrage: "Kilométrage",
    couleur: "Couleur",
    pays_origine: "Pays d'origine",
    date_entree: "Date d'entrée",
    date_sortie: "Date de sortie",
    prix_achat: "Prix d'achat",
    mode_reglement: "Mode de règlement",
    vendeur_nom: "Nom vendeur",
    vendeur_prenom: "Prénom vendeur",
    vendeur_adresse: "Adresse vendeur",
    vendeur_type: "Type vendeur",
    vendeur_piece_type: "Type de pièce",
    vendeur_piece_id: "N° pièce d'identité",
    vendeur_piece_date: "Date de pièce",
    vendeur_piece_autorite: "Autorité de délivrance",
    acheteur_nom: "Nom acheteur",
    acheteur_adresse: "Adresse acheteur",
    // Champs CNI acheteur — optionnels mais tracés dans l'historique si modifiés.
    acheteur_piece_type: "Type pièce acheteur",
    acheteur_piece_id: "N° pièce acheteur",
    acheteur_piece_date: "Date pièce acheteur",
    acheteur_piece_autorite: "Autorité pièce acheteur",
  };

  // Calcule les différences entre 2 versions de l'entrée.
  // ⚠ Une transition "" → "valeur" = premier remplissage, pas une modification.
  // On ne demande de justification QUE si on modifie une valeur déjà saisie.
  // Cela évite de demander une "justification" la 1ère fois qu'on complète une
  // entrée auto-créée depuis la flotte (où tous les champs vendeur sont vides).
  const computeDiff = (oldEntry, newEntry) => {
    const changes = {};
    for (const key of Object.keys(SENSITIVE_FIELDS)) {
      const oldVal = String(oldEntry[key] ?? "").trim();
      const newVal = String(newEntry[key] ?? "").trim();
      if (oldVal === newVal) continue;          // pas de changement
      if (oldVal === "" && newVal !== "") continue; // premier remplissage → ignoré
      // Cas restants : modification réelle (valeur changée) ou suppression (valeur effacée)
      changes[key] = {
        label: SENSITIVE_FIELDS[key],
        avant: String(oldEntry[key] ?? ""),
        apres: String(newEntry[key] ?? ""),
      };
    }
    return changes;
  };

  // Modale de justification — apparaît avant la sauvegarde si des modifications
  // sur des champs sensibles ont été détectées. Sans justification, pas de save.
  const [pendingModif, setPendingModif] = useState(null); // { entry, oldEntry, diff } | null
  const [modifReason, setModifReason] = useState("");
  const [modifReasonCustom, setModifReasonCustom] = useState("");

  const saveEntry = (entry) => {
    // Retirer le flag _incomplete si les infos obligatoires sont remplies
    const isComplete = entry.vendeur_nom && entry.vendeur_piece_id && entry.prix_achat;
    const exists = entries.find(x => x.id === entry.id);

    const now = new Date();
    const horoStamp = {
      date: today(),
      heure: now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
    };

    if (exists) {
      // ─── MODIFICATION ───
      const diff = computeDiff(exists, entry);
      const hasChanges = Object.keys(diff).length > 0;

      if (hasChanges) {
        // Modifications de champs sensibles détectées → on demande une justification
        // avant de persister. La sauvegarde réelle se fait dans confirmModif().
        setPendingModif({ entry, oldEntry: exists, diff });
        return;
      }

      // Pas de changement sensible → on enregistre directement (notes, annotation PV…)
      const cleaned = { ...entry, _incomplete: !isComplete, historique: exists.historique || [] };
      setLivrePolice(entries.map(x => x.id === cleaned.id ? cleaned : x));
      setModal(null);
    } else {
      // ─── CRÉATION ───
      const cleaned = {
        ...entry,
        _incomplete: !isComplete,
        historique: [{ ...horoStamp, action: "creation" }],
      };
      setLivrePolice([...entries, cleaned]);
      setModal(null);
    }
  };

  // Confirme la modification après saisie de la justification
  const confirmModif = () => {
    if (!pendingModif) return;
    const reason = modifReason === "Autre" ? modifReasonCustom.trim() : modifReason.trim();
    if (!reason) return;

    const { entry, oldEntry, diff } = pendingModif;
    const isComplete = entry.vendeur_nom && entry.vendeur_piece_id && entry.prix_achat;
    const now = new Date();
    const horoStamp = {
      date: today(),
      heure: now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
    };
    const cleaned = {
      ...entry,
      _incomplete: !isComplete,
      historique: [...(oldEntry.historique || []), { ...horoStamp, action: "modification", changes: diff, raison: reason }],
    };
    setLivrePolice(entries.map(x => x.id === cleaned.id ? cleaned : x));
    setPendingModif(null);
    setModifReason("");
    setModifReasonCustom("");
    setModal(null);
  };

  const cancelModif = () => {
    setPendingModif(null);
    setModifReason("");
    setModifReasonCustom("");
  };

  // ── ARCHIVAGE (admin) — alternative douce à la suppression ──
  // L'entrée n'est plus affichée dans la liste mais reste en base, avec
  // la raison d'archivage et l'horodatage tracés dans l'historique.
  const [pendingArchive, setPendingArchive] = useState(null); // { id, num, label }
  const [archiveReason, setArchiveReason] = useState("");

  const archiveEntry = () => {
    if (!pendingArchive || !archiveReason.trim()) return;
    const now = new Date();
    setLivrePolice(entries.map(e => e.id === pendingArchive.id ? {
      ...e,
      _archived: true,
      archive_date: today(),
      archive_heure: now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
      archive_raison: archiveReason.trim(),
      historique: [
        ...(e.historique || []),
        {
          date: today(),
          heure: now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
          action: "archivage",
          raison: archiveReason.trim(),
        },
      ],
    } : e));
    setPendingArchive(null);
    setArchiveReason("");
  };

  // Sauvegarde silencieuse (depuis PVLivraisonDoc — sans fermer la modale livre)
  const saveEntryFromPv = (entry) => {
    const exists = entries.find(x => x.id === entry.id);
    const next = exists ? entries.map(x => x.id === entry.id ? entry : x) : [...entries, entry];
    setLivrePolice(next);
  };

  const delEntry = (id) => { setLivrePolice(entries.filter(e => e.id !== id)); setPendingDelete(null); };

  return (
    <div className="page">
      {modal && <LivrePoliceModal entry={modal === "add" ? null : modal} nextNum={nextNum} vehicles={vehicles} onSave={saveEntry} onClose={() => setModal(null)} />}
      {pvLivraison && <PVLivraisonDoc entry={pvLivraison} dealer={dealer} onSave={saveEntryFromPv} onClose={() => setPvLivraison(null)} />}
      {pendingDelete && (
        <ConfirmModal
          title="Supprimer l'entrée"
          message={`Supprimer l'entrée N°${String(pendingDelete.num).padStart(4,"0")} — ${pendingDelete.label} du livre de police ? Cette action est irréversible.`}
          confirmLabel="Supprimer"
          onConfirm={() => delEntry(pendingDelete.id)}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {/* Modale d'archivage — alternative douce à la suppression.
          Demande la raison qui sera tracée dans l'historique. */}
      {pendingArchive && (
        <div className="modal-bg" onClick={e => e.target === e.currentTarget && setPendingArchive(null)}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <div className="modal-hd">
              <span className="modal-title">♻️ Archiver l'entrée N°{String(pendingArchive.num).padStart(4,"0")}</span>
              <button className="close-btn" onClick={() => { setPendingArchive(null); setArchiveReason(""); }}>×</button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 14, lineHeight: 1.6 }}>
                <strong>{pendingArchive.label}</strong>
                <br />
                L'entrée sera <strong style={{ color: "var(--text)" }}>masquée de la liste</strong> mais conservée en base pour l'historique légal (5 ans, art. R321-3).
                Vous pourrez la retrouver via la case « Afficher les archivées ».
              </div>
              <div className="form-group">
                <label className="form-label">Raison de l'archivage <span style={{ color: "var(--red)" }}>*</span></label>
                <select
                  className="form-input"
                  value={archiveReason}
                  onChange={e => setArchiveReason(e.target.value)}
                  style={{ marginBottom: 8 }}
                >
                  <option value="">— Sélectionner —</option>
                  <option value="Doublon">Doublon (déjà saisi)</option>
                  <option value="Erreur de saisie">Erreur de saisie</option>
                  <option value="Annulation de la vente">Annulation de la vente</option>
                  <option value="Rétractation client">Rétractation client</option>
                  <option value="Test / saisie de démonstration">Test / saisie de démonstration</option>
                  <option value="Autre">Autre (préciser)</option>
                </select>
                {archiveReason === "Autre" && (
                  <input
                    className="form-input"
                    placeholder="Précisez la raison..."
                    onChange={e => setArchiveReason(e.target.value)}
                    autoFocus
                  />
                )}
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => { setPendingArchive(null); setArchiveReason(""); }}>Annuler</button>
              <button
                className="btn btn-primary"
                disabled={!archiveReason.trim() || archiveReason === "Autre"}
                onClick={archiveEntry}
              >♻️ Archiver</button>
            </div>
          </div>
        </div>
      )}

      {/* Modale de justification des modifications.
          Apparaît à la place de la modale d'édition quand des champs sensibles ont été modifiés.
          Sans justification → la modification n'est pas enregistrée. */}
      {pendingModif && (
        <div className="modal-bg" onClick={e => e.target === e.currentTarget && cancelModif()}>
          <div className="modal" style={{ maxWidth: 540 }}>
            <div className="modal-hd">
              <span className="modal-title">📝 Justification de la modification</span>
              <button className="close-btn" onClick={cancelModif}>×</button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 14, lineHeight: 1.6 }}>
                Le Livre de Police est un registre légal. Toute modification doit être justifiée pour
                garantir l'intégrité des écritures (esprit art. R321-3 Code pénal).
              </div>

              {/* Aperçu des modifications détectées */}
              <div style={{ background: "rgba(212,168,67,.06)", border: "1px solid rgba(212,168,67,.2)", borderRadius: 8, padding: "10px 14px", marginBottom: 14, maxHeight: 180, overflowY: "auto" }}>
                <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: "var(--gold)", marginBottom: 6, fontWeight: 700 }}>
                  Modifications détectées ({Object.keys(pendingModif.diff).length})
                </div>
                {Object.entries(pendingModif.diff).map(([k, c]) => (
                  <div key={k} style={{ fontSize: 11, marginBottom: 4, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "baseline" }}>
                    <strong style={{ color: "var(--muted2)", minWidth: 130 }}>{c.label} :</strong>
                    <span style={{ color: "var(--red)", textDecoration: "line-through" }}>{c.avant || "(vide)"}</span>
                    <span style={{ color: "var(--muted)" }}>→</span>
                    <span style={{ color: "var(--green)" }}>{c.apres || "(vide)"}</span>
                  </div>
                ))}
              </div>

              <div className="form-group">
                <label className="form-label">Raison de la modification <span style={{ color: "var(--red)" }}>*</span></label>
                <select
                  className="form-input"
                  value={modifReason}
                  onChange={e => setModifReason(e.target.value)}
                  style={{ marginBottom: 8 }}
                  autoFocus
                >
                  <option value="">— Sélectionner —</option>
                  <option value="Erreur de saisie initiale">Erreur de saisie initiale</option>
                  <option value="Information complémentaire reçue du vendeur">Information complémentaire reçue du vendeur</option>
                  <option value="Correction sur pièce officielle">Correction sur pièce officielle</option>
                  <option value="Mise à jour suite à livraison">Mise à jour suite à livraison</option>
                  <option value="Régularisation administrative">Régularisation administrative</option>
                  <option value="Autre">Autre (préciser)</option>
                </select>
                {modifReason === "Autre" && (
                  <input
                    className="form-input"
                    placeholder="Précisez la raison..."
                    value={modifReasonCustom}
                    onChange={e => setModifReasonCustom(e.target.value)}
                    autoFocus
                  />
                )}
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={cancelModif}>Annuler la modification</button>
              <button
                className="btn btn-primary"
                disabled={!modifReason || (modifReason === "Autre" && !modifReasonCustom.trim())}
                onClick={confirmModif}
              >✓ Confirmer la modification</button>
            </div>
          </div>
        </div>
      )}

      <div className="page-header">
        <div>
          <div className="page-title">📋 Livre de Police</div>
          <div className="page-sub">Registre obligatoire — art. R321-3 à R321-5 Code Pénal · Conservation 5 ans</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {entries.length === 0 && (
            <button
              className="btn btn-ghost btn-sm"
              title="Définir le premier numéro d'ordre du registre (utile si vous continuez un registre papier existant)"
              onClick={() => {
                const current = parseInt(dealer?.lp_start_offset) || 1;
                const val = prompt(
                  "Premier numéro d'ordre du registre\n\n"
                  + "Si vous continuez un registre papier existant, saisissez ici le numéro à partir duquel démarrer.\n"
                  + "Exemple : si votre dernier numéro papier était 247, saisissez 248.\n\n"
                  + "Numéro actuel de départ : " + current,
                  String(current)
                );
                if (val === null) return;
                const num = parseInt(val);
                if (!Number.isInteger(num) || num < 1) {
                  alert("Numéro invalide. Le numéro doit être un entier ≥ 1.");
                  return;
                }
                if (typeof setDealer === "function") {
                  setDealer({ ...(dealer || {}), lp_start_offset: num });
                  alert("✅ Le prochain numéro d'ordre créé sera " + num + ".");
                } else {
                  alert("⚠️ Impossible de sauvegarder (setDealer non disponible). Rechargez l'app.");
                }
              }}
            >
              🔢 Définir n° d'ordre initial
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => printRegistre(filtered, dealer)}>
            🖨 Imprimer le registre
          </button>
          <button className="btn btn-primary" onClick={() => setModal("add")}>+ Nouvelle entrée</button>
        </div>
      </div>

      {/* Bandeau légal */}
      <div style={{ background: "rgba(229,151,60,.08)", border: "1px solid rgba(229,151,60,.25)", borderRadius: 10, padding: "12px 18px", marginBottom: 20, display: "flex", gap: 12, alignItems: "flex-start" }}>
        <span style={{ fontSize: 20 }}>⚖️</span>
        <div style={{ fontSize: 12, color: "var(--muted2)", lineHeight: 1.7, flex: 1 }}>
          <strong style={{ color: "var(--orange)" }}>Obligation légale</strong> — Tout professionnel achetant/revendant des véhicules d'occasion doit tenir ce registre à jour.
          Consultable à tout moment par la police, gendarmerie ou services fiscaux. <strong style={{ color: "var(--text)" }}>Conservation : 5 ans minimum.</strong>
          Sanctions : amende + suspension d'activité en cas de manquement.
        </div>
        {entries.filter(e => e._incomplete).length > 0 && (
          <div style={{ flexShrink: 0, background: "rgba(229,151,60,.15)", border: "1px solid var(--orange)", borderRadius: 8, padding: "8px 14px", textAlign: "center" }}>
            <div style={{ fontSize: 20, lineHeight: 1 }}>⚠️</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--orange)", marginTop: 4 }}>{entries.filter(e => e._incomplete).length}</div>
            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>à compléter</div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <input className="search-input" placeholder="Rechercher véhicule, vendeur, acheteur..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: 320, marginBottom: 0 }} />
        {viewMode === "admin" && entries.some(e => e._archived) && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)", cursor: "pointer" }}>
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
            Afficher les archivées <span style={{ color: "var(--gold)" }}>({entries.filter(e => e._archived).length})</span>
          </label>
        )}
      </div>

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>N° ordre</th>
              <th>Date entrée</th>
              <th>Véhicule</th>
              <th>Immat.</th>
              <th>VIN</th>
              <th>Km</th>
              <th>Vendeur / Provenance</th>
              <th>Prix achat / Marge</th>
              <th>Date sortie</th>
              <th>Acheteur</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={11} style={{ textAlign: "center", color: "var(--muted)", padding: 40 }}>
                Aucune entrée — cliquez sur "+ Nouvelle entrée" pour commencer
              </td></tr>
            )}
            {filtered.map(e => (
              <tr key={e.id} style={{ background: e._incomplete ? "rgba(229,151,60,.04)" : "transparent" }}>
                <td style={{ fontFamily: "DM Mono", fontWeight: 700, color: "var(--gold)" }}>
                  #{String(e.num_ordre).padStart(4, "0")}
                  {e._incomplete && (
                    <div style={{ fontSize: 9, color: "var(--orange)", marginTop: 2 }}>⚠️ À compléter</div>
                  )}
                </td>
                <td style={{ fontSize: 12 }}>{e.date_entree}</td>
                <td>
                  <div style={{ fontWeight: 600 }}>{e.marque} {e.modele}</div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>{e.couleur} · {e.annee}</div>
                </td>
                <td><PlateBadge plate={e.immat} /></td>
                <td style={{ fontFamily: "DM Mono", fontSize: 11, color: "var(--muted)" }}>{e.vin || "—"}</td>
                <td style={{ fontSize: 12 }}>{e.kilometrage ? Number(e.kilometrage).toLocaleString("fr-FR") : "—"}</td>
                <td>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>{e.vendeur_nom || "—"}</div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>{e.vendeur_type === "pro" ? "🏢 Pro" : "👤 Particulier"} · {e.vendeur_piece_id}</div>
                </td>
                <td style={{ fontFamily: "DM Mono" }}>{(() => {
                  // v8.48.6 — Affichage dynamique :
                  //   - Véhicule en stock (pas de date_sortie) → prix d'achat
                  //   - Véhicule livré → marge = prix_vente - prix_achat
                  const prixA = parseFloat(e.prix_achat) || 0;
                  const prixV = parseFloat(e.prix_vente) || 0;
                  if (!e.date_sortie) {
                    // En stock : affiche prix achat en rouge
                    return prixA > 0
                      ? <span style={{ color: "var(--red)" }}>{fmt(prixA)}</span>
                      : <span style={{ color: "var(--muted)" }}>—</span>;
                  }
                  // Livré : affiche la marge
                  if (prixA > 0 && prixV > 0) {
                    const marge = prixV - prixA;
                    return (
                      <>
                        <span style={{ color: marge >= 0 ? "var(--green)" : "var(--red)", fontWeight: 700 }}>
                          {marge >= 0 ? "+" : ""}{fmt(marge)}
                        </span>
                        <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 2 }}>
                          {fmt(prixV)} − {fmt(prixA)}
                        </div>
                      </>
                    );
                  }
                  // Fallback : au moins un des 2 est vide
                  return prixA > 0
                    ? <span style={{ color: "var(--red)" }}>{fmt(prixA)}</span>
                    : <span style={{ color: "var(--muted)" }}>—</span>;
                })()}</td>
                <td style={{ fontSize: 12, color: e.date_sortie ? "var(--green)" : "var(--muted)" }}>
                  {e.date_sortie || "En stock"}
                  {e.date_sortie && e.motif_sortie && e.motif_sortie !== "vente" && (
                    <div style={{ fontSize: 9, marginTop: 2, padding: "1px 6px", borderRadius: 4, display: "inline-block",
                      background: e.motif_sortie === "annulation" || e.motif_sortie === "retractation" ? "rgba(229,80,80,.15)" : "rgba(229,151,60,.12)",
                      color: e.motif_sortie === "annulation" || e.motif_sortie === "retractation" ? "var(--red)" : "var(--orange)" }}>
                      {e.motif_sortie === "annulation" ? "Annulé" : e.motif_sortie === "retractation" ? "Rétracté" : e.motif_sortie === "retour_vendeur" ? "Retour vendeur" : e.motif_sortie === "destruction" ? "VHU" : e.motif_sortie}
                    </div>
                  )}
                </td>
                <td style={{ fontSize: 12 }}>{e.acheteur_nom || "—"}</td>
                <td>
                  <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                    <button className="btn btn-ghost btn-xs" onClick={() => setModal(e)}>✏️</button>
                    {e.date_sortie && (
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => setPvLivraison(e)}
                        title="PV de Livraison"
                        style={{ color: "var(--gold)" }}
                      >📜 PV</button>
                    )}
                    {viewMode === "admin" && !e._archived && (
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => setPendingArchive({ id: e.id, num: e.num_ordre, label: `${e.marque} ${e.modele} ${e.immat || ""}` })}
                        title="Archiver (recommandé) — l'entrée sera masquée mais conservée pour l'historique légal"
                        style={{ color: "#5fb573" }}
                      >♻️</button>
                    )}
                    {viewMode === "admin" && e._archived && (
                      <span title={`Archivée le ${e.archive_date} : ${e.archive_raison || ""}`} style={{ fontSize: 10, color: "#888", fontStyle: "italic", padding: "0 6px" }}>
                        Archivée
                      </span>
                    )}
                    {viewMode === "admin" && (
                      <button className="btn btn-danger btn-xs" onClick={() => setPendingDelete({ id: e.id, num: e.num_ordre, label: `${e.marque} ${e.modele} ${e.immat || ""}` })}>🗑</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LivrePoliceModal({ entry, nextNum, vehicles, onSave, onClose }) {
  const [form, setForm] = useState(entry || {
    id: uid(), num_ordre: nextNum, date_entree: today(),
    marque: "", modele: "", annee: "", couleur: "", immat: "", vin: "", kilometrage: "",
    pays_origine: "France",
    vendeur_type: "particulier",
    vendeur_nom: "", vendeur_prenom: "", vendeur_adresse: "",
    vendeur_piece_id: "", vendeur_piece_type: "CNI", vendeur_piece_date: "", vendeur_piece_autorite: "",
    prix_achat: "", mode_reglement: "Virement",
    date_sortie: "", acheteur_nom: "", acheteur_adresse: "",
    // Champs CNI acheteur — OPTIONNELS. Recommandé en bonne pratique mais
    // pas exigé légalement (art. R.321-3 vise uniquement le vendeur).
    acheteur_piece_type: "CNI", acheteur_piece_id: "", acheteur_piece_date: "", acheteur_piece_autorite: "",
    notes: ""
  });

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const [showHistorique, setShowHistorique] = useState(false);

  const fillFromVehicle = (vid) => {
    const v = vehicles?.find(x => x.id === vid);
    if (!v) return;
    setForm(f => ({
      ...f, marque: v.marque || "", modele: v.modele || "", annee: getYear(v) || "",
      couleur: v.couleur || "", immat: v.plate || "", vin: v.vin || "",
      kilometrage: v.kilometrage || "", prix_achat: v.prix_achat || ""
    }));
  };

  const PIECES = ["CNI", "Passeport", "Permis de conduire", "Carte de séjour", "Extrait Kbis"];
  const REGLEMENTS = ["Virement", "Chèque", "Espèces", "Financement", "Reprise (compensation)"];

  return (
    <div className="modal-bg" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-hd">
          <span className="modal-title">📋 Entrée livre de police — N°{String(form.num_ordre).padStart(4, "0")}</span>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">

          {/* Import depuis flotte */}
          {vehicles?.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <label className="form-label">Importer depuis la flotte</label>
              <select className="form-input" onChange={e => fillFromVehicle(e.target.value)} style={{ marginTop: 4 }}>
                <option value="">— Choisir un véhicule —</option>
                {vehicles.map(v => <option key={v.id} value={v.id}>{v.plate} · {v.marque} {v.modele} ({getYear(v)})</option>)}
              </select>
            </div>
          )}

          {/* Section véhicule */}
          <div style={{ fontFamily: "Syne", fontSize: 12, fontWeight: 700, letterSpacing: 1, color: "var(--gold)", textTransform: "uppercase", marginBottom: 10 }}>🚗 Identification du véhicule</div>
          <div className="form-grid" style={{ marginBottom: 20 }}>
            {[["marque","Marque *"],["modele","Modèle *"],["annee","Année","number"],["couleur","Couleur"],["immat","Immatriculation"],["vin","N° VIN / Châssis"],["kilometrage","Kilométrage","number"],["pays_origine","Pays d'origine"],["date_entree","Date d'entrée *"]].map(([k,l,t]) => (
              <div className="form-group" key={k}>
                <label className="form-label">{l}</label>
                <input className="form-input" type={t||"text"} value={form[k]||""} onChange={e => set(k, e.target.value)} />
              </div>
            ))}
          </div>

          {/* Section vendeur — c'est-à-dire la PROVENANCE du véhicule.
              Légalement (art. R.321-3 Code pénal), le LP doit identifier la
              personne qui a CÉDÉ le véhicule au garage (l'ancien propriétaire).
              C'est sa pièce d'identité qu'il faut, pas celle de l'acheteur final. */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontFamily: "Syne", fontSize: 12, fontWeight: 700, letterSpacing: 1, color: "var(--blue)", textTransform: "uppercase" }}>
              🔄 Provenance du véhicule
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 }}>
              Identité de la personne qui vous a <strong style={{ color: "var(--text)" }}>cédé / vendu</strong> ce véhicule (ancien propriétaire). Sa pièce d'identité est obligatoire (art. R.321-3 du Code pénal).
            </div>
          </div>
          <div className="form-grid" style={{ marginBottom: 20 }}>
            <div className="form-group">
              <label className="form-label">Type</label>
              <select className="form-input" value={form.vendeur_type} onChange={e => set("vendeur_type", e.target.value)}>
                <option value="particulier">Particulier</option>
                <option value="pro">Professionnel / Société</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Nom / Raison sociale *</label>
              <input className="form-input" value={form.vendeur_nom||""} onChange={e => set("vendeur_nom", e.target.value)} placeholder="ex: Dupont" />
            </div>
            {form.vendeur_type === "particulier" && (
              <div className="form-group">
                <label className="form-label">Prénom</label>
                <input className="form-input" value={form.vendeur_prenom||""} onChange={e => set("vendeur_prenom", e.target.value)} placeholder="ex: Jean" />
              </div>
            )}
            <div className="form-group full">
              <label className="form-label">Adresse</label>
              <input className="form-input" value={form.vendeur_adresse||""} onChange={e => set("vendeur_adresse", e.target.value)} placeholder="adresse complète de l'ancien propriétaire" />
            </div>
            <div className="form-group">
              <label className="form-label">Type pièce d'identité *</label>
              <select className="form-input" value={form.vendeur_piece_type} onChange={e => set("vendeur_piece_type", e.target.value)}>
                {PIECES.map(p => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">N° pièce d'identité *</label>
              <input className="form-input" value={form.vendeur_piece_id||""} onChange={e => set("vendeur_piece_id", e.target.value)} placeholder="N° de la CNI / passeport de l'ancien propriétaire" />
            </div>
            <div className="form-group">
              <label className="form-label">Date délivrance</label>
              <input className="form-input" value={form.vendeur_piece_date||""} onChange={e => set("vendeur_piece_date", e.target.value)} placeholder="jj/mm/aaaa" />
            </div>
            <div className="form-group">
              <label className="form-label">Autorité émettrice</label>
              <input className="form-input" value={form.vendeur_piece_autorite||""} onChange={e => set("vendeur_piece_autorite", e.target.value)} placeholder="ex: Préfecture du Rhône" />
            </div>
            <div className="form-group">
              <label className="form-label">Prix d'achat (€)</label>
              <input className="form-input" type="number" value={form.prix_achat||""} onChange={e => set("prix_achat", e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Mode de règlement</label>
              <select className="form-input" value={form.mode_reglement} onChange={e => set("mode_reglement", e.target.value)}>
                {REGLEMENTS.map(r => <option key={r}>{r}</option>)}
              </select>
            </div>
          </div>

          {/* Section sortie — l'acheteur, c'est le client final qui rachète au garage. */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontFamily: "Syne", fontSize: 12, fontWeight: 700, letterSpacing: 1, color: "var(--green)", textTransform: "uppercase" }}>
              🏷 Sortie du parc
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 }}>
              Identité du <strong style={{ color: "var(--text)" }}>nouveau propriétaire</strong> (votre client final qui rachète le véhicule). À compléter lors de la vente.
            </div>
          </div>
          <div className="form-grid" style={{ marginBottom: 16 }}>
            <div className="form-group">
              <label className="form-label">Motif de sortie</label>
              <select className="form-input" value={form.motif_sortie || "vente"} onChange={e => set("motif_sortie", e.target.value)}>
                <option value="vente">Vente</option>
                <option value="annulation">Annulation achat</option>
                <option value="retractation">Rétractation</option>
                <option value="retour_vendeur">Retour au vendeur</option>
                <option value="destruction">Destruction (VHU)</option>
                <option value="autre">Autre</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Date de sortie</label>
              <input className="form-input" value={form.date_sortie||""} onChange={e => set("date_sortie", e.target.value)} placeholder="jj/mm/aaaa" />
            </div>
            <div className="form-group">
              <label className="form-label">Nom de l'acheteur</label>
              <input className="form-input" value={form.acheteur_nom||""} onChange={e => set("acheteur_nom", e.target.value)} placeholder="nouveau propriétaire" />
            </div>
            <div className="form-group full">
              <label className="form-label">Adresse de l'acheteur</label>
              <input className="form-input" value={form.acheteur_adresse||""} onChange={e => set("acheteur_adresse", e.target.value)} />
            </div>
            {/* Pièce d'identité acheteur — OPTIONNELLE.
                La loi (art. R.321-3) n'impose la pièce d'identité que pour le VENDEUR
                (anti-recel : prouver qu'on n'achète pas un véhicule volé).
                Pour l'acheteur, c'est une bonne pratique recommandée — utile en cas
                de litige ou de fraude au paiement — mais pas obligatoire. */}
            <div className="form-group full" style={{ marginTop: 4 }}>
              <div style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>
                Pièce d'identité acheteur · facultatif
              </div>
              <div style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.5, marginBottom: 8, fontStyle: "italic" }}>
                Recommandé en cas de litige ou de fraude — non exigé par l'art. R.321-3 du Code pénal.
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Type pièce</label>
              <select className="form-input" value={form.acheteur_piece_type || "CNI"} onChange={e => set("acheteur_piece_type", e.target.value)}>
                {PIECES.map(p => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">N° pièce d'identité</label>
              <input className="form-input" value={form.acheteur_piece_id||""} onChange={e => set("acheteur_piece_id", e.target.value)} placeholder="optionnel" />
            </div>
            <div className="form-group">
              <label className="form-label">Date délivrance</label>
              <input className="form-input" value={form.acheteur_piece_date||""} onChange={e => set("acheteur_piece_date", e.target.value)} placeholder="jj/mm/aaaa" />
            </div>
            <div className="form-group">
              <label className="form-label">Autorité émettrice</label>
              <input className="form-input" value={form.acheteur_piece_autorite||""} onChange={e => set("acheteur_piece_autorite", e.target.value)} placeholder="ex: Préfecture du Rhône" />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Notes</label>
            <textarea className="form-input" rows={2} value={form.notes||""} onChange={e => set("notes", e.target.value)} />
          </div>

          {/* ═══ PV DE LIVRAISON ═══
              Apparaît dès qu'une date de sortie est saisie (= véhicule livré).
              L'annotation est libre, modifiable plus tard. */}
          {form.date_sortie && (
            <div style={{ marginTop: 24, padding: "16px 18px", background: "rgba(212,168,67,.05)", border: "1px solid rgba(212,168,67,.2)", borderRadius: 10 }}>
              <div style={{ fontFamily: "Syne", fontSize: 12, fontWeight: 700, letterSpacing: 1, color: "var(--gold)", textTransform: "uppercase", marginBottom: 12 }}>
                📜 PV de Livraison — annotation
              </div>
              <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>
                Cette annotation apparaîtra sur le PV de livraison généré (téléchargeable depuis la liste).
              </div>
              <textarea
                className="form-input"
                rows={3}
                value={form.pv_annotation || ""}
                onChange={e => set("pv_annotation", e.target.value)}
                placeholder="Ex : véhicule remis en bon état, contrôle technique fourni, 2 clés remises, manuel utilisateur, carte grise barrée..."
              />
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Annuler</button>
          {entry?.historique?.length > 0 && (
            <button
              className="btn btn-ghost"
              onClick={() => setShowHistorique(s => !s)}
              title="Voir l'historique des modifications"
              style={{ color: "var(--gold)" }}
            >🕐 Historique ({entry.historique.length})</button>
          )}
          <button className="btn btn-primary" onClick={() => {
            if (!form.marque || !form.date_entree) return alert("Marque et date d'entrée requis");
            // Retirer le flag _incomplete si les infos obligatoires sont remplies
            const isComplete = form.vendeur_nom && form.vendeur_piece_id;
            onSave({
              ...form,
              prix_achat: parseFloat(form.prix_achat) || 0,
              kilometrage: parseInt(form.kilometrage) || 0,
              _incomplete: isComplete ? false : form._incomplete,
            });
          }}>💾 Enregistrer</button>
        </div>

        {/* Panneau Historique des modifications — affiché à la demande */}
        {showHistorique && entry?.historique?.length > 0 && (
          <div style={{ borderTop: "1px solid var(--border2)", padding: "16px 24px", background: "rgba(212,168,67,.04)", maxHeight: 320, overflowY: "auto" }}>
            <div style={{ fontFamily: "Syne", fontSize: 13, fontWeight: 700, letterSpacing: 1, color: "var(--gold)", textTransform: "uppercase", marginBottom: 12 }}>
              🕐 Historique des modifications
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 14, fontStyle: "italic" }}>
              Chaque modification des champs sensibles est tracée pour garantir l'intégrité du registre (esprit art. R321-3 Code pénal).
              Cet historique n'apparaît pas sur le registre imprimé.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {[...entry.historique].reverse().map((h, idx) => (
                <div key={idx} style={{ background: "var(--card2)", border: "1px solid var(--border2)", borderRadius: 8, padding: "10px 14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: h.changes || h.raison ? 8 : 0 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>
                      {h.action === "creation" && <span style={{ color: "var(--green)" }}>● Création</span>}
                      {h.action === "modification" && <span style={{ color: "var(--gold)" }}>● Modification</span>}
                      {h.action === "archivage" && <span style={{ color: "#5fb573" }}>● Archivage</span>}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "DM Mono, monospace" }}>
                      {h.date} · {h.heure}
                    </span>
                  </div>
                  {h.action === "archivage" && h.raison && (
                    <div style={{ fontSize: 11, color: "var(--muted2)" }}>Raison : <strong style={{ color: "var(--text)" }}>{h.raison}</strong></div>
                  )}
                  {h.action === "modification" && h.changes && (
                    <>
                      {h.raison && (
                        <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 6, paddingBottom: 6, borderBottom: "1px dashed var(--border2)" }}>
                          📝 Justification : <strong style={{ color: "var(--text)" }}>{h.raison}</strong>
                        </div>
                      )}
                      <div style={{ fontSize: 11, display: "flex", flexDirection: "column", gap: 4 }}>
                        {Object.entries(h.changes).map(([k, c]) => (
                          <div key={k} style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "baseline" }}>
                            <strong style={{ color: "var(--muted2)", minWidth: 140 }}>{c.label} :</strong>
                            <span style={{ color: "var(--red)", textDecoration: "line-through" }}>{c.avant || "(vide)"}</span>
                            <span style={{ color: "var(--muted)" }}>→</span>
                            <span style={{ color: "var(--green)" }}>{c.apres || "(vide)"}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   FACTUR-X — Export facture électronique conforme 2026
   Profils : minimum | en16931 (PA-compatible)
═══════════════════════════════════════════════════════════════ */
function exportFacturX(order, dealer, profil = "minimum") {
  const c = calcOrder(order);
  const dateISO = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const dueDate = (order.date_echeance || today()).split("/").reverse().join("");
  const isEN16931 = profil === "en16931";
  const siren = (dealer?.siret || "").replace(/\s/g, "").slice(0, 9);
  const profilID = isEN16931
    ? "urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:en16931"
    : "urn:factur-x.eu:1p0:minimum";

  const lignes = isEN16931 ? (order.lignes || [{
    id: "1", nom: order.vehicle_label || "Véhicule", qte: 1,
    prix_unitaire: c.base.toFixed(2), montant_net: c.base.toFixed(2),
    tva_code: "S", tva_pct: order.tva_pct || 20,
  }]) : [];

  const lignesXml = lignes.map((l, i) => [
    '    <ram:IncludedSupplyChainTradeLineItem>',
    '      <ram:AssociatedDocumentLineDocument>',
    `        <ram:LineID>${i + 1}</ram:LineID>`,
    '      </ram:AssociatedDocumentLineDocument>',
    '      <ram:SpecifiedTradeProduct>',
    `        <ram:Name>${l.nom}</ram:Name>`,
    '      </ram:SpecifiedTradeProduct>',
    '      <ram:SpecifiedLineTradeAgreement>',
    '        <ram:NetPriceProductTradePrice>',
    `          <ram:ChargeAmount>${l.prix_unitaire}</ram:ChargeAmount>`,
    '        </ram:NetPriceProductTradePrice>',
    '      </ram:SpecifiedLineTradeAgreement>',
    '      <ram:SpecifiedLineTradeDelivery>',
    `        <ram:BilledQuantity unitCode="C62">${l.qte}</ram:BilledQuantity>`,
    '      </ram:SpecifiedLineTradeDelivery>',
    '      <ram:SpecifiedLineTradeSettlement>',
    '        <ram:ApplicableTradeTax>',
    '          <ram:TypeCode>VAT</ram:TypeCode>',
    `          <ram:CategoryCode>${l.tva_code}</ram:CategoryCode>`,
    `          <ram:RateApplicablePercent>${l.tva_pct}</ram:RateApplicablePercent>`,
    '        </ram:ApplicableTradeTax>',
    '        <ram:SpecifiedTradeSettlementLineMonetarySummation>',
    `          <ram:LineTotalAmount>${l.montant_net}</ram:LineTotalAmount>`,
    '        </ram:SpecifiedTradeSettlementLineMonetarySummation>',
    '      </ram:SpecifiedLineTradeSettlement>',
    '    </ram:IncludedSupplyChainTradeLineItem>',
  ].join("\n")).join("\n");

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!-- Factur-X 1.08 / ZUGFeRD 2.4 profil ${isEN16931 ? "EN16931" : "MINIMUM"} — conforme reforme 01/09/2026 -->`,
    '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"',
    '  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"',
    '  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">',
    '  <rsm:ExchangedDocumentContext>',
    '    <ram:GuidelineSpecifiedDocumentContextParameter>',
    `      <ram:ID>${profilID}</ram:ID>`,
    '    </ram:GuidelineSpecifiedDocumentContextParameter>',
    '  </rsm:ExchangedDocumentContext>',
    '  <rsm:ExchangedDocument>',
    `    <ram:ID>${order.ref}</ram:ID>`,
    '    <ram:TypeCode>380</ram:TypeCode>',
    '    <ram:IssueDateTime>',
    `      <udt:DateTimeString format="102">${dateISO}</udt:DateTimeString>`,
    '    </ram:IssueDateTime>',
    '  </rsm:ExchangedDocument>',
    '  <rsm:SupplyChainTradeTransaction>',
    ...(isEN16931 && lignesXml ? [lignesXml] : []),
    '    <ram:ApplicableHeaderTradeAgreement>',
    '      <ram:SellerTradeParty>',
    `        <ram:Name>${dealer?.name || ""}</ram:Name>`,
    ...(siren ? [
      '        <ram:SpecifiedLegalOrganization>',
      `          <ram:ID schemeID="0002">${siren}</ram:ID>`,
      '        </ram:SpecifiedLegalOrganization>',
    ] : []),
    '        <ram:PostalTradeAddress>',
    `          <ram:LineOne>${(dealer?.address || "").split("\n")[0]}</ram:LineOne>`,
    '          <ram:CountryID>FR</ram:CountryID>',
    '        </ram:PostalTradeAddress>',
    '        <ram:SpecifiedTaxRegistration>',
    `          <ram:ID schemeID="VA">${dealer?.tva_num || ""}</ram:ID>`,
    '        </ram:SpecifiedTaxRegistration>',
    '      </ram:SellerTradeParty>',
    '      <ram:BuyerTradeParty>',
    `        <ram:Name>${order.client?.name || ""}</ram:Name>`,
    '      </ram:BuyerTradeParty>',
    '    </ram:ApplicableHeaderTradeAgreement>',
    '    <ram:ApplicableHeaderTradeDelivery/>',
    '    <ram:ApplicableHeaderTradeSettlement>',
    '      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>',
    '      <ram:ApplicableTradeTax>',
    `        <ram:CalculatedAmount>${c.tvaAmt.toFixed(2)}</ram:CalculatedAmount>`,
    '        <ram:TypeCode>VAT</ram:TypeCode>',
    `        <ram:BasisAmount>${c.base.toFixed(2)}</ram:BasisAmount>`,
    '        <ram:CategoryCode>S</ram:CategoryCode>',
    `        <ram:RateApplicablePercent>${order.tva_pct || 20}</ram:RateApplicablePercent>`,
    '      </ram:ApplicableTradeTax>',
    '      <ram:SpecifiedTradePaymentTerms>',
    '        <ram:DueDateDateTime>',
    `          <udt:DateTimeString format="102">${dueDate}</udt:DateTimeString>`,
    '        </ram:DueDateDateTime>',
    '      </ram:SpecifiedTradePaymentTerms>',
    '      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>',
    `        <ram:LineTotalAmount>${c.base.toFixed(2)}</ram:LineTotalAmount>`,
    `        <ram:TaxBasisTotalAmount>${c.base.toFixed(2)}</ram:TaxBasisTotalAmount>`,
    `        <ram:TaxTotalAmount currencyID="EUR">${c.tvaAmt.toFixed(2)}</ram:TaxTotalAmount>`,
    // v8.49.11 — Norme EN 16931 : GrandTotalAmount inclut les débours (montant à payer)
    `        <ram:GrandTotalAmount>${c.grandTotal.toFixed(2)}</ram:GrandTotalAmount>`,
    `        <ram:TotalPrepaidAmount>${c.encaisse.toFixed(2)}</ram:TotalPrepaidAmount>`,
    `        <ram:DuePayableAmount>${c.reste.toFixed(2)}</ram:DuePayableAmount>`,
    '      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>',
    '    </ram:ApplicableHeaderTradeSettlement>',
    '  </rsm:SupplyChainTradeTransaction>',
    '</rsm:CrossIndustryInvoice>',
  ];

  const xml = lines.join("\n");
  const blob = new Blob([xml], { type: "application/xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${order.ref}_facturx_${isEN16931 ? "EN16931" : "MINIMUM"}.xml`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ═══════════════════════════════════════════════════════════════
   CRM — CLIENTS
═══════════════════════════════════════════════════════════════ */
const STATUTS_CLIENT = {
  prospect:    { label: "Prospect",       cls: "badge-muted",   icon: "🔍" },
  contacte:    { label: "Contacté",       cls: "badge-blue",    icon: "📞" },
  negociation: { label: "Négociation",    cls: "badge-orange",  icon: "🤝" },
  client:      { label: "Client",         cls: "badge-green",   icon: "✅" },
  inactif:     { label: "Inactif",        cls: "badge-muted",   icon: "💤" },
};

function CrmPage({ clients, setClients, orders, viewMode, dealer, setDealer, token }) {
  const [search, setSearch]         = useState("");
  const [filterStatut, setFilter]   = useState("all");
  const [modal, setModal]           = useState(null);
  const [fiche, setFiche]           = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [showDemoLimit, setShowDemoLimit] = useState(false);

  // ─── MODE D'AFFICHAGE (capsules / liste) ────────────────────
  // Persisté dans dealer.ui_prefs.crm_view (Supabase) avec miroir localStorage.
  // "cards" = vue capsules (par défaut), "list" = vue liste compacte.
  const sanitizeView = (raw) => (raw === "list" || raw === "cards") ? raw : null;
  const [crmView, setCrmView] = useState(() => {
    try {
      const fromDealer = sanitizeView(dealer?.ui_prefs?.crm_view);
      if (fromDealer) return fromDealer;
    } catch (e) { /* ignore */ }
    try {
      const raw = localStorage.getItem("iocar_crm_view");
      const fromLocal = sanitizeView(raw);
      if (fromLocal) return fromLocal;
    } catch (e) { /* ignore */ }
    return "cards";
  });
  useEffect(() => {
    const fromDealer = sanitizeView(dealer?.ui_prefs?.crm_view);
    if (fromDealer && fromDealer !== crmView) setCrmView(fromDealer);
  }, [dealer?.ui_prefs?.crm_view]);
  const setCrmViewPersisted = (next) => {
    if (!sanitizeView(next)) return;
    setCrmView(next);
    try { localStorage.setItem("iocar_crm_view", next); } catch (e) { /* ignore */ }
    if (typeof setDealer === "function") {
      const newPrefs = { ...(dealer?.ui_prefs || {}), crm_view: next };
      setDealer({ ...dealer, ui_prefs: newPrefs });
    }
  };

  const filtered = clients.filter(c => {
    const matchS = !search || `${c.nom} ${c.prenom} ${c.email} ${c.phone}`.toLowerCase().includes(search.toLowerCase());
    const matchF = filterStatut === "all" || c.statut === filterStatut;
    return matchS && matchF;
  });

  const save = (c) => {
    const exists = clients.find(x => x.id === c.id);
    setClients(exists ? clients.map(x => x.id === c.id ? c : x) : [c, ...clients]);
    setModal(null);
    if (fiche?.id === c.id) setFiche(c);
    // v8.44 — Sync IOBILL géré automatiquement par le wrapper setClientsRaw au niveau App
  };

  const del = (id) => {
    setClients(clients.filter(c => c.id !== id));
    if (fiche?.id === id) setFiche(null);
    setPendingDelete(null);
    // v8.44 — Suppression IOBILL gérée automatiquement par le wrapper setClientsRaw au niveau App
  };

  const clientOrders = (clientId) => orders.filter(o => o.client_id === clientId || (fiche && o.client?.name?.toLowerCase() === fiche.nom?.toLowerCase()));

  return (
    <div className="page">
      {fiche && <CrmFiche client={fiche} orders={clientOrders(fiche.id)} onEdit={() => setModal(fiche)} onClose={() => setFiche(null)} onSave={save} dealer={dealer} setDealer={setDealer} viewMode={viewMode} />}
      {modal && <CrmModal client={modal === "add" ? null : modal} onSave={save} onClose={() => setModal(null)} />}
      {pendingDelete && (
        <ConfirmModal
          title="Supprimer le contact"
          message={`Supprimer définitivement la fiche de ${pendingDelete.label} ? Ses documents ne seront pas supprimés.`}
          confirmLabel="Supprimer"
          onConfirm={() => del(pendingDelete.id)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {viewMode === "trial" && showDemoLimit && <DemoLimitModal type="clients" onClose={() => setShowDemoLimit(false)} />}

      <div className="page-header">
        <div>
          <div className="page-title">👥 CRM Clients</div>
          <div className="page-sub">{clients.length} contact{clients.length !== 1 ? "s" : ""} · {clients.filter(c => c.statut === "client").length} clients actifs{viewMode === "trial" && <span style={{ marginLeft: 8, fontSize: 11, color: "var(--orange)" }}>· Mode démo ({clients.length}/{DEMO_LIMITS.clients})</span>}</div>
        </div>
        <button className="btn btn-primary" onClick={() => {
          if (viewMode === "trial" && clients.length >= DEMO_LIMITS.clients) { setShowDemoLimit(true); return; }
          setModal("add");
        }}>+ Nouveau contact</button>
      </div>

      {/* Filtres */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <input className="search-input" placeholder="Rechercher nom, email, téléphone..." value={search} onChange={e => setSearch(e.target.value)} />
        <div className="tabs" style={{ margin: 0 }}>
          {[["all", "Tous"], ...Object.entries(STATUTS_CLIENT).map(([k, v]) => [k, v.icon + " " + v.label])].map(([k, l]) => (
            <div key={k} className={`tab${filterStatut === k ? " active" : ""}`} onClick={() => setFilter(k)}>{l}</div>
          ))}
        </div>
        {/* Toggle vue capsules / liste — persisté dans ui_prefs.crm_view */}
        <div style={{ marginLeft: "auto", display: "inline-flex", background: "var(--card2)", border: "1px solid var(--border2)", borderRadius: 8, padding: 3, gap: 2 }}>
          {[
            { key: "cards", icon: "▦", label: "Capsules" },
            { key: "list", icon: "≡", label: "Liste" },
          ].map(opt => {
            const active = crmView === opt.key;
            return (
              <button
                key={opt.key}
                onClick={() => setCrmViewPersisted(opt.key)}
                title={opt.label}
                style={{
                  padding: "6px 12px", fontSize: 12, fontWeight: 600,
                  borderRadius: 6, border: "none", cursor: "pointer",
                  background: active ? "var(--gold)" : "transparent",
                  color: active ? "#0a0a0a" : "var(--muted)",
                  transition: "all .15s",
                  display: "flex", alignItems: "center", gap: 6,
                }}
              >
                <span style={{ fontSize: 14, lineHeight: 1 }}>{opt.icon}</span>
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Vue clients — capsules ou liste selon préférence */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--muted)" }}>
          <div style={{ fontSize: 48, marginBottom: 16, opacity: .3 }}>👥</div>
          <div style={{ fontSize: 14 }}>Aucun contact trouvé</div>
        </div>
      ) : crmView === "list" ? (
        // ─── MODE LISTE ─────────────────────────────────────────
        // Format compact : tableau avec une ligne par client. Idéal pour scanner
        // rapidement un grand volume de contacts.
        <div className="card" style={{ overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "var(--card2)", borderBottom: "1px solid var(--border2)" }}>
                  <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--muted)" }}>Client</th>
                  <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--muted)" }}>Contact</th>
                  <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--muted)" }}>Statut</th>
                  <th style={{ padding: "10px 14px", textAlign: "center", fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--muted)" }}>Documents</th>
                  <th style={{ padding: "10px 14px", textAlign: "left", fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--muted)" }}>Intérêt</th>
                  <th style={{ padding: "10px 14px", textAlign: "right", fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--muted)" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => {
                  // v8.45 — Match robuste : prioritairement par client_id, fallback nom (dans n'importe quel sens)
                  const cFullName = `${c.nom || ''} ${c.prenom || ''}`.toLowerCase().trim();
                  const cFullNameRev = `${c.prenom || ''} ${c.nom || ''}`.toLowerCase().trim();
                  const nbDocs = orders.filter(o => {
                    if (o.client_id === c.id) return true;
                    const orderName = (o.client?.name || '').toLowerCase().trim();
                    return orderName && (orderName === cFullName || orderName === cFullNameRev);
                  }).length;
                  return (
                    <tr
                      key={c.id}
                      onClick={() => setFiche(c)}
                      onMouseEnter={e => e.currentTarget.style.background = "rgba(212,168,67,.04)"}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}
                      style={{ borderBottom: "1px solid var(--border2)", cursor: "pointer", transition: "background .15s" }}
                    >
                      <td style={{ padding: "10px 14px" }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <div style={{
                            width: 32, height: 32, borderRadius: "50%", background: "var(--gold3)",
                            border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center",
                            fontFamily: "Syne", fontWeight: 800, fontSize: 12, color: "var(--gold)", flexShrink: 0
                          }}>
                            {(c.nom?.[0] || "?").toUpperCase()}
                          </div>
                          <div style={{ fontWeight: 600 }}>{c.prenom} {c.nom}</div>
                        </div>
                      </td>
                      <td style={{ padding: "10px 14px", color: "var(--muted2)", fontSize: 12 }}>
                        {c.email || c.phone || "—"}
                      </td>
                      <td style={{ padding: "10px 14px" }}>
                        <span className={`badge ${STATUTS_CLIENT[c.statut || "prospect"]?.cls}`}>
                          {STATUTS_CLIENT[c.statut || "prospect"]?.label}
                        </span>
                      </td>
                      <td style={{ padding: "10px 14px", textAlign: "center", fontSize: 12, color: "var(--muted)" }}>
                        🧾 {nbDocs}
                      </td>
                      <td style={{ padding: "10px 14px", fontSize: 12, color: "var(--muted2)" }}>
                        {c.vehicule_interet || (c.budget ? fmt(c.budget) : "—")}
                      </td>
                      <td style={{ padding: "10px 14px", textAlign: "right" }}>
                        <button
                          className="btn btn-danger btn-xs"
                          onClick={e => { e.stopPropagation(); setPendingDelete({ id: c.id, label: `${c.prenom || ""} ${c.nom}`.trim() }); }}
                        >🗑</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        // ─── MODE CAPSULES (par défaut) ─────────────────────────
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14 }}>
          {filtered.map(c => {
            // v8.45 — Match robuste : prioritairement par client_id, fallback nom (dans n'importe quel sens)
            const cFullName = `${c.nom || ''} ${c.prenom || ''}`.toLowerCase().trim();
            const cFullNameRev = `${c.prenom || ''} ${c.nom || ''}`.toLowerCase().trim();
            const nbDocs = orders.filter(o => {
              if (o.client_id === c.id) return true;
              const orderName = (o.client?.name || '').toLowerCase().trim();
              return orderName && (orderName === cFullName || orderName === cFullNameRev);
            }).length;
            const lastAnnot = c.annotations?.length > 0 ? c.annotations[c.annotations.length - 1] : null;
            return (
              <div key={c.id} className="card" style={{ transition: "border-color .15s" }}
                onMouseEnter={e => e.currentTarget.style.borderColor = "var(--border)"}
                onMouseLeave={e => e.currentTarget.style.borderColor = "rgba(255,255,255,.07)"}>
                <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border2)", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ display: "flex", gap: 12, alignItems: "center", cursor: "pointer", flex: 1 }} onClick={() => setFiche(c)}>
                    <div style={{
                      width: 42, height: 42, borderRadius: "50%", background: "var(--gold3)",
                      border: "2px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center",
                      fontFamily: "Syne", fontWeight: 800, fontSize: 15, color: "var(--gold)", flexShrink: 0
                    }}>
                      {(c.nom?.[0] || "?").toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>{c.prenom} {c.nom}</div>
                      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{c.email || c.phone || "—"}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span className={`badge ${STATUTS_CLIENT[c.statut || "prospect"]?.cls}`}>
                      {STATUTS_CLIENT[c.statut || "prospect"]?.label}
                    </span>
                    <button className="btn btn-danger btn-xs" onClick={e => { e.stopPropagation(); setPendingDelete({ id: c.id, label: `${c.prenom || ""} ${c.nom}`.trim() }); }}>🗑</button>
                  </div>
                </div>
                <div style={{ padding: "12px 20px" }}>
                  <div style={{ display: "flex", gap: 16, fontSize: 12, color: "var(--muted)", marginBottom: lastAnnot ? 10 : 0 }}>
                    <span>🧾 {nbDocs} document{nbDocs !== 1 ? "s" : ""}</span>
                    {c.vehicule_interet && <span>🚗 {c.vehicule_interet}</span>}
                    {c.budget && <span>💰 {fmt(c.budget)}</span>}
                  </div>
                  {lastAnnot && (
                    <div style={{ fontSize: 11, color: "var(--muted2)", background: "var(--card2)", borderRadius: 6, padding: "6px 10px", borderLeft: "3px solid var(--border)" }}>
                      📝 {lastAnnot.texte?.slice(0, 80)}{lastAnnot.texte?.length > 80 ? "…" : ""}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Fiche détail client ── */
function CrmFiche({ client, orders, onEdit, onClose, onSave, dealer, setDealer, viewMode }) {
  const [newAnnot, setNewAnnot] = useState("");
  const [annotMode, setAnnotMode] = useState(false);
  const [pendingDeleteAnnot, setPendingDeleteAnnot] = useState(null);
  const [print, setPrint] = useState(null); // aperçu PDF d'un document cliqué

  // ─── MODULES VISIBLES ───────────────────────────────────────
  // Même système que le Dashboard : ui_prefs.crm_modules dans Supabase + miroir localStorage.
  // "coordonnees" n'est pas toggleable (info de base du client, toujours visible).
  const CRM_MODULE_KEYS = ["documents", "reprises", "annotations"];
  const CRM_DEFAULT_VISIBLE = { documents: true, reprises: true, annotations: true };
  const sanitizeCrmModules = (raw) => {
    if (!raw || typeof raw !== "object") return null;
    const out = {};
    for (const k of CRM_MODULE_KEYS) {
      if (k in raw) out[k] = raw[k] === true;
    }
    return out;
  };
  const [crmVisible, setCrmVisible] = useState(() => {
    try {
      const fromDealer = sanitizeCrmModules(dealer?.ui_prefs?.crm_modules);
      if (fromDealer) return { ...CRM_DEFAULT_VISIBLE, ...fromDealer };
    } catch (e) { /* ignore */ }
    try {
      const raw = localStorage.getItem("iocar_crm_modules");
      if (raw) {
        const fromLocal = sanitizeCrmModules(JSON.parse(raw));
        if (fromLocal) return { ...CRM_DEFAULT_VISIBLE, ...fromLocal };
      }
    } catch (e) { /* ignore */ }
    return CRM_DEFAULT_VISIBLE;
  });
  useEffect(() => {
    const fromDealer = sanitizeCrmModules(dealer?.ui_prefs?.crm_modules);
    if (fromDealer) setCrmVisible(prev => ({ ...CRM_DEFAULT_VISIBLE, ...fromDealer }));
  }, [dealer?.ui_prefs?.crm_modules]);
  const toggleCrmModule = (key) => {
    if (!CRM_MODULE_KEYS.includes(key)) return;
    const next = { ...crmVisible, [key]: !crmVisible[key] };
    setCrmVisible(next);
    try { localStorage.setItem("iocar_crm_modules", JSON.stringify(next)); } catch (e) { /* ignore */ }
    if (typeof setDealer === "function") {
      const newPrefs = { ...(dealer?.ui_prefs || {}), crm_modules: next };
      setDealer({ ...dealer, ui_prefs: newPrefs });
    }
  };

  // Mini toggle dans le coin d'une section. on=true → activé (or plein), on=false → grisé.
  // Au clic, appelle toggleCrmModule. e.stopPropagation() pour que le clic ne déclenche pas
  // un éventuel handler parent (ex. le clic sur la zone scrollable).
  const MiniToggle = ({ on, onClick }) => (
    <div
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{ display: "inline-flex", alignItems: "center", cursor: "pointer", userSelect: "none", flexShrink: 0 }}
      title={on ? "Cliquer pour masquer cette section" : "Cliquer pour afficher cette section"}
    >
      <div style={{
        width: 28, height: 16, borderRadius: 8,
        background: on ? "var(--gold)" : "var(--card)",
        border: "1px solid var(--border2)", position: "relative", transition: "background .2s",
      }}>
        <div style={{
          width: 12, height: 12, borderRadius: "50%", background: "#fff",
          position: "absolute", top: 1,
          left: on ? 14 : 1,
          transition: "left .2s", boxShadow: "0 1px 2px rgba(0,0,0,.3)"
        }} />
      </div>
    </div>
  );

  const addAnnotation = () => {
    if (!newAnnot.trim()) return;
    const annot = { id: uid(), texte: newAnnot.trim(), date: today(), heure: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) };
    onSave({ ...client, annotations: [...(client.annotations || []), annot] });
    setNewAnnot("");
    setAnnotMode(false);
  };

  const delAnnot = (id) => {
    onSave({ ...client, annotations: (client.annotations || []).filter(a => a.id !== id) });
    setPendingDeleteAnnot(null);
  };

  return (
    <div className="modal-bg" onClick={e => e.target === e.currentTarget && onClose()}>
      {pendingDeleteAnnot && (
        <ConfirmModal
          title="Supprimer l'annotation"
          message={`Supprimer cette note : "${pendingDeleteAnnot.texte?.slice(0, 60)}…" ?`}
          confirmLabel="Supprimer"
          onConfirm={() => delAnnot(pendingDeleteAnnot.id)}
          onCancel={() => setPendingDeleteAnnot(null)}
        />
      )}
      {/* Aperçu PDF du document cliqué (BC / Facture / Avoir).
          Se superpose à la fiche client — la fermeture revient à la fiche. */}
      {print && <PrintDoc order={print} dealer={dealer} onClose={() => setPrint(null)} viewMode={viewMode} />}
      <div className="modal modal-lg" style={{ display: "flex", flexDirection: "column", maxHeight: "92vh" }}>
        <div className="modal-hd" style={{ flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--gold3)", border: "2px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Syne", fontWeight: 800, fontSize: 16, color: "var(--gold)" }}>
              {(client.nom?.[0] || "?").toUpperCase()}
            </div>
            <div>
              <span className="modal-title">{client.prenom} {client.nom}</span>
              <div style={{ display: "flex", gap: 8, marginTop: 3 }}>
                <span className={`badge ${STATUTS_CLIENT[client.statut || "prospect"]?.cls}`}>
                  {STATUTS_CLIENT[client.statut || "prospect"]?.icon} {STATUTS_CLIENT[client.statut || "prospect"]?.label}
                </span>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={onEdit}>✏️ Modifier</button>
            <button className="close-btn" onClick={onClose}>×</button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>

          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 20, marginBottom: 24
          }}>

            {/* Infos contact */}
            <div className="card card-pad">
              <div style={{ fontFamily: "Syne", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: "var(--gold)", textTransform: "uppercase", marginBottom: 12 }}>Coordonnées</div>
              {[["📧", "Email", client.email], ["📞", "Téléphone", client.phone], ["🏠", "Adresse", client.adresse], ["🚗", "Intérêt véhicule", client.vehicule_interet], ["💰", "Budget", client.budget ? fmt(client.budget) : null], ["📅", "Contact le", client.date_contact]].filter(([,, v]) => v).map(([icon, label, val]) => (
                <div key={label} style={{ display: "flex", gap: 8, marginBottom: 8, fontSize: 13 }}>
                  <span>{icon}</span>
                  <span style={{ color: "var(--muted)", minWidth: 100 }}>{label}</span>
                  <span style={{ fontWeight: 500 }}>{val}</span>
                </div>
              ))}
              {client.notes && (
                <div style={{ marginTop: 8, padding: "8px 12px", background: "var(--card2)", borderRadius: 6, fontSize: 12, color: "var(--muted2)" }}>
                  {client.notes}
                </div>
              )}
            </div>

            {/* Documents rattachés — toggleable depuis le coin du header.
                Si désactivé : seul le header reste visible avec le toggle pour réactiver. */}
            <div className="card card-pad">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: crmVisible.documents ? 12 : 0 }}>
                <div style={{ fontFamily: "Syne", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: crmVisible.documents ? "var(--gold)" : "var(--muted)", textTransform: "uppercase" }}>
                  Factures & Bons de commande ({orders.length})
                </div>
                <MiniToggle on={crmVisible.documents} onClick={() => toggleCrmModule("documents")} />
              </div>
              {crmVisible.documents && (
                orders.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>Aucun document lié</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {orders.map(o => {
                      const c2 = calcOrder(o);
                      // Badge selon type : facture (or), BC (bleu), avoir (rouge)
                      const badgeInfo = o.type === "facture"
                        ? { cls: "badge-gold", label: "🧾 Facture" }
                        : o.type === "avoir"
                        ? { cls: "badge-red", label: "↩️ Avoir" }
                        : { cls: "badge-blue", label: "📝 BC" };
                      return (
                        <div
                          key={o.id}
                          onClick={() => setPrint(o)}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--gold)"; e.currentTarget.style.background = "rgba(212,168,67,.05)"; }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.background = "var(--card2)"; }}
                          style={{
                            display: "flex", justifyContent: "space-between", alignItems: "center",
                            padding: "8px 10px", background: "var(--card2)", borderRadius: 6,
                            border: "1px solid transparent", cursor: "pointer", transition: "all .15s",
                          }}
                          title="Cliquer pour voir l'aperçu"
                        >
                          <div>
                            <div style={{ fontSize: 12, fontWeight: 600, fontFamily: "DM Mono" }}>{o.ref}</div>
                            <div style={{ fontSize: 11, color: "var(--muted)" }}>{o.date_creation} · {o.vehicle_label}</div>
                          </div>
                          <div style={{ textAlign: "right", display: "flex", alignItems: "center", gap: 10 }}>
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 700 }}>{fmtDec(c2.grandTotal)}</div>
                              <span className={`badge ${badgeInfo.cls}`} style={{ fontSize: 10 }}>
                                {badgeInfo.label}
                              </span>
                            </div>
                            <span style={{ fontSize: 14, color: "var(--muted)" }}>👁</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              )}
            </div>
          </div>

          {/* Reprises véhicules — calculé à partir des ordres du client.
              Toggleable depuis le coin du header. Si aucune reprise → on n'affiche rien
              (sinon c'est du bruit visuel). */}
          {(() => {
            const reprises = orders.filter(o => o.reprise_active && (parseFloat(o.reprise_valeur) || 0) > 0);
            if (reprises.length === 0) return null;
            const totalReprise = reprises.reduce((s, o) => s + (parseFloat(o.reprise_valeur) || 0), 0);
            return (
              <div className="card card-pad" style={{ marginBottom: 24, border: "1px solid rgba(212,168,67,.3)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: crmVisible.reprises ? 12 : 0, gap: 12 }}>
                  <div style={{ fontFamily: "Syne", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: crmVisible.reprises ? "var(--gold)" : "var(--muted)", textTransform: "uppercase" }}>
                    🔄 Reprises véhicules ({reprises.length})
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    {crmVisible.reprises && (
                      <div style={{ fontSize: 12, color: "var(--muted)" }}>
                        Total repris : <strong style={{ color: "var(--gold)" }}>{fmt(totalReprise)}</strong>
                      </div>
                    )}
                    <MiniToggle on={crmVisible.reprises} onClick={() => toggleCrmModule("reprises")} />
                  </div>
                </div>
                {crmVisible.reprises && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {reprises.map(o => {
                    const modele = [o.reprise_marque, o.reprise_modele].filter(Boolean).join(" ") || "Véhicule";
                    return (
                      <div key={o.id} style={{ padding: "10px 12px", background: "var(--card2)", borderRadius: 6, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                        <div style={{ flex: 1, minWidth: 200 }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{modele} {o.reprise_annee && <span style={{ color: "var(--muted)", fontWeight: 400 }}>· {o.reprise_annee}</span>}</div>
                          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3, display: "flex", gap: 10, flexWrap: "wrap" }}>
                            {o.reprise_plate && <span style={{ fontFamily: "monospace" }}>🔖 {o.reprise_plate}</span>}
                            {o.reprise_km && <span>📏 {o.reprise_km} km</span>}
                            <span>📄 {o.ref} · {o.date_creation}</span>
                          </div>
                          {o.reprise_vin && (
                            <div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "monospace", marginTop: 2 }}>
                              VIN : {o.reprise_vin}
                            </div>
                          )}
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--gold)" }}>{fmt(parseFloat(o.reprise_valeur) || 0)}</div>
                          <div style={{ fontSize: 10, color: "var(--muted)" }}>valeur reprise</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                )}
              </div>
            );
          })()}

          {/* Annotations */}
          {/* Annotations — toggleable depuis le coin du header.
              Si désactivé : seul le header reste visible avec le toggle pour réactiver. */}
          <div className="card">
            <div style={{ padding: "14px 20px", borderBottom: crmVisible.annotations ? "1px solid var(--border2)" : "none", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <div style={{ fontFamily: "Syne", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, color: crmVisible.annotations ? "var(--gold)" : "var(--muted)", textTransform: "uppercase" }}>
                📝 Annotations & Suivi ({(client.annotations || []).length})
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {crmVisible.annotations && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setAnnotMode(!annotMode)}>
                    {annotMode ? "Annuler" : "+ Ajouter une note"}
                  </button>
                )}
                <MiniToggle on={crmVisible.annotations} onClick={() => toggleCrmModule("annotations")} />
              </div>
            </div>

            {crmVisible.annotations && annotMode && (
              <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border2)", background: "var(--card2)" }}>
                <textarea
                  className="form-input"
                  rows={3}
                  placeholder="Votre note... (ex: Intéressé par un SUV diesel, rappeler en mai)"
                  value={newAnnot}
                  onChange={e => setNewAnnot(e.target.value)}
                  autoFocus
                  style={{ marginBottom: 10 }}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={addAnnotation}>💾 Enregistrer</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setAnnotMode(false); setNewAnnot(""); }}>Annuler</button>
                </div>
              </div>
            )}

            {crmVisible.annotations && (
            <div style={{ maxHeight: 320, overflowY: "auto" }}>
              {(client.annotations || []).length === 0 ? (
                <div style={{ padding: "20px", fontSize: 12, color: "var(--muted)", textAlign: "center" }}>
                  Aucune annotation — cliquez sur "+ Ajouter une note"
                </div>
              ) : (
                [...(client.annotations || [])].reverse().map(a => (
                  <div key={a.id} style={{ padding: "12px 20px", borderBottom: "1px solid var(--border2)", display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <div style={{ width: 32, height: 32, borderRadius: "50%", background: "var(--card2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>📝</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, lineHeight: 1.6 }}>{a.texte}</div>
                      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{a.date} à {a.heure}</div>
                    </div>
                    <button className="btn btn-danger btn-xs" onClick={() => setPendingDeleteAnnot(a)}>🗑</button>
                  </div>
                ))
              )}
            </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Formulaire création/édition client ── */
function CrmModal({ client, onSave, onClose }) {
  const [form, setForm] = useState(client || {
    id: uid(), civilite: "", nom: "", prenom: "", email: "", phone: "", adresse: "",
    code_postal: "", ville: "", pays: "France",
    statut: "prospect", vehicule_interet: "", budget: "", date_contact: today(),
    notes: "", annotations: []
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="modal-bg" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-md">
        <div className="modal-hd">
          <span className="modal-title">{client ? "Modifier le contact" : "Nouveau contact"}</span>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <div className="form-group">
              <label className="form-label">Civilité</label>
              <select className="form-input" value={form.civilite || ""} onChange={e => set("civilite", e.target.value)}>
                <option value="">—</option>
                <option value="M">M.</option>
                <option value="F">Mme</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Prénom</label>
              <input className="form-input" value={form.prenom} onChange={e => set("prenom", e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Nom *</label>
              <input className="form-input" value={form.nom} onChange={e => set("nom", e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input className="form-input" type="email" value={form.email} onChange={e => set("email", e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Téléphone</label>
              <input className="form-input" value={form.phone} onChange={e => set("phone", e.target.value)} />
            </div>
            <div className="form-group full">
              <label className="form-label">Adresse</label>
              <input className="form-input" value={form.adresse} onChange={e => set("adresse", e.target.value)} placeholder="N° et rue" />
            </div>
            <div className="form-group">
              <label className="form-label">Code postal</label>
              <input className="form-input" value={form.code_postal || ""} onChange={e => set("code_postal", e.target.value)} placeholder="13001" />
            </div>
            <div className="form-group">
              <label className="form-label">Ville</label>
              <input className="form-input" value={form.ville || ""} onChange={e => set("ville", e.target.value)} placeholder="Marseille" />
            </div>
            <div className="form-group">
              <label className="form-label">Pays</label>
              <input className="form-input" value={form.pays || "France"} onChange={e => set("pays", e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Statut</label>
              <select className="form-input" value={form.statut} onChange={e => set("statut", e.target.value)}>
                {Object.entries(STATUTS_CLIENT).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Date de contact</label>
              <input className="form-input" value={form.date_contact} onChange={e => set("date_contact", e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Véhicule recherché</label>
              <input className="form-input" placeholder="ex: SUV diesel, Budget 20k€" value={form.vehicule_interet} onChange={e => set("vehicule_interet", e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Budget max (€)</label>
              <input className="form-input" type="number" value={form.budget} onChange={e => set("budget", e.target.value)} />
            </div>
            <div className="form-group full">
              <label className="form-label">Notes internes</label>
              <textarea className="form-input" rows={2} value={form.notes} onChange={e => set("notes", e.target.value)} placeholder="Informations générales sur ce contact..." />
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Annuler</button>
          <button className="btn btn-primary" onClick={() => {
            if (!form.nom.trim()) return alert("Le nom est requis");
            onSave({ ...form, budget: parseFloat(form.budget) || 0 });
          }}>💾 Enregistrer</button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   EXPORT COMPTABLE CSV — FEC simplifié
═══════════════════════════════════════════════════════════════ */
function exportComptableCSV(orders, dealer) {
  const sep = ";";
  const headers = [
    "Type", "Référence", "Date", "Client", "SIREN client",
    "Véhicule", "Plaque", "Base HT (€)", "TVA (%)", "Montant TVA (€)",
    "Total TTC (€)", "Débours (€)", "Total à payer (€)",
    "Encaissé (€)", "Reste dû (€)", "Statut paiement",
    "Catégorie opération", "TVA sur débits", "Avec TVA", "Facture origine"
  ].join(sep);

  const rows = [...orders]
    .sort((a, b) => (a.ref || "").localeCompare(b.ref || ""))
    .map(o => {
      const c = calcOrder(o);
      const paySt = c.reste <= 0.01 ? "Soldé" : c.encaisse > 0 ? "Partiel" : "À encaisser";
      const catOp = o.categorie_operation === "prestation_services" ? "Prestation de services"
        : o.categorie_operation === "mixte" ? "Livraison + Prestation"
        : "Livraison de biens";
      return [
        o.type === "facture" ? "Facture" : o.type === "avoir" ? "Avoir" : "Bon de commande",
        o.ref || "",
        o.date_creation || "",
        (o.client?.name || "").replace(/;/g, ","),
        o.client?.siren || "",
        (o.vehicle_label || "").replace(/;/g, ","),
        o.vehicle_plate || "",
        c.base.toFixed(2).replace(".", ","),
        o.avec_tva !== false ? (o.tva_pct || 20) : 0,
        c.tvaAmt.toFixed(2).replace(".", ","),
        c.ttc.toFixed(2).replace(".", ","),
        // v8.49.11 — Nouvelles colonnes fiscales pour la compta
        c.debourTotal.toFixed(2).replace(".", ","),
        c.grandTotal.toFixed(2).replace(".", ","),
        c.encaisse.toFixed(2).replace(".", ","),
        c.reste.toFixed(2).replace(".", ","),
        paySt,
        catOp,
        o.tva_sur_debits ? "Oui" : "Non",
        o.avec_tva !== false ? "Oui" : "Non (Art. 297A CGI)",
        o.facture_origine || "",
      ].join(sep);
    });

  const bom = "\uFEFF"; // BOM UTF-8 pour Excel
  const csv = bom + [headers, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `export_comptable_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ═══════════════════════════════════════════════════════════════
   SUPABASE DATA HOOKS
═══════════════════════════════════════════════════════════════ */
function useSupabaseTable(token, garageId, table) {
  const [data, setData] = useState([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!token || !garageId) { setReady(true); return; }
    setReady(false);
    sb.select(token, table, `garage_id=eq.${garageId}`)
      .then(rows => {
        // Supabase stocke {id, garage_id, data:{...}} — on aplatit pour l'UI
        const flat = (rows || []).map(r => {
          if (r.data && typeof r.data === "object") {
            return { ...r.data, id: r.id, garage_id: r.garage_id, created_at: r.created_at };
          }
          return r;
        });
        setData(flat);
      })
      .catch(() => setData([]))
      .finally(() => setReady(true));
  }, [token, garageId]);

  // setData wrapper : met à jour le state ET persiste les changements dans Supabase
  const setDataAndSync = useCallback((newDataOrFn) => {
    setData(prev => {
      const next = typeof newDataOrFn === "function" ? newDataOrFn(prev) : newDataOrFn;
      if (!token || !garageId || token === "demo") return next;

      if (table === "livre_police") {
        console.log(`[LP Sync] prev: ${prev.length} → next: ${next.length} items`);
      }

      const prevIds = new Set(prev.map(r => r.id));
      const nextIds = new Set(next.map(r => r.id));

      // Upsert : éléments nouveaux ou modifiés — wrapper dans {id, garage_id, data:{...}}
      for (const row of next) {
        const old = prev.find(r => r.id === row.id);
        if (!old || JSON.stringify(old) !== JSON.stringify(row)) {
          const { id, garage_id: _g, created_at: _c, ...fields } = row;
          sb.upsert(token, table, { id, garage_id: garageId, data: fields })
            .then(() => { if (table === "livre_police") console.log(`[LP Sync] ✅ upsert OK: ${id}`); })
            .catch(err => console.error(`[LP Sync] ❌ upsert FAIL: ${id}`, err));
        }
      }

      // Delete : éléments supprimés
      for (const id of prevIds) {
        if (!nextIds.has(id)) {
          sb.delete(token, table, id).catch(() => {});
          // v8.58 — Propagation IOBILL pour la table clients uniquement.
          // Le hook `useSupabaseTable` supprimait bien côté Supabase IOCAR
          // mais NE PROPAGEAIT PAS côté IOBILL — le client restait en base
          // IOBILL et impossible à supprimer (car external_managed=true bloque
          // aussi la suppression manuelle côté IOBILL depuis v8.57.12).
          // On appelle l'endpoint bridge `delete_client` qui, côté IOBILL,
          // fait un hard delete si aucune facture liée, sinon un soft delete
          // (déverrouille la lecture seule pour permettre la finalisation).
          if (table === "clients") {
            fetch("/api/iobill-bridge", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
              },
              body: JSON.stringify({
                action: "delete_client",
                client_id: id
              })
            })
              .then((r) => r.json().catch(() => ({})))
              .then((j) => {
                if (j && j.ok) {
                  console.log(
                    `[Bridge] delete_client OK ${id} — ` +
                    (j.hard_deleted ? "hard delete IOBILL" : "soft delete IOBILL")
                  );
                } else {
                  console.warn(
                    `[Bridge] delete_client échec IOBILL pour ${id}`,
                    j?.error || j
                  );
                }
              })
              .catch((err) => {
                console.warn(`[Bridge] delete_client réseau échoué pour ${id}`, err);
              });
          }
        }
      }

      return next;
    });
  }, [token, garageId, table]);

  return [data, setDataAndSync, ready];
}

/* ═══════════════════════════════════════════════════════════════
   ÉCRAN CONNEXION
═══════════════════════════════════════════════════════════════ */
// ── STRIPE CONFIG ─────────────────────────────────────────────
// Note : depuis qu'on utilise un endpoint serveur pour Checkout, la clé
// publique Stripe n'est plus nécessaire côté front. Tout passe par
// /api/create-checkout-session qui utilise STRIPE_SECRET_KEY côté serveur.
const STRIPE_PLANS = {
  monthly: {
    priceId: "price_1TzfDwGHGXxR2PvGfrExXJRv",
    label:   "Mensuel",
    price:   "34,99€",
    period:  "/ mois HT",
    badge:   null,
  },
  annual: {
    priceId: "price_1TzfEnGHGXxR2PvGOrZaiAxA",
    label:   "Annuel",
    price:   "349,90€",
    period:  "/ an HT",
    badge:   "2 mois offerts",
  },
};

async function redirectToStripe(priceId, email) {
  // Appel à notre endpoint serveur qui crée la session Stripe Checkout.
  // Avantage : la STRIPE_SECRET_KEY reste 100 % côté serveur, et on est
  // compatible avec tous les comptes Stripe (pas besoin de l'option
  // "client-only" qui n'existe plus pour les nouveaux comptes).
  const res = await fetch("/api/create-checkout-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      priceId,
      email,
      successUrl: window.location.origin + "/?subscribed=1",
      cancelUrl:  window.location.origin + "/?canceled=1",
    }),
  });

  if (!res.ok) {
    let msg = `Erreur ${res.status}`;
    try { const j = await res.json(); msg = j.error || msg; } catch(e) {}
    throw new Error(msg);
  }

  const { url } = await res.json();
  if (!url) throw new Error("URL Checkout manquante");

  // Redirection vers la page Stripe Checkout hébergée
  window.location.href = url;
}

/* ═══════════════════════════════════════════════════════════════
   RESET PASSWORD SCREEN — v8.52
   Écran affiché quand l'user arrive sur /reset-password depuis
   un lien email Supabase (avec #access_token=xxx&type=recovery
   dans le hash de l'URL).

   v8.52 — Refonte visuelle avec styles inline (cohérent avec
   TrialExpiredPage) : dark, doré, logo IO Car, cadre centré.
═══════════════════════════════════════════════════════════════ */
function ResetPasswordScreen({ accessToken, onSuccess }) {
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [success, setSuccess] = React.useState("");

  const submit = async () => {
    setError(""); setSuccess("");
    if (password.length < 6) {
      setError("Le mot de passe doit faire au moins 6 caractères.");
      return;
    }
    if (password !== confirm) {
      setError("Les mots de passe ne correspondent pas.");
      return;
    }
    setLoading(true);
    try {
      const res = await sb.updatePassword(accessToken, password);
      if (res.error) {
        const code = res.error.error_code || res.error.code;
        let msg = res.error.message || "Erreur lors de la mise à jour";
        if (code === "same_password" || /same as/i.test(msg)) {
          msg = "Le nouveau mot de passe doit être différent de l'ancien.";
        } else if (/expired|invalid/i.test(msg)) {
          msg = "Ce lien de réinitialisation a expiré ou est invalide. Demandez-en un nouveau.";
        }
        setError(msg);
        setLoading(false);
        return;
      }
      setSuccess("✅ Mot de passe modifié ! Redirection…");
      setTimeout(() => {
        window.location.hash = "";
        window.location.href = "/";
      }, 1500);
    } catch(e) {
      setError("Erreur réseau. Réessayez.");
    }
    setLoading(false);
  };

  const inputStyle = {
    width: "100%",
    padding: "12px 14px",
    background: "rgba(255,255,255,0.03)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 8,
    color: "#e8e8e8",
    fontSize: 14,
    boxSizing: "border-box",
    outline: "none",
    fontFamily: "inherit",
  };

  const labelStyle = {
    display: "block",
    fontSize: 11,
    color: "#8a8d95",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 1,
    fontWeight: 600,
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0b0c10",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 20,
      fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
    }}>
      <div style={{
        maxWidth: 460,
        width: "100%",
        background: "#141519",
        border: "1px solid rgba(212,168,67,0.15)",
        borderRadius: 14,
        padding: 36,
        boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
      }}>
        {/* Logo IO Car */}
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
            <div style={{
              width: 48,
              height: 48,
              background: "#d4a843",
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 20,
              fontWeight: 800,
              color: "#0b0c10",
              fontFamily: "'Syne',sans-serif",
            }}>IO</div>
            <div style={{
              fontFamily: "'Syne',sans-serif",
              fontSize: 22,
              fontWeight: 800,
              color: "#d4a843",
              letterSpacing: "-0.02em",
            }}>IO Car</div>
          </div>
          <p style={{ margin: "12px 0 0 0", fontSize: 10, color: "#7a7d85", letterSpacing: 2, textTransform: "uppercase" }}>
            By Owl's Industry
          </p>
        </div>

        {/* Séparateur gradient */}
        <div style={{
          height: 1,
          background: "linear-gradient(90deg,transparent,rgba(212,168,67,0.3),transparent)",
          marginBottom: 28,
        }} />

        <h1 style={{
          margin: "0 0 8px 0",
          fontFamily: "'Syne',sans-serif",
          fontSize: 22,
          fontWeight: 700,
          color: "#ffffff",
          letterSpacing: "-0.01em",
        }}>
          🔐 Nouveau mot de passe
        </h1>
        <p style={{ margin: "0 0 24px 0", fontSize: 13, color: "#8a8d95", lineHeight: 1.5 }}>
          Choisissez votre nouveau mot de passe pour votre compte IO Car.
        </p>

        {error && (
          <div style={{
            padding: "12px 14px",
            marginBottom: 16,
            background: "rgba(229,73,73,0.1)",
            border: "1px solid rgba(229,73,73,0.3)",
            borderRadius: 8,
            color: "#e5493c",
            fontSize: 13,
            lineHeight: 1.5,
          }}>⚠️ {error}</div>
        )}
        {success && (
          <div style={{
            padding: "12px 14px",
            marginBottom: 16,
            background: "rgba(62,207,122,0.1)",
            border: "1px solid rgba(62,207,122,0.3)",
            borderRadius: 8,
            color: "#3ecf7a",
            fontSize: 13,
            lineHeight: 1.5,
            textAlign: "center",
          }}>{success}</div>
        )}

        {!success && (
          <>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Nouveau mot de passe</label>
              <input
                type="password"
                autoFocus
                placeholder="Minimum 6 caractères"
                value={password}
                onChange={e => setPassword(e.target.value)}
                style={inputStyle}
              />
            </div>

            <div style={{ marginBottom: 24 }}>
              <label style={labelStyle}>Confirmez</label>
              <input
                type="password"
                placeholder="Retapez le même mot de passe"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") submit(); }}
                style={inputStyle}
              />
            </div>

            <button
              onClick={submit}
              disabled={loading}
              style={{
                width: "100%",
                padding: "13px 20px",
                background: "#d4a843",
                color: "#0b0c10",
                border: 0,
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 700,
                cursor: loading ? "default" : "pointer",
                opacity: loading ? 0.6 : 1,
                fontFamily: "'Syne',sans-serif",
                letterSpacing: "0.02em",
                transition: "opacity 0.15s",
              }}
            >
              {loading ? "⏳ Mise à jour…" : "Mettre à jour mon mot de passe"}
            </button>

            <div style={{ textAlign: "center", marginTop: 20 }}>
              <a
                onClick={() => { window.location.hash = ""; window.location.href = "/"; }}
                style={{
                  color: "#8a8d95",
                  fontSize: 12,
                  textDecoration: "none",
                  cursor: "pointer",
                }}
                onMouseOver={e => e.target.style.color = "#d4a843"}
                onMouseOut={e => e.target.style.color = "#8a8d95"}
              >
                ← Retour à la connexion
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function LoginScreen({ onLogin }) {
  const [mode, setMode]           = useState("login"); // login | register | reset | plan
  const [plan, setPlan]           = useState("monthly");
  const [email, setEmail]         = useState("");
  const [password, setPassword]   = useState("");
  const [garageName, setGarageName] = useState("");
  const [error, setError]         = useState("");
  const [success, setSuccess]     = useState("");
  const [loading, setLoading]     = useState(false);

  // Détection retour Stripe
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("subscribed") === "1") {
      setSuccess("🎉 Abonnement activé ! Connectez-vous pour accéder à IO Car.");
      setMode("login");
      window.history.replaceState({}, "", window.location.pathname);
    }
    if (params.get("canceled") === "1") {
      setError("Paiement annulé. Vous pouvez réessayer.");
      setMode("register");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const handle = async () => {
    setError(""); setSuccess(""); setLoading(true);
    try {
      if (mode === "reset") {
        // v8.50 — Propage les erreurs (rate limit, email inexistant, etc.)
        const res = await sb.resetPassword(email);
        if (res && res.error) {
          const code = res.error.error_code || res.error.code;
          let msg = res.error.message || "Erreur lors de l'envoi";
          if (code === "over_email_send_rate_limit" || res.error.code === 429) {
            msg = "⏳ Trop de demandes récentes. Attendez environ 1 heure avant de réessayer.";
          } else if (code === "user_not_found" || /not found/i.test(msg)) {
            // Sécurité : on n'indique pas si l'email existe ou non pour éviter l'énumération
            setSuccess("Si un compte existe avec cet email, un lien de réinitialisation vient d'être envoyé.");
            setLoading(false);
            return;
          }
          setError(msg);
          setLoading(false);
          return;
        }
        setSuccess("📧 Email de réinitialisation envoyé ! Vérifiez votre boîte mail (et le dossier spam).");
        setLoading(false); return;
      }
      if (mode === "register") {
        if (!garageName.trim()) { setError("Nom de la concession requis"); setLoading(false); return; }
        if (!email.trim() || !password.trim()) { setError("Email et mot de passe requis"); setLoading(false); return; }
        // 1. Créer le compte Supabase
        const res = await sb.signUp(email, password, garageName);
        if (res.error) {
          // v8.49.17.1 — Messages d'erreur explicites selon le cas
          const code = res.error.error_code || res.error.code;
          let msg = res.error.message || "Erreur inscription";
          if (code === "over_email_send_rate_limit" || res.error.code === 429) {
            msg = "⏳ Trop d'essais de création de compte. Attendez environ 1 heure avant de réessayer, ou utilisez un email différent.";
          } else if (code === "user_already_exists" || /already registered|already exists/i.test(msg)) {
            msg = "Un compte existe déjà avec cet email. Cliquez sur \"Se connecter\" ou \"Mot de passe oublié ?\".";
          } else if (code === "weak_password" || /password/i.test(msg)) {
            msg = "Mot de passe trop faible (minimum 6 caractères).";
          } else if (code === "invalid_email" || /email/i.test(msg)) {
            msg = "Adresse email invalide.";
          }
          setError(msg);
          setLoading(false);
          return;
        }
        // v8.49.16 — On ne redirige PLUS vers Stripe à l'inscription.
        // L'utilisateur bénéficie de 7 jours d'essai gratuit illimité, puis
        // se voit proposer un paywall (TrialExpiredPage) à l'expiration.
        // Auto-login pour aller direct dans l'app.
        try {
          const login = await sb.signIn(email, password);
          if (login?.access_token) {
            saveSession(login.access_token, login.user, login.refresh_token);
            onLogin(login.access_token, login.user);
            setLoading(false);
            return;
          }
          // v8.49.17.1 — Si le login auto échoue, on identifie précisément la cause.
          if (login?.error) {
            const code = login.error.error_code || login.error.code;
            if (code === "email_not_confirmed" || /confirm/i.test(login.error.message || "")) {
              setSuccess("📧 Compte créé ! Un email de confirmation a été envoyé à " + email + ". Cliquez sur le lien puis revenez vous connecter.");
            } else {
              setError("Compte créé mais connexion auto impossible : " + (login.error.message || "réessayez manuellement"));
            }
          } else {
            setSuccess("📧 Compte créé ! Vérifiez votre email pour confirmer votre inscription.");
          }
          setMode("login");
        } catch(e) {
          setError("Compte créé mais erreur réseau lors de la connexion auto. Reconnectez-vous manuellement.");
          setMode("login");
        }
        setLoading(false); return;
      }
      // Login
      const res = await sb.signIn(email, password);
      if (res.error) {
        // v8.49.17.1 — Messages d'erreur login explicites
        const code = res.error.error_code || res.error.code;
        let msg = "Email ou mot de passe incorrect";
        if (code === "email_not_confirmed" || /confirm/i.test(res.error.message || "")) {
          msg = "📧 Email pas encore confirmé. Vérifiez votre boîte mail (et spam) et cliquez sur le lien de confirmation.";
        } else if (code === "over_request_rate_limit" || res.error.code === 429) {
          msg = "⏳ Trop d'essais de connexion. Attendez quelques minutes avant de réessayer.";
        }
        setError(msg);
        setLoading(false);
        return;
      }
      saveSession(res.access_token, res.user, res.refresh_token); // v8.49 — refresh_token stocké
      onLogin(res.access_token, res.user);
    } catch(e) {
      setError("Erreur réseau — vérifiez votre connexion");
    }
    setLoading(false);
  };

  return (
    <>
      <style>{STYLE}</style>
      <div className="auth-wrap">
        <div className="auth-box">
          {/* Logo — cliquable, retour au site vitrine */}
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <a
              href="https://www.iocar.online"
              title="Retour au site IO Car"
              style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 10, cursor: "pointer" }}
            >
              <div style={{ width: 44, height: 44, borderRadius: 10, background: "var(--gold)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Syne", fontWeight: 800, fontSize: 16, color: "#0b0c10" }}>IO</div>
              <div>
                <div style={{ fontFamily: "Syne", fontWeight: 800, fontSize: 20, letterSpacing: 2, color: "var(--text)" }}>IO <span style={{ color: "var(--gold)" }}>Car</span></div>
                <div style={{ fontSize: 9, letterSpacing: 2, color: "var(--muted)", textTransform: "uppercase" }}>by OWL'S INDUSTRY</div>
              </div>
            </a>
          </div>

          <div style={{ fontFamily: "Syne", fontSize: 20, fontWeight: 700, textAlign: "center", marginBottom: 6 }}>
            {mode === "login" ? "Connexion" : mode === "register" ? "Créer mon accès" : "Mot de passe oublié"}
          </div>
          <div style={{ fontSize: 13, color: "var(--muted)", textAlign: "center", marginBottom: 24 }}>
            {mode === "login" ? "Accédez à votre concession" : mode === "register" ? "7 jours d'essai gratuit, sans carte bancaire" : "Réinitialiser votre mot de passe"}
          </div>

          {error && <div className="auth-error">⚠️ {error}</div>}
          {success && <div className="auth-success">✅ {success}</div>}

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {mode === "register" && (
              <>
                {/* v8.49.16 — Aperçu des tarifs après essai (non-cliquable, informatif) */}
                <div style={{
                  padding: "10px 12px",
                  background: "rgba(212,168,67,0.06)",
                  border: "1px solid rgba(212,168,67,0.2)",
                  borderRadius: 10,
                  marginBottom: 4,
                }}>
                  <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
                    Aperçu des tarifs après vos 7 jours d'essai
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    {Object.entries(STRIPE_PLANS).map(([key, p]) => (
                      <div key={key} style={{
                        padding: "10px 8px", borderRadius: 8, textAlign: "center",
                        border: "1px solid var(--border2)",
                        background: "var(--card2)",
                        position: "relative", opacity: 0.85,
                      }}>
                        {p.badge && (
                          <div style={{ position: "absolute", top: -8, left: "50%", transform: "translateX(-50%)", background: "var(--green)", color: "#fff", fontSize: 9, fontWeight: 700, padding: "2px 8px", borderRadius: 10, whiteSpace: "nowrap" }}>
                            {p.badge}
                          </div>
                        )}
                        <div style={{ fontFamily: "Syne", fontWeight: 700, fontSize: 12, color: "var(--muted2)" }}>{p.label}</div>
                        <div style={{ fontFamily: "Syne", fontWeight: 800, fontSize: 16, marginTop: 2 }}>{p.price}</div>
                        <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 1 }}>{p.period}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--muted)", textAlign: "center", marginTop: 8, fontStyle: "italic" }}>
                    Aucun prélèvement pendant votre essai · IO BILL inclus
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Nom de la concession</label>
                  <input className="form-input" placeholder="ex: Garage Dupont" value={garageName} onChange={e => setGarageName(e.target.value)} />
                </div>
              </>
            )}
            <div className="form-group">
              <label className="form-label">Email</label>
              <input className="form-input" type="email" placeholder="contact@mongarage.fr" value={email} onChange={e => setEmail(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handle()} />
            </div>
            {mode !== "reset" && (
              <div className="form-group">
                <label className="form-label">Mot de passe</label>
                <input className="form-input" type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handle()} />
              </div>
            )}
            <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", padding: "12px", marginTop: 4 }}
              onClick={handle} disabled={loading}>
              {loading ? (mode === "login" ? "⏳ Chargement en cours..." : "⏳ Création du compte...") : mode === "login" ? "🔓 Se connecter" : mode === "register" ? "🎁 Démarrer mon essai gratuit (7 jours)" : "📧 Envoyer le lien"}
            </button>
            {mode === "register" && (
              <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", lineHeight: 1.6 }}>
                Sans carte bancaire · Aucun engagement<br />
                En créant votre compte vous acceptez nos <a href="https://iocar.online/cgu" target="_blank" rel="noreferrer" style={{ color: "var(--gold)" }}>CGU</a>
              </div>
            )}
          </div>

          {mode === "login" && (
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <span style={{ fontSize: 12, color: "var(--muted)", cursor: "pointer" }} onClick={() => { setMode("reset"); setError(""); setSuccess(""); }}>
                Mot de passe oublié ?
              </span>
            </div>
          )}

          <div className="auth-switch">
            {mode === "login" ? <>Pas encore abonné ? <a onClick={() => { setMode("register"); setError(""); setSuccess(""); }}>S'abonner</a></> :
             mode === "register" ? <>Déjà abonné ? <a onClick={() => { setMode("login"); setError(""); setSuccess(""); }}>Se connecter</a></> :
             <a onClick={() => { setMode("login"); setError(""); setSuccess(""); }}>← Retour à la connexion</a>}
          </div>

          {/* v8.49.16 — Ancien "mode démo (limité)" supprimé :
              remplacé par l'essai gratuit 7 jours qui donne un accès complet. */}
        </div>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════
   ÉCRAN ACCÈS SUSPENDU
═══════════════════════════════════════════════════════════════ */
function SuspendedScreen({ garage, onLogout }) {
  const [loadingPortal, setLoadingPortal] = useState(false);

  // Détermine la cause de la suspension pour adapter le message
  const isPastDue = garage?.sub_status === "past_due" || garage?.payment_failed_at;
  const isArchived = garage?._archived === true;
  const hasStripeCustomer = !!garage?.stripe_customer_id;

  const openPortal = async () => {
    const { token } = loadSession();
    if (!token) { alert("Session expirée, veuillez vous reconnecter."); return; }
    setLoadingPortal(true);
    try {
      const res = await fetch("/api/customer-portal", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "Erreur lors de l'ouverture du portail");
      }
      const { url } = await res.json();
      if (url) window.location.href = url;
    } catch (e) {
      alert(e.message);
    }
    setLoadingPortal(false);
  };

  // Si archivé : on cache l'option Stripe (on demande de contacter)
  const showStripeButton = !isArchived && hasStripeCustomer;

  // Titre + message adaptés
  let title = "Abonnement suspendu";
  let message = (
    <>L'accès de <strong style={{ color: "var(--text)" }}>{garage?.name || "votre concession"}</strong> a été suspendu.</>
  );
  let icon = "🔒";

  if (isArchived) {
    title = "Compte archivé";
    icon = "📦";
    message = (
      <>
        Le compte <strong style={{ color: "var(--text)" }}>{garage?.name || "de cette concession"}</strong> a été archivé.<br />
        Vos données sont conservées conformément aux obligations légales (Livre de Police 5 ans, factures 10 ans).<br />
        Pour réactiver votre compte, contactez-nous.
      </>
    );
  } else if (isPastDue) {
    title = "Échec de paiement";
    icon = "💳";
    message = (
      <>
        Le dernier paiement de l'abonnement de <strong style={{ color: "var(--text)" }}>{garage?.name || "votre concession"}</strong> a échoué.<br />
        Mettez à jour votre carte bancaire pour réactiver votre accès immédiatement.
      </>
    );
  }

  return (
    <>
      <style>{STYLE}</style>
      <div className="auth-wrap">
        <div className="auth-box" style={{ textAlign: "center", maxWidth: 480 }}>
          <div style={{ fontSize: 64, marginBottom: 20 }}>{icon}</div>
          <div style={{ fontFamily: "Syne", fontSize: 22, fontWeight: 700, marginBottom: 12 }}>{title}</div>
          <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.7, marginBottom: 28 }}>
            {message}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
            {showStripeButton && (
              <button
                className="btn btn-primary"
                onClick={openPortal}
                disabled={loadingPortal}
                style={{ minWidth: 240 }}
              >
                {loadingPortal ? "..." : isPastDue ? "💳 Mettre à jour ma carte" : "✅ Réactiver mon abonnement"}
              </button>
            )}

            <a
              href="mailto:contact@iocar.online"
              className="btn btn-ghost"
              style={{ display: "inline-flex", justifyContent: "center", minWidth: 240 }}
            >
              📧 Nous contacter
            </a>

            <button className="btn btn-ghost btn-sm" onClick={onLogout} style={{ marginTop: 8 }}>
              Se déconnecter
            </button>
          </div>

          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 24, lineHeight: 1.6 }}>
            Si vous souhaitez récupérer vos données (factures, livre de police…),<br />
            contactez-nous, nous pourrons rouvrir votre accès temporairement.
          </div>
        </div>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════
   ADMIN PAGE — Dashboard garages IO Car
═══════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════
   ADMIN TICKET CHAT PANEL — v8.49.15
   Panneau chat threadé côté admin IOCAR.
═══════════════════════════════════════════════════════════════ */
function AdminTicketChatPanel({ ticket, adminCall, onStatusAutoUpdate, onDelete, garageEmail, typeInfoLabel }) {
  const [messages, setMessages] = useState([]);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const scrollRef = React.useRef(null);
  const readOnly = ticket.status === "resolved" || ticket.status === "closed";

  const loadThread = React.useCallback(async () => {
    setLoading(true);
    try {
      const { messages: msgs } = await adminCall("tickets_thread", { ticketId: ticket.id });
      setMessages(msgs || []);
    } catch (e) {
      console.warn("[AdminTicketChatPanel] load", e.message);
    }
    setLoading(false);
  }, [ticket.id, adminCall]);

  React.useEffect(() => { loadThread(); }, [loadThread]);

  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length]);

  // Realtime
  React.useEffect(() => {
    let channel = null;
    let cancelled = false;
    (async () => {
      try {
        const mod = await import("@supabase/supabase-js");
        const { createClient } = mod;
        const supaUrl = window.__SUPABASE_URL || import.meta.env?.VITE_SUPABASE_URL;
        const supaAnon = window.__SUPABASE_ANON_KEY || import.meta.env?.VITE_SUPABASE_ANON_KEY;
        if (!supaUrl || !supaAnon) return;
        const client = createClient(supaUrl, supaAnon);
        channel = client
          .channel(`admin_ticket_${ticket.id}`)
          .on("postgres_changes", {
            event: "INSERT",
            schema: "public",
            table: "ticket_messages",
            filter: `ticket_id=eq.${ticket.id}`
          }, (payload) => {
            if (cancelled) return;
            setMessages(prev => {
              if (prev.some(m => m.id === payload.new.id)) return prev;
              return [...prev, payload.new];
            });
          })
          .subscribe();
      } catch (e) {
        console.warn("[AdminTicketChatPanel] Realtime indisponible:", e.message);
      }
    })();
    return () => {
      cancelled = true;
      if (channel && channel.unsubscribe) channel.unsubscribe();
    };
  }, [ticket.id]);

  async function send() {
    if (!reply.trim() || sending) return;
    setSending(true);
    try {
      const { message } = await adminCall("tickets_reply", {
        ticketId: ticket.id,
        message: reply.trim()
      });
      if (message) {
        setMessages(prev => {
          if (prev.some(m => m.id === message.id)) return prev;
          return [...prev, message];
        });
      }
      if (ticket.status === "new" && onStatusAutoUpdate) {
        onStatusAutoUpdate("in_progress");
      }
      setReply("");
    } catch (e) {
      alert(e.message || "Échec envoi");
    }
    setSending(false);
  }

  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--muted)", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>
        💬 Conversation avec l'abonné
      </div>
      <div ref={scrollRef} style={{
        maxHeight: 380, overflowY: "auto", marginBottom: 10, padding: 10,
        background: "var(--card2)", borderRadius: 8,
        border: "1px solid var(--border2)"
      }}>
        {loading && <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", padding: 10 }}>Chargement…</div>}
        {!loading && messages.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--muted)", textAlign: "center", padding: 10 }}>
            Aucune réponse encore. Envoyez le premier message à l'abonné.
          </div>
        )}
        {messages.map(m => {
          const isAdmin = m.author_type === "admin";
          return (
            <div key={m.id} style={{ marginBottom: 10, display: "flex", flexDirection: "column", alignItems: isAdmin ? "flex-end" : "flex-start" }}>
              <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 3 }}>
                {isAdmin ? "🛠 Vous" : `👤 ${m.author_name || "Abonné"}`} · {new Date(m.created_at).toLocaleString("fr-FR")}
              </div>
              <div style={{
                background: isAdmin ? "var(--gold)" : "var(--card)",
                color: isAdmin ? "#0a0a0a" : "var(--text)",
                padding: "8px 12px",
                borderRadius: 8,
                fontSize: 12,
                whiteSpace: "pre-wrap",
                maxWidth: "80%",
                border: !isAdmin ? "1px solid var(--border2)" : "none"
              }}>
                {m.message}
              </div>
            </div>
          );
        })}
      </div>

      {readOnly ? (
        <div style={{ fontSize: 11, color: "var(--muted)", textAlign: "center", padding: 8, marginBottom: 10 }}>
          🔒 Ce ticket est {ticket.status === "resolved" ? "résolu" : "fermé"} — repassez-le en "En cours" pour reprendre la conversation.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 10 }}>
          <textarea
            className="form-input"
            rows={2}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Votre réponse à l'abonné…"
            style={{ fontSize: 12, flex: 1, resize: "none" }}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
                e.preventDefault(); send();
              }
            }}
          />
          <button className="btn btn-primary btn-sm" onClick={send} disabled={sending || !reply.trim()}>
            {sending ? "…" : "📤 Envoyer"}
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
        <a
          href={`mailto:${garageEmail}?subject=${encodeURIComponent(`[IO Car] Re: ${typeInfoLabel}`)}&body=${encodeURIComponent(`Bonjour,\n\nSuite à votre ticket :\n\n> ${ticket.message.split('\n').join('\n> ')}\n\n`)}`}
          className="btn btn-ghost btn-sm"
          style={{ textDecoration: "none" }}
          title="Répondre par email (hors chat)"
        >
          📧 Email direct
        </a>
        <button
          className="btn btn-danger btn-sm"
          onClick={onDelete}
          style={{ marginLeft: "auto" }}
          title="Supprimer définitivement ce ticket"
        >
          🗑 Supprimer
        </button>
      </div>
    </div>
  );
}

function AdminPage({ token }) {
  // Sous-onglet actif : "garages" (par défaut) ou "tickets"
  const [adminTab, setAdminTab] = useState("garages");
  const [garages, setGarages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState("");
  const [updating, setUpdating] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [backupInfo, setBackupInfo] = useState(null);
  const [backupLoading, setBackupLoading] = useState(false);
  const [expandedGarage, setExpandedGarage] = useState(null);
  const [garageData, setGarageData] = useState(null);

  // ─── TICKETS DE SUPPORT ─────────────────────────────────────
  const [tickets, setTickets] = useState([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [ticketStatusFilter, setTicketStatusFilter] = useState("all");
  const [ticketsCountNew, setTicketsCountNew] = useState(0);
  const [expandedTicket, setExpandedTicket] = useState(null);
  const [ticketEditNotes, setTicketEditNotes] = useState({});

  // Helper : appel générique à l'endpoint admin sécurisé
  const adminCall = async (action, payload, opts = {}) => {
    const res = await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ action, payload }),
    });
    if (opts.raw) return res;
    if (!res.ok) {
      let msg = `Erreur ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch(e) {}
      throw new Error(msg);
    }
    return res.json();
  };

  useEffect(() => {
    adminCall("list")
      .then(({ garages }) => { setGarages(garages || []); setLoading(false); })
      .catch(() => setLoading(false));
    checkBackup();
    // Charge le compteur de tickets non lus en arrière-plan pour le badge
    adminCall("tickets_count_new")
      .then(({ count }) => setTicketsCountNew(count || 0))
      .catch(() => {});
  }, [token]);

  // Charge la liste des tickets quand on bascule sur l'onglet "tickets"
  // ou quand le filtre de statut change.
  useEffect(() => {
    if (adminTab !== "tickets") return;
    setTicketsLoading(true);
    const filter = ticketStatusFilter === "all" ? {} : { status: ticketStatusFilter };
    adminCall("tickets_list", filter)
      .then(({ tickets }) => { setTickets(tickets || []); setTicketsLoading(false); })
      .catch(() => { setTickets([]); setTicketsLoading(false); });
  }, [adminTab, ticketStatusFilter]);

  const updateTicket = async (ticketId, updates) => {
    try {
      const { ticket } = await adminCall("tickets_update", { ticketId, ...updates });
      // Met à jour la liste locale
      setTickets(prev => prev.map(t => t.id === ticketId ? { ...t, ...ticket } : t));
      // Met à jour le compteur de tickets non lus
      adminCall("tickets_count_new").then(({ count }) => setTicketsCountNew(count || 0)).catch(() => {});
    } catch (e) {
      alert(`Erreur : ${e.message}`);
    }
  };

  // Suppression d'un ticket (avec confirmation côté UI).
  const deleteTicket = async (ticketId) => {
    if (!window.confirm("Supprimer définitivement ce ticket ? Cette action est irréversible.")) return;
    try {
      await adminCall("tickets_delete", { ticketId });
      setTickets(prev => prev.filter(t => t.id !== ticketId));
      // Le compteur "new" peut diminuer si on a supprimé un ticket non lu
      adminCall("tickets_count_new").then(({ count }) => setTicketsCountNew(count || 0)).catch(() => {});
      // Si le ticket supprimé était expanded, on referme
      if (expandedTicket === ticketId) setExpandedTicket(null);
    } catch (e) {
      alert(`Erreur : ${e.message}`);
    }
  };

  // Purge de tous les tickets fermés — utile pour le nettoyage périodique.
  const purgeClosedTickets = async () => {
    if (!window.confirm("Supprimer définitivement TOUS les tickets fermés ? Cette action est irréversible.")) return;
    try {
      const { deleted } = await adminCall("tickets_purge_closed");
      // Recharge la liste depuis le serveur pour refléter les suppressions
      const filter = ticketStatusFilter === "all" ? {} : { status: ticketStatusFilter };
      const { tickets: refreshed } = await adminCall("tickets_list", filter);
      setTickets(refreshed || []);
      alert(`${deleted} ticket${deleted > 1 ? "s" : ""} fermé${deleted > 1 ? "s" : ""} supprimé${deleted > 1 ? "s" : ""}.`);
    } catch (e) {
      alert(`Erreur : ${e.message}`);
    }
  };

  const loadGarageData = async (garageId) => {
    if (expandedGarage === garageId) { setExpandedGarage(null); setGarageData(null); return; }
    setExpandedGarage(garageId);
    try {
      const { data } = await adminCall("garage_data", { garageId });
      setGarageData(data);
    } catch(e) {
      setGarageData({ vehicles: [], orders: [], clients: [], livre_police: [] });
    }
  };

  const deleteEntry = async (table, id) => {
    if (!window.confirm("Supprimer cette entrée ? Irréversible.")) return;
    try {
      await adminCall("delete_entry", { table, id });
      setGarageData(prev => ({ ...prev, [table]: prev[table].filter(x => x.id !== id) }));
    } catch(e) {
      alert("Erreur : " + e.message);
    }
  };

  const checkBackup = async () => {
    try {
      const { backup } = await adminCall("backup_info");
      if (backup) setBackupInfo(backup);
    } catch(e) {}
  };

  const downloadBackup = async () => {
    setBackupLoading(true);
    try {
      const res = await adminCall("backup_download", null, { raw: true });
      if (!res.ok) throw new Error("Backup introuvable");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `iocar_backup_${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch(e) {
      alert("Erreur : " + e.message);
    }
    setBackupLoading(false);
  };

  const exportAllData = async () => {
    setExporting(true);
    try {
      const backup = await adminCall("export_all");
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `iocar_export_${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch(e) {
      alert("Erreur export : " + e.message);
    }
    setExporting(false);
  };

  const [savingBackup, setSavingBackup] = useState(false);

  const runBackup = async () => {
    setSavingBackup(true);
    try {
      const r = await adminCall("backup_save");
      await checkBackup();
      alert(`✅ Sauvegarde créée — ${r.total_garages} garages — ${r.size_kb} KB`);
    } catch(e) {
      alert("Erreur sauvegarde : " + e.message);
    }
    setSavingBackup(false);
  };

  const toggleActive = async (g) => {
    setUpdating(g.id);
    const newVal = !g.is_active;
    try {
      await adminCall("toggle_active", { garageId: g.id, value: newVal });
      setGarages(garages.map(x => x.id === g.id ? { ...x, is_active: newVal, updated_at: new Date().toISOString() } : x));
    } catch(e) {
      alert("Erreur : " + e.message);
    }
    setUpdating(null);
  };

  const archiveGarage = async (g) => {
    const raison = window.prompt(
      `Archiver le compte de "${g.name || g.email}" ?\n\n` +
      `Le client ne pourra plus se connecter, mais ses données restent en base ` +
      `(LP 5 ans, factures 10 ans). Vous pourrez réactiver le compte plus tard.\n\n` +
      `Raison de l'archivage (facultatif) :`
    );
    // null = annulation utilisateur, "" = OK sans raison → on poursuit
    if (raison === null) return;
    setUpdating(g.id);
    try {
      await adminCall("archive_garage", { garageId: g.id, raison });
      setGarages(garages.map(x => x.id === g.id ? {
        ...x,
        _archived: true,
        is_active: false,
        archive_date: new Date().toISOString(),
        archive_raison: raison || null,
        updated_at: new Date().toISOString(),
      } : x));
    } catch(e) {
      alert("Erreur : " + e.message);
    }
    setUpdating(null);
  };

  const unarchiveGarage = async (g) => {
    if (!window.confirm(
      `Désarchiver le compte de "${g.name || g.email}" ?\n\n` +
      `Le compte redeviendra visible et le client pourra se reconnecter, ` +
      `mais l'accès restera suspendu tant qu'il ne se sera pas réabonné via Stripe.`
    )) return;
    setUpdating(g.id);
    try {
      await adminCall("unarchive_garage", { garageId: g.id });
      setGarages(garages.map(x => x.id === g.id ? {
        ...x,
        _archived: false,
        archive_date: null,
        archive_raison: null,
        updated_at: new Date().toISOString(),
      } : x));
    } catch(e) {
      alert("Erreur : " + e.message);
    }
    setUpdating(null);
  };

  // Suppression définitive du garage (action irréversible).
  // Demande une confirmation forte : taper le nom du garage pour valider.
  const deleteGarage = async (g) => {
    const expectedName = g.name || g.email || "GARAGE";
    const confirmation = window.prompt(
      `⚠️ SUPPRESSION DÉFINITIVE\n\n` +
      `Vous êtes sur le point de supprimer pour TOUJOURS le compte :\n` +
      `"${expectedName}"\n\n` +
      `Cela effacera :\n` +
      `• Tous les véhicules, factures, clients, livre de police\n` +
      `• Le compte utilisateur (impossibilité de se reconnecter)\n\n` +
      `Cette action est IRRÉVERSIBLE.\n\n` +
      `Pour confirmer, tapez exactement le nom du garage :\n${expectedName}`
    );
    if (confirmation === null) return; // annulation
    if (confirmation.trim() !== expectedName) {
      alert("Confirmation incorrecte. Suppression annulée.");
      return;
    }
    setUpdating(g.id);
    try {
      await adminCall("delete_garage", { garageId: g.id });
      // On retire le garage de la liste localement
      setGarages(garages.filter(x => x.id !== g.id));
    } catch(e) {
      alert("Erreur : " + e.message);
    }
    setUpdating(null);
  };

  const setPlan = async (g, plan) => {
    setUpdating(g.id);
    try {
      await adminCall("set_plan", { garageId: g.id, plan });
      setGarages(garages.map(x => x.id === g.id ? { ...x, plan, updated_at: new Date().toISOString() } : x));
    } catch(e) {
      alert("Erreur : " + e.message);
    }
    setUpdating(null);
  };

  // Liste purement esthétique pour afficher un badge "ADMIN" à côté de votre email.
  // N'apporte AUCUN contrôle de sécurité — la vraie protection est en DB + RLS.
  const ADMIN_LIST = garages.filter(g => g.is_admin).map(g => g.email);

  const filtered = garages.filter(g =>
    !search || `${g.name} ${g.email} ${g.siret}`.toLowerCase().includes(search.toLowerCase())
  );

  // Exclure les comptes admin du MRR
  const payingGarages = garages.filter(g => !ADMIN_LIST.includes(g.email));

  // Calcul plaques supplémentaires ce mois (marge 0,10€ par plaque)
  const monthKey = new Date().toISOString().slice(0, 7);
  const totalPlaquesSupp = payingGarages.reduce((sum, g) => {
    const u = typeof g.api_usage === "string" ? (() => { try { return JSON.parse(g.api_usage); } catch(e) { return {}; } })() : (g.api_usage || {});
    const used = u[monthKey] || 0;
    return sum + Math.max(0, used - 10);
  }, 0);

  const stats = {
    total: payingGarages.length,
    actifs: payingGarages.filter(g => g.is_active).length,
    suspendus: payingGarages.filter(g => !g.is_active).length,
    annual: payingGarages.filter(g => g.plan === "annual").length,
    monthly: payingGarages.filter(g => g.plan === "monthly").length,
    trial: payingGarages.filter(g => !g.plan || g.plan === "trial").length,
  };

  // MRR = abonnements + marge plaques supplémentaires (0,10€/plaque)
  const mrrAbos = (stats.monthly * 34.99) + (stats.annual * (349.90 / 12));
  const mrrPlaques = totalPlaquesSupp * 0.10;
  const mrr = mrrAbos + mrrPlaques;

  return (
    <div className="page page-admin">
      <div className="page-header">
        <div>
          <div className="page-title">🛡 Dashboard Admin</div>
          <div className="page-sub">IO Car — Vue globale des concessions</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={exportAllData} disabled={exporting || loading}
            title="Télécharger un backup JSON de toutes les données">
            {exporting ? "⏳ Export en cours..." : "💾 Exporter toutes les données"}
          </button>
        </div>
      </div>

      {/* Onglets admin */}
      <div className="tabs" style={{ marginBottom: 20 }}>
        <div className={`tab${adminTab === "garages" ? " active" : ""}`} onClick={() => setAdminTab("garages")}>
          🏢 Concessions
        </div>
        <div className={`tab${adminTab === "tickets" ? " active" : ""}`} onClick={() => setAdminTab("tickets")} style={{ position: "relative" }}>
          🎫 Tickets
          {ticketsCountNew > 0 && (
            <span style={{
              marginLeft: 8, padding: "2px 7px", borderRadius: 10,
              background: "var(--red)", color: "#fff",
              fontSize: 10, fontWeight: 700, fontFamily: "DM Mono",
            }}>
              {ticketsCountNew}
            </span>
          )}
        </div>
      </div>

      {adminTab === "garages" && (<>

      {/* Sauvegarde manuelle */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 20, padding: "12px 16px", background: "var(--card)", border: "1px solid var(--border2)", borderRadius: 10 }}>
        <div style={{ fontSize: 28 }}>🗄️</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Sauvegarde des données</div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
            Écrase la sauvegarde précédente — à faire régulièrement
          </div>
          {backupInfo ? (
            <div style={{ fontSize: 11, color: "var(--green)", marginTop: 4 }}>
              ✅ Dernière sauvegarde : {new Date(backupInfo.updated_at || backupInfo.created_at).toLocaleString("fr-FR")}
              {backupInfo.size && ` · ${Math.round(backupInfo.size / 1024)} KB`}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: "var(--orange)", marginTop: 4 }}>
              ⚠️ Aucune sauvegarde — cliquez sur "Sauvegarder maintenant"
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-primary btn-sm" onClick={runBackup} disabled={savingBackup || loading}>
            {savingBackup ? "⏳ En cours..." : "💾 Sauvegarder"}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={downloadBackup} disabled={backupLoading || !backupInfo}>
            {backupLoading ? "⏳" : "⬇️ Télécharger"}
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px,1fr))", marginBottom: 28 }}>
        {[
          ["Abonnés", stats.total, "var(--text)"],
          ["Actifs", stats.actifs, "var(--green)"],
          ["Suspendus", stats.suspendus, "var(--red)"],
          ["MRR total", `${fmtDec(mrr)}`, "var(--gold)"],
          ["dont abos", `${fmtDec(mrrAbos)}`, "var(--blue)"],
          ["dont plaques", `${fmtDec(mrrPlaques)}`, "var(--green)"],
          ["Mensuel", stats.monthly, "var(--blue)"],
          ["Annuel", stats.annual, "var(--green)"],
          ["Essai", stats.trial, "var(--muted2)"],
        ].map(([label, val, color]) => (
          <div key={label} className="kpi">
            <div className="kpi-label">{label}</div>
            <div className="kpi-val" style={{ fontSize: 22, color }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Recherche */}
      <input className="search-input" style={{ marginBottom: 16, width: "100%", maxWidth: 400 }}
        placeholder="Rechercher par nom, email, SIRET..."
        value={search} onChange={e => setSearch(e.target.value)} />

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>Chargement...</div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Concession</th>
                <th>Email</th>
                <th>SIRET</th>
                <th>Clé RapidAPI</th>
                <th>Plaques ce mois</th>
                <th>Plaques total</th>
                <th>Plan</th>
                <th>Statut</th>
                <th>Inscrit le</th>
                <th>Dernière MAJ</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--muted)", padding: 40 }}>Aucun garage trouvé</td></tr>
              )}
              {filtered.map(g => (
                <React.Fragment key={g.id}>
                <tr>
                  <td style={{ fontWeight: 600 }}>
                    {g.name || "—"}
                    {ADMIN_LIST.includes(g.email) && (
                      <span style={{ marginLeft: 6, fontSize: 9, background: "var(--gold)", color: "#0b0c10", borderRadius: 4, padding: "1px 5px", fontWeight: 700 }}>ADMIN</span>
                    )}
                  </td>
                  <td style={{ fontSize: 12, color: "var(--muted)" }}>{g.email || "—"}</td>
                  <td style={{ fontFamily: "DM Mono", fontSize: 11 }}>{g.siret || "—"}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input
                        className="form-input"
                        style={{ padding: "3px 8px", fontSize: 10, fontFamily: "DM Mono", width: 160 }}
                        defaultValue={g.rapidapi_key || ""}
                        placeholder="Clé RapidAPI..."
                        type="password"
                        onBlur={async e => {
                          const val = e.target.value.trim();
                          if (val === (g.rapidapi_key || "")) return;
                          try {
                            await adminCall("update_rapidapi", { garageId: g.id, rapidapi_key: val });
                            setGarages(garages.map(x => x.id === g.id ? { ...x, rapidapi_key: val, updated_at: new Date().toISOString() } : x));
                          } catch(err) {
                            alert("Erreur : " + err.message);
                          }
                        }}
                      />
                      {g.rapidapi_key && <span style={{ color: "var(--green)", fontSize: 10 }}>✓</span>}
                    </div>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    {(() => {
                      const mk = new Date().toISOString().slice(0, 7);
                      const u = typeof g.api_usage === "string" ? JSON.parse(g.api_usage || "{}") : (g.api_usage || {});
                      const mois = u[mk] || 0;
                      return (
                        <span style={{ fontFamily: "DM Mono", fontWeight: 700, color: mois >= 10 ? "var(--orange)" : "var(--text)" }}>
                          {mois}
                          {mois >= 10 && <span style={{ fontSize: 9, color: "var(--orange)", marginLeft: 4 }}>+payant</span>}
                        </span>
                      );
                    })()}
                  </td>
                  <td style={{ textAlign: "center" }}>
                    {(() => {
                      const u = typeof g.api_usage === "string" ? JSON.parse(g.api_usage || "{}") : (g.api_usage || {});
                      const total = Object.values(u).reduce((s, v) => s + (parseInt(v) || 0), 0);
                      return <span style={{ fontFamily: "DM Mono", fontWeight: 700 }}>{total}</span>;
                    })()}
                  </td>
                  <td>
                    <select
                      className="form-input"
                      style={{ padding: "3px 8px", fontSize: 11, width: "auto" }}
                      value={g.plan || "trial"}
                      onChange={e => setPlan(g, e.target.value)}
                      disabled={updating === g.id || ADMIN_LIST.includes(g.email)}
                    >
                      <option value="trial">Essai</option>
                      <option value="monthly">Mensuel</option>
                      <option value="annual">Annuel</option>
                    </select>
                  </td>
                  <td>
                    {(() => {
                      // v8.49.16 — Statut d'abonnement enrichi (essai / plan / bloqué / exempt)
                      if (g._archived) {
                        return <span className="badge" style={{ background: "rgba(140,140,140,.15)", color: "#999", border: "1px solid rgba(140,140,140,.3)" }}>📦 Archivé</span>;
                      }
                      if (!g.is_active) {
                        return <span className="badge badge-red">🔒 Suspendu</span>;
                      }
                      const now = Date.now();
                      const trialEnd = g.trial_ends_at ? new Date(g.trial_ends_at).getTime() : null;
                      const daysLeft = trialEnd ? Math.ceil((trialEnd - now) / 86400000) : 0;
                      if (g.sub_status === "exempt") {
                        return <span className="badge" style={{ background: "rgba(140,140,140,.15)", color: "#bbb", border: "1px solid rgba(140,140,140,.3)" }}>✅ Exempt</span>;
                      }
                      if (g.sub_status === "trialing") {
                        if (trialEnd && trialEnd > now) {
                          const urgent = daysLeft <= 2;
                          return (
                            <span className="badge" style={{
                              background: urgent ? "rgba(232,150,61,.15)" : "rgba(212,168,67,.15)",
                              color: urgent ? "var(--orange)" : "var(--gold)",
                              border: `1px solid ${urgent ? "rgba(232,150,61,.4)" : "rgba(212,168,67,.35)"}`
                            }}>
                              🎁 Essai · {daysLeft}j restant{daysLeft > 1 ? "s" : ""}
                            </span>
                          );
                        }
                        return <span className="badge badge-red">🔒 Bloqué (essai fini)</span>;
                      }
                      if (g.sub_status === "active") {
                        if (g.plan === "annual") {
                          return <span className="badge badge-green">💳 Annuel</span>;
                        }
                        if (g.plan === "monthly") {
                          return <span className="badge badge-green">💳 Mensuel</span>;
                        }
                        return <span className="badge badge-green">💳 Actif</span>;
                      }
                      if (g.sub_status === "past_due") {
                        return <span className="badge" style={{ background: "rgba(232,150,61,.15)", color: "var(--orange)", border: "1px solid rgba(232,150,61,.4)" }}>⚠️ Retard paiement</span>;
                      }
                      if (g.sub_status === "canceled") {
                        return <span className="badge badge-red">❌ Annulé</span>;
                      }
                      // Fallback : sub_status inconnu ou null
                      return <span className="badge badge-green">✅ Actif</span>;
                    })()}
                  </td>
                  <td style={{ fontSize: 11, color: "var(--muted)" }}>
                    {g.created_at ? new Date(g.created_at).toLocaleDateString("fr-FR") : "—"}
                  </td>
                  <td>
                    {g.updated_at ? (
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text)" }}>
                          {new Date(g.updated_at).toLocaleDateString("fr-FR")}
                        </div>
                        <div style={{ fontSize: 10, color: "var(--muted)" }}>
                          {new Date(g.updated_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                        </div>
                      </div>
                    ) : <span style={{ color: "var(--muted)", fontSize: 11 }}>—</span>}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {/* Cadenas — toggle d'accès rapide. Désactivé si archivé. */}
                      {!g._archived && (
                        <button
                          className={`btn btn-sm ${g.is_active ? "btn-danger" : "btn-primary"}`}
                          onClick={() => toggleActive(g)}
                          disabled={updating === g.id}
                          style={{ fontSize: 11 }}
                          title={g.is_active ? "Suspendre l'accès (cadenas fermé)" : "Réactiver l'accès (cadenas ouvert)"}
                        >
                          {updating === g.id ? "..." : g.is_active ? "🔒 Suspendre" : "🔓 Activer"}
                        </button>
                      )}

                      {/* Archiver / Désarchiver */}
                      {!g._archived ? (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => archiveGarage(g)}
                          disabled={updating === g.id}
                          style={{ fontSize: 11, color: "#888" }}
                          title="Archiver le compte (les données restent en base, le client ne peut plus se connecter)"
                        >
                          ♻️ Archiver
                        </button>
                      ) : (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => unarchiveGarage(g)}
                          disabled={updating === g.id}
                          style={{ fontSize: 11 }}
                          title="Désarchiver le compte — le client devra se réabonner via Stripe"
                        >
                          🔄 Réactiver
                        </button>
                      )}

                      {/* Suppression définitive — uniquement sur garages archivés
                          pour éviter les drames. Action irréversible. */}
                      {g._archived && (
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => deleteGarage(g)}
                          disabled={updating === g.id}
                          style={{ fontSize: 11 }}
                          title="Supprimer définitivement le garage et toutes ses données (irréversible)"
                        >
                          🗑 Supprimer
                        </button>
                      )}

                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 11 }}
                        title={`Explorer les données de ${g.name || g.email}`}
                        onClick={() => loadGarageData(g.id)}
                      >
                        {expandedGarage === g.id ? "▲ Fermer" : "📂 Données"}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: 11 }}
                        title={`Exporter les données de ${g.name || g.email}`}
                        onClick={async () => {
                          try {
                            const { data } = await adminCall("garage_data", { garageId: g.id });
                            const payload = { exported_at: new Date().toISOString(), garage: { ...g, data } };
                            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `iocar_backup_${(g.name || g.email || g.id).replace(/\s/g,"_")}_${new Date().toISOString().slice(0,10)}.json`;
                            a.click();
                            URL.revokeObjectURL(url);
                          } catch(err) {
                            alert("Erreur export : " + err.message);
                          }
                        }}
                      >
                        💾
                      </button>
                    </div>
                  </td>
                </tr>
                {/* Données du garage — expandable */}
                {expandedGarage === g.id && garageData && (
                  <tr><td colSpan={11} style={{ padding: 0, background: "var(--card2)" }}>
                    <div style={{ padding: "16px 20px" }}>
                      {["vehicles", "orders", "clients", "livre_police"].map(table => (
                        <div key={table} style={{ marginBottom: 16 }}>
                          <div style={{ fontFamily: "Syne", fontSize: 12, fontWeight: 700, color: "var(--gold)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>
                            {table === "vehicles" ? "🚗 Véhicules" : table === "orders" ? "📄 Factures/BC" : table === "clients" ? "👥 Clients" : "📋 Livre de Police"}
                            <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 400, marginLeft: 8 }}>({garageData[table].length})</span>
                          </div>
                          {garageData[table].length === 0 ? (
                            <div style={{ fontSize: 12, color: "var(--muted)", padding: "8px 0" }}>Aucune donnée</div>
                          ) : (
                            <div style={{ maxHeight: 200, overflowY: "auto", borderRadius: 8, border: "1px solid var(--border2)" }}>
                              <table style={{ fontSize: 11 }}>
                                <thead>
                                  <tr>
                                    {table === "vehicles" && <><th>Marque</th><th>Modèle</th><th>Plaque</th><th>Statut</th><th>Action</th></>}
                                    {table === "orders" && <><th>Réf</th><th>Type</th><th>Client</th><th>TTC</th><th>Date</th><th>Action</th></>}
                                    {table === "clients" && <><th>Nom</th><th>Email</th><th>Statut</th><th>Action</th></>}
                                    {table === "livre_police" && <><th>N°</th><th>Marque</th><th>Plaque</th><th>Entrée</th><th>Sortie</th><th>Action</th></>}
                                  </tr>
                                </thead>
                                <tbody>
                                  {garageData[table].map(row => {
                                    const d = row.data || row;
                                    return (
                                      <tr key={row.id}>
                                        {table === "vehicles" && <><td>{d.marque}</td><td>{d.modele}</td><td>{d.plate}</td><td>{d.statut}</td></>}
                                        {table === "orders" && <><td>{d.ref}</td><td>{d.type}</td><td>{d.client?.name}</td><td>{fmtDec(calcOrder(d).grandTotal)}</td><td>{d.date_creation}</td></>}
                                        {table === "clients" && <><td>{d.prenom} {d.nom}</td><td>{d.email}</td><td>{d.statut}</td></>}
                                        {table === "livre_police" && <><td>{d.num_ordre}</td><td>{d.marque}</td><td>{d.immat}</td><td>{d.date_entree}</td><td>{d.date_sortie || "—"}</td></>}
                                        <td>
                                          <button className="btn btn-danger btn-xs" onClick={() => deleteEntry(table, row.id)}>🗑</button>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </td></tr>
                )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>)}

      {adminTab === "tickets" && (
        <div>
          {/* Filtres statut + bouton purge */}
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
            <div className="tabs" style={{ margin: 0, flex: 1 }}>
              {[
                { k: "all", l: "Tous" },
                { k: "new", l: "🔴 Nouveaux" },
                { k: "in_progress", l: "🟡 En cours" },
                { k: "resolved", l: "🟢 Résolus" },
                { k: "closed", l: "⚫ Fermés" },
              ].map(opt => (
                <div
                  key={opt.k}
                  className={`tab${ticketStatusFilter === opt.k ? " active" : ""}`}
                  onClick={() => setTicketStatusFilter(opt.k)}
                >
                  {opt.l}
                </div>
              ))}
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={purgeClosedTickets}
              title="Supprimer tous les tickets avec le statut 'Fermé'"
              style={{ color: "var(--red)", borderColor: "rgba(229,92,92,.3)" }}
            >
              🧹 Purger les tickets fermés
            </button>
          </div>

          {ticketsLoading ? (
            <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>⏳ Chargement…</div>
          ) : tickets.length === 0 ? (
            <div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>
              <div style={{ fontSize: 48, marginBottom: 12, opacity: .3 }}>🎫</div>
              <div style={{ fontSize: 14 }}>
                {ticketStatusFilter === "all"
                  ? "Aucun ticket pour le moment"
                  : `Aucun ticket avec le statut "${ticketStatusFilter}"`}
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {tickets.map(t => {
                const TYPES_LABELS = {
                  incident:     { label: "🔴 Incident technique", color: "var(--red)" },
                  amelioration: { label: "💡 Amélioration",        color: "var(--gold)" },
                  question:     { label: "❓ Question",            color: "var(--blue)" },
                  facturation:  { label: "💳 Facturation",         color: "var(--orange)" },
                };
                const STATUS_LABELS = {
                  new:         { label: "Nouveau",  cls: "badge-red" },
                  in_progress: { label: "En cours", cls: "badge-orange" },
                  resolved:    { label: "Résolu",   cls: "badge-green" },
                  closed:      { label: "Fermé",    cls: "badge-muted" },
                };
                const typeInfo = TYPES_LABELS[t.type] || { label: t.type, color: "var(--muted)" };
                const statusInfo = STATUS_LABELS[t.status] || { label: t.status, cls: "badge-muted" };
                const isExpanded = expandedTicket === t.id;
                const garageName = t.garages?.name || "—";
                const garageEmail = t.garages?.email || "—";
                const currentNotes = ticketEditNotes[t.id] !== undefined ? ticketEditNotes[t.id] : (t.admin_notes || "");
                return (
                  <div key={t.id} className="card" style={{
                    borderLeft: `3px solid ${typeInfo.color}`,
                    transition: "all .15s",
                  }}>
                    {/* Header — toujours visible, clickable pour expand */}
                    <div
                      onClick={() => setExpandedTicket(isExpanded ? null : t.id)}
                      style={{
                        padding: "12px 16px", cursor: "pointer",
                        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: typeInfo.color }}>{typeInfo.label}</span>
                          <span className={`badge ${statusInfo.cls}`}>{statusInfo.label}</span>
                          {!t.email_sent && (
                            <span className="badge badge-orange" title={t.email_error || "Email non envoyé"}>📧 Email KO</span>
                          )}
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{garageName}</div>
                        <div style={{ fontSize: 11, color: "var(--muted)" }}>
                          {garageEmail} · {new Date(t.created_at).toLocaleString("fr-FR")}
                        </div>
                      </div>
                      <div style={{ fontSize: 18, color: "var(--muted)" }}>{isExpanded ? "▼" : "▶"}</div>
                    </div>

                    {/* Détail — visible si expanded */}
                    {isExpanded && (
                      <div style={{ padding: "0 16px 16px 16px", borderTop: "1px solid var(--border2)" }}>
                        {/* Message du ticket */}
                        <div style={{ fontSize: 11, color: "var(--muted)", letterSpacing: 1, textTransform: "uppercase", marginTop: 12, marginBottom: 6 }}>
                          Message de l'abonné
                        </div>
                        <div style={{
                          background: "var(--card2)", borderRadius: 8, padding: "12px 14px",
                          fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap",
                          marginBottom: 16,
                        }}>
                          {t.message}
                        </div>

                        {/* Infos garage */}
                        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 16 }}>
                          SIRET : {t.garages?.siret || "—"} · Ticket ID : <span style={{ fontFamily: "DM Mono" }}>{t.id}</span>
                        </div>

                        {/* Changement de statut */}
                        <div style={{ fontSize: 11, color: "var(--muted)", letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>
                          Changer le statut
                        </div>
                        <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
                          {[
                            { k: "new",         l: "🔴 Nouveau" },
                            { k: "in_progress", l: "🟡 En cours" },
                            { k: "resolved",    l: "🟢 Résolu" },
                            { k: "closed",      l: "⚫ Fermé" },
                          ].map(s => (
                            <button
                              key={s.k}
                              className={`btn btn-xs ${t.status === s.k ? "btn-primary" : "btn-ghost"}`}
                              onClick={() => updateTicket(t.id, { status: s.k })}
                              disabled={t.status === s.k}
                            >
                              {s.l}
                            </button>
                          ))}
                        </div>

                        {/* v8.49.15 — Chat threadé admin ↔ abonné (remplace Notes) */}
                        <AdminTicketChatPanel
                          ticket={t}
                          adminCall={adminCall}
                          onStatusAutoUpdate={(s) => updateTicket(t.id, { status: s })}
                          onDelete={() => deleteTicket(t.id)}
                          garageEmail={garageEmail}
                          typeInfoLabel={typeInfo.label}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [tab, setTab]               = useState("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [token, setToken]           = useState(() => {
    const s = loadSession();
    // Ne jamais restaurer une session démo
    if (s.token === "demo") { clearSession(); return null; }
    return s.token;
  });
  const [user, setUser]             = useState(() => {
    const s = loadSession();
    if (s.token === "demo") return null;
    return s.user;
  });
  const [garage, setGarage]         = useState(null);
  const [garageReady, setGarageReady] = useState(false);
  const [appLoading, setAppLoading] = useState(true);

  const isRealDemo = token === "demo";

  // v8.49 — AUTO-REFRESH JWT ────────────────────────────────────
  // Renouvelle silencieusement l'access_token Supabase avant qu'il expire.
  // Sans ça, au bout d'1h les appels aux API Vercel (iobill-bridge, lookup-plate, etc.)
  // renvoient 401 "Non authentifié" en pleine session.
  //
  // Deux mécanismes complémentaires :
  //   1. Proactif : timer qui refresh 5 min avant l'expiration du JWT courant
  //   2. Réactif : fonction globale window.__iocarRefreshNow() exposée pour retry
  //      depuis n'importe quel composant qui reçoit un 401
  //
  // Migration silencieuse : les users connectés avant v8.49 n'ont pas de refresh_token
  // stocké — on gère gracefully (pas de refresh proactif, mais pas de crash non plus).
  const refreshTokenRef = React.useRef(loadSession().refreshToken);

  // Fonction de refresh partagée entre le timer proactif et le retry réactif.
  // Retourne { access_token, refresh_token } ou null si échec.
  const refreshTokenNow = React.useCallback(async () => {
    const rt = refreshTokenRef.current || localStorage.getItem(REFRESH_KEY);
    if (!rt) return null;
    try {
      const res = await sb.refresh(rt);
      if (res && res.access_token) {
        refreshTokenRef.current = res.refresh_token || rt;
        saveSession(res.access_token, res.user || user, res.refresh_token || rt);
        setToken(res.access_token);
        return { access_token: res.access_token, refresh_token: res.refresh_token || rt };
      }
    } catch(e) {}
    return null;
  }, [user]);

  // Expose la fonction globalement pour que les composants puissent l'appeler sur 401
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.__iocarRefreshNow = refreshTokenNow;
    }
    return () => {
      if (typeof window !== "undefined") delete window.__iocarRefreshNow;
    };
  }, [refreshTokenNow]);

  // Timer proactif : refresh 5 min avant expiration
  useEffect(() => {
    if (!token || token === "demo") return;

    let cancelled = false;
    let timer = null;

    const scheduleNextRefresh = (currentToken) => {
      const expMs = decodeJwtExp(currentToken);
      if (!expMs) return; // token invalide/vide, on n'essaie même pas
      const now = Date.now();
      // Refresh 5 min avant expiration
      const delay = expMs - now - 5 * 60 * 1000;
      if (delay <= 0) {
        // Déjà expiré ou proche : refresh IMMÉDIAT (pas de setTimeout minimum)
        // Ça évite qu'un appel API parte avec un token expiré au boot.
        (async () => {
          if (cancelled) return;
          const res = await refreshTokenNow();
          if (cancelled) return;
          if (res && res.access_token) {
            scheduleNextRefresh(res.access_token);
          } else {
            timer = setTimeout(async () => {
              if (cancelled) return;
              await refreshTokenNow();
            }, 60_000);
          }
        })();
        return;
      }
      // Programmation normale
      timer = setTimeout(async () => {
        if (cancelled) return;
        const res = await refreshTokenNow();
        if (cancelled) return;
        if (res && res.access_token) {
          scheduleNextRefresh(res.access_token);
        } else {
          if (!cancelled) timer = setTimeout(async () => {
            if (cancelled) return;
            await refreshTokenNow();
          }, 60_000);
        }
      }, delay);
    };

    scheduleNextRefresh(token);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [token, refreshTokenNow]);

  // ─── DÉTECTION DU RÉSEAU ────────────────────────────────────
  // Affiche un bandeau quand l'abonné est offline.
  // Combine 2 signaux :
  //  - navigator.onLine (rapide, mais peu fiable : "true" si carte wifi active)
  //  - ping périodique vers Supabase (vraie détection : peut-on parler au serveur ?)
  // Le bandeau ne s'affiche que si BOTH signaux sont KO pour éviter les faux positifs.
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  useEffect(() => {
    // Nettoyage des brouillons expirés au démarrage de l'app (1 fois par session)
    purgeExpiredDrafts();

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Ping de vérification toutes les 30s — détecte les "faux online" (wifi sans internet)
    // On ping un endpoint Supabase léger (HEAD sur /auth) qui répond rapidement.
    // En cas d'erreur réseau (vraie coupure) → on bascule offline même si navigator.onLine = true.
    let cancelled = false;
    const pingInterval = setInterval(async () => {
      if (!navigator.onLine) {
        if (!cancelled) setIsOnline(false);
        return;
      }
      try {
        // AbortController avec timeout 5s pour ne pas bloquer si le serveur traîne
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 5000);
        await fetch(`${SUPABASE_URL}/auth/v1/health`, {
          method: "HEAD",
          signal: controller.signal,
        });
        clearTimeout(t);
        if (!cancelled) setIsOnline(true);
      } catch (e) {
        if (!cancelled) setIsOnline(false);
      }
    }, 30000);

    return () => {
      cancelled = true;
      clearInterval(pingInterval);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Le statut admin est lu depuis la colonne garages.is_admin (DB),
  // initialisé à false et réaffecté dès que le garage est chargé.
  // Aucune liste d'emails n'est plus hardcodée dans le bundle — le front n'est
  // qu'un miroir esthétique, les vraies permissions sont appliquées par les RLS Postgres.
  const [isRealAdmin, setIsRealAdmin] = useState(false);

  // viewMode DOIT être déclaré ici avant tout return conditionnel
  const [viewMode, setViewMode] = useState(token === "demo" ? "trial" : "subscriber");

  // ── Mode DÉMO : données locales via useStored ─────────────
  const [demoVehicles,    setDemoVehicles,    dvReady]   = useStored("autodeskFleet", []);
  const [demoOrders,      setDemoOrders,      doReady]   = useStored("autodeskOrders", []);
  const [demoClients,     setDemoClients,     dcReady]   = useStored("autodeskClients", []);
  const [demoLivrePolice, setDemoLivrePolice, dlpReady]  = useStored("autodeskLivrePolice", []);
  const [demoDealer,      setDemoDealer,      ddReady]   = useStored("autodeskDealer", {
    name: "AUTO PRESTIGE MOTORS", address: "12 Avenue de la République\n75011 Paris",
    phone: "01 23 45 67 89", email: "contact@autoprestige.fr", siret: "123 456 789 00010"
  });

  // ── Mode SUPABASE : données distantes ─────────────────────
  const userId = isRealDemo ? null : user?.id;
  const [garageId, setGarageId] = useState(null);

  const [vehicles,    setVehicles,    vReady]    = useSupabaseTable(token, garageId, "vehicles");
  const [orders,      setOrders,      oReady]    = useSupabaseTable(token, garageId, "orders");
  const [clients,     setClients,     cReady]    = useSupabaseTable(token, garageId, "clients");
  const [livrePolice, setLivrePolice, lpReady]   = useSupabaseTable(token, garageId, "livre_police");

  // Charger le profil garage (Supabase uniquement)
  // ⚠ ÉGALEMENT vérification au démarrage que le token JWT est encore valide.
  // Sinon on se retrouve avec un compte fantôme (token expiré + user supprimé)
  // qui s'affiche en mode "connecté" alors qu'aucune donnée ne peut être lue.
  useEffect(() => {
    if (isRealDemo) { setGarage(null); setGarageReady(true); setAppLoading(false); setIsRealAdmin(false); return; }
    if (!token || !userId) { setAppLoading(false); setGarageReady(true); setIsRealAdmin(false); return; }

    let cancelled = false;

    (async () => {
      // 1. Vérifier que le token est encore valide auprès de Supabase
      try {
        const u = await sb.getUser(token);
        // Supabase renvoie soit un user (avec id, email, etc.) soit une erreur
        // (code 401, msg "invalid JWT", "User not found", etc.)
        if (!u || !u.id || u.code || u.error || u.error_code || u.msg) {
          console.warn("[auth] Token invalide/expiré ou user supprimé — déconnexion");
          if (!cancelled) {
            clearSession();
            setToken(null); setUser(null); setGarage(null); setGarageId(null); setIsRealAdmin(false);
            setAppLoading(false); setGarageReady(true);
          }
          return;
        }
      } catch (e) {
        // Erreur réseau : on n'invalide PAS la session (pas la peine de déconnecter
        // l'utilisateur s'il a juste perdu le wifi 2 secondes), mais on remonte le souci
        console.warn("[auth] Impossible de vérifier le token (réseau) :", e?.message);
        if (!cancelled) { setAppLoading(false); setGarageReady(true); }
        return;
      }

      // 2. Charger le garage de l'utilisateur
      let g = null;
      try {
        g = await sb.getGarage(token, userId);
      } catch (e) {
        // Erreur réseau au chargement du garage : on ne fait rien d'agressif
        if (cancelled) return;
        setGarageReady(true); setAppLoading(false);
        return;
      }

      if (cancelled) return;

      // ⚠ Cas du COMPTE FANTÔME : auth.users existe mais aucun garage en DB
      // (exemple : inscription interrompue avant paiement, garage supprimé
      // manuellement, etc.). Sans cette protection, l'utilisateur tombe sur
      // un dashboard "Ma Concession" complètement vide et ne comprend pas.
      if (!g || !g.id) {
        console.warn("[auth] Token valide mais aucun garage trouvé — déconnexion");
        clearSession();
        setToken(null); setUser(null); setGarage(null); setGarageId(null); setIsRealAdmin(false);
        setAppLoading(false); setGarageReady(true);
        // On affiche un message bref à l'utilisateur
        setTimeout(() => {
          alert("Votre compte n'a pas de concession associée.\nVeuillez vous réinscrire ou contacter le support à contact@iocar.online.");
        }, 100);
        return;
      }

      // v8.49 — Refresh l'URL signée du logo au chargement.
      // garage.logo est stockée comme URL signée temporaire (~1h). Après
      // reconnexion, l'URL est expirée → <img src="URL périmée"> renvoie 401
      // → icône cassée. On regénère une URL fraîche depuis logo_path.
      if (g.logo_path) {
        try {
          const freshUrl = await getImageSignedUrl({ bucket: 'logos', path: g.logo_path });
          if (freshUrl) g.logo = freshUrl;
        } catch (e) {
          console.warn('[garage load] refresh logo URL failed:', e.message);
        }
      }

      setGarage(g);
      setGarageId(g.id);
      // Source de vérité : la colonne is_admin en DB (protégée par RLS)
      setIsRealAdmin(g.is_admin === true);
      setGarageReady(true);
      setAppLoading(false);
    })();

    return () => { cancelled = true; };
  }, [token, userId, isRealDemo]);

  const handleLogin = (tk, u) => {
    setToken(tk); setUser(u);
    if (tk !== "demo") saveSession(tk, u);
  };

  const handleLogout = async () => {
    if (token && !isRealDemo) await sb.signOut(token).catch(() => {});
    clearSession();
    setToken(null); setUser(null); setGarage(null); setGarageId(null); setIsRealAdmin(false);
  };

  // Déconnexion auto du mode Essai quand on quitte/ferme la page
  useEffect(() => {
    if (!isRealDemo) return;
    const autoLogoutDemo = () => { clearSession(); };
    window.addEventListener("beforeunload", autoLogoutDemo);
    return () => window.removeEventListener("beforeunload", autoLogoutDemo);
  }, [isRealDemo]);

  // v8.49 — Colonnes "UI-only" qui vivent dans le state React mais n'ont
  // PAS de colonne correspondante dans la table SQL garages. Sans ce filtre,
  // PostgREST rejette le PATCH avec 400 PGRST204 ("column not found") et
  // TOUTES les modifs de paramètres sont perdues silencieusement.
  const GARAGE_UI_ONLY_KEYS = [
    "logo_original",  // sauvegardé en localStorage pour "Restaurer l'original"
    "logoBlend",      // mixBlendMode CSS
    "logoInvert",     // filter CSS
    "logoBg",         // fond aperçu (checker/dark/white)
    "saved",          // flag "modifs non sauvegardées"
  ];

  const saveDealer = async (data) => {
    if (isRealDemo) { setDemoDealer({ ...demoDealer, ...data }); return; }
    const updated = { ...garage, ...data };
    setGarage(updated);
    // v8.49 — On strippe les clés UI-only avant l'envoi PostgREST
    const cleanData = { ...data };
    for (const k of GARAGE_UI_ONLY_KEYS) delete cleanData[k];
    if (!token || !garage?.id) return;
    if (Object.keys(cleanData).length === 0) return; // rien à persister
    try {
      const result = await sb.update(token, "garages", garage.id, cleanData);
      if (!result) {
        console.warn("[saveDealer] sb.update a retourné null — vérifier RLS ou schéma");
      }
    } catch (e) {
      console.error("[saveDealer] erreur:", e.message);
    }
  };

  // Quota API plaque — sauvegardé en localStorage ET dans Supabase
  const monthKey = new Date().toISOString().slice(0, 7);
  const [usage, setUsageLocal] = useState(() => {
    try { return JSON.parse(localStorage.getItem("iocar_usage") || "{}"); } catch(e) { return {}; }
  });

  // Charger api_usage depuis Supabase au login
  useEffect(() => {
    if (isRealDemo || !garage?.api_usage) return;
    try {
      const remote = typeof garage.api_usage === "string" ? JSON.parse(garage.api_usage) : garage.api_usage;
      setUsageLocal(remote);
      localStorage.setItem("iocar_usage", JSON.stringify(remote));
    } catch(e) {}
  }, [garage?.id]);

  const setUsage = (u) => {
    setUsageLocal(u);
    try { localStorage.setItem("iocar_usage", JSON.stringify(u)); } catch(e) {}
    if (!isRealDemo && garageId && token) {
      fetch(`${SUPABASE_URL}/rest/v1/garages?id=eq.${garageId}`, {
        method: "PATCH",
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ api_usage: u })
      }).catch(() => {});
    }
  };

  // Écoute l'événement "goto register" depuis les modals démo
  useEffect(() => {
    const handler = () => { handleLogout(); };
    window.addEventListener("iocar_goto_register", handler);
    return () => window.removeEventListener("iocar_goto_register", handler);
  }, []);

  // Sync viewMode si login change — DOIT être avant tout return conditionnel
  useEffect(() => {
    if (isRealDemo) setViewMode("trial");
    else if (isRealAdmin) setViewMode("admin");
    else setViewMode("subscriber");
  }, [isRealDemo, isRealAdmin]);

  // v8.45 — Polling 5s : sync miroir des clients IOCAR → IOBILL en continu.
  // Tant que l'onglet est ouvert et le pont IOBILL configuré, on pousse tous
  // les clients toutes les 5 secondes. Le hash JSON évite les appels inutiles.
  const lastSyncHashRef = useRef("");
  useEffect(() => {
    if (!token || !garage?.iobill_auto_push || !garage?.iobill_company_id) return;
    const POLLING_INTERVAL_MS = 5000;

    const tick = () => {
      // Construit un hash léger de la liste pour skipper si rien n'a changé
      const minimalSnapshot = JSON.stringify((clients || []).map(c => ({
        id: c.id, name: c.name, phone: c.phone, email: c.email,
        siren: c.siren, address: c.address
      })));
      if (minimalSnapshot === lastSyncHashRef.current) return; // No-op
      lastSyncHashRef.current = minimalSnapshot;

      fetch("/api/iobill-bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "sync_clients_batch" })
      })
        .then(r => r.json())
        .then(j => {
          if (j.ok) {
            console.log(`🔄 Sync clients : ${j.sent} envoyés, ${j.synced} synchros, ${j.removed} supprimés, ${j.unlocked} déverrouillés`);
          } else {
            console.warn("Sync batch IOBILL erreur :", j.error);
            // En cas d'erreur, on reset le hash pour réessayer au prochain tick
            lastSyncHashRef.current = "";
          }
        })
        .catch(e => {
          console.warn("Sync batch IOBILL réseau :", e.message);
          lastSyncHashRef.current = "";
        });
    };

    // Premier tick immédiat puis polling régulier
    tick();
    const interval = setInterval(tick, POLLING_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [token, garage?.iobill_auto_push, garage?.iobill_company_id, clients]);

  // ── Écrans d'auth ─────────────────────────────────────────
  // v8.50 — Détection du flow reset password
  // Supabase redirige avec un hash du type :
  //   #access_token=xxx&refresh_token=yyy&type=recovery&expires_in=3600
  // Si on détecte ce hash, on affiche ResetPasswordScreen au lieu de LoginScreen.
  const recoveryToken = React.useMemo(() => {
    if (typeof window === "undefined") return null;
    const hash = window.location.hash || "";
    if (!hash.includes("type=recovery")) return null;
    const params = new URLSearchParams(hash.substring(1));
    return params.get("access_token") || null;
  }, []);

  if (recoveryToken && (!token || !user)) {
    return <ResetPasswordScreen accessToken={recoveryToken} onSuccess={() => {
      window.location.hash = "";
      window.location.href = "/";
    }} />;
  }

  if (!token || !user) return <LoginScreen onLogin={handleLogin} />;

  // Loading
  const allReady = isRealDemo
    ? dvReady && doReady && dcReady && dlpReady && ddReady
    : !appLoading && garageReady && vReady && oReady && cReady && lpReady;

  // v8.49.17.5 — On étend le "loading" au cas où le garage est chargé
  // mais son sub_status n'est pas encore renseigné (race condition Supabase).
  // Sans ça on avait un flash paywall 200-500 ms avant que le dashboard
  // s'affiche. Ici on continue simplement d'afficher le loader spinner.
  const subStatusReady = isRealDemo || isRealAdmin ||
    (garage && garage.sub_status != null && garage.sub_status !== "");

  if (!allReady || !subStatusReady) {
    return (
      <>
        <style>{STYLE}</style>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", background: "var(--bg)" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ width: 48, height: 48, border: "3px solid var(--border)", borderTopColor: "var(--gold)", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 20px" }} />
            <div style={{ color: "var(--muted)", fontSize: 13, letterSpacing: 2 }}>CHARGEMENT...</div>
          </div>
        </div>
      </>
    );
  }

  if (!isRealDemo && !isRealAdmin && garage?.is_active === false)
    return <SuspendedScreen garage={garage} onLogout={handleLogout} />;

  // v8.49.16 — Gate paywall : bloque totalement l'accès si l'essai est expiré
  // et qu'il n'y a pas d'abonnement actif (ni exempt/past_due).
  // Les admins et le mode démo passent au travers.
  // La logique complète est dans hasValidAccess() de TrialBanner.jsx.
  //
  // v8.49.17.5 — GARDE-FOU ANTI-FLASH RENFORCÉ :
  // On ne déclenche le paywall QUE si :
  //   - le garage est complètement chargé (avec un sub_status non vide)
  //   - ET hasValidAccess renvoie false
  // Sinon on laisse passer (pas de flash). Les cas de vrai blocage
  // (canceled, expired, trialing expiré) ont TOUS un sub_status renseigné.
  const paywallReady = garage && garage.sub_status != null && garage.sub_status !== "";
  if (!isRealDemo && !isRealAdmin && paywallReady && !hasValidAccess(garage)) {
    return <TrialExpiredPage garage={garage} onSignOut={handleLogout} />;
  }

  // Sources de données — trial utilise localStorage, les autres Supabase
  const useTrial = viewMode === "trial";
  const activeVehicles    = useTrial ? demoVehicles    : vehicles;
  const activeOrders      = useTrial ? demoOrders      : orders;
  const activeClients     = useTrial ? demoClients      : clients;
  const activeLivrePolice = useTrial ? demoLivrePolice : livrePolice;
  const dealer            = useTrial ? demoDealer      : (garage || {});

  const setVehiclesRaw    = useTrial ? setDemoVehicles    : setVehicles;
  const setOrdersRaw      = useTrial ? setDemoOrders      : setOrders;
  const setClientsRaw     = useTrial ? setDemoClients     : setClients;
  const setLivrePoliceRaw = useTrial ? setDemoLivrePolice : setLivrePolice;
  const setDealerRaw      = saveDealer;

  const navItems = [
    { id: "dashboard",   icon: "📊", label: "Dashboard" },
    { id: "fleet",       icon: "🚗", label: "Flotte" },
    { id: "orders",      icon: "📄", label: "Factures" },
    { id: "crm",         icon: "👥", label: "CRM" },
    { id: "livrepolice", icon: "📋", label: "Police" },
    { id: "settings",    icon: "⚙️", label: "Paramètres" },
    ...(isRealAdmin ? [{ id: "admin", icon: "🛡", label: "Admin IO Car" }] : []),
  ];

  const bottomNavItems = [
    { id: "dashboard",   icon: "📊", label: "Dashboard" },
    { id: "fleet",       icon: "🚗", label: "Flotte" },
    { id: "orders",      icon: "📄", label: "Factures" },
    { id: "crm",         icon: "👥", label: "CRM" },
    { id: "livrepolice", icon: "📋", label: "Police" },
  ];

  const navigate = (id) => { setTab(id); setSidebarOpen(false); };

  // Badge plan
  const planLabel = garage?.is_active === false ? "⛔ Suspendu"
    : garage?.plan === "pro" ? "⭐ Pro"
    : garage?.plan === "starter" ? "✅ Starter"
    : (garage?.is_active || garage?.stripe_subscription_id) ? "✅ Abonné"
    : isRealDemo ? "🔓 Essai"
    : "🔓 Essai";
  const planCls = garage?.is_active === false ? "plan-suspended"
    : garage?.plan === "trial" ? "plan-trial" : "plan-active";

  return (
    <>
      <style>{STYLE}</style>

      {/* ─── BANDEAU OFFLINE ───────────────────────────────────
          S'affiche tant que l'abonné est hors-ligne. Permet d'éviter qu'il
          ne pense que ses actions sont enregistrées alors qu'elles échouent
          silencieusement. Position fixed en haut, au-dessus de tout. */}
      {!isOnline && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 600,
          background: "linear-gradient(90deg, #c44, #a33)",
          color: "#fff", padding: "10px 16px",
          fontSize: 13, fontWeight: 600, textAlign: "center",
          boxShadow: "0 2px 8px rgba(0,0,0,.3)",
          letterSpacing: .3,
        }}>
          🔴 Connexion perdue — vos modifications ne pourront pas être sauvegardées tant que la connexion n'est pas rétablie
        </div>
      )}

      {/* ── Hamburger mobile ── */}
      <div className="hamburger" onClick={() => setSidebarOpen(o => !o)}>
        <span style={{ transform: sidebarOpen ? "rotate(45deg) translate(5px,5px)" : "none" }} />
        <span style={{ opacity: sidebarOpen ? 0 : 1, width: sidebarOpen ? 0 : 18 }} />
        <span style={{ transform: sidebarOpen ? "rotate(-45deg) translate(5px,-5px)" : "none" }} />
      </div>

      {/* ── Bannière mode démo ou preview ── */}
      {viewMode === "trial" && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 500,
          background: isRealAdmin
            ? "linear-gradient(90deg, #3a3a3a, #555)"
            : "linear-gradient(90deg, var(--gold), #f0c86a)",
          color: isRealAdmin ? "#fff" : "#0b0c10",
          padding: "8px 20px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          fontSize: 12, fontWeight: 700, gap: 12
        }}>
          <span>{isRealAdmin ? "👁 Prévisualisation — Mode Essai" : `🚀 Mode démo — Limité à ${DEMO_LIMITS.vehicles} véhicules · ${DEMO_LIMITS.orders} documents · ${DEMO_LIMITS.clients} clients`}</span>
          {!isRealAdmin && (
            <button style={{ background: "#0b0c10", color: "var(--gold)", border: "none", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontWeight: 700, fontSize: 11 }}
              onClick={handleLogout}>S'abonner — 34,99€/mois →</button>
          )}
          {isRealAdmin && (
            <button className="btn btn-ghost btn-sm" onClick={() => setViewMode("admin")}>← Retour Admin</button>
          )}
        </div>
      )}
      {viewMode === "subscriber" && isRealAdmin && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 500,
          background: "linear-gradient(90deg, var(--blue), #7ab4f0)",
          color: "#fff", padding: "8px 20px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          fontSize: 12, fontWeight: 700, gap: 12
        }}>
          <span>👁 Prévisualisation — Mode Abonné</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setViewMode("admin")}>← Retour Admin</button>
        </div>
      )}

      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}

      {/* ══ MODE ADMIN — Interface directe sans sidebar ══ */}
      {viewMode === "admin" ? (
        <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
          {/* Header admin */}
          <div style={{
            position: "sticky", top: 0, zIndex: 100,
            background: "var(--card)", borderBottom: "1px solid var(--border2)",
            padding: "10px 24px", display: "flex", alignItems: "center", justifyContent: "space-between"
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--gold)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Syne", fontWeight: 800, fontSize: 12, color: "#0b0c10" }}>IO</div>
              <div style={{ fontFamily: "Syne", fontWeight: 800, fontSize: 15, letterSpacing: 1 }}>IO <span style={{ color: "var(--gold)" }}>Car</span> <span style={{ fontSize: 11, color: "var(--muted)", fontFamily: "DM Sans" }}>— Admin</span></div>
            </div>
            {/* Sélecteur de vue */}
            <div style={{ display: "flex", gap: 4, background: "var(--card2)", borderRadius: 8, padding: 4 }}>
              {[
                { mode: "admin",      label: "🛡 Admin",   color: "var(--gold)" },
                { mode: "subscriber", label: "✅ Abonné",  color: "var(--green)" },
                { mode: "trial",      label: "👁 Essai",   color: "var(--muted2)" },
              ].map(({ mode, label, color }) => (
                <div key={mode} onClick={() => { setViewMode(mode); setTab("dashboard"); }} style={{
                  padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 700,
                  background: viewMode === mode ? "var(--card3)" : "transparent",
                  color: viewMode === mode ? color : "var(--muted)",
                  border: viewMode === mode ? `1px solid ${color}30` : "1px solid transparent",
                  transition: "all .15s"
                }}>{label}</div>
              ))}
            </div>
            <button className="btn btn-ghost btn-sm" onClick={handleLogout}>🚪 Déconnexion</button>
          </div>
          {/* Contenu admin — dashboard OU accès aux données des garages */}
          <AdminPage token={token} />
        </div>

      ) : (
        /* ══ MODE ABONNÉ / ESSAI — Interface normale avec sidebar ══ */
        <div className="shell">
          <aside className={`sidebar${sidebarOpen ? " open" : ""}${(viewMode === "trial" || viewMode === "subscriber") ? " demo-pushed" : ""}`}>
            <a
              className="sidebar-logo"
              href="https://www.iocar.online"
              title="Retour au site IO Car"
              style={{ textDecoration: "none", display: "block", cursor: "pointer" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--gold)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Syne", fontWeight: 800, fontSize: 13, color: "#0b0c10", letterSpacing: 1, flexShrink: 0 }}>IO</div>
                <div>
                  <div style={{ fontFamily: "Syne", fontWeight: 800, fontSize: 16, letterSpacing: 2, color: "var(--text)", lineHeight: 1 }}>IO <span style={{ color: "var(--gold)" }}>Car</span></div>
                  <div style={{ fontSize: 8, letterSpacing: 2, color: "var(--muted)", textTransform: "uppercase", marginTop: 3 }}>by OWL'S INDUSTRY</div>
                </div>
              </div>
            </a>

            {/* Sélecteur vue preview (admin uniquement) */}
            {isRealAdmin && (
              <div style={{ padding: "12px 12px 0" }}>
                <div style={{ fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "var(--muted)", padding: "0 8px", marginBottom: 8 }}>Vue prévisualisation</div>
                <div style={{ display: "flex", gap: 4, background: "var(--card2)", borderRadius: 8, padding: 4 }}>
                  {[
                    { mode: "admin",      label: "🛡 Admin",   color: "var(--gold)" },
                    { mode: "subscriber", label: "✅ Abonné",  color: "var(--green)" },
                    { mode: "trial",      label: "👁 Essai",   color: "var(--muted2)" },
                  ].map(({ mode, label, color }) => (
                    <div key={mode} onClick={() => { setViewMode(mode); if (mode === "admin") setTab("dashboard"); }} style={{
                      flex: 1, textAlign: "center", padding: "5px 4px",
                      borderRadius: 6, cursor: "pointer", fontSize: 10, fontWeight: 700,
                      background: viewMode === mode ? "var(--card3)" : "transparent",
                      color: viewMode === mode ? color : "var(--muted)",
                      border: viewMode === mode ? `1px solid ${color}30` : "1px solid transparent",
                      transition: "all .15s"
                    }}>{label}</div>
                  ))}
                </div>
              </div>
            )}

            <div className="nav-section">
              <div className="nav-label">Navigation</div>
              {navItems.filter(n => n.id !== "admin").map(n => (
                <div key={n.id} className={`nav-item${tab === n.id ? " active" : ""}`} onClick={() => navigate(n.id)}>
                  <span className="nav-icon">{n.icon}</span>
                  {n.label}
                </div>
              ))}
            </div>

            <div style={{ padding: "8px 12px" }}>
              <div style={{ fontSize: 10, letterSpacing: 2, textTransform: "uppercase", color: "var(--muted)", padding: "0 8px", marginBottom: 8 }}>Stats rapides</div>
              <div style={{ background: "var(--card2)", borderRadius: 8, padding: "12px 14px" }}>
                {(() => {
                  const used = usage?.[new Date().toISOString().slice(0,7)] || 0;
                  const q = getQuotaStatus(usage);
                  return (
                    <div style={{ marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid var(--border2)" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 12, color: "var(--muted)" }}>🔍 Plaques</span>
                        {viewMode === "admin" ? (
                          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--gold)" }}>{used} <span style={{ fontSize: 10, color: "var(--muted)" }}>/ ∞</span></span>
                        ) : (
                          <span style={{ fontSize: 12, fontWeight: 700, color: q.color }}>{q.used}/{QUOTA_FREE}</span>
                        )}
                      </div>
                      {viewMode !== "admin" && !q.isFree && (
                        <div style={{ fontSize: 10, color: "var(--red)", fontWeight: 600, marginTop: 4, textAlign: "right" }}>
                          {q.montantHT.toFixed(2)} € HT à facturer
                        </div>
                      )}
                    </div>
                  );
                })()}
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>🚗 En stock</span>
                  <span style={{ fontSize: 12, fontWeight: 700 }}>{activeVehicles.filter(v => v.statut === "disponible").length}</span>
                </div>
              </div>
            </div>

            <div className="sidebar-footer">
              {dealer.logo && (
                <div style={{ marginBottom: 10, textAlign: "center" }}>
                  <img src={dealer.logo} alt="Logo" style={{ maxHeight: 56, maxWidth: "100%", objectFit: "contain", mixBlendMode: dealer.logoBlend || "normal", filter: dealer.logoInvert ? "invert(1)" : "none" }} />
                </div>
              )}
              <div className="dealer-info">
                <div style={{ fontWeight: 700, color: "var(--text)", fontSize: 12, marginBottom: 3 }}>{dealer.name || "Ma Concession"}</div>
                <div>{dealer.address?.split("\n")[0]}</div>
                <div style={{ marginTop: 4 }}><span className={`plan-badge ${planCls}`}>{planLabel}</span></div>
              </div>
              <button className="btn btn-ghost btn-sm" style={{ width: "100%", justifyContent: "center", marginTop: 10 }} onClick={handleLogout}>
                🚪 Déconnexion
              </button>
            </div>
          </aside>

          <main className={`content${(viewMode === "trial" || viewMode === "subscriber") ? " demo-offset" : ""}`}>
            {/* v8.49.16 — Bandeau essai gratuit (visible pendant 'trialing') */}
            {!isRealDemo && viewMode === "subscriber" && <TrialBanner garage={garage} />}
            {tab === "dashboard"   && <Dashboard vehicles={activeVehicles} setVehicles={setVehiclesRaw} orders={activeOrders} setTab={setTab} apiKey={dealer.rapidapi_key} usage={usage} setUsage={setUsage} livrePolice={livrePolice} dealer={dealer} setDealer={setDealerRaw} />}
            {tab === "fleet"       && <FleetPage vehicles={activeVehicles} setVehicles={setVehiclesRaw} orders={activeOrders} setOrders={setOrdersRaw} apiKey={dealer.rapidapi_key} usage={usage} setUsage={setUsage} livrePolice={activeLivrePolice} setLivrePolice={setLivrePoliceRaw} viewMode={viewMode} garageId={garageId} dealer={dealer} token={token} />}
            {tab === "orders"      && <OrdersPage orders={activeOrders} setOrders={setOrdersRaw} vehicles={activeVehicles} setVehiclesRaw={setVehiclesRaw} dealer={dealer} apiKey={dealer.rapidapi_key} usage={usage} setUsage={setUsage} clients={activeClients} setClients={setClientsRaw} viewMode={viewMode} token={token} />}
            {tab === "crm"         && <CrmPage clients={activeClients} setClients={setClientsRaw} orders={activeOrders} viewMode={viewMode} dealer={dealer} setDealer={setDealerRaw} token={token} />}
            {tab === "livrepolice" && (viewMode === "trial" ? (
              <div className="page" style={{ textAlign: "center", paddingTop: 80 }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>📋</div>
                <div style={{ fontFamily: "Syne", fontSize: 20, fontWeight: 700, marginBottom: 10 }}>Livre de Police</div>
                <div style={{ fontSize: 14, color: "var(--muted)", marginBottom: 24 }}>Disponible avec un abonnement IO Car.</div>
                <button className="btn btn-primary" onClick={handleLogout}>🚀 S'abonner — 34,99€/mois</button>
              </div>
            ) : <LivreDePolice vehicles={activeVehicles} livrePolice={activeLivrePolice} setLivrePolice={setLivrePoliceRaw} dealer={dealer} setDealer={setDealerRaw} viewMode={viewMode} />)}
            {tab === "settings"    && <SettingsPage dealer={dealer} setDealer={setDealerRaw} usage={usage} isRealAdmin={isRealAdmin} token={token} />}
          </main>
        </div>
      )}

      {/* Bottom nav mobile — uniquement en mode preview */}
      {viewMode !== "admin" && (
        <nav className="bottom-nav">
          {bottomNavItems.map(n => (
            <div key={n.id} className={`bottom-nav-item${tab === n.id ? " active" : ""}`} onClick={() => navigate(n.id)}>
              <span className="bn-icon">{n.icon}</span>
              <span>{n.label}</span>
            </div>
          ))}
        </nav>
      )}
    </>
  );
}
