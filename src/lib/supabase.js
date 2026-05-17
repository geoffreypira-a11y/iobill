// ═══════════════════════════════════════════════════════════════
//  IO BILL — CLIENT SUPABASE LÉGER (fetch natif, pas de SDK lourd)
// ═══════════════════════════════════════════════════════════════

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    "[IO BILL] Variables d'env manquantes : VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. " +
    "Crée un fichier .env.local à la racine du projet."
  );
}

const baseHeaders = () => ({
  apikey: SUPABASE_ANON_KEY,
  "Content-Type": "application/json",
  Prefer: "return=representation"
});

const authHeaders = (token) => ({
  ...baseHeaders(),
  Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`
});

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export const sb = {
  url: SUPABASE_URL,

  /* ─── AUTH ─────────────────────────────────────────────── */
  async signUp({ email, password, metadata = {} }) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST",
      headers: { ...baseHeaders(), Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ email, password, data: metadata })
    });
    return { ok: r.ok, status: r.status, data: await safeJson(r) };
  },

  async signIn({ email, password }) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ email, password })
    });
    return { ok: r.ok, status: r.status, data: await safeJson(r) };
  },

  async signOut(token) {
    if (!token) return;
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: "POST",
      headers: authHeaders(token)
    });
  },

  async getUser(token) {
    if (!token) return null;
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: authHeaders(token)
    });
    return r.ok ? r.json() : null;
  },

  async resetPassword(email) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
      method: "POST",
      headers: baseHeaders(),
      body: JSON.stringify({ email })
    });
    return { ok: r.ok, data: await safeJson(r) };
  },

  async updateUserPassword(token, newPassword) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: authHeaders(token),
      body: JSON.stringify({ password: newPassword })
    });
    return { ok: r.ok, data: await safeJson(r) };
  },

  /* ─── REST CRUD ────────────────────────────────────────── */
  async select(token, table, { filter = "", order = "created_at.desc", limit = null, select = "*" } = {}) {
    let q = `select=${encodeURIComponent(select)}`;
    if (filter) q += `&${filter}`;
    if (order) q += `&order=${order}`;
    if (limit) q += `&limit=${limit}`;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${q}`, {
      headers: authHeaders(token)
    });
    return r.ok ? r.json() : [];
  },

  async selectOne(token, table, filter, select = "*") {
    const rows = await this.select(token, table, { filter, limit: 1, select });
    return rows?.[0] || null;
  },

  async insert(token, table, data) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: { ...authHeaders(token), Prefer: "return=representation" },
      body: JSON.stringify(data)
    });
    return r.ok ? r.json() : null;
  },

  async upsert(token, table, data, onConflict = null) {
    const conflict = onConflict ? `?on_conflict=${onConflict}` : "";
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${conflict}`, {
      method: "POST",
      headers: {
        ...authHeaders(token),
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify(data)
    });
    return r.ok ? r.json() : null;
  },

  async update(token, table, filter, data) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
      method: "PATCH",
      headers: { ...authHeaders(token), Prefer: "return=representation" },
      body: JSON.stringify(data)
    });
    return r.ok ? r.json() : null;
  },

  async delete(token, table, filter) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
      method: "DELETE",
      headers: authHeaders(token)
    });
    return r.ok;
  },

  /* ─── RPC (fonctions Postgres) ─────────────────────────── */
  async rpc(token, fnName, params = {}) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(params)
    });
    return r.ok ? r.json() : null;
  },

  /* ─── STORAGE ─────────────────────────────────────────── */
  async uploadFile(token, bucket, path, file) {
    // Encoder chaque segment pour eviter les bugs avec espaces/accents
    const safePath = path.split("/").map(encodeURIComponent).join("/");
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${safePath}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
        "x-upsert": "true",
        "Content-Type": file.type || "application/octet-stream"
      },
      body: file
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error("[uploadFile] FAIL", bucket, path, "status=" + r.status, "body=", errText);
      return null;
    }
    return r.json();
  },

  async getSignedUrl(token, bucket, path, expiresIn = 300) {
    // Encoder chaque segment du path (sans toucher aux /) pour gerer les
    // noms de fichiers avec espaces, accents, etc. dans les anciens fichiers.
    const safePath = path.split("/").map(encodeURIComponent).join("/");
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${safePath}`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ expiresIn })
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.signedURL ? `${SUPABASE_URL}/storage/v1${j.signedURL}` : null;
  }
};
