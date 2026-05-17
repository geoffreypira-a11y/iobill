// IO BILL - Helper Supabase Admin (cote serveur, service_role pour bypass RLS)
// Toutes les API routes utilisent ce client pour les operations sensibles.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

function headers() {
  return {
    apikey: SERVICE_ROLE,
    Authorization: "Bearer " + SERVICE_ROLE,
    "Content-Type": "application/json",
    Prefer: "return=representation"
  };
}

export const sbAdmin = {
  url: SUPABASE_URL,

  async select(table, { filter = "", order = "", limit = null, select = "*" } = {}) {
    let q = "select=" + encodeURIComponent(select);
    if (filter) q += "&" + filter;
    if (order) q += "&order=" + order;
    if (limit) q += "&limit=" + limit;
    const r = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + q, { headers: headers() });
    return r.ok ? r.json() : [];
  },

  async selectOne(table, filter, select = "*") {
    const rows = await this.select(table, { filter, limit: 1, select });
    return rows && rows[0] ? rows[0] : null;
  },

  async insert(table, data) {
    const r = await fetch(SUPABASE_URL + "/rest/v1/" + table, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(data)
    });
    return r.ok ? r.json() : null;
  },

  async update(table, filter, data) {
    const r = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + filter, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify(data)
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error("[sbAdmin.update] FAIL", table, filter, "status=" + r.status, "body=", errText);
      return null;
    }
    return r.json();
  },

  async delete(table, filter) {
    const r = await fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + filter, {
      method: "DELETE",
      headers: headers()
    });
    return r.ok;
  },

  async rpc(fnName, params = {}) {
    const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + fnName, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(params)
    });
    return r.ok ? r.json() : null;
  },

  // Recupere l'utilisateur depuis le bearer token de l'utilisateur (frontend)
  async getUserFromToken(bearerToken) {
    const r = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: {
        apikey: process.env.VITE_SUPABASE_ANON_KEY,
        Authorization: "Bearer " + bearerToken
      }
    });
    return r.ok ? r.json() : null;
  },

  async getCompanyForUser(userId) {
    return this.selectOne("companies", "user_id=eq." + userId);
  }
};

// Helper: extrait le token Bearer du header Authorization
export function extractToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

// Helper: vérifie l'auth et renvoie {user, company}
export async function authenticate(req) {
  const token = extractToken(req);
  if (!token) return { error: "Missing token", status: 401 };
  const user = await sbAdmin.getUserFromToken(token);
  if (!user || !user.id) return { error: "Invalid token", status: 401 };
  const company = await sbAdmin.getCompanyForUser(user.id);
  if (!company) return { error: "No company", status: 403 };
  return { user, company, token };
}

// Helper: reponse JSON
export function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}
