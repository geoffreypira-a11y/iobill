// api/admin.js — Endpoints admin sécurisés + création ticket par abonné
//
// Actions ouvertes à tout authentifié :
//   create_ticket
//
// Actions réservées is_admin :
//   list, company_data, delete_doc, toggle_active,
//   archive_company, unarchive_company, delete_company,
//   export_company, backup_save, backup_info, backup_download,
//   tickets_list, tickets_count_new, tickets_update,
//   tickets_delete, tickets_purge_closed

import { sbAdmin, authenticate } from "./_lib/supabase-admin.js";

function json(res, status, body) {
  res.status(status);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(body));
}

const TICKET_TYPES = ["incident", "amelioration", "question", "facturation"];
const TICKET_STATUSES = ["new", "in_progress", "resolved", "closed"];
const DOC_TABLES = ["invoices", "credit_notes", "quotes"];

export default async function handler(req, res) {
  try {
    return await handleRequest(req, res);
  } catch (e) {
    console.error("[admin] UNCAUGHT", e?.stack || e?.message);
    return json(res, 500, { error: "Erreur serveur : " + (e?.message || "inconnue") });
  }
}

async function handleRequest(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status || 401, { error: auth.error });
  const { user, company } = auth;
  if (!company) return json(res, 403, { error: "Company introuvable" });

  const { action, payload } = req.body || {};
  if (!action) return json(res, 400, { error: "action requise" });

  // ─── ACTION OUVERTE : création ticket ─────────────────────
  if (action === "create_ticket") {
    const { type, message } = payload || {};
    if (!TICKET_TYPES.includes(type)) {
      return json(res, 400, { error: "Type de ticket invalide" });
    }
    if (!message || typeof message !== "string") {
      return json(res, 400, { error: "Message manquant" });
    }
    const clean = message.trim();
    if (clean.length === 0) return json(res, 400, { error: "Message vide" });
    if (clean.length > 5000) return json(res, 400, { error: "Message trop long (max 5000)" });
    const inserted = await sbAdmin.insert("support_tickets", {
      user_id: user.id,
      company_id: company.id,
      type,
      message: clean,
      status: "new"
    });
    if (!inserted || !inserted[0]) return json(res, 500, { error: "Échec création" });
    return json(res, 200, { ok: true, ticket: inserted[0] });
  }

  // ─── ACTION OUVERTE : liste de MES tickets (utilisateur) ───
  if (action === "my_tickets") {
    const tickets = await sbAdmin.select("support_tickets", {
      filter: `user_id=eq.${user.id}`,
      order: "created_at.desc",
      limit: 100
    });
    return json(res, 200, { tickets: tickets || [] });
  }

  // ─── À PARTIR D'ICI : ADMIN UNIQUEMENT ────────────────────
  if (company.is_admin !== true) {
    return json(res, 403, { error: "Accès refusé (admin uniquement)" });
  }

  const SUPA_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SR_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const srHeaders = () => ({
    apikey: SR_KEY,
    Authorization: `Bearer ${SR_KEY}`,
    "Content-Type": "application/json"
  });

  switch (action) {

    // ─── ABONNÉS ──────────────────────────────────────────
    case "list": {
      const companies = await sbAdmin.select("companies", {
        order: "created_at.desc",
        limit: 1000
      });
      return json(res, 200, { companies: companies || [] });
    }

    case "company_data": {
      const { companyId } = payload || {};
      if (!companyId) return json(res, 400, { error: "companyId manquant" });
      const data = {};
      for (const t of [...DOC_TABLES, "clients", "purchases", "payments"]) {
        try {
          data[t] = await sbAdmin.select(t, {
            filter: `company_id=eq.${companyId}`,
            order: "created_at.desc",
            limit: 200
          }) || [];
        } catch { data[t] = []; }
      }
      return json(res, 200, { data });
    }

    case "delete_doc": {
      const { table, id } = payload || {};
      if (!DOC_TABLES.includes(table) || !id) {
        return json(res, 400, { error: "Paramètres invalides" });
      }
      const lineType = table === "credit_notes" ? "credit_note"
                     : table === "quotes" ? "quote" : "invoice";
      try {
        await sbAdmin.delete("document_lines", `document_type=eq.${lineType}&document_id=eq.${id}`);
      } catch {}
      const ok = await sbAdmin.delete(table, `id=eq.${id}`);
      if (!ok) return json(res, 500, { error: "Échec suppression" });
      return json(res, 200, { ok: true });
    }

    case "toggle_active": {
      const { companyId, value } = payload || {};
      if (!companyId || typeof value !== "boolean") {
        return json(res, 400, { error: "Paramètres invalides" });
      }
      const updated = await sbAdmin.update("companies", `id=eq.${companyId}`, { is_active: value });
      if (!updated) return json(res, 500, { error: "Échec" });
      return json(res, 200, { ok: true });
    }

    case "archive_company": {
      const { companyId, reason } = payload || {};
      if (!companyId) return json(res, 400, { error: "companyId manquant" });
      if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
        return json(res, 400, { error: "Raison d'archivage requise" });
      }
      const updated = await sbAdmin.update("companies", `id=eq.${companyId}`, {
        _archived: true,
        is_active: false,
        archive_date: new Date().toISOString(),
        archive_reason: reason.trim().slice(0, 500)
      });
      if (!updated) return json(res, 500, { error: "Échec archivage" });
      return json(res, 200, { ok: true });
    }

    case "unarchive_company": {
      const { companyId, reactivate } = payload || {};
      if (!companyId) return json(res, 400, { error: "companyId manquant" });
      const updated = await sbAdmin.update("companies", `id=eq.${companyId}`, {
        _archived: false,
        is_active: reactivate === true,
        archive_date: null,
        archive_reason: null
      });
      if (!updated) return json(res, 500, { error: "Échec" });
      return json(res, 200, { ok: true });
    }

    case "delete_company": {
      const { companyId } = payload || {};
      if (!companyId) return json(res, 400, { error: "companyId manquant" });
      const c = await sbAdmin.selectOne("companies", `id=eq.${companyId}`);
      if (!c) return json(res, 404, { error: "Company introuvable" });
      // CASCADE manuel (FK CASCADE devrait suffire mais on est explicite)
      const cascadeTables = [
        "invoices", "credit_notes", "quotes", "clients",
        "purchases", "payments", "support_tickets", "notifications", "audit_log"
      ];
      for (const t of cascadeTables) {
        try { await sbAdmin.delete(t, `company_id=eq.${companyId}`); } catch {}
      }
      const ok = await sbAdmin.delete("companies", `id=eq.${companyId}`);
      if (!ok) return json(res, 500, { error: "Échec delete company" });
      // auth.users best-effort
      if (c.user_id) {
        try {
          await fetch(`${SUPA_URL}/auth/v1/admin/users/${c.user_id}`, {
            method: "DELETE",
            headers: { apikey: SR_KEY, Authorization: `Bearer ${SR_KEY}` }
          });
        } catch {}
      }
      return json(res, 200, { ok: true });
    }

    // ─── EXPORT / BACKUP ─────────────────────────────────
    case "export_company": {
      const { companyId } = payload || {};
      if (!companyId) return json(res, 400, { error: "companyId manquant" });
      const c = await sbAdmin.selectOne("companies", `id=eq.${companyId}`);
      if (!c) return json(res, 404, { error: "Company introuvable" });
      const data = {};
      for (const t of [...DOC_TABLES, "clients", "purchases", "payments"]) {
        try {
          data[t] = await sbAdmin.select(t, {
            filter: `company_id=eq.${companyId}`,
            order: "created_at.asc"
          }) || [];
        } catch { data[t] = []; }
      }
      return json(res, 200, {
        version: "1.0", platform: "iobill",
        exported_at: new Date().toISOString(),
        company: c, data
      });
    }

    case "backup_save": {
      const companies = await sbAdmin.select("companies", { order: "created_at.asc" });
      const backup = {
        version: "1.0", platform: "iobill",
        backup_date: new Date().toISOString(),
        total_companies: (companies || []).length,
        companies: []
      };
      for (const c of companies || []) {
        const cData = {
          id: c.id, legal_name: c.legal_name, email: c.email, siret: c.siret,
          sub_status: c.sub_status, is_active: c.is_active, _archived: c._archived,
          created_at: c.created_at, data: {}
        };
        for (const t of [...DOC_TABLES, "clients", "purchases"]) {
          try {
            cData.data[t] = await sbAdmin.select(t, {
              filter: `company_id=eq.${c.id}`,
              order: "created_at.asc"
            }) || [];
          } catch { cData.data[t] = []; }
        }
        backup.companies.push(cData);
      }
      const jsonStr = JSON.stringify(backup);
      const filename = `backup_${new Date().toISOString().slice(0, 10)}_${Date.now()}.json`;
      const upR = await fetch(`${SUPA_URL}/storage/v1/object/backups/${filename}`, {
        method: "POST",
        headers: { ...srHeaders(), "x-upsert": "true" },
        body: jsonStr
      });
      if (!upR.ok) {
        const t = await upR.text().catch(() => "");
        return json(res, 500, { error: "Backup upload failed: " + t });
      }
      await fetch(`${SUPA_URL}/storage/v1/object/backups/backup_latest.json`, {
        method: "POST",
        headers: { ...srHeaders(), "x-upsert": "true" },
        body: jsonStr
      });
      return json(res, 200, {
        ok: true, filename,
        total_companies: backup.total_companies,
        size_kb: Math.round(jsonStr.length / 1024)
      });
    }

    case "backup_info": {
      const r = await fetch(`${SUPA_URL}/storage/v1/object/list/backups`, {
        method: "POST",
        headers: srHeaders(),
        body: JSON.stringify({ prefix: "", limit: 100, sortBy: { column: "updated_at", order: "desc" } })
      });
      if (!r.ok) return json(res, 200, { backup: null });
      const files = await r.json();
      const latest = (Array.isArray(files) ? files : []).find((f) => f.name === "backup_latest.json");
      return json(res, 200, { backup: latest || null });
    }

    case "backup_download": {
      const r = await fetch(`${SUPA_URL}/storage/v1/object/backups/backup_latest.json`, {
        headers: { apikey: SR_KEY, Authorization: `Bearer ${SR_KEY}` }
      });
      if (!r.ok) return json(res, 404, { error: "Aucun backup trouvé" });
      const text = await r.text();
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition",
        `attachment; filename="iobill_backup_${new Date().toISOString().slice(0, 10)}.json"`);
      return res.status(200).send(text);
    }

    // ─── TICKETS ─────────────────────────────────────────
    case "tickets_list": {
      const { status } = payload || {};
      const filter = (status && TICKET_STATUSES.includes(status))
        ? `status=eq.${status}` : "";
      const tickets = await sbAdmin.select("support_tickets", {
        filter, order: "created_at.desc", limit: 200
      });
      const cMap = {};
      const cIds = [...new Set((tickets || []).map((t) => t.company_id))];
      if (cIds.length > 0) {
        const cs = await sbAdmin.select("companies", {
          filter: `id=in.(${cIds.join(",")})`,
          select: "id,legal_name,email,siret"
        });
        for (const c of cs || []) cMap[c.id] = c;
      }
      return json(res, 200, {
        tickets: (tickets || []).map((t) => ({ ...t, company: cMap[t.company_id] || null }))
      });
    }

    case "tickets_count_new": {
      const r = await fetch(`${SUPA_URL}/rest/v1/support_tickets?select=id&status=eq.new`, {
        headers: { apikey: SR_KEY, Authorization: `Bearer ${SR_KEY}`, Prefer: "count=exact" }
      });
      const cr = r.headers.get("content-range") || "";
      const count = parseInt((cr.split("/")[1] || "0"), 10) || 0;
      return json(res, 200, { count });
    }

    case "tickets_update": {
      const { ticketId, status, admin_notes } = payload || {};
      if (!ticketId) return json(res, 400, { error: "ticketId manquant" });
      const updates = {};
      if (status !== undefined) {
        if (!TICKET_STATUSES.includes(status)) return json(res, 400, { error: "Statut invalide" });
        updates.status = status;
      }
      if (admin_notes !== undefined) {
        if (typeof admin_notes !== "string" || admin_notes.length > 5000) {
          return json(res, 400, { error: "Notes invalides" });
        }
        updates.admin_notes = admin_notes;
      }
      if (Object.keys(updates).length === 0) {
        return json(res, 400, { error: "Aucune mise à jour" });
      }
      const updated = await sbAdmin.update("support_tickets", `id=eq.${ticketId}`, updates);
      if (!updated || !updated[0]) return json(res, 500, { error: "Échec update" });
      return json(res, 200, { ticket: updated[0] });
    }

    case "tickets_delete": {
      const { ticketId } = payload || {};
      if (!ticketId) return json(res, 400, { error: "ticketId manquant" });
      const ok = await sbAdmin.delete("support_tickets", `id=eq.${ticketId}`);
      if (!ok) return json(res, 500, { error: "Échec suppression" });
      return json(res, 200, { ok: true });
    }

    case "tickets_purge_closed": {
      const closed = await sbAdmin.select("support_tickets", {
        filter: "status=eq.closed", select: "id"
      });
      await sbAdmin.delete("support_tickets", "status=eq.closed");
      return json(res, 200, { deleted: (closed || []).length });
    }

    // ─── CABINETS (Mode Comptable) ─────────────────────────
    case "firms_list": {
      const firms = await sbAdmin.select("accounting_firms", {
        order: "created_at.desc",
        limit: 1000
      });
      // Pour chaque cabinet, compter membres et clients
      const result = [];
      for (const f of (firms || [])) {
        let memberCount = 0;
        let clientCount = 0;
        try {
          const members = await sbAdmin.select("firm_members", {
            filter: `firm_id=eq.${f.id}`,
            select: "user_id"
          });
          memberCount = (members || []).length;
        } catch {}
        try {
          const links = await sbAdmin.select("firm_client_links", {
            filter: `firm_id=eq.${f.id}&accepted_at=not.is.null&revoked_at=is.null`,
            select: "id"
          });
          clientCount = (links || []).length;
        } catch {}
        result.push({ ...f, member_count: memberCount, client_count: clientCount });
      }
      return json(res, 200, { firms: result });
    }

    case "firm_data": {
      const { firmId } = payload || {};
      if (!firmId) return json(res, 400, { error: "firmId manquant" });
      const data = {};
      try {
        data.members = await sbAdmin.select("firm_members", {
          filter: `firm_id=eq.${firmId}`,
          limit: 200
        }) || [];
      } catch { data.members = []; }
      try {
        data.client_links = await sbAdmin.select("firm_client_links", {
          filter: `firm_id=eq.${firmId}`,
          limit: 500
        }) || [];
      } catch { data.client_links = []; }
      try {
        data.signals = await sbAdmin.select("firm_signals", {
          filter: `firm_id=eq.${firmId}`,
          order: "created_at.desc",
          limit: 100
        }) || [];
      } catch { data.signals = []; }
      return json(res, 200, { data });
    }

    case "firm_toggle_suspend": {
      const { firmId, suspend } = payload || {};
      if (!firmId || typeof suspend !== "boolean") {
        return json(res, 400, { error: "Paramètres invalides" });
      }
      const updated = await sbAdmin.update("accounting_firms", `id=eq.${firmId}`, {
        status: suspend ? "suspended" : "active",
        suspended_at: suspend ? new Date().toISOString() : null
      });
      if (!updated) return json(res, 500, { error: "Échec" });
      return json(res, 200, { ok: true });
    }

    case "firm_archive": {
      const { firmId, reason } = payload || {};
      if (!firmId) return json(res, 400, { error: "firmId manquant" });
      if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
        return json(res, 400, { error: "Raison d'archivage requise" });
      }
      const updated = await sbAdmin.update("accounting_firms", `id=eq.${firmId}`, {
        status: "archived",
        archived_at: new Date().toISOString(),
        notes_admin: reason.trim().slice(0, 500)
      });
      if (!updated) return json(res, 500, { error: "Échec archivage" });
      return json(res, 200, { ok: true });
    }

    case "firm_unarchive": {
      const { firmId } = payload || {};
      if (!firmId) return json(res, 400, { error: "firmId manquant" });
      const updated = await sbAdmin.update("accounting_firms", `id=eq.${firmId}`, {
        status: "active",
        archived_at: null
      });
      if (!updated) return json(res, 500, { error: "Échec désarchivage" });
      return json(res, 200, { ok: true });
    }

    case "firm_delete": {
      const { firmId } = payload || {};
      if (!firmId) return json(res, 400, { error: "firmId manquant" });
      // CASCADE supprimera firm_members, firm_client_links, firm_signals, firm_messages
      const ok = await sbAdmin.delete("accounting_firms", `id=eq.${firmId}`);
      if (!ok) return json(res, 500, { error: "Échec suppression" });
      return json(res, 200, { ok: true });
    }

    default:
      return json(res, 400, { error: "Action inconnue : " + action });
  }
}
