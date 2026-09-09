import React, { useEffect, useState, useRef } from "react";
import { sb } from "../lib/supabase.js";
import { SirenLookup, TvaIntraNote } from "./SirenLookup.jsx";
import { initials, isSiretOrSiren } from "../lib/helpers.js";

function displayName(c) {
  if (c.client_type === "individual") {
    return [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Client";
  }
  return c.legal_name || "Client";
}

export function ClientPicker({ token, company, value, onChange, label = "Client" }) {
  const [open, setOpen] = useState(false);
  const [clients, setClients] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const wrapRef = useRef(null);

  async function refreshClients() {
    setLoading(true);
    const list = await sb.select(token, "clients", {
      filter: `company_id=eq.${company.id}`,
      order: "updated_at.desc",
      limit: 200
    });
    setClients(list || []);
    setLoading(false);
    return list || [];
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      await refreshClients();
      if (!alive) return;
    })();
    return () => { alive = false; };
  }, [token, company.id]);

  useEffect(() => {
    function onClick(e) {
      if (showCreate) return;
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open, showCreate]);

  const selected = clients.find((c) => c.id === value);

  const filtered = clients.filter((c) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      (c.legal_name || "").toLowerCase().includes(s) ||
      (c.first_name || "").toLowerCase().includes(s) ||
      (c.last_name || "").toLowerCase().includes(s) ||
      (c.email || "").toLowerCase().includes(s)
    );
  });

  async function handleClientCreated(newClient) {
    await refreshClients();
    onChange(newClient.id, newClient);
    setShowCreate(false);
    setOpen(false);
    setSearch("");
  }

  return (
    <div className="form-row" style={{ position: "relative" }} ref={wrapRef}>
      {label && <label className="form-label">{label}</label>}
      <button
        type="button"
        className="form-input"
        onClick={() => setOpen((o) => !o)}
        style={{
          textAlign: "left",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "var(--card2)"
        }}
      >
        {selected ? (
          <>
            <div className="avatar" style={{ width: 24, height: 24, fontSize: 9 }}>
              {initials(displayName(selected))}
            </div>
            <span style={{ flex: 1, color: "var(--text)" }}>{displayName(selected)}</span>
          </>
        ) : (
          <span style={{ color: "var(--muted)" }}>— Sélectionner un client —</span>
        )}
        <span style={{ color: "var(--muted)", fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            marginTop: 4,
            maxHeight: 320,
            overflowY: "auto",
            zIndex: 20,
            boxShadow: "0 6px 20px rgba(0,0,0,0.4)"
          }}
        >
          <div style={{ padding: 8, borderBottom: "1px solid var(--border2)", display: "flex", gap: 6 }}>
            <input
              className="form-input"
              placeholder="Rechercher..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
              style={{ fontSize: 12, flex: 1 }}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setShowCreate(true)}
              style={{ whiteSpace: "nowrap", fontSize: 11 }}
              title="Créer un nouveau client"
            >
              + Nouveau
            </button>
          </div>
          {loading ? (
            <div style={{ padding: 16, color: "var(--muted)", fontSize: 12 }}>Chargement...</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 16, color: "var(--muted)", fontSize: 12 }}>
              Aucun client trouvé.
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowCreate(true)}
                  style={{ fontSize: 11 }}
                >
                  + Créer un client maintenant
                </button>
              </div>
            </div>
          ) : (
            filtered.map((c) => (
              <div
                key={c.id}
                onClick={() => { onChange(c.id, c); setOpen(false); setSearch(""); }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 12px",
                  cursor: "pointer",
                  fontSize: 13,
                  borderBottom: "1px solid var(--border2)"
                }}
                onMouseOver={(e) => e.currentTarget.style.background = "var(--card2)"}
                onMouseOut={(e) => e.currentTarget.style.background = ""}
              >
                <div className="avatar" style={{ width: 26, height: 26, fontSize: 9 }}>
                  {initials(displayName(c))}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: "var(--text)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {displayName(c)}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>{c.email || c.phone || "—"}</div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {showCreate && (
        <QuickClientCreateModal
          token={token}
          company={company}
          onClose={() => setShowCreate(false)}
          onCreated={handleClientCreated}
        />
      )}
    </div>
  );
}

