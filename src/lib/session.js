// ═══════════════════════════════════════════════════════════════
//  IO BILL — SESSION (localStorage)
// ═══════════════════════════════════════════════════════════════
const TOKEN_KEY = "iobill_token";
const REFRESH_KEY = "iobill_refresh";
const USER_KEY = "iobill_user";
const ACTIVE_COMPANY_KEY = "iobill_active_company_id";

export function saveSession(token, refresh, user) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch (e) {
    console.warn("[IO BILL] localStorage indisponible :", e);
  }
}

export function loadSession() {
  try {
    return {
      token: localStorage.getItem(TOKEN_KEY),
      refresh: localStorage.getItem(REFRESH_KEY),
      user: JSON.parse(localStorage.getItem(USER_KEY) || "null"),
      activeCompanyId: localStorage.getItem(ACTIVE_COMPANY_KEY)
    };
  } catch {
    return { token: null, refresh: null, user: null, activeCompanyId: null };
  }
}

export function setActiveCompanyId(companyId) {
  try {
    if (companyId) localStorage.setItem(ACTIVE_COMPANY_KEY, companyId);
    else localStorage.removeItem(ACTIVE_COMPANY_KEY);
  } catch {}
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(ACTIVE_COMPANY_KEY);
  } catch {}
}
