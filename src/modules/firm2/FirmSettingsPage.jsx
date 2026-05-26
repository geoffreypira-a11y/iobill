import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { sb } from "../../lib/supabase.js";

/**
 * FirmSettingsPage — page "⚙ Réglages cabinet"
 *
 * Onglets (v8.35) :
 *   - cabinet  → Identité, Coordonnées, Identifiants, Logo, Notifications
 *   - tickets  → Mes tickets de support (identique à l'abonné)
 */
const VALID_TABS = ["cabinet", "tickets"];

export function FirmSettingsPage({ token, user }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = VALID_TABS.includes(searchParams.get("tab")) ? searchParams.get("tab") : "cabinet";
  const [tab, setTab] = useState(initialTab);

  // Sync onglet ↔ URL pour deep-link et back/forward
  useEffect(() => {
    if (searchParams.get("tab") !== tab) {
      const next = new URLSearchParams(searchParams);
      next.set("tab", tab);
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const [firm, setFirm] = useState(null);
  const [firmLoading, setFirmLoading] = useState(true);
  const [form, setForm] = useState({
    name: "",
    siret: "",
    email_contact: "",
    phone: "",
    address_line1: "",
    address_zip: "",
    address_city: "",
    ordre_number: "",
    opening_hours: "",
    logo_url: "",
    notif_on_message: true,
    notif_on_declaration_due: true
  });
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [error, setError] = useState("");

  // Charger le firm dont l'utilisateur est membre
  async function loadFirm() {
    if (!token || !user?.id) { setFirmLoading(false); return; }
    setFirmLoading(true);
    try {
      const memberships = await sb.select(token, "firm_members", {
        filter: `user_id=eq.${user.id}`,
        select: "firm_id,role",
        order: "",
        limit: 1
      });
      console.log("[FirmSettings] memberships:", memberships);
      if (memberships && memberships[0]) {
        const f = await sb.selectOne(
          token,
          "accounting_firms",
          `id=eq.${memberships[0].firm_id}`,
          "*"
        );
        console.log("[FirmSettings] firm:", f);
        setFirm(f);
      } else {
        setFirm(null);
      }
    } catch (e) {
      console.warn("[FirmSettings] loadFirm error:", e);
      setFirm(null);
    }
    setFirmLoading(false);
  }

  useEffect(() => { loadFirm(); }, [token, user?.id]);

  // Hydrate le formulaire à partir du firm
  useEffect(() => {
    if (firm) {
      setForm({
        name: firm.name || "",
        siret: firm.siret || "",
        email_contact: firm.email_contact || firm.email || "",
        phone: firm.phone || "",
        address_line1: firm.address_line1 || "",
        address_zip: firm.address_zip || "",
        address_city: firm.address_city || "",
        ordre_number: firm.ordre_number || "",
        opening_hours: firm.opening_hours || "",
        logo_url: firm.logo_url || "",
        notif_on_message: firm.notif_on_message !== false,
        notif_on_declaration_due: firm.notif_on_declaration_due !== false
      });
    }
  }, [firm?.id]);

  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    setSavedAt(null);
  }

  async function save() {
    if (!firm?.id) return;
    setSaving(true);
    setError("");
    try {
      const r = await sb.update(token, "accounting_firms", `id=eq.${firm.id}`, form);
      if (r && r[0]) {
        setSavedAt(new Date());
        loadFirm();
      } else {
        setError("Erreur lors de la sauvegarde");
      }
    } catch (e) {
      setError(e.message || "Erreur");
    }
    setSaving(false);
  }

  async function uploadLogo(file) {
    if (!file || !firm?.id) return;
    if (file.size > 2 * 1024 * 1024) {
      setError("Logo trop volumineux (max 2 Mo)");
      return;
    }
    setUploadingLogo(true);
    setError("");
    try {
      // On utilise le bucket firm-logos (ou firm-attachments en fallback)
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      const path = `${firm.id}/logo-${Date.now()}.${ext}`;
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/firm-logos/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": file.type || "application/octet-stream",
          "x-upsert": "true"
        },
        body: file
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error("Upload échoué : " + txt);
      }
      // URL publique (le bucket firm-logos est public)
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/firm-logos/${path}`;
      update("logo_url", publicUrl);
    } catch (e) {
      setError(e.message || "Erreur upload");
    }
    setUploadingLogo(false);
  }

  if (firmLoading) {
    return <div className="page"><div style={loaderStyle}>Chargement…</div></div>;
  }

  if (!firm) {
    return (
      <div className="page">
        <h1 className="page-title">⚙ Réglages cabinet</h1>
        <div className="card card-pad" style={{ textAlign: "center", padding: 40 }}>
          Vous n'êtes membre d'aucun cabinet. Demandez à votre administrateur de vous inviter.
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 12 }}>
        <h1 className="page-title" style={{ margin: 0 }}>⚙ Réglages cabinet</h1>
        {tab === "cabinet" && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {savedAt && (
              <span style={{ fontSize: 11, color: "var(--green)" }}>
                ✓ Enregistré {savedAt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? "Enregistrement…" : "💾 Enregistrer"}
            </button>
          </div>
        )}
      </div>

      {/* Onglets v8.35 */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border2, rgba(255,255,255,0.08))", marginBottom: 20 }}>
        <TabButton active={tab === "cabinet"} onClick={() => setTab("cabinet")}>
          ⚙ Cabinet
        </TabButton>
        <TabButton active={tab === "tickets"} onClick={() => setTab("tickets")}>
          🎫 Mes tickets
        </TabButton>
      </div>

      {tab === "tickets" && (
        <FirmTicketsTab token={token} />
      )}

      {tab === "cabinet" && (
        <>
          {error && (
            <div className="card card-pad" style={{ background: "rgba(255,68,68,0.08)", border: "1px solid rgba(255,68,68,0.3)", marginBottom: 16, fontSize: 12, color: "var(--red)" }}>
              {error}
            </div>
          )}

      {/* SECTION 1 — Identité */}
      <Section title="Identité du cabinet" icon="🏢">
        <Field label="Nom du cabinet" required>
          <input className="form-input" value={form.name} onChange={(e) => update("name", e.target.value)} />
        </Field>
        <Field label="SIRET">
          <input className="form-input" value={form.siret} onChange={(e) => update("siret", e.target.value)} placeholder="14 chiffres" maxLength={14} />
        </Field>
      </Section>

      {/* SECTION 2 — Coordonnées */}
      <Section title="Coordonnées" icon="📞">
        <Field label="Email de contact">
          <input className="form-input" type="email" value={form.email_contact} onChange={(e) => update("email_contact", e.target.value)} />
        </Field>
        <Field label="Téléphone">
          <input className="form-input" value={form.phone} onChange={(e) => update("phone", e.target.value)} />
        </Field>
        <Field label="Adresse">
          <input className="form-input" value={form.address_line1} onChange={(e) => update("address_line1", e.target.value)} placeholder="N° et rue" />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 8 }}>
          <Field label="Code postal">
            <input className="form-input" value={form.address_zip} onChange={(e) => update("address_zip", e.target.value)} maxLength={5} />
          </Field>
          <Field label="Ville">
            <input className="form-input" value={form.address_city} onChange={(e) => update("address_city", e.target.value)} />
          </Field>
        </div>
        <Field label="Horaires d'ouverture" hint="Optionnel — texte libre">
          <textarea className="form-input" rows={2} value={form.opening_hours} onChange={(e) => update("opening_hours", e.target.value)} placeholder="Lun-Ven 9h-12h / 14h-18h" />
        </Field>
      </Section>

      {/* SECTION 3 — Identifiants */}
      <Section title="Identifiants comptable" icon="🎓">
        <Field label="N° d'inscription à l'Ordre" hint="Numéro d'inscription auprès du Conseil National de l'Ordre des Experts-Comptables">
          <input className="form-input" value={form.ordre_number} onChange={(e) => update("ordre_number", e.target.value)} />
        </Field>
      </Section>

      {/* SECTION 4 — Logo */}
      <Section title="Logo du cabinet" icon="🖼️">
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          {form.logo_url ? (
            <img src={form.logo_url} alt="Logo cabinet" style={{ maxWidth: 200, maxHeight: 100, background: "#fff", padding: 8, borderRadius: 4 }} />
          ) : (
            <div style={{ width: 200, height: 100, border: "1px dashed var(--border2)", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 11 }}>
              Aucun logo
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label className="btn btn-ghost" style={{ cursor: "pointer" }}>
              {uploadingLogo ? "⏳ Upload…" : "📤 Choisir un fichier"}
              <input
                type="file"
                accept="image/png,image/jpeg,image/svg+xml,image/webp"
                style={{ display: "none" }}
                onChange={(e) => uploadLogo(e.target.files?.[0])}
                disabled={uploadingLogo}
              />
            </label>
            {form.logo_url && (
              <button className="btn btn-ghost btn-sm" onClick={() => update("logo_url", "")}>🗑 Retirer</button>
            )}
            <div style={{ fontSize: 10, color: "var(--muted)" }}>PNG, JPG, SVG, WebP · max 2 Mo</div>
          </div>
        </div>
      </Section>

      {/* SECTION 5 — Notifications */}
      <Section title="Notifications email" icon="🔔">
        <ToggleField
          label="À chaque message d'un client"
          hint="Vous recevez un email dès qu'un de vos clients vous envoie un message dans la messagerie"
          checked={form.notif_on_message}
          onChange={(v) => update("notif_on_message", v)}
        />
        <ToggleField
          label="À l'approche d'une date de déclaration TVA"
          hint="Email J-3 avant la date limite de chaque déclaration TVA de vos clients"
          checked={form.notif_on_declaration_due}
          onChange={(v) => update("notif_on_declaration_due", v)}
        />
      </Section>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 20 }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? "Enregistrement…" : "💾 Enregistrer toutes les modifications"}
        </button>
      </div>
        </>
      )}
    </div>
  );
}

// ─── Sous-composants ────────────────────────────────────────────────

function Section({ title, icon, children }) {
  return (
    <div className="card" style={{ padding: 0, marginBottom: 16, overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border2)", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 16 }}>{icon}</span> {title}
      </div>
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
        {children}
      </div>
    </div>
  );
}

function Field({ label, hint, required, children }) {
  return (
    <div>
      <label style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {label}{required && <span style={{ color: "var(--red)", marginLeft: 4 }}>*</span>}
      </label>
      {children}
      {hint && <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function ToggleField({ label, hint, checked, onChange }) {
  return (
    <label style={{ display: "flex", alignItems: "flex-start", gap: 12, cursor: "pointer", padding: "8px 0" }}>
      <div style={{ position: "relative", flexShrink: 0, marginTop: 2 }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
        />
        <div style={{
          width: 36,
          height: 20,
          background: checked ? "var(--gold)" : "rgba(255,255,255,0.15)",
          borderRadius: 10,
          position: "relative",
          transition: "background 0.2s"
        }}>
          <div style={{
            position: "absolute",
            top: 2,
            left: checked ? 18 : 2,
            width: 16,
            height: 16,
            background: "#fff",
            borderRadius: "50%",
            transition: "left 0.2s"
          }} />
        </div>
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13 }}>{label}</div>
        {hint && <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 2 }}>{hint}</div>}
      </div>
    </label>
  );
}

const loaderStyle = { padding: 40, textAlign: "center", color: "var(--muted)" };

// ═══════════════════════════════════════════════════════════════════
// TabButton — bouton d'onglet (v8.35)
// ═══════════════════════════════════════════════════════════════════
function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        border: 0,
        borderBottom: active ? "2px solid var(--gold, #d4a843)" : "2px solid transparent",
        color: active ? "var(--gold, #d4a843)" : "var(--muted)",
        padding: "10px 16px",
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        cursor: "pointer",
        marginBottom: -1,
        transition: "color 0.15s, border-color 0.15s"
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = "var(--muted)"; }}
    >
      {children}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════
// FirmTicketsTab — suivi des tickets cabinet (v8.35)
// Identique au TicketsTab de l'abonné, mais branché sur l'API admin
// /api/admin?action=my_tickets qui filtre par user_id donc marche aussi
// pour les membres cabinet.
// ═══════════════════════════════════════════════════════════════════
function FirmTicketsTab({ token }) {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);

  const TYPES = {
    incident: { label: "🔴 Incident", color: "var(--red, #e0556a)" },
    amelioration: { label: "💡 Amélioration", color: "var(--gold, #d4a843)" },
    question: { label: "❓ Question", color: "var(--muted2, #888)" },
    facturation: { label: "💳 Facturation", color: "var(--orange)" }
  };
  const STATUS_LABEL = {
    new: { label: "🔴 Nouveau", desc: "Le support n'a pas encore pris en charge" },
    in_progress: { label: "🟡 En cours", desc: "Le support travaille sur ce ticket" },
    resolved: { label: "🟢 Résolu", desc: "Solution apportée — vérifiez et fermez si OK" },
    closed: { label: "⚫ Fermé", desc: "Ticket clos" }
  };

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "my_tickets" })
      });
      const j = await r.json();
      setTickets(j.tickets || []);
    } catch {
      setTickets([]);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, [token]);

  return (
    <div className="card card-pad">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
        <div>
          <h3 style={{ margin: 0 }}>Mes tickets de support</h3>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
            Historique de vos demandes et leur statut. Pour ouvrir un nouveau ticket,
            utilisez le menu en bas à gauche → "🎫 Signaler un problème".
          </div>
        </div>
        <button className="btn btn-ghost" onClick={load} style={{ fontSize: 12 }}>
          🔄 Actualiser
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: 30, color: "var(--muted)" }}>Chargement…</div>
      ) : tickets.length === 0 ? (
        <div style={{ textAlign: "center", padding: 30, color: "var(--muted)" }}>
          <div style={{ fontSize: 30, marginBottom: 8 }}>🎫</div>
          Aucun ticket pour le moment.
          <div style={{ fontSize: 11, marginTop: 8 }}>
            Si vous rencontrez un problème, n'hésitez pas à nous le signaler.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {tickets.map((t) => {
            const tt = TYPES[t.type] || { label: t.type, color: "var(--muted)" };
            const ss = STATUS_LABEL[t.status] || { label: t.status, desc: "" };
            return (
              <div key={t.id} style={{
                padding: 12,
                border: "1px solid var(--border, rgba(255,255,255,0.08))",
                borderRadius: 8,
                background: t.status === "new" ? "rgba(212,168,67,0.04)" : "transparent"
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span style={{ color: tt.color, fontSize: 12, fontWeight: 600 }}>{tt.label}</span>
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>· {fmtTicketDate(t.created_at)}</span>
                  </div>
                  <span style={{
                    fontSize: 11, padding: "3px 8px", borderRadius: 6,
                    background: "rgba(255,255,255,0.05)"
                  }}>
                    {ss.label}
                  </span>
                </div>
                <div style={{ fontSize: 13, whiteSpace: "pre-wrap", marginBottom: 6 }}>
                  {t.message}
                </div>
                <div style={{ fontSize: 10, color: "var(--muted)" }}>
                  {ss.desc}
                </div>
                {t.admin_notes && (
                  <div style={{
                    marginTop: 10, padding: 10,
                    background: "rgba(62,207,122,0.06)",
                    border: "1px solid rgba(62,207,122,0.2)",
                    borderRadius: 6,
                    fontSize: 12
                  }}>
                    <div style={{ fontWeight: 600, marginBottom: 4, color: "var(--green, #3ecf7a)" }}>
                      💬 Réponse du support
                    </div>
                    <div style={{ whiteSpace: "pre-wrap" }}>{t.admin_notes}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// fmtTicketDate — formatage de date inline pour éviter le couplage avec helpers.js
function fmtTicketDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString("fr-FR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return iso;
  }
}