function QuickClientCreateModal({ token, company, onClose, onCreated }) {
  const [clientType, setClientType] = useState("company");
  const [legalName, setLegalName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [siret, setSiret] = useState("");   // v8.48.17 — indispensable pour la PA
  // v8.175 — Adresse et n° de TVA : ce formulaire ne les demandait pas, alors
  // qu'une facture a besoin de l'adresse du client (et le Factur-X de sa
  // commune et de son pays). La recherche annuaire les rapporte, il aurait
  // été dommage de les jeter — ils restent modifiables avant création.
  const [vatNumber, setVatNumber] = useState("");
  const [addr1, setAddr1] = useState("");
  const [cp, setCp] = useState("");
  const [ville, setVille] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  // Résultat de l'annuaire : la raison sociale du registre fait foi, le reste
  // ne comble que ce qui est vide — on n'écrase pas une saisie.
  function applySiren(d) {
    if (d.raison_sociale) setLegalName(d.raison_sociale);
    if (d.siret) setSiret(d.siret);
    setVatNumber((v) => v || d.tva_intra || "");
    setAddr1((v) => v || d.adresse || "");
    setCp((v) => v || d.code_postal || "");
    setVille((v) => v || d.ville || "");
  }

  async function save(e) {
    if (e) e.preventDefault();
    setErr("");

    if (clientType === "company" && !legalName.trim()) {
      setErr("Le nom de la société est requis.");
      return;
    }
    if (clientType === "individual" && !lastName.trim() && !firstName.trim()) {
      setErr("Au moins le nom ou le prénom est requis.");
      return;
    }
    if (clientType === "company" && siret && !isSiretOrSiren(siret)) {
      setErr("SIRET (14 chiffres) ou SIREN (9 chiffres) attendu.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        company_id: company.id,
        client_type: clientType,
        legal_name: clientType === "company" ? legalName.trim() : null,
        first_name: clientType === "individual" ? firstName.trim() : null,
        last_name: clientType === "individual" ? lastName.trim() : null,
        siret: clientType === "company" ? (siret.replace(/\s/g, "") || null) : null,
        vat_number: clientType === "company" ? (vatNumber.trim() || null) : null,
        address_line1: addr1.trim() || null,
        postal_code: cp.trim() || null,
        city: ville.trim() || null,
        country: "FR",
        email: email.trim() || null,
        phone: phone.trim() || null
      };
      const created = await sb.insert(token, "clients", payload);
      if (!created || !created[0]) {
        throw new Error("Création échouée");
      }
      onCreated(created[0]);
    } catch (e) {
      setErr(e.message || "Erreur lors de la création");
      setSaving(false);
    }
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20
      }}
    >
      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 24,
          maxWidth: 460,
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
            Nouveau client
          </div>
          <button
            type="button"
            className="close-btn"
            onClick={onClose}
            disabled={saving}
            aria-label="Fermer"
          >
            ✕
          </button>
        </div>

        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 16, lineHeight: 1.5 }}>
          Création rapide. Vous pourrez compléter les autres infos (SIRET, adresse, TVA) plus tard depuis Clients.
        </div>

        <form onSubmit={save}>
          <div className="form-row" style={{ marginBottom: 12 }}>
            <label className="form-label">Type</label>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => setClientType("company")}
                className={"btn btn-sm " + (clientType === "company" ? "btn-primary" : "btn-ghost")}
                style={{ flex: 1 }}
              >
                🏢 Société
              </button>
              <button
                type="button"
                onClick={() => setClientType("individual")}
                className={"btn btn-sm " + (clientType === "individual" ? "btn-primary" : "btn-ghost")}
                style={{ flex: 1 }}
              >
                👤 Particulier
              </button>
            </div>
          </div>

          {clientType === "company" ? (
            <div className="form-row" style={{ marginBottom: 12 }}>
              <label className="form-label">Nom de la société *</label>
              <input
                className="form-input"
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                placeholder="Ex : Dupont SARL"
                autoFocus
                disabled={saving}
              />
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
              <div className="form-row">
                <label className="form-label">Prénom</label>
                <input
                  className="form-input"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="Jean"
                  autoFocus
                  disabled={saving}
                />
              </div>
              <div className="form-row">
                <label className="form-label">Nom *</label>
                <input
                  className="form-input"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Dupont"
                  disabled={saving}
                />
              </div>
            </div>
          )}

          <div className="form-row" style={{ marginBottom: 12 }}>
            <label className="form-label">Email</label>
            <input
              className="form-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="contact@exemple.fr"
              disabled={saving}
            />
            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>
              Recommandé pour envoyer devis et factures par email.
            </div>
          </div>

          {clientType === "company" && (
            <div style={{ marginBottom: 12 }}>
              {/* v8.175 — Saisir le SIRET suffit : l'annuaire remplit raison
                  sociale, adresse et n° de TVA. */}
              <SirenLookup
                value={siret}
                onChange={setSiret}
                onResult={applySiren}
              />
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4, marginBottom: 12 }}>
                Recommandé pour transmettre les factures via la Plateforme Agréée.
              </div>
              <div className="form-row" style={{ marginBottom: 12 }}>
                <label className="form-label">N° TVA intracom.</label>
                <input className="form-input" value={vatNumber}
                  onChange={(e) => setVatNumber(e.target.value.toUpperCase())}
                  placeholder="FR..." disabled={saving} />
                <TvaIntraNote siren={siret} value={vatNumber} />
              </div>
            </div>
          )}

          {/* L'adresse figure sur la facture : autant la saisir ici plutôt que
              de rouvrir la fiche client juste après. */}
          <div className="form-row" style={{ marginBottom: 12 }}>
            <label className="form-label">Adresse</label>
            <input className="form-input" value={addr1} onChange={(e) => setAddr1(e.target.value)}
              placeholder="12 rue de la Paix" disabled={saving} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10, marginBottom: 12 }}>
            <div className="form-row" style={{ margin: 0 }}>
              <label className="form-label">Code postal</label>
              <input className="form-input" value={cp} onChange={(e) => setCp(e.target.value)}
                placeholder="75001" disabled={saving} />
            </div>
            <div className="form-row" style={{ margin: 0 }}>
              <label className="form-label">Ville</label>
              <input className="form-input" value={ville} onChange={(e) => setVille(e.target.value)}
                placeholder="Paris" disabled={saving} />
            </div>
          </div>

          <div className="form-row" style={{ marginBottom: 16 }}>
            <label className="form-label">Téléphone</label>
            <input
              className="form-input"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="06 12 34 56 78"
              disabled={saving}
            />
          </div>

          {err && (
            <div className="auth-error" style={{ marginBottom: 12 }}>
              {err}
            </div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onClose}
              disabled={saving}
            >
              Annuler
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving}
            >
              {saving ? "Création..." : "Créer et utiliser"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
